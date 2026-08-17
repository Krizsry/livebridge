/**
 * Live Bridge - FFmpeg relay manager (requirements 7 and 8).
 *
 * Handles the two directions that SRS cannot do natively:
 *
 *   EGRESS  local stream -> external RTMP/SRT (YouTube, Facebook, Twitch, ...)
 *           Pulls from SRS over the internal Docker network and pushes out.
 *           Defaults to `-c copy`: no transcode, no quality loss, ~no CPU.
 *
 *   INGRESS remote SRT in caller or rendezvous mode -> local RTMP
 *           SRS's SRT server is listener-only, so caller and rendezvous ingest
 *           (requirement 4) are implemented as FFmpeg pull jobs that republish
 *           into SRS. Listener mode needs none of this - it is native.
 *
 * The reverse bridge, RTMP in -> SRT out, needs no process at all: SRS serves
 * any ingested stream over SRT playback. See the README.
 *
 * SECURITY: FFmpeg is always spawned with an argv ARRAY and `shell: false`.
 * No user-supplied value is ever concatenated into a command string, so a
 * malicious destination URL cannot become command injection (project rule 8).
 */

import { spawn } from 'node:child_process';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { applySrtStats } from './state.js';
import { enqueueWrite, insertRelayEvent } from './supabase.js';

const log = createLogger('relay');

/**
 * The spawn implementation. Production always uses node's, but the supervision
 * logic below - restart-on-exit, backoff, and above all the spawn-IDENTITY guard
 * that stops a dying child from nulling out its successor's handle - is
 * unreachable from a test otherwise. FFmpeg cannot be made to exit on cue, and
 * substituting a stub binary is not portable (Windows refuses to spawn a script
 * without a shell, and `shell: true` is exactly what rule 8 forbids here).
 *
 * Only `test/relay-supervision.test.mjs` calls the setter. Nothing in src/ does.
 */
let spawnImpl = spawn;

/** @internal test seam - see the note above. */
export function __setSpawnForTests(fn) {
  spawnImpl = fn || spawn;
}

/** relayId -> runtime record */
const relays = new Map();
/** destinationId -> destination config (mirror of the Supabase table) */
const destinations = new Map();
/** relayId -> pending restart timer */
const restartTimers = new Map();

// =============================================================================
// Argument builders (pure functions - unit-testable without spawning anything)
// =============================================================================

/**
 * Stamped onto the relay's own RTMP pull so the poller can tell it apart from a
 * real viewer. Without it, every running relay showed up in SRS's client list as
 * a play client and inflated viewer_count by one per relay - the dashboard
 * reported an audience that was actually just us.
 */
export const RELAY_PAGE_URL = 'livebridge://relay';

/** stderr lines matching this set `last_error`; everything else is just noise. */
const ERROR_LINE_RE = /error|failed|unable|invalid|denied|refused|timed?\s*out|not found|no such/i;

const BASE_ARGS = [
  '-hide_banner',
  '-loglevel', 'warning',
  // Never read stdin: an FFmpeg child that grabs the terminal will hang the
  // parent under some supervisors.
  '-nostdin',
  // Machine-readable progress on stdout, one block per second.
  '-progress', 'pipe:1',
  '-stats_period', '1',
];

/** Local pull URL for a stream that SRS already has. */
export function localSourceUrl(app, streamKey) {
  return `${config.srs.internalRtmp}/${app}/${streamKey}`;
}

/**
 * Build the argv for an outbound relay.
 *
 * @param {object} dest destination record
 * @param {string} sourceApp
 * @returns {string[]} argv (never a shell string)
 */
export function buildEgressArgs(dest, sourceApp = 'live') {
  const args = [...BASE_ARGS];

  // --- Input: the local SRS stream -------------------------------------------
  args.push(
    // Reconnect if SRS restarts underneath us.
    '-rw_timeout', '10000000',
    // Identifies this connection as our own relay pull in SRS's client list.
    // Must precede -i: it is an input option for the rtmp protocol.
    '-rtmp_pageurl', RELAY_PAGE_URL,
    '-i', localSourceUrl(sourceApp, dest.source_stream_key),
  );

  // --- Codecs ----------------------------------------------------------------
  if (dest.transcode) {
    const p = dest.transcode_profile || {};
    args.push(
      '-c:v', 'libx264',
      '-preset', String(p.preset || 'veryfast'),
      '-profile:v', String(p.profile || 'main'),
      '-b:v', `${Number(p.video_bitrate_kbps) || 4500}k`,
      '-maxrate', `${Number(p.video_bitrate_kbps) || 4500}k`,
      '-bufsize', `${(Number(p.video_bitrate_kbps) || 4500) * 2}k`,
      '-pix_fmt', 'yuv420p',
      // Fixed 2 s keyframe interval - every major platform wants this.
      '-g', String(Number(p.gop) || 60),
      '-keyint_min', String(Number(p.gop) || 60),
      '-sc_threshold', '0',
      '-c:a', 'aac',
      '-b:a', `${Number(p.audio_bitrate_kbps) || 128}k`,
      '-ar', '44100',
      '-ac', '2',
    );
    if (p.width && p.height) {
      args.push('-vf', `scale=${Number(p.width)}:${Number(p.height)}`);
    }
  } else {
    // Straight remux. The destination must accept the source codecs
    // (H.264 + AAC covers every platform we target).
    args.push('-c', 'copy');
  }

  // --- Output ----------------------------------------------------------------
  const target = buildDestinationUrl(dest);
  if (target.startsWith('srt://')) {
    args.push('-f', 'mpegts', target);
  } else {
    args.push(
      '-f', 'flv',
      // Live output has no known duration/filesize; suppress the warning and
      // the bogus metadata rewrite attempt.
      '-flvflags', 'no_duration_filesize',
      target,
    );
  }

  return args;
}

/**
 * Join the destination base URL and its platform stream key.
 * Both halves are validated before ever reaching here (see validate.js).
 */
export function buildDestinationUrl(dest) {
  const base = String(dest.url).replace(/\/+$/, '');
  if (!dest.dest_stream_key) return base;
  return `${base}/${dest.dest_stream_key}`;
}

/**
 * Build the argv for an SRT ingest job in caller or rendezvous mode.
 *
 * @param {object} job
 * @param {string} job.mode         'caller' | 'rendezvous' | 'listener'
 * @param {string} job.remoteHost
 * @param {number} job.remotePort
 * @param {string} job.streamKey    local stream key to republish as
 * @param {string} [job.passphrase]
 * @param {string} [job.remoteStreamId]
 */
export function buildIngressArgs(job) {
  const params = new URLSearchParams();
  params.set('mode', job.mode);
  params.set('transtype', 'live');
  params.set('latency', String(job.latencyMs ?? config.srt.latencyMs));
  if (job.passphrase) {
    params.set('passphrase', job.passphrase);
    params.set('pbkeylen', String(job.pbkeylen ?? config.srt.pbkeylen));
  }
  if (job.remoteStreamId) params.set('streamid', job.remoteStreamId);

  const srtUrl = `srt://${job.remoteHost}:${job.remotePort}?${params.toString()}`;

  return [
    ...BASE_ARGS,
    '-i', srtUrl,
    '-c', 'copy',
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    `${config.srs.internalRtmp}/${job.app || 'live'}/${job.streamKey}`,
  ];
}

// =============================================================================
// Process supervision
// =============================================================================

function relayId(dest) {
  return `dest:${dest.id}`;
}

function activeCount() {
  return [...relays.values()].filter((r) => r.status === 'running' || r.status === 'starting').length;
}

function recordEvent(destinationId, sourceStreamKey, event, detail) {
  enqueueWrite('insertRelayEvent', () => insertRelayEvent({
    destination_id: destinationId,
    source_stream_key: sourceStreamKey,
    event,
    detail: detail ? String(detail).slice(0, 2000) : null,
  }));
}

/**
 * Start (or restart) the relay for a destination.
 * Idempotent: calling it for an already-running relay is a no-op.
 */
export function startRelay(dest, sourceApp = 'live') {
  const id = relayId(dest);
  const existing = relays.get(id);

  if (existing && (existing.status === 'running' || existing.status === 'starting')) {
    return existing;
  }

  // A stop is already in flight (PATCH /destinations stops then immediately
  // restarts). Spawning now would race the dying child: when it finally exits it
  // would null out the NEW child's handle and schedule a further restart, leaving
  // an orphaned FFmpeg still pushing to the platform and a relay the dashboard
  // can no longer stop. Record the intent and let the exit handler do it.
  if (existing && existing.status === 'stopping') {
    existing.restartRequested = { dest, sourceApp };
    log.info('relay restart deferred until the previous process exits', {
      event: 'relay_restart_deferred', destination_id: dest.id,
    });
    return existing;
  }

  if (activeCount() >= config.relay.maxConcurrent) {
    log.error('relay start refused - concurrency limit reached', {
      event: 'relay_refused',
      destination_id: dest.id,
      max_concurrent: config.relay.maxConcurrent,
    });
    return null;
  }

  const args = buildEgressArgs(dest, sourceApp);

  const record = existing || {
    id,
    destination_id: dest.id,
    name: dest.name,
    platform: dest.platform,
    source_stream_key: dest.source_stream_key,
    // Only the host is exposed to the dashboard - never the full URL, which
    // contains the platform stream key.
    target_host: safeHost(dest.url),
    status: 'starting',
    pid: null,
    started_at: null,
    restarts: 0,
    last_error: null,
    stats: { bitrate_kbps: 0, fps: null, dropped_frames: 0, speed: null, out_time_sec: 0 },
  };

  record.status = 'starting';
  record.last_error = null;
  relays.set(id, record);

  log.info('relay starting', {
    event: 'relay_start',
    destination_id: dest.id,
    name: dest.name,
    platform: dest.platform,
    source_stream_key: dest.source_stream_key,
    target_host: record.target_host,
    transcode: Boolean(dest.transcode),
  });

  let child;
  try {
    child = spawnImpl(config.relay.ffmpegPath, args, {
      // shell: false is the default and is what keeps this injection-proof.
      // Stated explicitly so nobody "simplifies" it away later.
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    record.status = 'failed';
    record.last_error = err.message;
    log.error('relay failed to spawn', {
      event: 'relay_error', destination_id: dest.id, detail: err.message,
    });
    recordEvent(dest.id, dest.source_stream_key, 'spawn_failed', err.message);
    return record;
  }

  record.pid = child.pid;
  record.status = 'running';
  record.started_at = new Date().toISOString();
  record.process = child;

  recordEvent(dest.id, dest.source_stream_key, 'started', null);

  // --- stdout: -progress key=value blocks ------------------------------------
  let progressBuf = '';
  child.stdout.on('data', (chunk) => {
    progressBuf += chunk.toString();
    const lines = progressBuf.split('\n');
    progressBuf = lines.pop() || '';
    for (const line of lines) applyProgressLine(record, line.trim());
  });

  // --- stderr: warnings and errors -------------------------------------------
  let stderrBuf = '';
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Only genuine errors become last_error. FFmpeg writes plenty of benign
      // chatter to stderr, and treating all of it as the relay's error state
      // painted a healthy running relay red in the dashboard.
      const isError = ERROR_LINE_RE.test(trimmed);
      if (isError) record.last_error = trimmed;
      log[isError ? 'warn' : 'debug']('relay ffmpeg output', {
        event: 'relay_stderr',
        destination_id: dest.id,
        source_stream_key: dest.source_stream_key,
        detail: trimmed.slice(0, 500),
      });
      maybeApplySrtStats(dest.source_stream_key, trimmed);
    }
  });

  child.on('error', (err) => {
    record.status = 'failed';
    record.last_error = err.message;
    log.error('relay process error', {
      event: 'relay_error', destination_id: dest.id, detail: err.message,
    });
  });

  child.on('exit', (code, signal) => {
    // Ignore a child that is no longer the one we are supervising. An earlier
    // process can exit AFTER its replacement has been spawned; without this
    // guard it would clear the successor's pid/handle and schedule another
    // restart on top of a relay that is already running.
    if (record.process !== child) return;

    record.pid = null;
    record.process = null;

    // Deliberate stop - do not restart.
    if (record.status === 'stopping') {
      record.status = 'stopped';
      log.info('relay stopped', {
        event: 'relay_stop', destination_id: dest.id, source_stream_key: dest.source_stream_key,
      });
      recordEvent(dest.id, dest.source_stream_key, 'stopped', null);

      // A restart was requested while this process was shutting down - now that
      // it is genuinely gone, honour it. This is the safe half of the
      // stop-then-start sequence that PATCH /destinations performs.
      const pending = record.restartRequested;
      record.restartRequested = null;
      if (pending) startRelay(pending.dest, pending.sourceApp);
      return;
    }

    log.error('relay exited unexpectedly', {
      event: 'relay_exit',
      destination_id: dest.id,
      source_stream_key: dest.source_stream_key,
      exit_code: code,
      signal,
      last_error: record.last_error,
    });
    recordEvent(dest.id, dest.source_stream_key, 'exited', `code=${code} signal=${signal}`);

    scheduleRestart(dest, sourceApp, record);
  });

  return record;
}

/** Exponential backoff, capped, with the destination's own retry counter. */
function scheduleRestart(dest, sourceApp, record) {
  record.status = 'retrying';
  record.restarts += 1;

  const delay = Math.min(
    config.relay.backoffMinMs * 2 ** Math.min(record.restarts - 1, 10),
    config.relay.backoffMaxMs,
  );

  log.info('relay restart scheduled', {
    event: 'relay_retry',
    destination_id: dest.id,
    attempt: record.restarts,
    delay_ms: delay,
  });

  const timer = setTimeout(() => {
    restartTimers.delete(record.id);
    // Only retry while the destination is still enabled and its source is live.
    const current = destinations.get(dest.id);
    if (!current || current.enabled === false) {
      record.status = 'stopped';
      return;
    }
    startRelay(current, sourceApp);
  }, delay);

  timer.unref?.();
  restartTimers.set(record.id, timer);
}

export function stopRelay(destinationId, reason = 'manual') {
  const id = `dest:${destinationId}`;
  const record = relays.get(id);
  if (!record) return false;

  const timer = restartTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    restartTimers.delete(id);
  }

  if (record.process) {
    record.status = 'stopping';
    // SIGTERM lets FFmpeg flush and close the connection cleanly; SIGKILL after
    // a grace period in case it wedges.
    const dying = record.process;
    dying.kill('SIGTERM');
    const killTimer = setTimeout(() => {
      // Only kill the child we actually asked to stop. `record.process` is NOT
      // safe to read here: a stop is normally followed by a deferred restart
      // (PATCH /destinations does exactly that), so five seconds later this
      // handle usually points at a healthy REPLACEMENT. Killing that is what
      // turned every destination edit into a ~35 s relay outage - SIGKILL, an
      // "exited unexpectedly", then a full backoff - instead of a 200 ms blip.
      // Same defect class as the exit-handler identity guard above, in the one
      // place that guard did not cover.
      if (record.process === dying) dying.kill('SIGKILL');
    }, 5000);
    killTimer.unref?.();
  } else {
    record.status = 'stopped';
  }

  log.info('relay stop requested', {
    event: 'relay_stop_requested', destination_id: destinationId, reason,
  });
  return true;
}

function applyProgressLine(record, line) {
  const eq = line.indexOf('=');
  if (eq < 1) return;
  const key = line.slice(0, eq);
  const value = line.slice(eq + 1);

  switch (key) {
    case 'bitrate': {
      // e.g. "4500.2kbits/s" or "N/A"
      const m = /^([\d.]+)kbits\/s$/.exec(value);
      record.stats.bitrate_kbps = m ? Math.round(Number(m[1])) : 0;
      break;
    }
    case 'fps':
      record.stats.fps = value === 'N/A' ? null : Number(value);
      break;
    case 'drop_frames':
      record.stats.dropped_frames = Number(value) || 0;
      break;
    case 'speed': {
      const m = /^([\d.]+)x$/.exec(value);
      record.stats.speed = m ? Number(m[1]) : null;
      break;
    }
    case 'out_time_us':
      record.stats.out_time_sec = Math.round((Number(value) || 0) / 1e6);
      break;
    default:
      break;
  }
}

/**
 * Best-effort extraction of SRT transport statistics from FFmpeg's stderr.
 *
 * Honest caveat: whether these lines appear at all depends on the FFmpeg build
 * and libsrt log level. When nothing matches we leave the metrics as null and
 * the dashboard shows "n/a" - we never substitute a fabricated zero.
 */
function maybeApplySrtStats(streamKey, line) {
  if (!line.toLowerCase().includes('srt')) return;

  const rtt = /rtt[=:\s]+([\d.]+)/i.exec(line);
  const loss = /(?:pktRcvLoss|loss)[=:\s]+([\d.]+)/i.exec(line);
  const latency = /latency[=:\s]+([\d.]+)/i.exec(line);

  if (!rtt && !loss && !latency) return;

  applySrtStats(streamKey, {
    rttMs: rtt ? Number(rtt[1]) : null,
    packetLossPct: loss ? Number(loss[1]) : null,
    latencyMs: latency ? Number(latency[1]) : null,
  });
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

// =============================================================================
// Destination registry + lifecycle wiring
// =============================================================================

export function setDestinations(list) {
  destinations.clear();
  for (const d of list) destinations.set(d.id, d);
  log.info('relay destinations loaded', { count: destinations.size });
}

export function upsertDestination(dest) {
  destinations.set(dest.id, dest);
}

export function removeDestination(destinationId) {
  stopRelay(destinationId, 'destination deleted');
  destinations.delete(destinationId);
  relays.delete(`dest:${destinationId}`);
}

export function listDestinations() {
  return [...destinations.values()];
}

/** Called when a publisher goes live: start every enabled destination for it. */
export function onStreamOnline(streamKey, app = 'live') {
  for (const dest of destinations.values()) {
    if (dest.source_stream_key !== streamKey) continue;
    if (dest.enabled === false) continue;
    startRelay(dest, app);
  }
}

/** Called when a publisher goes offline: stop its relays so FFmpeg doesn't spin. */
export function onStreamOffline(streamKey) {
  for (const dest of destinations.values()) {
    if (dest.source_stream_key !== streamKey) continue;
    const record = relays.get(`dest:${dest.id}`);
    if (record) {
      // Reset backoff so the next show starts clean.
      record.restarts = 0;
      stopRelay(dest.id, 'source stream went offline');
    }
  }
}

/** Relay status for the dashboard. Contains no stream keys or full URLs. */
export function relayStatus() {
  return [...relays.values()].map((r) => ({
    id: r.id,
    destination_id: r.destination_id,
    name: r.name,
    platform: r.platform,
    source_stream_key: r.source_stream_key,
    target_host: r.target_host,
    status: r.status,
    started_at: r.started_at,
    restarts: r.restarts,
    last_error: r.last_error ? String(r.last_error).slice(0, 300) : null,
    stats: r.stats,
  }));
}

// =============================================================================
// SRT ingest jobs - caller and rendezvous modes (requirement 4)
// =============================================================================
// SRS's SRT server only listens; it never dials out. So when the far end is the
// listener (caller mode) or when both ends are behind NAT (rendezvous), we run
// an FFmpeg process that connects outward and republishes into SRS over local
// RTMP. From that point on the stream is indistinguishable from a native SRT
// ingest - same hooks, same HLS output, same relay options.
// =============================================================================

/** jobId -> ingest runtime record */
const ingestJobs = new Map();
let ingestSeq = 0;

/**
 * @param {object} job
 * @param {string|null} existingId reuse this job id instead of minting a new one.
 *   Restarts pass the original id: a new id on every retry silently invalidated
 *   any `DELETE /api/ingest/<id>` the dashboard was still holding, so stopping a
 *   flapping ingest job from the UI quietly did nothing.
 */
export function startIngest(job, existingId = null) {
  const id = existingId || `ingest:${++ingestSeq}`;
  const args = buildIngressArgs(job);

  const record = {
    id,
    stream_key: job.streamKey,
    app: job.app || 'live',
    mode: job.mode,
    remote: `${job.remoteHost}:${job.remotePort}`,
    status: 'starting',
    pid: null,
    started_at: new Date().toISOString(),
    restarts: 0,
    last_error: null,
    stats: { bitrate_kbps: 0, fps: null, dropped_frames: 0, speed: null, out_time_sec: 0 },
  };
  ingestJobs.set(id, record);

  log.info('srt ingest job starting', {
    event: 'ingest_start',
    job_id: id,
    stream_key: job.streamKey,
    mode: job.mode,
    remote: record.remote,
  });

  let child;
  try {
    child = spawnImpl(config.relay.ffmpegPath, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    record.status = 'failed';
    record.last_error = err.message;
    log.error('srt ingest failed to spawn', { event: 'ingest_error', job_id: id, detail: err.message });
    return record;
  }

  record.pid = child.pid;
  record.status = 'running';
  record.process = child;

  let progressBuf = '';
  child.stdout.on('data', (chunk) => {
    progressBuf += chunk.toString();
    const lines = progressBuf.split('\n');
    progressBuf = lines.pop() || '';
    for (const line of lines) applyProgressLine(record, line.trim());
  });

  let stderrBuf = '';
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      record.last_error = trimmed;
      log.warn('srt ingest ffmpeg output', {
        event: 'ingest_stderr', job_id: id, stream_key: job.streamKey, detail: trimmed.slice(0, 500),
      });
      // Ingest jobs are the one path where real SRT transport stats are
      // available, because FFmpeg is the SRT endpoint here rather than SRS.
      maybeApplySrtStats(job.streamKey, trimmed);
    }
  });

  child.on('exit', (code, signal) => {
    record.pid = null;
    record.process = null;

    if (record.status === 'stopping') {
      record.status = 'stopped';
      // Removed here, not in stopIngest(): dropping the entry before the process
      // had actually exited left stopAllRelays() unable to reach it on shutdown.
      ingestJobs.delete(id);
      log.info('srt ingest stopped', { event: 'ingest_stop', job_id: id });
      return;
    }

    record.status = 'retrying';
    record.restarts += 1;
    log.error('srt ingest exited', {
      event: 'ingest_exit', job_id: id, exit_code: code, signal, attempt: record.restarts,
    });

    const delay = Math.min(
      config.relay.backoffMinMs * 2 ** Math.min(record.restarts - 1, 10),
      config.relay.backoffMaxMs,
    );
    const timer = setTimeout(() => {
      if (!ingestJobs.has(id)) return;
      // Same id, so the job keeps its identity across restarts and the dashboard's
      // stop control keeps working. Carry the retry count so backoff keeps growing.
      const restarted = startIngest(job, id);
      restarted.restarts = record.restarts;
    }, delay);
    timer.unref?.();
  });

  return record;
}

export function stopIngest(jobId) {
  const record = ingestJobs.get(jobId);
  if (!record) return false;
  record.status = 'stopping';
  if (record.process) {
    // Capture the child: an ingest job keeps its id and its map entry across a
    // restart, so `record.process` can be a replacement by the time this fires.
    // See the note in stopRelay().
    const dying = record.process;
    dying.kill('SIGTERM');
    const t = setTimeout(() => {
      if (record.process === dying) dying.kill('SIGKILL');
    }, 5000);
    t.unref?.();
  } else {
    record.status = 'stopped';
    ingestJobs.delete(jobId);
  }
  log.info('srt ingest stop requested', { event: 'ingest_stop_requested', job_id: jobId });
  return true;
}

export function listIngest() {
  return [...ingestJobs.values()].map((r) => ({
    id: r.id,
    stream_key: r.stream_key,
    app: r.app,
    mode: r.mode,
    remote: r.remote,
    status: r.status,
    started_at: r.started_at,
    restarts: r.restarts,
    last_error: r.last_error ? String(r.last_error).slice(0, 300) : null,
    stats: r.stats,
  }));
}

/** Stop everything - used on SIGTERM so we don't orphan FFmpeg processes. */
export function stopAllRelays() {
  for (const record of ingestJobs.values()) {
    if (record.process) {
      record.status = 'stopping';
      record.process.kill('SIGTERM');
    }
  }
  ingestJobs.clear();

  for (const timer of restartTimers.values()) clearTimeout(timer);
  restartTimers.clear();
  for (const record of relays.values()) {
    if (record.process) {
      record.status = 'stopping';
      record.process.kill('SIGTERM');
    }
  }
  log.info('all relays stopped', { count: relays.size });
}

/**
 * Live Bridge - in-memory live state.
 *
 * This module is the single source of truth for "what is happening right now".
 * It is deliberately in-memory only:
 *   - It must answer an SRS on_publish hook in single-digit milliseconds.
 *   - It must keep working when Supabase is unreachable (requirement 21).
 * Supabase receives an asynchronous copy for history; it is never read on the
 * hot path.
 */

import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('state');

/** streamKey -> stream record */
const streams = new Map();
/** SRS client id -> viewer record */
const viewers = new Map();

function nowIso() {
  return new Date().toISOString();
}

/**
 * Elapsed uptime in seconds for a publisher.
 *
 * DO NOT use SRS's `live_ms` for this. Despite the name it is neither a
 * duration nor the stream's start time - it is SRS's *current server clock* in
 * epoch milliseconds, and it advances on every API call. Dividing it by 1000
 * and calling it uptime is what produced the ~496358h display: that is the span
 * from the Unix epoch to now. Verified by polling twice and watching the value
 * track wall-clock time to within ~100 ms.
 *
 * The authoritative figure is `alive` on the publisher's entry in
 * GET /api/v1/clients, which is seconds-connected as a float. It is only known
 * once the client list has been read, so our own admission time is the fallback
 * for the first tick and for any tick where the publisher is not listed.
 */
export function computeUptimeSec(aliveSec, startedAtIso, nowMs = Date.now()) {
  // `Number(null)` is 0, and so is `Number('')`. Coercing first meant a record
  // whose `_aliveSec` was still null - every stream's first tick, and every tick
  // of a publisher missing from the client list - took the "alive" branch with a
  // value of 0 and reported an uptime frozen at zero, never reaching the
  // started_at fallback below. Reject the empty cases before coercing.
  const alive = (aliveSec === null || aliveSec === undefined || aliveSec === '')
    ? NaN
    : Number(aliveSec);
  if (Number.isFinite(alive) && alive >= 0) return Math.round(alive);

  const started = Date.parse(startedAtIso);
  if (Number.isFinite(started)) return Math.max(0, Math.round((nowMs - started) / 1000));

  return 0;
}

function emptyMetrics() {
  return {
    bitrate_kbps: 0,
    avg_bitrate_kbps: 0,
    peak_bitrate_kbps: 0,
    uptime_sec: 0,
    bytes_received: 0,
    viewer_count: 0,
    // SRT-specific. Null means "not measurable for this ingest path" - SRS's
    // HTTP API does not expose per-connection SRT statistics, so these are only
    // populated for streams arriving through an FFmpeg SRT ingest job, which
    // does report them. The dashboard renders null as "n/a" rather than 0, so
    // an operator is never shown a fake zero packet-loss figure.
    latency_ms: null,
    packet_loss_pct: null,
    rtt_ms: null,
    // The SRT receive-buffer depth this server is configured with. NOT a
    // measurement - it is the target latency SRT is working to, and it is the
    // only latency figure that exists for a native SRT ingest. Populated for
    // SRT streams only; RTMP has no equivalent setting.
    configured_latency_ms: null,
    video: null,
    audio: null,
  };
}

/**
 * Register a publisher. Called from the SRS on_publish hook, so this runs
 * before the stream is admitted and must not do any I/O.
 */
export function publisherConnected({
  streamKey, app, protocol, connectionMode, sourceIp, clientId, streamId, authorized,
  enforceProtocol = null,
  /**
   * Invoked with the previous record when a new publisher takes over a key we
   * still hold as live. The caller uses it to close that session's Supabase row
   * and stop its relays - see the note at the replacement branch below.
   */
  onDisplace = null,
}) {
  const existing = streams.get(streamKey);

  // A reconnect within the grace window resumes the same logical stream so the
  // dashboard doesn't flap and the session history stays as one row.
  if (existing && existing.status === 'reconnecting') {
    existing.status = 'online';
    existing.client_id = clientId;
    existing.source_ip = sourceIp;
    existing.protocol = protocol;
    existing.connection_mode = connectionMode;
    existing.last_seen_at = nowIso();
    existing.reconnect_count += 1;
    existing.ended_at = null;
    log.info('publisher reconnected', {
      event: 'publisher_reconnect',
      stream_key: streamKey,
      protocol,
      source_ip: sourceIp,
      reconnect_count: existing.reconnect_count,
    });
    return existing;
  }

  // A publisher is taking over a key we still hold as live (not a reconnect -
  // that is handled above). The old record was previously just overwritten in the
  // map, which abandoned its session_id: nothing ever closed that Supabase row,
  // so it read as "live" indefinitely, and its relays were left running against a
  // stream that no longer existed. Finalise it properly first.
  if (existing) {
    existing.status = 'offline';
    existing.ended_at = nowIso();
    existing.end_reason = 'replaced by a new publisher on the same stream key';
    log.warn('publisher replaced an existing live stream on the same key', {
      event: 'publisher_replaced',
      stream_key: streamKey,
      previous_source_ip: existing.source_ip,
      new_source_ip: sourceIp,
      previous_uptime_sec: existing.metrics.uptime_sec,
    });
    if (onDisplace) onDisplace(existing);
  }

  const record = {
    stream_key: streamKey,
    stream_id: streamId || streamKey,
    app: app || 'live',
    protocol,
    connection_mode: connectionMode,
    source_ip: sourceIp,
    client_id: clientId,
    status: 'online',
    authorized: Boolean(authorized),
    // Set when the stream key restricts protocol but the transport was not yet
    // knowable at admission time. Checked in updatePublisherTransport().
    enforce_protocol: enforceProtocol,
    protocol_violation: false,
    started_at: nowIso(),
    last_seen_at: nowIso(),
    ended_at: null,
    reconnect_count: 0,
    session_id: null,
    metrics: emptyMetrics(),
    // Rolling window of { t, kbps } samples for the dashboard sparkline.
    history: [],
    // Running totals used to compute the session average bitrate.
    _sampleCount: 0,
    _sampleSum: 0,
    // Seconds-connected, refreshed from the SRS client list each tick. Null
    // until the first client-list read; uptime falls back to started_at.
    _aliveSec: null,
    // Whether the Supabase session row has had its protocol/connection_mode
    // backfilled. The poller retries every tick until it is true, because the
    // transport is identified from the client list while the session_id is still
    // in flight from a queued insert - see persistSessionTransport().
    _transportPersisted: false,
  };

  streams.set(streamKey, record);

  log.info('publisher connected', {
    event: 'publisher_connect',
    stream_key: streamKey,
    stream_id: record.stream_id,
    protocol,
    connection_mode: connectionMode,
    source_ip: sourceIp,
    app: record.app,
  });

  return record;
}

/**
 * Mark a publisher as gone. It enters `reconnecting` for the grace period
 * before being finalised, so a brief network blip doesn't close the session.
 */
export function publisherDisconnected(streamKey, reason = 'unpublish') {
  const record = streams.get(streamKey);
  if (!record) return null;

  record.status = 'reconnecting';
  record.ended_at = nowIso();
  record.end_reason = reason;
  record.metrics.bitrate_kbps = 0;

  log.info('publisher disconnected', {
    event: 'publisher_disconnect',
    stream_key: streamKey,
    protocol: record.protocol,
    source_ip: record.source_ip,
    reason,
    uptime_sec: record.metrics.uptime_sec,
    avg_bitrate_kbps: record.metrics.avg_bitrate_kbps,
  });

  return record;
}

/**
 * Finalise streams that have been `reconnecting` longer than the grace period.
 * Returns the records that just went offline so the caller can close their
 * Supabase session rows and stop their relays.
 */
export function reapStaleStreams() {
  const finalised = [];
  const graceMs = config.reconnectGraceSec * 1000;
  const now = Date.now();

  for (const [key, record] of streams.entries()) {
    if (record.status !== 'reconnecting') continue;
    const endedAt = Date.parse(record.ended_at || record.last_seen_at);
    if (now - endedAt < graceMs) continue;

    record.status = 'offline';
    finalised.push(record);
    streams.delete(key);

    log.info('stream went offline', {
      event: 'stream_offline',
      stream_key: key,
      protocol: record.protocol,
      duration_sec: Math.max(
        0,
        Math.round((Date.parse(record.ended_at) - Date.parse(record.started_at)) / 1000),
      ),
      avg_bitrate_kbps: record.metrics.avg_bitrate_kbps,
      reconnect_count: record.reconnect_count,
      end_reason: record.end_reason || 'unknown',
    });
  }

  return finalised;
}

/**
 * Attach the Supabase session row id once the insert comes back.
 *
 * Returns false when there is nothing to attach it to - either the stream has
 * already ended (the insert is queued and fire-and-forget, so a short stream can
 * finish before its row exists) or the key now belongs to a *different* session.
 * The caller must close the row itself in that case; silently dropping the id
 * left the row with ended_at NULL forever, reading as "live" in the dashboard.
 */
export function attachSessionId(streamKey, sessionId, startedAt = null) {
  const record = streams.get(streamKey);
  if (!record) return false;
  if (startedAt && record.started_at !== startedAt) return false;
  record.session_id = sessionId;
  return true;
}

/**
 * Fold one poll tick of SRS data into a stream record.
 * `srsStream` is an element of GET /api/v1/streams.
 */
export function applySrsSample(streamKey, srsStream) {
  const record = streams.get(streamKey);
  if (!record) return;

  const kbps = Number(srsStream?.kbps?.recv_30s ?? 0);
  const bytes = Number(srsStream?.recv_bytes ?? 0);
  // `_aliveSec` is refreshed from the SRS client list each tick - see
  // updatePublisherTransport(). Never read srsStream.live_ms here.
  const uptimeSec = computeUptimeSec(record._aliveSec, record.started_at);

  record.last_seen_at = nowIso();
  if (record.status === 'reconnecting') record.status = 'online';

  record.metrics.bitrate_kbps = kbps;
  record.metrics.bytes_received = bytes;
  // Assigned unconditionally: computeUptimeSec always returns a sane figure, and
  // the old `uptimeSec || previous` guard would freeze the display during the
  // first second of a stream, when 0 is the correct answer.
  record.metrics.uptime_sec = uptimeSec;
  record.metrics.peak_bitrate_kbps = Math.max(record.metrics.peak_bitrate_kbps, kbps);

  // Only non-zero samples feed the average, so a stream that is briefly idle
  // doesn't drag its reported average toward zero.
  if (kbps > 0) {
    record._sampleCount += 1;
    record._sampleSum += kbps;
    record.metrics.avg_bitrate_kbps = Math.round(record._sampleSum / record._sampleCount);
  }

  if (srsStream?.video) {
    record.metrics.video = {
      codec: srsStream.video.codec ?? null,
      width: srsStream.video.width ?? null,
      height: srsStream.video.height ?? null,
      fps: srsStream.video.fps ?? null,
      profile: srsStream.video.profile ?? null,
    };
  }
  if (srsStream?.audio) {
    record.metrics.audio = {
      codec: srsStream.audio.codec ?? null,
      sample_rate: srsStream.audio.sample_rate ?? null,
      channel: srsStream.audio.channel ?? null,
    };
  }

  record.history.push({ t: Date.now(), kbps });
  if (record.history.length > config.metricHistoryLength) record.history.shift();
}

/**
 * Correct a stream's transport details from the SRS client list.
 *
 * The on_publish hook does not tell us which protocol the publisher used - SRS
 * normalises SRT and RTMP into the same callback shape. The client list does
 * (`srt-publish` vs `fmle-publish`), so the poller feeds it back here and the
 * record is corrected within one tick of going live.
 *
 * `connection_mode` is only overwritten when the record still holds the
 * placeholder, so an FFmpeg ingest job that already declared itself `caller` or
 * `rendezvous` is not downgraded to `listener`.
 */
export function updatePublisherTransport(streamKey, { protocol, sourceIp, clientId, aliveSec }) {
  const record = streams.get(streamKey);
  if (!record) return null;

  const wasUnknown = record.protocol === 'unknown';

  if (protocol) record.protocol = protocol;
  if (sourceIp) record.source_ip = sourceIp;
  if (clientId) record.client_id = clientId;

  // Seconds-connected, straight from SRS. This is the only trustworthy uptime
  // source; see computeUptimeSec() for why live_ms is not.
  if (Number.isFinite(Number(aliveSec))) {
    record._aliveSec = Number(aliveSec);
    record.metrics.uptime_sec = computeUptimeSec(record._aliveSec, record.started_at);
  }

  // Only SRT has a configured latency target. Surfacing it beats a bare "n/a",
  // which reads as though the dashboard is broken rather than as though the
  // measurement genuinely does not exist.
  // Set AND cleared in one place. Assigning only on the SRT branch meant a value
  // set once was never removed if the transport later resolved to something else.
  if (protocol) {
    record.metrics.configured_latency_ms = protocol === 'SRT' ? config.srt.latencyMs : null;
  }

  if (record.connection_mode === 'unknown' || record.connection_mode === undefined) {
    record.connection_mode = protocol === 'SRT' ? 'listener' : 'push';
  }

  if (wasUnknown && protocol) {
    log.info('publisher transport identified', {
      event: 'publisher_transport',
      stream_key: streamKey,
      protocol,
      connection_mode: record.connection_mode,
      source_ip: record.source_ip,
    });

    // -------------------------------------------------------------------------
    // Deferred protocol-restriction enforcement.
    //
    // The on_publish hook could not check this: SRS gives SRT and RTMP the same
    // callback shape, so the transport was unknown at admission time. Now that
    // we know it, enforce the key's restriction.
    //
    // HONEST LIMITATION: we cannot disconnect the publisher from here. SRS's
    // raw_api is deliberately off (it would let anyone on the network kick
    // streams), so there is no kick endpoint. What we do instead is mark the
    // stream, log at critical, and make it impossible to miss on the dashboard.
    // Treat the protocol field as an *alerting* control, not a hard block - the
    // stream key and secret are the hard controls.
    // -------------------------------------------------------------------------
    if (record.enforce_protocol && protocol !== record.enforce_protocol) {
      record.protocol_violation = true;
      record.authorized = false;
      log.critical('publisher violated its stream key protocol restriction', {
        event: 'protocol_violation',
        stream_key: streamKey,
        registered_for: record.enforce_protocol,
        actually_used: protocol,
        source_ip: record.source_ip,
        action: 'stream flagged in the dashboard; SRS cannot be asked to disconnect it '
          + '(raw_api is disabled by design)',
      });
    }
  }

  // Reported so the poller can backfill the Supabase session row, which was
  // opened with protocol/connection_mode NULL because neither was knowable at
  // admission time. Without this the history table shows "—" forever.
  return { record, identified: wasUnknown && Boolean(protocol) };
}

/**
 * SRT transport statistics reported by an FFmpeg ingest job. Only these
 * ingest paths can supply real loss/RTT figures - see emptyMetrics().
 */
export function applySrtStats(streamKey, { latencyMs, packetLossPct, rttMs }) {
  const record = streams.get(streamKey);
  if (!record) return;
  if (latencyMs !== undefined && latencyMs !== null) record.metrics.latency_ms = latencyMs;
  if (packetLossPct !== undefined && packetLossPct !== null) {
    record.metrics.packet_loss_pct = packetLossPct;
  }
  if (rttMs !== undefined && rttMs !== null) record.metrics.rtt_ms = rttMs;
}

// -----------------------------------------------------------------------------
// Viewers
// -----------------------------------------------------------------------------

/** Replace the whole viewer set from one poll tick (SRS is authoritative). */
export function replaceViewers(list) {
  viewers.clear();
  const perStream = new Map();

  for (const v of list) {
    viewers.set(v.client_id, v);
    const arr = perStream.get(v.stream_key) || [];
    arr.push(v);
    perStream.set(v.stream_key, arr);
  }

  for (const [key, record] of streams.entries()) {
    record.metrics.viewer_count = (perStream.get(key) || []).length;
  }

  return perStream;
}

export function viewersFor(streamKey) {
  return [...viewers.values()].filter((v) => v.stream_key === streamKey);
}

export function allViewers() {
  return [...viewers.values()];
}

// -----------------------------------------------------------------------------
// Read accessors
// -----------------------------------------------------------------------------

export function getStream(streamKey) {
  return streams.get(streamKey) || null;
}

export function hasStream(streamKey) {
  return streams.has(streamKey);
}

export function allStreams() {
  return [...streams.values()];
}

/** Shape sent to the dashboard. Excludes internal accumulator fields. */
export function serializeStream(record) {
  return {
    stream_key: record.stream_key,
    stream_id: record.stream_id,
    app: record.app,
    protocol: record.protocol,
    connection_mode: record.connection_mode,
    source_ip: record.source_ip,
    status: record.status,
    authorized: record.authorized,
    protocol_violation: Boolean(record.protocol_violation),
    registered_for: record.enforce_protocol || null,
    started_at: record.started_at,
    last_seen_at: record.last_seen_at,
    reconnect_count: record.reconnect_count,
    metrics: record.metrics,
    history: record.history,
    viewers: viewersFor(record.stream_key),
    hls_url: `/hls/${record.app}/${record.stream_key}.m3u8`,
    flv_url: `/live/${record.app}/${record.stream_key}.flv`,
  };
}

export function snapshot() {
  return {
    streams: allStreams().map(serializeStream),
    viewer_total: viewers.size,
    generated_at: nowIso(),
  };
}

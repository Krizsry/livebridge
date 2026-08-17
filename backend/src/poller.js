/**
 * Live Bridge - SRS statistics poll loop.
 *
 * Once per POLL_INTERVAL_MS (default 1 s) this:
 *   1. reads /api/v1/streams and /api/v1/clients from SRS,
 *   2. folds the numbers into the in-memory state,
 *   3. finalises streams whose reconnect grace period has expired, and
 *   4. broadcasts a frame to every connected dashboard over the WebSocket.
 *
 * Everything here is best-effort: if SRS is briefly unreachable the tick logs
 * and returns. The loop is scheduled with setTimeout-after-completion rather
 * than setInterval so a slow tick can never overlap with the next one.
 */

import { config } from './config.js';
import { createLogger } from './logger.js';
import { fetchStreams, fetchClients, classifyClient } from './srs.js';
import {
  applySrsSample, replaceViewers, reapStaleStreams, allStreams, snapshot,
  getStream, publisherDisconnected, hasStream, updatePublisherTransport,
} from './state.js';
import { closeSession, updateSession, enqueueWrite } from './supabase.js';
import { onStreamOffline, relayStatus, RELAY_PAGE_URL } from './relay.js';
import { registryStatus } from './registry.js';
import { sanitizeIp } from './validate.js';

const log = createLogger('poller');

let running = false;
let timer = null;
let broadcastFn = null;
let consecutiveSrsFailures = 0;

const health = {
  srs_reachable: false,
  last_tick_at: null,
  last_error: null,
  tick_count: 0,
};

export function setBroadcaster(fn) {
  broadcastFn = fn;
}

/**
 * SRS stream ids look like `live/mystream`. Extract the stream name, which is
 * the stream key we index everything by.
 */
function streamKeyOf(srsStream) {
  if (srsStream?.name) return srsStream.name;
  const url = String(srsStream?.url || '');
  const parts = url.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/**
 * Extract the stream key from an SRS *client* record.
 *
 * TRAP: `client.stream` is NOT the stream name. It is SRS's internal stream
 * OBJECT ID (e.g. "vid-69ejk70") and never matches a stream key. Reading it
 * here meant no client was ever matched to a stream, which silently broke three
 * separate things at once: publisher protocol stayed "unknown" forever (the
 * dashboard's permanent DETECTING badge), connection_mode stayed "unknown", and
 * every viewer was filed under a key that matched no stream, so viewer_count was
 * always 0.
 *
 * `client.name` carries the real stream name ("testkey"); `client.url` carries
 * "/live/testkey" as a fallback.
 */
function clientStreamKey(client) {
  if (client?.name) return client.name;
  const url = String(client?.url || '');
  const parts = url.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

async function tick() {
  health.tick_count += 1;
  health.last_tick_at = new Date().toISOString();

  // --- 1. Pull SRS state -----------------------------------------------------
  const [streamsRes, clientsRes] = await Promise.all([fetchStreams(), fetchClients()]);

  if (!streamsRes.ok || !clientsRes.ok) {
    consecutiveSrsFailures += 1;
    health.srs_reachable = false;
    health.last_error = streamsRes.error || clientsRes.error;

    // Log the first failure and then every 30th, so a long SRS outage doesn't
    // produce one log line per second forever.
    if (consecutiveSrsFailures === 1 || consecutiveSrsFailures % 30 === 0) {
      log.error('SRS poll failed', {
        event: 'srs_poll_failed',
        detail: health.last_error,
        consecutive_failures: consecutiveSrsFailures,
      });
    }

    // Still push a frame so the dashboard can show that the engine is unhealthy.
    broadcast();
    return;
  }

  if (consecutiveSrsFailures > 0) {
    log.info('SRS poll recovered', { after_failures: consecutiveSrsFailures });
  }
  consecutiveSrsFailures = 0;
  health.srs_reachable = true;
  health.last_error = null;

  // --- 2. Correct publisher transport details, and rebuild the viewer list ---
  // Clients are processed BEFORE per-stream metrics. applySrsSample() derives
  // uptime from the seconds-connected figure that updatePublisherTransport()
  // refreshes here, so folding metrics first reported an uptime that was always
  // exactly one tick out of date.
  const viewerRecords = [];
  let relayPulls = 0;
  for (const c of clientsRes.data) {
    const { protocol, role } = classifyClient(c.type);
    const streamKey = clientStreamKey(c);

    // Publishers: the on_publish hook can't tell SRT from RTMP (SRS gives both
    // the same callback shape), but the client list can. Fix the record here.
    if (role === 'publisher') {
      if (streamKey && hasStream(streamKey)) {
        const result = updatePublisherTransport(streamKey, {
          protocol,
          sourceIp: sanitizeIp(c.ip),
          clientId: String(c.id),
          aliveSec: Number(c.alive),
        });
        // The session row was opened with protocol/connection_mode NULL because
        // on_publish cannot see the transport. Attempt the backfill on EVERY
        // tick, not only the tick that identified it - see the note on
        // persistSessionTransport() for why firing once loses a race it cannot
        // win. The function is idempotent and self-limiting.
        if (result) persistSessionTransport(result.record);
      }
      continue;
    }

    const key = streamKey;
    if (!key) continue;

    // Our own egress relays pull from SRS over RTMP, so SRS lists them as play
    // clients exactly like a browser. Counting them inflated viewer_count by one
    // per running relay - the dashboard reported an audience that was really
    // just us. buildEgressArgs() stamps RELAY_PAGE_URL on the pull so it can be
    // told apart here.
    if (typeof c.pageUrl === 'string' && c.pageUrl.includes(RELAY_PAGE_URL)) {
      relayPulls += 1;
      continue;
    }

    viewerRecords.push({
      client_id: String(c.id),
      stream_key: key,
      protocol,
      source_ip: sanitizeIp(c.ip),
      connected_since_sec: Math.round(Number(c.alive ?? 0)),
      page_url: typeof c.pageUrl === 'string' ? c.pageUrl.slice(0, 256) : null,
    });
  }
  replaceViewers(viewerRecords);
  health.relay_pulls = relayPulls;

  // --- 3. Fold per-stream metrics -------------------------------------------
  const seenKeys = new Set();
  for (const s of streamsRes.data) {
    const key = streamKeyOf(s);
    if (!key) continue;

    // SRS keeps a stream object in /api/v1/streams AFTER the publisher leaves,
    // with publish.active false. Treating those as live resurrected the record
    // on every tick: a stream that on_unpublish had moved to `reconnecting` was
    // flipped straight back to `online`, so reapStaleStreams() never fired, the
    // relay was never stopped and the Supabase session row was never closed.
    // That is where the "ghost live rows" came from - closeOrphanedSessions()
    // cleans them up at boot, but this is what was creating them.
    //
    // An inactive entry is not evidence of a publisher, so it neither feeds
    // metrics nor counts as "seen" for the vanish check in step 4.
    if (s?.publish && s.publish.active === false) continue;

    seenKeys.add(key);
    // Only streams we know about (i.e. that passed on_publish) are tracked.
    if (hasStream(key)) applySrsSample(key, s);
  }

  // --- 4. Detect publishers that vanished without an on_unpublish ------------
  // SRS normally fires the hook, but a hard process kill or a network drop can
  // skip it. Anything we think is online but SRS no longer lists is moved to
  // `reconnecting`, which the reaper will finalise after the grace period.
  for (const record of allStreams()) {
    if (record.status === 'online' && !seenKeys.has(record.stream_key)) {
      publisherDisconnected(record.stream_key, 'vanished from SRS');
    }
  }

  // --- 5. Finalise expired streams ------------------------------------------
  const finalised = reapStaleStreams();
  for (const record of finalised) {
    onStreamOffline(record.stream_key);
    persistSessionClose(record);
  }

  // --- 6. Push to the dashboard ---------------------------------------------
  broadcast();
}

/**
 * Write the closing half of a session row. Queued and fire-and-forget: a
 * Supabase outage must never delay the poll loop (requirement 21).
 */
function persistSessionClose(record) {
  if (!record.session_id) return;

  const startedMs = Date.parse(record.started_at);
  const endedMs = Date.parse(record.ended_at || new Date().toISOString());
  const durationSec = Math.max(0, Math.round((endedMs - startedMs) / 1000));

  enqueueWrite('closeSession', () => closeSession(record.session_id, {
    ended_at: record.ended_at,
    duration_sec: durationSec,
    avg_bitrate_kbps: record.metrics.avg_bitrate_kbps,
    peak_bitrate_kbps: record.metrics.peak_bitrate_kbps,
    bytes_received: record.metrics.bytes_received,
    end_reason: record.end_reason || 'unknown',
    reconnect_count: record.reconnect_count,
  }));
}

/**
 * Backfill a session row's transport columns once the poller has identified
 * them. Queued and fire-and-forget, like every other Supabase write on this
 * path - history accuracy must never delay a tick.
 *
 * WHY THIS RETRIES (bug #29). Two independent things have to happen before the
 * backfill is possible, and they arrive in an order we do not control:
 *
 *   - the transport is identified from the SRS client list, typically on the
 *     first poll tick, ~1 s after the publisher is admitted;
 *   - the `session_id` comes back from an insert that was deliberately queued
 *     and fire-and-forget so it could never delay the on_publish hook.
 *
 * The insert routinely loses that race. The original version fired only on the
 * tick that identified the transport and returned early if `session_id` was
 * still null, so nothing ever wrote the columns and every short stream showed
 * a blank protocol and connection mode in the history table.
 *
 * Calling this every tick fixes it: the first tick where BOTH facts exist does
 * the single write, and `_transportPersisted` stops it happening twice. A
 * stream that ends before its session_id ever arrives still keeps NULL columns,
 * which is honest - we genuinely never had a row to write to.
 */
function persistSessionTransport(record) {
  if (!record || record._transportPersisted) return;
  // Not yet knowable, or nowhere to put it yet. Either way, try again next tick.
  if (!record.session_id) return;
  if (!record.protocol || record.protocol === 'unknown') return;

  record._transportPersisted = true;

  enqueueWrite('updateSessionTransport', () => updateSession(record.session_id, {
    protocol: record.protocol === 'unknown' ? null : record.protocol,
    connection_mode: record.connection_mode === 'unknown' ? null : record.connection_mode,
    source_ip: record.source_ip,
  }));
}

function broadcast() {
  if (!broadcastFn) return;
  broadcastFn({
    type: 'tick',
    data: {
      ...snapshot(),
      relays: relayStatus(),
      engine: { srs_reachable: health.srs_reachable, last_error: health.last_error },
      // Carried on EVERY frame, not just the snapshot: the dashboard replaces its
      // whole data object per frame, so anything sent once is lost on the next
      // tick. It is a handful of fields and it is what lets the UI tell "registry
      // deliberately not configured" apart from "registry temporarily down" (#9).
      registry: registryStatus(),
    },
  });
}

export function startPoller() {
  if (running) return;
  running = true;

  const loop = async () => {
    if (!running) return;
    try {
      await tick();
    } catch (err) {
      log.error('poll tick threw', { detail: err.message, stack: err.stack });
    }
    if (running) {
      timer = setTimeout(loop, config.pollIntervalMs);
      timer.unref?.();
    }
  };

  log.info('poller started', { interval_ms: config.pollIntervalMs });
  loop();
}

export function stopPoller() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  log.info('poller stopped', { ticks: health.tick_count });
}

export function pollerHealth() {
  return { ...health, consecutive_failures: consecutiveSrsFailures };
}

/** Used by the hooks route to build the initial snapshot for a new WS client. */
export function currentSnapshot() {
  return {
    ...snapshot(),
    relays: relayStatus(),
    engine: { srs_reachable: health.srs_reachable, last_error: health.last_error },
    registry: registryStatus(),
  };
}

// Re-exported so routes don't need to reach into state.js directly.
export { getStream };

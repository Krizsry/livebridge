/**
 * Live Bridge - SRS HTTP callback endpoints.
 *
 * SRS calls these on every connect/publish/play. The contract is simple and
 * unforgiving: reply HTTP 200 with a body of `0` to allow, anything else to
 * reject. SRS treats a slow or failed callback as a rejection, so every handler
 * here must answer from memory and must never await Supabase.
 *
 * This is where requirement 5 lands for BOTH protocols:
 *   RTMP - stream key from `rtmp://host/live/<KEY>`
 *   SRT  - stream ID from `#!::r=live/<KEY>`
 * SRS normalises both into the same `app` + `stream` fields below.
 */

import express from 'express';
import { createLogger } from './../logger.js';
import { config } from './../config.js';
import { authorizePublish } from './../registry.js';
import {
  publisherConnected, publisherDisconnected, attachSessionId, getStream,
} from './../state.js';
import { insertSession, closeSession, enqueueWrite, insertEventLog } from './../supabase.js';
import { onStreamOnline, onStreamOffline } from './../relay.js';
import { pushEvent } from './../ws.js';
import { validateStreamKey, validateApp, sanitizeIp, ValidationError } from './../validate.js';

const log = createLogger('hooks');
const router = express.Router();

const ALLOW = '0';
const DENY = '1';

/** SRS wants a bare status code in the body, not JSON. */
function allow(res) {
  res.status(200).type('text/plain').send(ALLOW);
}
function deny(res, reason) {
  // 200 + non-zero body is the documented SRS rejection. A 4xx works too but
  // some SRS versions log it as a hook failure rather than a policy decision.
  res.status(200).type('text/plain').send(DENY);
  return reason;
}

/**
 * Parse the query string SRS passes through in `param`, e.g. `?key=abc&mode=x`.
 * For SRT this is whatever followed the stream ID.
 */
function parseParam(param) {
  if (typeof param !== 'string' || param.length === 0) return new URLSearchParams();
  try {
    return new URLSearchParams(param.startsWith('?') ? param.slice(1) : param);
  } catch {
    return new URLSearchParams();
  }
}

// =============================================================================
// on_publish - the authorisation gate
// =============================================================================
router.post('/publish', (req, res) => {
  const body = req.body || {};
  const sourceIp = sanitizeIp(body.ip);
  const clientId = String(body.client_id ?? '');

  let streamKey;
  let app;
  try {
    streamKey = validateStreamKey(body.stream, 'stream');
    app = validateApp(body.app, 'app');
  } catch (err) {
    log.warn('publish rejected - malformed stream name', {
      event: 'publish_rejected',
      reason: err instanceof ValidationError ? err.message : 'invalid stream identifier',
      raw_stream: String(body.stream ?? '').slice(0, 100),
      source_ip: sourceIp,
      client_id: clientId,
    });
    deny(res, 'malformed stream name');
    return;
  }

  const params = parseParam(body.param);
  const secret = params.get('secret') || params.get('key') || null;

  // Synchronous, in-memory, microseconds. Never touches Supabase.
  const decision = authorizePublish({ streamKey, protocol: 'unknown', secret });

  if (!decision.allowed) {
    log.warn('publish rejected', {
      event: 'publish_rejected',
      stream_key: streamKey,
      app,
      source_ip: sourceIp,
      client_id: clientId,
      reason: decision.reason,
    });
    queueEvent('publish_rejected', {
      stream_key: streamKey, source_ip: sourceIp, detail: decision.reason,
    });
    deny(res, decision.reason);
    return;
  }

  // Fail-open path: the operator must be able to see this in the logs.
  if (decision.degraded) {
    log.critical('publisher admitted without verification - registry unavailable', {
      event: 'publish_unverified',
      stream_key: streamKey,
      source_ip: sourceIp,
      auth_failure_mode: config.auth.failureMode,
      detail: decision.reason,
    });
  }

  // `protocol` and `connection_mode` start as `unknown`; the poller corrects
  // them from the SRS client list within one tick (see state.updatePublisherTransport).
  const record = publisherConnected({
    streamKey,
    app,
    protocol: 'unknown',
    connectionMode: 'unknown',
    sourceIp,
    clientId,
    streamId: params.get('streamid') || streamKey,
    authorized: !decision.degraded,
    enforceProtocol: decision.enforceProtocol || null,
    // A new publisher on a key we still hold as live displaces the old one.
    // Close its history row and stop its relays rather than orphaning both.
    onDisplace: (old) => {
      onStreamOffline(old.stream_key);
      if (!old.session_id) return;
      enqueueWrite('closeDisplacedSession', () => closeSession(old.session_id, {
        ended_at: old.ended_at,
        end_reason: old.end_reason,
        avg_bitrate_kbps: old.metrics.avg_bitrate_kbps,
        peak_bitrate_kbps: old.metrics.peak_bitrate_kbps,
        bytes_received: old.metrics.bytes_received,
        reconnect_count: old.reconnect_count,
      }));
    },
  });

  // Answer SRS first. Everything below is deferred so a slow network can never
  // delay the handshake.
  allow(res);

  setImmediate(() => {
    // Start any external relays configured for this source.
    onStreamOnline(streamKey, app);
    pushEvent('stream_online', { stream_key: streamKey, app });

    // Open the history row. Fire-and-forget; if Supabase is down we simply have
    // no history for this session and the live view is unaffected.
    enqueueWrite('insertSession', async () => {
      const result = await insertSession({
        stream_key: streamKey,
        protocol: record.protocol === 'unknown' ? null : record.protocol,
        connection_mode: record.connection_mode === 'unknown' ? null : record.connection_mode,
        source_ip: sourceIp,
        started_at: record.started_at,
        authorized: record.authorized,
        client_id: clientId,
      });
      if (result.ok && result.data?.id) {
        // The insert is queued, so a very short stream can end before its row
        // exists. attachSessionId reports that, and we close the row right away -
        // otherwise nothing ever would, and it would read as "live" forever.
        const attached = attachSessionId(streamKey, result.data.id, record.started_at);
        if (!attached) {
          // The record is out of the live map but this closure still holds it,
          // so anything the poller managed to learn before the reap - usually
          // the transport - is written here rather than lost. Without it a short
          // stream's history row shows a blank protocol forever (bug #29).
          record._transportPersisted = true;
          enqueueWrite('closeStrandedSession', () => closeSession(result.data.id, {
            ended_at: new Date().toISOString(),
            end_reason: 'stream ended before its session row was created',
            protocol: record.protocol === 'unknown' ? null : record.protocol,
            connection_mode: record.connection_mode === 'unknown' ? null : record.connection_mode,
          }));
        }
      }
      return result;
    });
  });
});

// =============================================================================
// on_unpublish
// =============================================================================
router.post('/unpublish', (req, res) => {
  const body = req.body || {};
  allow(res);

  let streamKey;
  try {
    streamKey = validateStreamKey(body.stream, 'stream');
  } catch {
    return;
  }

  publisherDisconnected(streamKey, 'unpublish');
  pushEvent('stream_reconnecting', { stream_key: streamKey });
  queueEvent('unpublish', { stream_key: streamKey, source_ip: sanitizeIp(body.ip) });
});

// =============================================================================
// on_play / on_stop - viewer accounting
// =============================================================================
// The poller rebuilds the authoritative viewer list every tick from the SRS
// client list; these hooks exist for the audit log and for instant UI feedback.
router.post('/play', (req, res) => {
  const body = req.body || {};
  allow(res);

  log.info('viewer connected', {
    event: 'viewer_connect',
    stream_key: String(body.stream ?? '').slice(0, 64),
    app: String(body.app ?? '').slice(0, 32),
    source_ip: sanitizeIp(body.ip),
    client_id: String(body.client_id ?? ''),
  });
});

router.post('/stop', (req, res) => {
  const body = req.body || {};
  allow(res);

  log.info('viewer disconnected', {
    event: 'viewer_disconnect',
    stream_key: String(body.stream ?? '').slice(0, 64),
    source_ip: sanitizeIp(body.ip),
    client_id: String(body.client_id ?? ''),
  });
});

// =============================================================================
// on_connect / on_close - transport-level, both protocols
// =============================================================================
router.post('/connect', (req, res) => {
  const body = req.body || {};
  allow(res);

  log.debug('client connected', {
    event: 'client_connect',
    app: String(body.app ?? '').slice(0, 32),
    source_ip: sanitizeIp(body.ip),
    client_id: String(body.client_id ?? ''),
    tc_url: String(body.tcUrl ?? '').slice(0, 200),
  });
});

router.post('/close', (req, res) => {
  const body = req.body || {};
  allow(res);

  log.debug('client closed', {
    event: 'client_close',
    source_ip: sanitizeIp(body.ip),
    client_id: String(body.client_id ?? ''),
    send_bytes: Number(body.send_bytes ?? 0),
    recv_bytes: Number(body.recv_bytes ?? 0),
  });
});

// =============================================================================
// on_hls - fired per HLS segment. Debug level only: at a 2 s fragment this is
// 30 calls per minute per stream and would drown the log at info.
// =============================================================================
router.post('/hls', (req, res) => {
  const body = req.body || {};
  allow(res);

  log.debug('hls segment written', {
    event: 'hls_segment',
    stream_key: String(body.stream ?? '').slice(0, 64),
    duration: Number(body.duration ?? 0),
    seq_no: Number(body.seq_no ?? 0),
  });
});

/** Queue an audit row without ever blocking the hook response. */
function queueEvent(event, fields) {
  enqueueWrite('insertEventLog', () => insertEventLog({
    event,
    stream_key: fields.stream_key ?? null,
    source_ip: fields.source_ip ?? null,
    detail: fields.detail ?? null,
  }));
}

export default router;
export { getStream };

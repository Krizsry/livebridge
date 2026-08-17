/**
 * Live Bridge - dashboard REST API.
 *
 * No authentication (requirement 12) - access control is at the network layer.
 * Everything here is still validated (project rule 8), because "no login" is a
 * deployment posture, not permission to accept malformed input.
 *
 * Every Supabase-backed endpoint degrades: when Supabase is unreachable it
 * returns HTTP 200 with `{ degraded: true, ... }` and an empty result rather
 * than an error, so the dashboard can render "History unavailable" instead of
 * a broken page (requirement 21).
 */

import express from 'express';
import { config, publicConfig } from './../config.js';
import { createLogger } from './../logger.js';
import { allStreams, serializeStream, getStream, allViewers } from './../state.js';
import { currentSnapshot, pollerHealth } from './../poller.js';
import { isHealthy as srsHealthy } from './../srs.js';
import {
  fetchSessions, fetchDestinations, insertDestination, updateDestination,
  deleteDestination, fetchRelayEvents, supabaseHealth, writeQueueDepth,
} from './../supabase.js';
import {
  addKey, editKey, removeKey, listKeysRedacted, registryStatus, refresh as refreshRegistry,
} from './../registry.js';
import {
  relayStatus, startRelay, stopRelay, upsertDestination, removeDestination,
  listDestinations, startIngest, stopIngest, listIngest,
} from './../relay.js';
import { wsClientCount } from './../ws.js';
import {
  validateStreamKey, validateApp, validateString, validateBool, validateInt,
  validateEnum, validateUuid, validateRelayUrl, validateDestinationKey,
  validateIsoDate, ValidationError,
} from './../validate.js';

const log = createLogger('api');
const router = express.Router();

/** Wrap an async handler so a rejected promise becomes a 500, not a hang. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Turn a failed Supabase result into the right HTTP status.
 *
 * Everything used to answer 503 "Supabase is unreachable", so a duplicate stream
 * key - a plain client mistake - was reported as an outage, complete with
 * `degraded: true`. That is misleading on its own, and it also told the operator
 * to go looking at Supabase when the fix was to pick a different key.
 */
function sendSupabaseError(res, result, fallbackMessage) {
  if (result.appError) {
    if (result.code === '23505') {
      res.status(409).json({
        error: 'that value is already taken', code: result.code, detail: result.error,
      });
      return;
    }
    res.status(400).json({
      error: 'the database rejected this request', code: result.code, detail: result.error,
    });
    return;
  }
  res.status(503).json({ error: fallbackMessage, detail: result.error, degraded: true });
}

// =============================================================================
// Meta
// =============================================================================

/** Non-sensitive config so the dashboard can render correct connection strings. */
router.get('/config', (req, res) => {
  res.json(publicConfig);
});

router.get('/health', wrap(async (req, res) => {
  const srs = await srsHealthy();
  const supabase = supabaseHealth();
  const poller = pollerHealth();

  // The health verdict deliberately ignores Supabase: the streaming engine is
  // what "healthy" means here. Supabase being down degrades the dashboard, not
  // the service (requirement 21).
  const healthy = srs.healthy;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    app: 'Live Bridge',
    engine: { srs_reachable: srs.healthy, srs_version: srs.version, error: srs.error },
    poller,
    supabase: { ...supabase, write_queue: writeQueueDepth() },
    registry: registryStatus(),
    dashboard_clients: wsClientCount(),
    active_streams: allStreams().length,
    active_viewers: allViewers().length,
    uptime_sec: Math.round(process.uptime()),
  });
}));

// =============================================================================
// Live state
// =============================================================================

router.get('/streams', (req, res) => {
  res.json(currentSnapshot());
});

router.get('/streams/:key', (req, res) => {
  const key = validateStreamKey(req.params.key, 'key');
  const record = getStream(key);
  if (!record) {
    res.status(404).json({ error: 'stream not live', stream_key: key });
    return;
  }
  res.json(serializeStream(record));
});

router.get('/viewers', (req, res) => {
  res.json({ viewers: allViewers(), total: allViewers().length });
});

// =============================================================================
// Session history (Supabase-backed, degrades gracefully)
// =============================================================================

router.get('/sessions', wrap(async (req, res) => {
  const limit = validateInt(req.query.limit, 'limit', { min: 1, max: 500, fallback: 100 });
  const offset = validateInt(req.query.offset, 'offset', { min: 0, max: 100000, fallback: 0 });
  const streamKey = req.query.stream_key
    ? validateStreamKey(req.query.stream_key, 'stream_key') : null;
  const protocol = req.query.protocol
    ? validateEnum(req.query.protocol, 'protocol', ['SRT', 'RTMP'], undefined) : null;
  const since = validateIsoDate(req.query.since, 'since');

  const result = await fetchSessions({ limit, offset, streamKey, protocol, since });

  if (!result.ok) {
    // 200, not 5xx: this is a known degraded state the UI renders explicitly.
    res.json({
      sessions: [],
      degraded: true,
      reason: 'history unavailable - Supabase is unreachable',
      supabase: supabaseHealth(),
    });
    return;
  }

  res.json({ sessions: result.data || [], degraded: false });
}));

// =============================================================================
// Registered stream keys / stream IDs
// =============================================================================

router.get('/keys', (req, res) => {
  res.json({
    keys: listKeysRedacted(),
    registry: registryStatus(),
    degraded: !registryStatus().loadedOk,
  });
});

router.post('/keys', wrap(async (req, res) => {
  const body = req.body || {};

  const record = {
    stream_key: validateStreamKey(body.stream_key, 'stream_key'),
    label: validateString(body.label, 'label', { min: 1, max: 120 }),
    protocol: validateEnum(body.protocol, 'protocol', ['SRT', 'RTMP', 'ANY'], 'ANY'),
    enabled: validateBool(body.enabled, 'enabled', true),
    secret: validateString(body.secret, 'secret', { min: 8, max: 128, required: false }),
    notes: validateString(body.notes, 'notes', { min: 0, max: 1000, required: false }),
  };

  const result = await addKey(record);
  if (!result.ok) {
    sendSupabaseError(res, result, 'could not save stream key - Supabase is unreachable');
    return;
  }

  // Never echo the secret back.
  const { secret, ...safe } = result.data;
  res.status(201).json({ key: { ...safe, has_secret: Boolean(secret) } });
}));

router.patch('/keys/:id', wrap(async (req, res) => {
  const id = validateUuid(req.params.id, 'id');
  const body = req.body || {};
  const patch = {};

  if (body.stream_key !== undefined) patch.stream_key = validateStreamKey(body.stream_key, 'stream_key');
  if (body.label !== undefined) patch.label = validateString(body.label, 'label', { max: 120 });
  if (body.protocol !== undefined) patch.protocol = validateEnum(body.protocol, 'protocol', ['SRT', 'RTMP', 'ANY']);
  if (body.enabled !== undefined) patch.enabled = validateBool(body.enabled, 'enabled');
  if (body.notes !== undefined) patch.notes = validateString(body.notes, 'notes', { min: 0, max: 1000, required: false });
  if (body.secret !== undefined) {
    patch.secret = body.secret === null || body.secret === ''
      ? null
      : validateString(body.secret, 'secret', { min: 8, max: 128 });
  }

  if (Object.keys(patch).length === 0) throw new ValidationError('no updatable fields supplied', 'body');

  const result = await editKey(id, patch);
  if (!result.ok) {
    sendSupabaseError(res, result, 'could not update stream key - Supabase is unreachable');
    return;
  }
  const { secret, ...safe } = result.data;
  res.json({ key: { ...safe, has_secret: Boolean(secret) } });
}));

router.delete('/keys/:id', wrap(async (req, res) => {
  const id = validateUuid(req.params.id, 'id');
  const result = await removeKey(id);
  if (!result.ok) {
    res.status(503).json({ error: 'could not delete stream key', detail: result.error, degraded: true });
    return;
  }
  res.status(204).end();
}));

router.post('/keys/refresh', wrap(async (req, res) => {
  const result = await refreshRegistry();
  res.json({ refreshed: result.ok, registry: registryStatus() });
}));

// =============================================================================
// Relay destinations - the "add new stream destination" UI (requirement 10)
// =============================================================================

router.get('/destinations', wrap(async (req, res) => {
  const result = await fetchDestinations();

  if (!result.ok) {
    // Fall back to the in-memory mirror so a Supabase outage doesn't hide
    // relays that are actually running right now.
    res.json({
      destinations: listDestinations().map(redactDestination),
      degraded: true,
      reason: 'showing cached destinations - Supabase is unreachable',
    });
    return;
  }

  // Refresh the mirror while we're here.
  for (const d of result.data || []) upsertDestination(d);

  res.json({ destinations: (result.data || []).map(redactDestination), degraded: false });
}));

router.post('/destinations', wrap(async (req, res) => {
  const body = req.body || {};

  const record = {
    name: validateString(body.name, 'name', { min: 1, max: 120 }),
    platform: validateEnum(
      body.platform, 'platform',
      ['youtube', 'facebook', 'twitch', 'custom'], 'custom',
    ),
    source_stream_key: validateStreamKey(body.source_stream_key, 'source_stream_key'),
    url: validateRelayUrl(body.url, 'url'),
    dest_stream_key: validateDestinationKey(body.dest_stream_key, 'dest_stream_key'),
    enabled: validateBool(body.enabled, 'enabled', true),
    transcode: validateBool(body.transcode, 'transcode', false),
    transcode_profile: validateTranscodeProfile(body.transcode_profile),
  };

  const result = await insertDestination(record);
  if (!result.ok) {
    sendSupabaseError(res, result, 'could not save destination - Supabase is unreachable');
    return;
  }

  upsertDestination(result.data);

  log.info('relay destination created', {
    event: 'destination_created',
    destination_id: result.data.id,
    name: result.data.name,
    platform: result.data.platform,
    source_stream_key: result.data.source_stream_key,
  });

  // If the source is already live, start relaying immediately.
  const live = getStream(result.data.source_stream_key);
  if (live && result.data.enabled) startRelay(result.data, live.app);

  res.status(201).json({ destination: redactDestination(result.data) });
}));

router.patch('/destinations/:id', wrap(async (req, res) => {
  const id = validateUuid(req.params.id, 'id');
  const body = req.body || {};
  const patch = {};

  if (body.name !== undefined) patch.name = validateString(body.name, 'name', { max: 120 });
  if (body.platform !== undefined) {
    patch.platform = validateEnum(body.platform, 'platform', ['youtube', 'facebook', 'twitch', 'custom']);
  }
  if (body.source_stream_key !== undefined) {
    patch.source_stream_key = validateStreamKey(body.source_stream_key, 'source_stream_key');
  }
  if (body.url !== undefined) patch.url = validateRelayUrl(body.url, 'url');
  if (body.dest_stream_key !== undefined) {
    patch.dest_stream_key = validateDestinationKey(body.dest_stream_key, 'dest_stream_key');
  }
  if (body.enabled !== undefined) patch.enabled = validateBool(body.enabled, 'enabled');
  if (body.transcode !== undefined) patch.transcode = validateBool(body.transcode, 'transcode');
  if (body.transcode_profile !== undefined) {
    patch.transcode_profile = validateTranscodeProfile(body.transcode_profile);
  }

  if (Object.keys(patch).length === 0) throw new ValidationError('no updatable fields supplied', 'body');

  const result = await updateDestination(id, patch);
  if (!result.ok) {
    res.status(503).json({ error: 'could not update destination', detail: result.error, degraded: true });
    return;
  }

  upsertDestination(result.data);

  // Any config change restarts the relay so the new settings take effect.
  stopRelay(id, 'destination updated');
  const live = getStream(result.data.source_stream_key);
  if (live && result.data.enabled) startRelay(result.data, live.app);

  res.json({ destination: redactDestination(result.data) });
}));

router.delete('/destinations/:id', wrap(async (req, res) => {
  const id = validateUuid(req.params.id, 'id');
  const result = await deleteDestination(id);
  if (!result.ok) {
    res.status(503).json({ error: 'could not delete destination', detail: result.error, degraded: true });
    return;
  }
  removeDestination(id);
  log.info('relay destination deleted', { event: 'destination_deleted', destination_id: id });
  res.status(204).end();
}));

router.post('/destinations/:id/start', (req, res) => {
  const id = validateUuid(req.params.id, 'id');
  const dest = listDestinations().find((d) => d.id === id);
  if (!dest) {
    res.status(404).json({ error: 'destination not found' });
    return;
  }
  const live = getStream(dest.source_stream_key);
  if (!live) {
    res.status(409).json({
      error: 'source stream is not live',
      detail: `nothing is publishing to '${dest.source_stream_key}' right now`,
    });
    return;
  }
  const record = startRelay(dest, live.app);
  if (!record) {
    res.status(429).json({
      error: 'relay concurrency limit reached',
      max_concurrent: config.relay.maxConcurrent,
    });
    return;
  }
  res.json({ relay: relayStatus().find((r) => r.destination_id === id) || null });
});

router.post('/destinations/:id/stop', (req, res) => {
  const id = validateUuid(req.params.id, 'id');
  const stopped = stopRelay(id, 'manual stop from dashboard');
  res.json({ stopped });
});

// =============================================================================
// Relay status + audit
// =============================================================================

router.get('/relays', (req, res) => {
  res.json({ relays: relayStatus(), ingest: listIngest() });
});

router.get('/relay-events', wrap(async (req, res) => {
  const limit = validateInt(req.query.limit, 'limit', { min: 1, max: 500, fallback: 100 });
  const result = await fetchRelayEvents({ limit });
  if (!result.ok) {
    res.json({ events: [], degraded: true, reason: 'relay history unavailable' });
    return;
  }
  res.json({ events: result.data || [], degraded: false });
}));

// =============================================================================
// SRT ingest jobs - caller / rendezvous modes (requirement 4)
// =============================================================================

router.get('/ingest', (req, res) => {
  res.json({ jobs: listIngest() });
});

router.post('/ingest', (req, res) => {
  const body = req.body || {};

  const job = {
    streamKey: validateStreamKey(body.stream_key, 'stream_key'),
    app: validateApp(body.app, 'app'),
    mode: validateEnum(body.mode, 'mode', ['caller', 'rendezvous', 'listener'], 'caller'),
    remoteHost: validateString(body.remote_host, 'remote_host', { min: 1, max: 253 }),
    remotePort: validateInt(body.remote_port, 'remote_port', { min: 1, max: 65535 }),
    latencyMs: validateInt(body.latency_ms, 'latency_ms', {
      min: 20, max: 8000, fallback: config.srt.latencyMs,
    }),
    passphrase: validateString(body.passphrase, 'passphrase', { min: 10, max: 79, required: false }),
    remoteStreamId: validateString(body.remote_stream_id, 'remote_stream_id', { min: 1, max: 512, required: false }),
  };

  // Hostname shape check - this value ends up in an FFmpeg URL argument.
  if (!/^[A-Za-z0-9_.:-]+$/.test(job.remoteHost)) {
    throw new ValidationError('remote_host must be a hostname or IP address', 'remote_host');
  }

  const record = startIngest(job);
  res.status(201).json({ job: listIngest().find((j) => j.id === record.id) || null });
});

router.delete('/ingest/:id', (req, res) => {
  const id = validateString(req.params.id, 'id', { min: 1, max: 64 });
  if (!/^ingest:\d+$/.test(id)) throw new ValidationError('id must be an ingest job id', 'id');
  const stopped = stopIngest(id);
  res.json({ stopped });
});

// =============================================================================
// Helpers
// =============================================================================

/**
 * Strip the platform stream key before sending a destination to the browser.
 *
 * The dashboard has no login (requirement 12), so anyone who reaches it could
 * read a YouTube stream key straight out of the API response and hijack the
 * broadcast. The UI shows the host and a masked key; the real value stays on
 * the backend.
 */
function redactDestination(d) {
  return {
    id: d.id,
    name: d.name,
    platform: d.platform,
    source_stream_key: d.source_stream_key,
    url_host: safeHost(d.url),
    url_masked: maskUrl(d.url),
    dest_stream_key_masked: maskKey(d.dest_stream_key),
    has_dest_stream_key: Boolean(d.dest_stream_key),
    enabled: d.enabled,
    transcode: d.transcode,
    transcode_profile: d.transcode_profile,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

function maskUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

function maskKey(key) {
  if (!key) return null;
  const s = String(key);
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}${'*'.repeat(Math.min(s.length - 4, 12))}${s.slice(-2)}`;
}

function validateTranscodeProfile(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('transcode_profile must be an object', 'transcode_profile');
  }
  return {
    video_bitrate_kbps: validateInt(value.video_bitrate_kbps, 'transcode_profile.video_bitrate_kbps', {
      min: 100, max: 60000, fallback: 4500,
    }),
    audio_bitrate_kbps: validateInt(value.audio_bitrate_kbps, 'transcode_profile.audio_bitrate_kbps', {
      min: 32, max: 512, fallback: 128,
    }),
    width: validateInt(value.width, 'transcode_profile.width', { min: 128, max: 7680, fallback: 0 }) || null,
    height: validateInt(value.height, 'transcode_profile.height', { min: 128, max: 4320, fallback: 0 }) || null,
    gop: validateInt(value.gop, 'transcode_profile.gop', { min: 10, max: 600, fallback: 60 }),
    preset: validateEnum(
      value.preset, 'transcode_profile.preset',
      ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'], 'veryfast',
    ),
    profile: validateEnum(
      value.profile, 'transcode_profile.profile',
      ['baseline', 'main', 'high'], 'main',
    ),
  };
}

export default router;

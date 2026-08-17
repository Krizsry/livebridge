/**
 * Live Bridge - registered stream key / stream ID registry and authorisation.
 *
 * This is what makes requirement 5 work for both protocols:
 *   RTMP - the stream key in `rtmp://host/live/<KEY>` is matched here.
 *   SRT  - the stream ID (`#!::r=live/<KEY>`) is matched here.
 *
 * The registry lives in memory and is refreshed from Supabase on a timer. The
 * on_publish hook reads ONLY the in-memory copy, never Supabase directly, so:
 *   - authorisation costs microseconds, not a network round trip; and
 *   - a Supabase outage cannot block or reject ingest (requirement 21).
 */

import { config } from './config.js';
import { createLogger } from './logger.js';
import {
  fetchStreamKeys, insertStreamKey, updateStreamKey, deleteStreamKey, supabaseEnabled,
} from './supabase.js';

const log = createLogger('registry');

/** stream_key -> record */
const cache = new Map();

const status = {
  loadedOk: false,
  lastLoadAt: null,
  lastError: null,
  count: 0,
};

let refreshTimer = null;

/** Pull the authoritative list from Supabase into the cache. */
export async function refresh({ quiet = false } = {}) {
  if (!supabaseEnabled) {
    if (!quiet) {
      log.warn('registry refresh skipped - supabase not configured', {
        auth_failure_mode: config.auth.failureMode,
      });
    }
    return { ok: false, degraded: true };
  }

  const res = await fetchStreamKeys();

  if (!res.ok) {
    status.lastError = res.error;
    log.error('registry refresh failed - continuing on cached keys', {
      detail: res.error,
      cached_keys: cache.size,
      loaded_ok_before: status.loadedOk,
    });
    return { ok: false, degraded: true };
  }

  cache.clear();
  for (const row of res.data || []) {
    cache.set(row.stream_key, row);
  }

  status.loadedOk = true;
  status.lastLoadAt = new Date().toISOString();
  status.lastError = null;
  status.count = cache.size;

  if (!quiet) log.info('registry refreshed', { registered_keys: cache.size });

  return { ok: true, degraded: false, count: cache.size };
}

export function startAutoRefresh() {
  if (refreshTimer) return;
  refresh();
  refreshTimer = setInterval(() => refresh({ quiet: true }), config.auth.cacheRefreshSec * 1000);
  refreshTimer.unref?.();
  log.info('registry auto-refresh started', { interval_sec: config.auth.cacheRefreshSec });
}

export function stopAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

/**
 * Decide whether a publisher may publish.
 *
 * @param {object} args
 * @param {string} args.streamKey  stream key (RTMP) or stream ID (SRT)
 * @param {string} args.protocol   'RTMP' | 'SRT'
 * @param {string|null} args.secret optional `?key=` / `?secret=` query token
 * @returns {{allowed: boolean, reason: string, record: object|null, degraded: boolean}}
 */
export function authorizePublish({ streamKey, protocol, secret }) {
  const record = cache.get(streamKey);

  if (record) {
    if (record.enabled === false) {
      return { allowed: false, reason: 'stream key is disabled', record, degraded: false };
    }

    // -------------------------------------------------------------------------
    // Protocol restriction ('SRT' | 'RTMP' | 'ANY' on the record).
    //
    // IMPORTANT: SRS's on_publish callback does NOT tell us which transport the
    // publisher used - it normalises SRT and RTMP into an identical payload. So
    // at this point `protocol` is almost always the literal string 'unknown'.
    //
    // Rejecting on a mismatch here would reject EVERY protocol-restricted key,
    // always, because 'unknown' never equals 'SRT' or 'RTMP'. Instead we defer:
    // the caller records `enforceProtocol`, and the poller enforces it one tick
    // later once the SRS client list reveals the real transport
    // (see state.updatePublisherTransport).
    // -------------------------------------------------------------------------
    const allowedProtocol = (record.protocol || 'ANY').toUpperCase();
    const claimed = String(protocol || 'unknown').toUpperCase();
    const protocolKnown = claimed === 'SRT' || claimed === 'RTMP';

    if (allowedProtocol !== 'ANY' && protocolKnown && allowedProtocol !== claimed) {
      return {
        allowed: false,
        reason: `stream key is registered for ${allowedProtocol}, not ${claimed}`,
        record,
        degraded: false,
      };
    }
    // Optional second factor: a token the publisher must send as a query
    // parameter in addition to knowing the stream key.
    if (record.secret) {
      if (!secret || !timingSafeEqual(String(secret), String(record.secret))) {
        return { allowed: false, reason: 'stream secret missing or incorrect', record, degraded: false };
      }
    }

    return {
      allowed: true,
      reason: 'registered stream key',
      record,
      degraded: false,
      // Null when the key permits any protocol, or when the restriction was
      // already checked above. Otherwise the poller must enforce it once the
      // real transport is known.
      enforceProtocol: allowedProtocol !== 'ANY' && !protocolKnown ? allowedProtocol : null,
    };
  }

  // Not in the cache. Two very different situations:
  //  (a) The cache is warm and simply doesn't contain this key -> genuine reject.
  //  (b) We have never successfully loaded the registry (cold start during a
  //      Supabase outage) -> AUTH_FAILURE_MODE decides.
  if (status.loadedOk) {
    return { allowed: false, reason: 'stream key is not registered', record: null, degraded: false };
  }

  if (config.auth.failureMode === 'closed') {
    return {
      allowed: false,
      reason: 'registry unavailable and AUTH_FAILURE_MODE=closed',
      record: null,
      degraded: true,
    };
  }

  return {
    allowed: true,
    reason: 'registry unavailable, AUTH_FAILURE_MODE=open - admitted unverified',
    record: null,
    degraded: true,
  };
}

/**
 * Constant-time string comparison so an attacker cannot recover a secret by
 * measuring how long a rejection takes.
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// -----------------------------------------------------------------------------
// CRUD - writes go to Supabase and are mirrored into the cache immediately so a
// key added from the dashboard works on the very next publish attempt.
// -----------------------------------------------------------------------------

export async function addKey(record) {
  const res = await insertStreamKey(record);
  if (res.ok && res.data) {
    cache.set(res.data.stream_key, res.data);
    status.count = cache.size;
    log.info('stream key registered', {
      event: 'stream_key_added',
      stream_key: res.data.stream_key,
      protocol: res.data.protocol,
      label: res.data.label,
    });
  }
  return res;
}

export async function editKey(id, patch) {
  const res = await updateStreamKey(id, patch);
  if (res.ok && res.data) {
    // The key itself may have changed - drop the stale entry first.
    for (const [k, v] of cache.entries()) if (v.id === id) cache.delete(k);
    cache.set(res.data.stream_key, res.data);
    status.count = cache.size;
    log.info('stream key updated', { event: 'stream_key_updated', stream_key: res.data.stream_key });
  }
  return res;
}

export async function removeKey(id) {
  const res = await deleteStreamKey(id);
  if (res.ok) {
    for (const [k, v] of cache.entries()) if (v.id === id) cache.delete(k);
    status.count = cache.size;
    log.info('stream key removed', { event: 'stream_key_removed', id });
  }
  return res;
}

/** Registry contents with the `secret` column stripped - safe for the dashboard. */
export function listKeysRedacted() {
  return [...cache.values()].map((r) => ({
    id: r.id,
    stream_key: r.stream_key,
    label: r.label,
    protocol: r.protocol,
    enabled: r.enabled,
    has_secret: Boolean(r.secret),
    notes: r.notes,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

export function registryStatus() {
  // `mode` separates "Supabase is not configured at all" from "configured but
  // currently unreachable". Both leave loadedOk false, so without this an
  // install with no Supabase looked permanently mid-outage.
  const mode = !supabaseEnabled ? 'disabled' : (status.loadedOk ? 'loaded' : 'unavailable');
  return {
    ...status, mode, cached_keys: cache.size, auth_failure_mode: config.auth.failureMode,
  };
}

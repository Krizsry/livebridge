/**
 * Live Bridge - Supabase data layer (BACKEND ONLY).
 *
 * Requirements 17-21 and project rules 25-29 in one place:
 *   - Service-role key, used only here. The frontend never talks to Supabase.
 *   - Supabase is metadata and logs only. No media ever passes through it.
 *   - A Supabase outage must NEVER take down SRT/RTMP ingest. Every call is
 *     wrapped in a timeout + circuit breaker and returns a degraded result
 *     instead of throwing, so an on_publish hook can always answer immediately.
 *
 * Degradation contract: every function here returns
 *     { ok: true,  data }      on success
 *     { ok: false, error, degraded: true }   when Supabase is unavailable
 * Callers must handle `ok: false` without failing the request.
 */

import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('supabase');

let client = null;

if (config.supabase.enabled && config.supabase.url && config.supabase.serviceRoleKey) {
  client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: {
      // This is a server process, not a user session: never persist or refresh
      // tokens, and never try to read a session from storage.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { 'x-application-name': 'livebridge-backend' },
    },
  });
  log.info('supabase client initialised', { url: config.supabase.url });
} else {
  log.warn('supabase disabled or not configured - history and persisted config unavailable', {
    enabled: config.supabase.enabled,
    has_url: Boolean(config.supabase.url),
    has_key: Boolean(config.supabase.serviceRoleKey),
  });
}

// -----------------------------------------------------------------------------
// Circuit breaker
// -----------------------------------------------------------------------------
// After N consecutive failures the breaker opens and every call short-circuits
// for a cooldown period. Without this, a Supabase outage means every hook and
// every poll tick pays a full timeout, which is exactly how a metadata outage
// turns into an ingest outage.
// -----------------------------------------------------------------------------
const breaker = {
  consecutiveFailures: 0,
  openUntil: 0,
  get isOpen() {
    return Date.now() < this.openUntil;
  },
  recordSuccess() {
    if (this.consecutiveFailures > 0 || this.openUntil !== 0) {
      log.info('supabase recovered', { after_failures: this.consecutiveFailures });
    }
    this.consecutiveFailures = 0;
    this.openUntil = 0;
  },
  recordFailure(reason) {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= config.supabase.breakerThreshold && !this.isOpen) {
      this.openUntil = Date.now() + config.supabase.breakerCooldownSec * 1000;
      log.error('supabase circuit breaker opened - degrading gracefully', {
        consecutive_failures: this.consecutiveFailures,
        cooldown_sec: config.supabase.breakerCooldownSec,
        reason,
      });
    }
  },
};

/** Current health, surfaced to the dashboard so it can show "history unavailable". */
export function supabaseHealth() {
  return {
    configured: Boolean(client),
    available: Boolean(client) && !breaker.isOpen,
    breaker_open: breaker.isOpen,
    consecutive_failures: breaker.consecutiveFailures,
    retry_in_sec: breaker.isOpen ? Math.ceil((breaker.openUntil - Date.now()) / 1000) : 0,
  };
}

const degraded = (error) => ({ ok: false, error, degraded: true, data: null });

/**
 * SQLSTATE classes that genuinely indicate the database could not be reached or
 * served the request. Everything else with a code is the database rejecting a
 * bad request, which says nothing about availability. See run().
 */
const TRANSPORT_SQLSTATE_PREFIXES = ['08', '53', '57', '58'];

/**
 * Run a Supabase query with a hard timeout and breaker accounting.
 * `fn` receives the client and must return a PostgREST thenable.
 */
async function run(label, fn) {
  if (!client) return degraded('supabase not configured');
  if (breaker.isOpen) return degraded('supabase circuit breaker open');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.supabase.timeoutMs);

  try {
    const result = await Promise.race([
      fn(client),
      new Promise((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new Error(`supabase timeout after ${config.supabase.timeoutMs}ms`));
        });
      }),
    ]);

    if (result?.error) {
      // Separate "the request was bad" from "Supabase is unreachable".
      //
      // PostgREST reports Postgres SQLSTATEs in `code` - 23505 duplicate key,
      // 23514 check violation, 42501 permission denied. Those prove the round
      // trip WORKED and the database said no. Counting them as breaker failures
      // meant three duplicate-key POSTs in a row opened the circuit for 30 s and
      // took out history, registry refresh and the entire write queue - a user
      // clicking "Add stream key" three times could disable the data layer.
      //
      // Only the connection-exception SQLSTATE classes (08 = connection, 53 =
      // insufficient resources, 57 = operator intervention, 58 = system error)
      // and errors with no code at all (network/abort) count against it.
      const code = result.error.code || null;
      const transport = !code || TRANSPORT_SQLSTATE_PREFIXES.some((p) => String(code).startsWith(p));

      if (transport) breaker.recordFailure(result.error.message);
      else breaker.recordSuccess(); // the connection is demonstrably fine

      log[transport ? 'error' : 'warn']('supabase query failed', {
        query: label, detail: result.error.message, code, app_error: !transport,
      });

      return {
        ok: false,
        error: result.error.message,
        code,
        appError: !transport,
        degraded: transport,
        data: null,
      };
    }

    breaker.recordSuccess();
    return { ok: true, data: result?.data ?? null, degraded: false };
  } catch (err) {
    breaker.recordFailure(err.message);
    log.error('supabase query threw', { query: label, detail: err.message });
    return degraded(err.message);
  } finally {
    clearTimeout(timer);
  }
}

// =============================================================================
// stream_keys - the registry of authorised stream IDs / stream keys
// =============================================================================

export async function fetchStreamKeys() {
  return run('fetchStreamKeys', (c) => c
    .from('stream_keys')
    .select('id, stream_key, label, protocol, enabled, secret, notes, created_at, updated_at')
    .order('created_at', { ascending: false }));
}

export async function insertStreamKey(record) {
  return run('insertStreamKey', (c) => c
    .from('stream_keys')
    .insert(record)
    .select()
    .single());
}

export async function updateStreamKey(id, patch) {
  return run('updateStreamKey', (c) => c
    .from('stream_keys')
    .update(patch)
    .eq('id', id)
    .select()
    .single());
}

export async function deleteStreamKey(id) {
  return run('deleteStreamKey', (c) => c
    .from('stream_keys')
    .delete()
    .eq('id', id));
}

// =============================================================================
// stream_sessions - historical log of past publisher sessions
// =============================================================================

export async function insertSession(record) {
  return run('insertSession', (c) => c
    .from('stream_sessions')
    .insert(record)
    .select('id')
    .single());
}

export async function closeSession(id, patch) {
  return run('closeSession', (c) => c
    .from('stream_sessions')
    .update(patch)
    .eq('id', id));
}

/** Patch an open session row in place (transport backfill, etc.). */
export async function updateSession(id, patch) {
  return run('updateSession', (c) => c
    .from('stream_sessions')
    .update(patch)
    .eq('id', id));
}

/**
 * Close session rows left open by a previous backend process.
 *
 * Live state is in-memory only, so a backend restart loses every session_id it
 * was holding. The matching Supabase rows keep `ended_at IS NULL` forever and
 * the dashboard renders them as "live" indefinitely - which is how three ghost
 * sessions accumulated for the same stream in one afternoon of restarts.
 *
 * We can safely close all of them at boot: this process has just started with
 * empty state, so by definition it owns no open session. A publisher that is
 * still connected gets a fresh row from its next on_publish, and SRS re-fires
 * that hook on reconnect.
 *
 * `end_reason` records why, so these are distinguishable from clean closes.
 */
export async function closeOrphanedSessions() {
  return run('closeOrphanedSessions', (c) => c
    .from('stream_sessions')
    .update({
      ended_at: new Date().toISOString(),
      end_reason: 'orphaned by backend restart',
    })
    .is('ended_at', null)
    .select('id'));
}

export async function fetchSessions({ limit = 100, offset = 0, streamKey = null, protocol = null, since = null } = {}) {
  return run('fetchSessions', (c) => {
    let q = c
      .from('stream_sessions')
      .select('id, stream_key, protocol, connection_mode, source_ip, started_at, ended_at, '
        + 'duration_sec, avg_bitrate_kbps, peak_bitrate_kbps, bytes_received, end_reason')
      .order('started_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (streamKey) q = q.eq('stream_key', streamKey);
    if (protocol) q = q.eq('protocol', protocol);
    if (since) q = q.gte('started_at', since);
    return q;
  });
}

// =============================================================================
// relay_destinations - external RTMP/SRT relay targets
// =============================================================================

export async function fetchDestinations() {
  return run('fetchDestinations', (c) => c
    .from('relay_destinations')
    .select('id, name, platform, source_stream_key, url, dest_stream_key, enabled, '
      + 'transcode, transcode_profile, created_at, updated_at')
    .order('created_at', { ascending: false }));
}

export async function insertDestination(record) {
  return run('insertDestination', (c) => c
    .from('relay_destinations')
    .insert(record)
    .select()
    .single());
}

export async function updateDestination(id, patch) {
  return run('updateDestination', (c) => c
    .from('relay_destinations')
    .update(patch)
    .eq('id', id)
    .select()
    .single());
}

export async function deleteDestination(id) {
  return run('deleteDestination', (c) => c
    .from('relay_destinations')
    .delete()
    .eq('id', id));
}

// =============================================================================
// relay_events + event_log - append-only audit trail
// =============================================================================

export async function insertRelayEvent(record) {
  return run('insertRelayEvent', (c) => c.from('relay_events').insert(record));
}

export async function insertEventLog(records) {
  const rows = Array.isArray(records) ? records : [records];
  return run('insertEventLog', (c) => c.from('event_log').insert(rows));
}

export async function fetchRelayEvents({ limit = 100 } = {}) {
  return run('fetchRelayEvents', (c) => c
    .from('relay_events')
    .select('id, destination_id, source_stream_key, event, detail, created_at')
    .order('created_at', { ascending: false })
    .limit(limit));
}

// =============================================================================
// Bounded, fire-and-forget write queue
// =============================================================================
// Session and event writes must never apply backpressure to the ingest path.
// They go on a bounded queue drained in the background; on overflow we drop the
// OLDEST entries and log it, because losing a metadata row is always preferable
// to stalling a live stream.
// =============================================================================

const writeQueue = [];
let draining = false;
let droppedTotal = 0;

export function enqueueWrite(label, fn) {
  if (!client) return;

  if (writeQueue.length >= config.supabase.writeQueueMax) {
    writeQueue.shift();
    droppedTotal += 1;
    if (droppedTotal % 100 === 1) {
      log.warn('supabase write queue overflow - dropping oldest metadata writes', {
        queue_max: config.supabase.writeQueueMax,
        dropped_total: droppedTotal,
      });
    }
  }

  writeQueue.push({ label, fn });
  if (!draining) drain();
}

async function drain() {
  draining = true;
  while (writeQueue.length > 0) {
    // If the breaker is open, stop draining and retry after the cooldown rather
    // than burning through the whole queue against a dead endpoint.
    if (breaker.isOpen) {
      setTimeout(() => { draining = false; drain(); }, config.supabase.breakerCooldownSec * 1000);
      return;
    }
    const job = writeQueue.shift();
    // Failures are already logged inside run(); a dropped metadata write is
    // deliberately not retried forever.
    await job.fn().catch((err) => {
      log.error('queued supabase write failed', { query: job.label, detail: err.message });
    });
  }
  draining = false;
}

export function writeQueueDepth() {
  return { depth: writeQueue.length, dropped_total: droppedTotal };
}

export const supabaseEnabled = Boolean(client);

/**
 * Live Bridge - configuration.
 *
 * Every value comes from the environment (.env, injected by docker-compose or
 * by the systemd unit's EnvironmentFile). Nothing here is ever sent to the
 * frontend - see src/routes/api.js, which exposes only non-sensitive fields.
 */

import { createLogger } from './logger.js';

const log = createLogger('config');

function str(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    log.warn('invalid integer env var, using fallback', {
      var: name, value: raw, fallback, min, max,
    });
    return fallback;
  }
  return n;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function enumerated(name, allowed, fallback) {
  const v = str(name, fallback);
  if (!allowed.includes(v)) {
    log.warn('invalid enum env var, using fallback', { var: name, value: v, allowed, fallback });
    return fallback;
  }
  return v;
}

export const config = {
  // --- Server ---------------------------------------------------------------
  port: int('BACKEND_PORT', 8000, { min: 1, max: 65535 }),
  logLevel: str('LOG_LEVEL', 'info'),

  // --- Public identity (safe to send to the browser) ------------------------
  publicHost: str('LIVEBRIDGE_PUBLIC_HOST', str('LIVEBRIDGE_HOST', 'localhost')),
  srtPort: int('HOST_SRT_PORT', 9000, { min: 1, max: 65535 }),
  rtmpPort: int('HOST_RTMP_PORT', 1935, { min: 1, max: 65535 }),

  // --- SRS engine (internal network) ---------------------------------------
  srs: {
    apiUrl: str('SRS_API_URL', 'http://livebridge-srs:1985').replace(/\/+$/, ''),
    httpUrl: str('SRS_HTTP_URL', 'http://livebridge-srs:8080').replace(/\/+$/, ''),
    internalRtmp: str('SRS_INTERNAL_RTMP', 'rtmp://livebridge-srs:1935').replace(/\/+$/, ''),
    internalSrtHost: str('SRS_INTERNAL_SRT_HOST', 'livebridge-srs'),
    internalSrtPort: int('SRS_INTERNAL_SRT_PORT', 9000, { min: 1, max: 65535 }),
    timeoutMs: int('SRS_API_TIMEOUT_MS', 3000, { min: 250, max: 30000 }),
  },

  // --- SRT ------------------------------------------------------------------
  srt: {
    // Held only so the backend can build FFmpeg ingest/egress URLs. Never
    // serialised to the frontend and redacted by the logger.
    passphrase: str('SRT_PASSPHRASE', ''),
    pbkeylen: int('SRT_PBKEYLEN', 16, { min: 16, max: 32 }),
    latencyMs: int('SRT_LATENCY_MS', 300, { min: 20, max: 8000 }),
  },

  // --- Live metrics ---------------------------------------------------------
  pollIntervalMs: int('POLL_INTERVAL_MS', 1000, { min: 250, max: 10000 }),
  reconnectGraceSec: int('RECONNECT_GRACE_SEC', 15, { min: 0, max: 600 }),
  // How many 1 s samples to retain per stream for the sparkline / average.
  metricHistoryLength: int('METRIC_HISTORY_LENGTH', 120, { min: 10, max: 3600 }),

  // --- Authorisation --------------------------------------------------------
  auth: {
    /**
     * What happens when a publisher arrives, Supabase is unreachable AND the
     * key cache is empty. `open` honours requirement 21 (Supabase must never
     * take down ingest); `closed` is stricter but will reject a show that
     * starts during a cold-start outage. See PROGRESS.md open questions.
     */
    failureMode: enumerated('AUTH_FAILURE_MODE', ['open', 'closed'], 'open'),
    cacheRefreshSec: int('KEY_CACHE_REFRESH_SEC', 60, { min: 5, max: 3600 }),
  },

  // --- Supabase (backend only) ---------------------------------------------
  supabase: {
    enabled: bool('SUPABASE_ENABLED', true),
    url: str('SUPABASE_URL', ''),
    serviceRoleKey: str('SUPABASE_SERVICE_ROLE_KEY', ''),
    timeoutMs: int('SUPABASE_TIMEOUT_MS', 5000, { min: 500, max: 30000 }),
    breakerCooldownSec: int('SUPABASE_BREAKER_COOLDOWN_SEC', 30, { min: 5, max: 600 }),
    breakerThreshold: int('SUPABASE_BREAKER_THRESHOLD', 3, { min: 1, max: 50 }),
    // Bounded write queue - metadata writes must never apply backpressure to
    // the ingest path.
    writeQueueMax: int('SUPABASE_WRITE_QUEUE_MAX', 1000, { min: 10, max: 100000 }),
  },

  // --- Relay ----------------------------------------------------------------
  relay: {
    ffmpegPath: str('FFMPEG_PATH', 'ffmpeg'),
    maxConcurrent: int('RELAY_MAX_CONCURRENT', 16, { min: 1, max: 256 }),
    backoffMinMs: int('RELAY_BACKOFF_MIN_MS', 1000, { min: 100, max: 60000 }),
    backoffMaxMs: int('RELAY_BACKOFF_MAX_MS', 30000, { min: 1000, max: 600000 }),
  },
};

/**
 * Config that is safe to hand to the browser. Used by GET /api/config so the
 * dashboard can show correct connection strings without hardcoding a hostname.
 * Deliberately contains no keys, no passphrase and no Supabase details.
 */
export const publicConfig = {
  appName: 'Live Bridge',
  publicHost: config.publicHost,
  srtPort: config.srtPort,
  rtmpPort: config.rtmpPort,
  srtLatencyMs: config.srt.latencyMs,
  // Tells the UI whether to show "encryption enabled" - not the value itself.
  srtEncrypted: config.srt.passphrase.length > 0,
  supabaseConfigured: config.supabase.enabled
    && config.supabase.url.length > 0
    && config.supabase.serviceRoleKey.length > 0,
};

/** Log a startup banner and warn about anything obviously misconfigured. */
export function validateConfig() {
  const problems = [];

  if (!config.srt.passphrase) {
    problems.push('SRT_PASSPHRASE is empty - SRT ingest will be unencrypted');
  }
  if (config.supabase.enabled && (!config.supabase.url || !config.supabase.serviceRoleKey)) {
    problems.push('SUPABASE_ENABLED=true but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing '
      + '- history and persisted config will be unavailable (live streaming is unaffected)');
  }
  if (config.relay.backoffMinMs > config.relay.backoffMaxMs) {
    problems.push('RELAY_BACKOFF_MIN_MS exceeds RELAY_BACKOFF_MAX_MS');
  }
  if (config.auth.failureMode === 'open') {
    problems.push('AUTH_FAILURE_MODE=open - if Supabase is down at cold start, unregistered '
      + 'publishers will be admitted (logged at critical). Set to `closed` to reject instead.');
  }

  for (const p of problems) log.warn('configuration warning', { detail: p });

  log.info('configuration loaded', {
    port: config.port,
    public_host: config.publicHost,
    srt_port: config.srtPort,
    rtmp_port: config.rtmpPort,
    poll_interval_ms: config.pollIntervalMs,
    auth_failure_mode: config.auth.failureMode,
    supabase_enabled: publicConfig.supabaseConfigured,
    srt_encrypted: publicConfig.srtEncrypted,
  });

  return problems;
}

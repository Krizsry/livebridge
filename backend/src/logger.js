/**
 * Live Bridge - structured JSON logger.
 *
 * Project rule 9 requires structured JSON logs (not plain text) for stream
 * events on both protocols, relay events, errors and dashboard access.
 *
 * Hand-rolled rather than pulling in pino/winston: rule 14 says don't install
 * dependencies we don't need, and this is ~80 lines.
 *
 * Every record is one line of JSON on stdout (or stderr for error/fatal), which
 * is what `docker logs`, `journalctl` and any log shipper expect.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, critical: 50 };

const configuredLevel = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

/**
 * Keys whose values must never reach the logs. Matched case-insensitively as a
 * substring, so `srt_passphrase`, `SUPABASE_SERVICE_ROLE_KEY`, `stream_secret`
 * and friends are all caught.
 */
const REDACT_PATTERNS = [
  'passphrase',
  'password',
  'secret',
  'service_role',
  'apikey',
  'api_key',
  'authorization',
  'token',
];

function shouldRedact(key) {
  const k = String(key).toLowerCase();
  return REDACT_PATTERNS.some((p) => k.includes(p));
}

/**
 * Stream keys are not secrets in the "never log" sense - we need them to
 * identify streams - but a full RTMP destination URL with an embedded key is.
 * Mask anything that looks like a stream key inside a URL.
 */
function maskUrl(value) {
  if (typeof value !== 'string') return value;
  // rtmp://a.rtmp.youtube.com/live2/xxxx-xxxx-xxxx -> .../live2/****
  return value.replace(
    /^(rtmps?:\/\/[^/]+\/[^/]+\/)(.+)$/i,
    (_m, prefix, key) => `${prefix}${maskTail(key)}`,
  );
}

function maskTail(str) {
  const s = String(str);
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}${'*'.repeat(Math.min(s.length - 4, 12))}${s.slice(-2)}`;
}

function sanitize(value, depth = 0) {
  if (depth > 6) return '[max-depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return maskUrl(value);
  if (typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = shouldRedact(k) ? '[redacted]' : sanitize(v, depth + 1);
  }
  return out;
}

function emit(level, service, msg, fields) {
  if (LEVELS[level] < configuredLevel) return;

  const record = {
    ts: new Date().toISOString(),
    level,
    service,
    msg,
    ...sanitize(fields || {}),
  };

  let line;
  try {
    line = JSON.stringify(record);
  } catch {
    // Circular reference or similar - never let logging throw.
    line = JSON.stringify({
      ts: record.ts,
      level: 'error',
      service,
      msg: 'log serialisation failed',
      original_msg: String(msg),
    });
  }

  if (LEVELS[level] >= LEVELS.error) process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

/**
 * Create a logger bound to a service name, e.g. `createLogger('relay')`.
 * The service name lands in every record so logs can be filtered per subsystem.
 */
export function createLogger(service) {
  return {
    debug: (msg, fields) => emit('debug', service, msg, fields),
    info: (msg, fields) => emit('info', service, msg, fields),
    warn: (msg, fields) => emit('warn', service, msg, fields),
    error: (msg, fields) => emit('error', service, msg, fields),
    /** Reserved for conditions an operator must see, e.g. auth fail-open. */
    critical: (msg, fields) => emit('critical', service, msg, fields),
    child: (sub) => createLogger(`${service}.${sub}`),
  };
}

export const logger = createLogger('livebridge');

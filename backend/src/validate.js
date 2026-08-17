/**
 * Live Bridge - input validation and sanitisation.
 *
 * Project rule 8: every backend endpoint validates and sanitises its input, and
 * nothing is ever concatenated into a shell command or a SQL string.
 *
 * Two defences are in play across the codebase:
 *   1. These validators - reject anything malformed at the edge.
 *   2. Structural safety downstream - FFmpeg is spawned with an argv ARRAY and
 *      no shell, and Supabase is queried through the parameterised client, so
 *      even a validator bug cannot become command or SQL injection.
 *
 * Hand-rolled instead of zod/joi to keep the dependency list to three (rule 14).
 */

export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.statusCode = 400;
  }
}

/**
 * Stream keys / stream IDs. These become URL path segments, HLS filenames and
 * FFmpeg arguments, so the character set is deliberately narrow: alphanumerics,
 * dash, underscore. No dots (path traversal / extension confusion), no slashes,
 * no spaces.
 */
const STREAM_KEY_RE = /^[A-Za-z0-9_-]{3,64}$/;

export function validateStreamKey(value, field = 'stream_key') {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`, field);
  const trimmed = value.trim();
  if (!STREAM_KEY_RE.test(trimmed)) {
    throw new ValidationError(
      `${field} must be 3-64 characters of A-Z a-z 0-9 _ - (no dots, slashes or spaces)`,
      field,
    );
  }
  return trimmed;
}

/** SRS app name, e.g. `live`. Same character class, shorter. */
export function validateApp(value, field = 'app') {
  if (value === undefined || value === null || value === '') return 'live';
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`, field);
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(trimmed)) {
    throw new ValidationError(`${field} must be 1-32 characters of A-Z a-z 0-9 _ -`, field);
  }
  return trimmed;
}

export function validateString(value, field, { min = 1, max = 256, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`${field} is required`, field);
    return null;
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`, field);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new ValidationError(`${field} must be ${min}-${max} characters`, field);
  }
  // Strip control characters - they have no business in any field we store and
  // they are what makes log injection and header smuggling possible.
  // eslint-disable-next-line no-control-regex
  return trimmed.replace(/[\x00-\x1f\x7f]/g, '');
}

export function validateBool(value, field, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (['true', '1', 'yes', 'on'].includes(value.toLowerCase())) return true;
    if (['false', '0', 'no', 'off'].includes(value.toLowerCase())) return false;
  }
  throw new ValidationError(`${field} must be a boolean`, field);
}

export function validateInt(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new ValidationError(`${field} is required`, field);
  }
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(`${field} must be an integer between ${min} and ${max}`, field);
  }
  return n;
}

export function validateEnum(value, field, allowed, fallback) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new ValidationError(`${field} is required`, field);
  }
  if (!allowed.includes(value)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}`, field);
  }
  return value;
}

export function validateUuid(value, field = 'id') {
  if (typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ValidationError(`${field} must be a UUID`, field);
  }
  return value.toLowerCase();
}

/**
 * Outbound relay destination URL (YouTube / Facebook / Twitch / any RTMP or SRT
 * endpoint).
 *
 * Restrictions and why:
 *   - Scheme allowlist: only rtmp/rtmps/srt. Blocks `file:`, `http:`, `pipe:`
 *     and FFmpeg's more exotic protocols being used to read local files.
 *   - No shell metacharacters or whitespace anywhere in the URL.
 *   - Must not begin with `-`, which would let the value be parsed as an
 *     FFmpeg flag rather than a URL.
 */
const ALLOWED_RELAY_SCHEMES = ['rtmp:', 'rtmps:', 'srt:'];

export function validateRelayUrl(value, field = 'url') {
  const raw = validateString(value, field, { min: 8, max: 2048 });

  if (raw.startsWith('-')) {
    throw new ValidationError(`${field} must not start with '-'`, field);
  }
  if (/[\s`$;&|<>\\^'"()]/.test(raw)) {
    throw new ValidationError(`${field} contains characters that are not allowed in a URL`, field);
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationError(`${field} is not a valid URL`, field);
  }

  if (!ALLOWED_RELAY_SCHEMES.includes(parsed.protocol)) {
    throw new ValidationError(
      `${field} must use one of: ${ALLOWED_RELAY_SCHEMES.join(' ')} (got ${parsed.protocol})`,
      field,
    );
  }
  if (!parsed.hostname) {
    throw new ValidationError(`${field} must include a hostname`, field);
  }

  return raw;
}

/**
 * The stream-key portion of a platform destination (e.g. a YouTube key like
 * `abcd-efgh-ijkl-mnop-qrst`). Kept permissive enough for every major platform
 * but still free of separators that could break out of a URL path.
 */
export function validateDestinationKey(value, field = 'stream_key') {
  const raw = validateString(value, field, { min: 1, max: 512, required: false });
  if (raw === null) return null;
  if (!/^[A-Za-z0-9_\-.=?&:/]+$/.test(raw)) {
    throw new ValidationError(
      `${field} contains characters that are not allowed in a platform stream key`,
      field,
    );
  }
  return raw;
}

/** ISO-8601 timestamp used by history range filters. */
export function validateIsoDate(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`${field} is required`, field);
    return null;
  }
  const s = String(value);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new ValidationError(`${field} must be an ISO-8601 timestamp`, field);
  return new Date(t).toISOString();
}

/** IP address as reported by SRS. Stored for display, so validate the shape. */
export function sanitizeIp(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[0-9a-fA-F:.]{3,45}$/.test(trimmed)) return null;
  return trimmed;
}

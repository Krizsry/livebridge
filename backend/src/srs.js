/**
 * Live Bridge - SRS HTTP API client.
 *
 * The backend never reconfigures SRS through this API (raw_api is off in the
 * SRS config) - it only reads live state:
 *   GET /api/v1/streams  - per-stream bitrate, byte counters, uptime, codecs
 *   GET /api/v1/clients  - per-connection protocol, source IP, publish/play role
 *
 * Every call has a hard timeout. If SRS is slow or restarting, the poller
 * degrades to "no data this tick" rather than piling up requests.
 */

import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('srs');

async function get(path) {
  const url = `${config.srs.apiUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.srs.timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`SRS API returned HTTP ${res.status}`);
    }
    const body = await res.json();
    // SRS wraps everything in { code: 0, ... }; non-zero is an application error.
    if (body.code !== undefined && body.code !== 0) {
      throw new Error(`SRS API error code ${body.code}`);
    }
    return { ok: true, data: body };
  } catch (err) {
    const reason = err.name === 'AbortError'
      ? `timeout after ${config.srs.timeoutMs}ms`
      : err.message;
    return { ok: false, error: reason, data: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map an SRS client `type` to our protocol + role vocabulary.
 *
 * SRS type values seen in practice:
 *   fmle-publish / flash-publish / rtmp-publish -> RTMP publisher
 *   flash-play / play / rtmp-play               -> RTMP viewer
 *   srt-publish                                 -> SRT publisher
 *   srt-play                                    -> SRT viewer
 *   hls-play / flv-play / http-play             -> HTTP viewer (browser preview)
 *   rtc-publish / rtc-play                      -> WebRTC (not used here)
 */
export function classifyClient(type = '') {
  const t = String(type).toLowerCase();

  if (t.includes('srt')) {
    return { protocol: 'SRT', role: t.includes('publish') ? 'publisher' : 'viewer' };
  }
  if (t.includes('rtc')) {
    return { protocol: 'WebRTC', role: t.includes('publish') ? 'publisher' : 'viewer' };
  }
  if (t.includes('hls')) return { protocol: 'HLS', role: 'viewer' };
  if (t.includes('flv') || t.includes('http')) return { protocol: 'HTTP-FLV', role: 'viewer' };

  // Everything else on SRS is RTMP.
  return { protocol: 'RTMP', role: t.includes('publish') ? 'publisher' : 'viewer' };
}

export async function fetchStreams() {
  const res = await get('/api/v1/streams/');
  if (!res.ok) return res;
  return { ok: true, data: Array.isArray(res.data.streams) ? res.data.streams : [] };
}

export async function fetchClients() {
  // count=1000 keeps the response bounded on a busy server.
  const res = await get('/api/v1/clients/?count=1000');
  if (!res.ok) return res;
  return { ok: true, data: Array.isArray(res.data.clients) ? res.data.clients : [] };
}

export async function fetchVersion() {
  const res = await get('/api/v1/versions');
  if (!res.ok) return res;
  return { ok: true, data: res.data.data || res.data };
}

/** Used by the /api/health endpoint and the container healthcheck path. */
export async function isHealthy() {
  const res = await fetchVersion();
  if (!res.ok) {
    log.warn('SRS API unreachable', { detail: res.error });
    return { healthy: false, error: res.error, version: null };
  }
  return { healthy: true, error: null, version: res.data?.version ?? null };
}

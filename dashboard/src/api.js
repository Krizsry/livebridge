/**
 * Live Bridge - dashboard API client.
 *
 * Same-origin only: Nginx serves this bundle and proxies /api and /ws to the
 * backend, so there is no API host to configure and no CORS to negotiate.
 *
 * The frontend NEVER talks to Supabase (project rule 25). Everything persisted
 * goes through these endpoints, which hold the service-role key server-side.
 */

const BASE = '/api';

class ApiError extends Error {
  constructor(message, status, field) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.field = field;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Network-level failure - the backend is unreachable, not a bad request.
    throw new ApiError('Backend unreachable', 0);
  }

  if (res.status === 204) return null;

  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { error: text };
  }

  if (!res.ok) {
    throw new ApiError(payload?.error || `Request failed (${res.status})`, res.status, payload?.field);
  }
  return payload;
}

export const api = {
  getConfig: () => request('/config'),
  getHealth: () => request('/health'),
  getStreams: () => request('/streams'),

  // History. Returns { sessions, degraded, reason } - `degraded: true` means
  // Supabase is unreachable and the UI should say so rather than show nothing.
  getSessions: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
    ).toString();
    return request(`/sessions${qs ? `?${qs}` : ''}`);
  },

  getKeys: () => request('/keys'),
  addKey: (payload) => request('/keys', { method: 'POST', body: payload }),
  updateKey: (id, payload) => request(`/keys/${id}`, { method: 'PATCH', body: payload }),
  deleteKey: (id) => request(`/keys/${id}`, { method: 'DELETE' }),

  getDestinations: () => request('/destinations'),
  addDestination: (payload) => request('/destinations', { method: 'POST', body: payload }),
  updateDestination: (id, payload) => request(`/destinations/${id}`, { method: 'PATCH', body: payload }),
  deleteDestination: (id) => request(`/destinations/${id}`, { method: 'DELETE' }),
  startDestination: (id) => request(`/destinations/${id}/start`, { method: 'POST' }),
  stopDestination: (id) => request(`/destinations/${id}/stop`, { method: 'POST' }),

  getRelays: () => request('/relays'),
  getIngest: () => request('/ingest'),
  addIngest: (payload) => request('/ingest', { method: 'POST', body: payload }),
  stopIngest: (id) => request(`/ingest/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

export { ApiError };

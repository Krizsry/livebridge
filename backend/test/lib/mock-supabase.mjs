/**
 * Live Bridge - mock PostgREST endpoint standing in for Supabase.
 *
 * Why a fake HTTP endpoint instead of stubbing `src/supabase.js`: the two things
 * under test here are (a) how `run()` classifies a PostgREST error into
 * appError vs transport, and (b) whether that classification reaches the HTTP
 * status the dashboard sees. Both live in the seam between supabase-js and our
 * code, so replacing supabase-js would test nothing. Pointing SUPABASE_URL at
 * this server exercises the real client, the real `run()` and the real route.
 *
 * Supported surface (all supabase-js needs for this backend):
 *   GET    /rest/v1/<table>?select=...      -> select
 *   POST   /rest/v1/<table>?select=...      -> insert  (Prefer: return=representation)
 *   PATCH  /rest/v1/<table>?<filters>       -> update
 *   DELETE /rest/v1/<table>?<filters>       -> delete
 * `.single()` sends Accept: application/vnd.pgrst.object+json and expects a bare
 * object rather than an array; that is honoured below.
 */

import http from 'node:http';

/** PostgREST's error body shape. supabase-js copies `code` onto error.code. */
export function pgError(code, message, status) {
  return {
    status,
    body: {
      code,
      message,
      details: null,
      hint: null,
    },
  };
}

/** A duplicate-key rejection: proves the round trip WORKED and the DB said no. */
export const DUPLICATE_KEY = () => pgError(
  '23505',
  'duplicate key value violates unique constraint "stream_keys_stream_key_key"',
  409,
);

/** A check-constraint rejection - also an application error, not an outage. */
export const CHECK_VIOLATION = () => pgError(
  '23514',
  'new row for relation "stream_keys" violates check constraint "protocol_valid"',
  400,
);

/** SQLSTATE class 08 - a genuine connection failure. This one must trip the breaker. */
export const CONNECTION_FAILURE = () => pgError(
  '08006',
  'connection failure',
  503,
);

export async function startMockSupabase(port) {
  /** method:table -> handler({ query, body, headers }) => {status, body, delayMs} */
  const handlers = new Map();
  const requests = [];

  const key = (method, table) => `${method.toUpperCase()}:${table}`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const table = url.pathname.replace(/^\/rest\/v1\//, '');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let body = null;
      const raw = Buffer.concat(chunks).toString();
      if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }

      const record = {
        method: req.method,
        table,
        query: url.search,
        body,
        at: Date.now(),
      };
      requests.push(record);

      const handler = handlers.get(key(req.method, table)) || handlers.get(key(req.method, '*'));
      let result = handler
        ? await handler({ query: url.searchParams, body, headers: req.headers })
        : { status: 200, body: [] };
      if (!result) result = { status: 200, body: [] };

      if (result.delayMs) await new Promise((r) => setTimeout(r, result.delayMs));

      let payload = result.body;
      // `.single()` asks for one object, not an array of one.
      const wantsObject = String(req.headers.accept || '').includes('pgrst.object+json');
      if (wantsObject && Array.isArray(payload)) payload = payload[0] ?? null;
      if (!wantsObject && result.status < 300 && payload !== null && !Array.isArray(payload)) {
        payload = [payload];
      }

      res.statusCode = result.status ?? 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload ?? null));
    });
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    /** Register a responder. `table` may be '*' to catch every table. */
    on(method, table, handler) {
      handlers.set(key(method, table), handler);
      return this;
    },
    /** Requests matching a method/table, in arrival order. */
    seen(method, table) {
      return requests.filter(
        (r) => r.method === method.toUpperCase() && (table === '*' || r.table === table),
      );
    },
    reset() {
      requests.length = 0;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

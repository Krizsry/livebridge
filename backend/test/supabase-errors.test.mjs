/**
 * Live Bridge - Supabase error classification.
 *
 * Two linked bugs:
 *   #3  Ordinary query errors tripped the circuit breaker. A duplicate-key
 *       rejection proves the round trip WORKED and the database said no, but it
 *       was counted as a failure - so an operator clicking "Add stream key"
 *       three times opened the breaker for 30 s and took out history, registry
 *       refresh and the whole write queue.
 *   #4  That same duplicate came back as `503 Supabase is unreachable` with
 *       `degraded: true`, sending the operator to look at an outage that did not
 *       exist. It should be a 409.
 *
 * Runs the real supabase-js client against a mock PostgREST, so the seam under
 * test - PostgREST error body -> run() classification -> HTTP status - is
 * exercised end to end rather than stubbed.
 */

import { createHarness, waitFor } from './lib/harness.mjs';
import { startBackend } from './lib/backend.mjs';
import { startMockSrs } from './lib/mock-srs.mjs';
import {
  startMockSupabase, DUPLICATE_KEY, CHECK_VIOLATION, CONNECTION_FAILURE,
} from './lib/mock-supabase.mjs';

const { ok, section, finish } = createHarness('supabase-errors');

const srs = await startMockSrs(11987);
const pg = await startMockSupabase(18102);

// The registry loads at boot and refreshes periodically; keep it quiet.
pg.on('GET', 'stream_keys', () => ({ status: 200, body: [] }));

const backend = await startBackend({
  SRS_API_URL: srs.url,
  SUPABASE_ENABLED: 'true',
  SUPABASE_URL: pg.url,
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key-not-a-real-one',
  SUPABASE_BREAKER_THRESHOLD: '3',
  SUPABASE_BREAKER_COOLDOWN_SEC: '30',
  POLL_INTERVAL_MS: '500',
  SRT_PASSPHRASE: 'supabaseerrortestpass',
}, { port: 18002 });

const newKey = (overrides = {}) => ({
  stream_key: 'studio_a',
  label: 'Studio A',
  protocol: 'ANY',
  ...overrides,
});

const health = async () => (await backend.json('/api/health')).body;

try {
  section('a duplicate stream key is a CLIENT error, not an outage (#4)');
  pg.on('POST', 'stream_keys', () => DUPLICATE_KEY());

  const dupes = [];
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    dupes.push(await backend.post('/api/keys', newKey()));
  }

  ok('every duplicate POST returns 409', dupes.every((d) => d.status === 409),
    `-> ${dupes.map((d) => d.status).join(',')}`);
  ok('the SQLSTATE is surfaced', dupes[0].body?.code === '23505', `-> ${dupes[0].body?.code}`);
  ok('the message says "already taken", not "unreachable"',
    /already taken/i.test(String(dupes[0].body?.error))
      && !/unreachable/i.test(String(dupes[0].body?.error)),
    `-> ${dupes[0].body?.error}`);
  ok('it is NOT flagged as a degraded/outage response',
    dupes.every((d) => d.body?.degraded !== true));

  section('three duplicates must NOT open the circuit breaker (#3)');
  {
    const h = await health();
    ok('breaker stayed closed', h?.supabase?.breaker_open === false,
      `-> ${JSON.stringify(h?.supabase)}`);
    ok('consecutive failure count is zero - the connection is demonstrably fine',
      h?.supabase?.consecutive_failures === 0, `-> ${h?.supabase?.consecutive_failures}`);
    ok('supabase still reports itself available', h?.supabase?.available === true);
  }

  section('other application errors map to 400, still without the breaker');
  pg.on('POST', 'stream_keys', () => CHECK_VIOLATION());
  {
    const res = await backend.post('/api/keys', newKey({ stream_key: 'studio_b' }));
    ok('a check-constraint violation is a 400', res.status === 400, `-> ${res.status}`);
    ok('the SQLSTATE is surfaced', res.body?.code === '23514', `-> ${res.body?.code}`);
    const h = await health();
    ok('breaker still closed', h?.supabase?.breaker_open === false);
  }

  section('the success path still works');
  pg.on('POST', 'stream_keys', ({ body }) => ({
    status: 201,
    body: {
      id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...body,
    },
  }));
  {
    const res = await backend.post('/api/keys', newKey({
      stream_key: 'studio_c', label: 'Studio C', secret: 'a-long-enough-secret',
    }));
    ok('a valid key is created', res.status === 201, `-> ${res.status} ${JSON.stringify(res.body)}`);
    ok('the secret is never echoed back',
      res.body?.key?.secret === undefined && res.body?.key?.has_secret === true,
      `-> ${JSON.stringify(res.body?.key)}`);

    const list = await backend.json('/api/keys');
    ok('the key is cached into the registry immediately',
      list.body?.keys?.some((k) => k.stream_key === 'studio_c'));
    ok('the registry listing carries no secrets',
      !JSON.stringify(list.body?.keys).includes('a-long-enough-secret'));
    ok('registry reports mode=loaded when Supabase is configured and answering',
      list.body?.registry?.mode === 'loaded', `-> ${list.body?.registry?.mode}`);
  }

  section('a REAL transport failure does trip the breaker (#3, the other half)');
  pg.on('POST', 'stream_keys', () => CONNECTION_FAILURE());
  {
    const results = [];
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await backend.post('/api/keys', newKey({ stream_key: 'studio_d' })));
    }
    ok('a connection-class SQLSTATE answers 503', results.every((r) => r.status === 503),
      `-> ${results.map((r) => r.status).join(',')}`);
    ok('and IS flagged degraded', results.every((r) => r.body?.degraded === true));

    const opened = await waitFor(async () => (await health())?.supabase?.breaker_open === true,
      { timeoutMs: 3000 });
    ok('the breaker opened after the threshold', opened);

    const before = pg.seen('POST', 'stream_keys').length;
    const shortCircuit = await backend.post('/api/keys', newKey({ stream_key: 'studio_e' }));
    const after = pg.seen('POST', 'stream_keys').length;
    ok('further calls short-circuit instead of paying a timeout each',
      after === before, `-> ${before} then ${after} requests reached the mock`);
    ok('the short-circuited call still answers, degraded', shortCircuit.status === 503);
  }

  section('ingest is never gated on any of this (requirement 21)');
  {
    const h = await health();
    ok('health is still 200 with the breaker open', Boolean(h));
    ok('SRS reachability is reported independently of Supabase',
      h?.engine?.srs_reachable === true, `-> ${JSON.stringify(h?.engine)}`);
    // `studio_c` was registered before the outage and is served from the
    // in-memory cache. That cache is the whole point: admission must not need a
    // round trip, so an open breaker cannot keep a legitimate publisher out.
    const pub = await backend.publish({
      stream: 'studio_c', param: '?secret=a-long-enough-secret',
    });
    ok('a publisher registered before the outage is still admitted from cache',
      String(pub.body).trim() === '0', `-> ${pub.body}`);
  }

  section('no secret reached the logs');
  ok('the service role key never appears in a log line',
    !backend.logText().includes('test-service-role-key-not-a-real-one'));
  ok('the SRT passphrase never appears in a log line',
    !backend.logText().includes('supabaseerrortestpass'));
} finally {
  await backend.stop();
  await pg.close();
  await srs.close();
}

finish();

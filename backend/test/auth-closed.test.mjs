/**
 * Live Bridge - AUTH_FAILURE_MODE=closed.
 *
 * Verifies that with the stream-key registry never loaded (cold start during a
 * Supabase outage) publishers are REJECTED, and - just as important - that SRS
 * is never left waiting for the answer. SRS treats a slow callback as a
 * rejection, so a hook that blocks on Supabase would break ingest even when the
 * decision would have been "allow".
 *
 * The default is `open` (requirement 21: a metadata outage must never take down
 * ingest). This suite is the proof that the strict alternative works for
 * operators who prefer to drop ingest over admitting an unregistered publisher.
 */

import { createHarness } from './lib/harness.mjs';
import { startBackend } from './lib/backend.mjs';
import { startMockSrs } from './lib/mock-srs.mjs';

const { ok, section, finish } = createHarness('auth-closed');

const srs = await startMockSrs(11986);

const backend = await startBackend({
  SRS_API_URL: srs.url,
  SUPABASE_ENABLED: 'false',
  AUTH_FAILURE_MODE: 'closed', // <-- the case under test
  POLL_INTERVAL_MS: '1000',
  SRT_PASSPHRASE: 'closedmodetestpass',
}, { port: 18001 });

try {
  section('AUTH_FAILURE_MODE=closed');

  const t0 = Date.now();
  const res = await backend.publish({ stream: 'unregistered_stream', client_id: 'c1', ip: '203.0.113.7' });
  const elapsed = Date.now() - t0;

  ok('unregistered publisher is REJECTED', String(res.body).trim() === '1',
    `-> body ${JSON.stringify(res.body)}`);
  ok('SRS gets its answer fast (no Supabase wait on the hook path)',
    elapsed < 250, `-> ${elapsed}ms`);

  const streams = await backend.json('/api/streams');
  ok('rejected publisher is NOT added to live state',
    (streams.body?.streams?.length ?? -1) === 0, `-> ${streams.body?.streams?.length}`);

  const events = backend.events();
  const rejection = events.find((e) => e.event === 'publish_rejected');
  ok('rejection is logged as a structured event', Boolean(rejection));
  ok('rejection reason names the closed failure mode',
    String(rejection?.reason || '').includes('closed'), `-> ${rejection?.reason}`);
  ok('no publish_unverified event in closed mode',
    !events.some((e) => e.event === 'publish_unverified'));
  ok('startup warned the operator about the auth mode',
    events.some((e) => e.msg === 'configuration loaded' && e.auth_failure_mode === 'closed'));
  ok('passphrase never appears in logs', !backend.logText().includes('closedmodetestpass'));
} finally {
  await backend.stop();
  await srs.close();
}

finish();

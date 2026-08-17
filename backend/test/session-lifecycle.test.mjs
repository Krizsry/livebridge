/**
 * Live Bridge - session row lifecycle, end to end.
 *
 * state.test.mjs proves the in-memory semantics. This proves the WRITES that
 * follow from them actually reach Supabase, by watching a mock PostgREST:
 *
 *   #5  A stream that ends before its (queued, fire-and-forget) insert lands
 *       must still get its row closed. Previously attachSessionId no-oped on a
 *       reaped record and persistSessionClose bailed on a null session_id, so
 *       the row kept `ended_at NULL` forever and the dashboard rendered it as a
 *       stream that is still live. This is where the ghost rows came from.
 *   #6  A re-publish on a key we still hold live must close the previous
 *       session's row rather than abandoning its id.
 *
 * The happy path is asserted too - a fix that closes rows aggressively would
 * pass #5 and quietly break normal history.
 */

import { createHarness, waitFor, sleep } from './lib/harness.mjs';
import { startBackend } from './lib/backend.mjs';
import {
  startMockSrs, livePublisherFixture, publisherClientFixture,
} from './lib/mock-srs.mjs';
import { startMockSupabase } from './lib/mock-supabase.mjs';

const { ok, section, finish } = createHarness('session-lifecycle');

const srs = await startMockSrs(11988);
const pg = await startMockSupabase(18103);

// The registry loads successfully here, so it is authoritative: an unlisted key
// is refused. Register the keys this suite publishes, with no secret, so the
// admission gate is not what is under test.
const registered = ['normal_close', 'shortlived', 'takeover', 'backfill'].map((stream_key, i) => ({
  id: `00000000-0000-4000-8000-00000000000${i}`,
  stream_key,
  label: stream_key,
  protocol: 'ANY',
  enabled: true,
  secret: null,
  notes: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}));
pg.on('GET', 'stream_keys', () => ({ status: 200, body: registered }));

/** Insert responder: hands out predictable ids, optionally slowly. */
let sessionSeq = 0;
let insertDelayMs = 0;
pg.on('POST', 'stream_sessions', () => {
  sessionSeq += 1;
  return { status: 201, body: { id: `sess-${sessionSeq}` }, delayMs: insertDelayMs };
});

const backend = await startBackend({
  SRS_API_URL: srs.url,
  SUPABASE_ENABLED: 'true',
  SUPABASE_URL: pg.url,
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key-not-a-real-one',
  POLL_INTERVAL_MS: '300',
  RECONNECT_GRACE_SEC: '1',
  SRT_PASSPHRASE: 'sessiontestpassphrase',
}, { port: 18003 });

/** PATCHes targeting one specific session row (ignores the boot-time orphan sweep). */
const patchesFor = (id) => pg.seen('PATCH', 'stream_sessions')
  .filter((r) => r.query.includes(`id=eq.${id}`));

/**
 * The CLOSING patch for a row. A single row can be patched more than once - the
 * poller backfills protocol/connection_mode as soon as the transport is
 * identified - so "the first patch" is not the same thing as "the close".
 */
const closePatchFor = (id) => patchesFor(id).find((r) => r.body?.end_reason !== undefined);

const liveKeys = async () => {
  const res = await backend.json('/api/streams');
  return (res.body?.streams ?? []).map((s) => s.stream_key);
};

try {
  section('boot');
  {
    // Rows left open by a previous process are closed at startup; without it a
    // restart leaves them reading as "live" forever.
    const sweep = await waitFor(() => pg.seen('PATCH', 'stream_sessions')
      .some((r) => r.query.includes('ended_at=is.null')), { timeoutMs: 5000 });
    ok('open rows from a previous process are swept at boot', sweep);
    const sweepRow = pg.seen('PATCH', 'stream_sessions')
      .find((r) => r.query.includes('ended_at=is.null'));
    ok('the sweep is distinguishable from a clean close',
      String(sweepRow?.body?.end_reason || '').includes('orphaned'),
      `-> ${sweepRow?.body?.end_reason}`);
  }

  section('happy path: a normal session opens and closes');
  {
    await backend.publish({ stream: 'normal_close', client_id: 'c-normal' });
    const inserted = await waitFor(() => pg.seen('POST', 'stream_sessions').length >= 1);
    ok('a session row is opened on publish', inserted);

    const insert = pg.seen('POST', 'stream_sessions')[0];
    ok('the row records the stream key', insert?.body?.stream_key === 'normal_close');
    ok('protocol is NULL at admission - SRS cannot tell us the transport yet',
      insert?.body?.protocol === null, `-> ${insert?.body?.protocol}`);
    ok('the source IP is captured', insert?.body?.source_ip === '203.0.113.50');

    await sleep(150);
    await backend.unpublish({ stream: 'normal_close' });

    const gone = await waitFor(async () => !(await liveKeys()).includes('normal_close'),
      { timeoutMs: 6000 });
    ok('the stream leaves live state after the grace period', gone);

    const closed = await waitFor(() => patchesFor('sess-1').length >= 1, { timeoutMs: 5000 });
    ok('its row is closed', closed, `-> ${patchesFor('sess-1').length} patches`);

    const patch = patchesFor('sess-1')[0];
    ok('ended_at is written', Boolean(patch?.body?.ended_at));
    ok('a duration is computed', Number.isFinite(patch?.body?.duration_sec),
      `-> ${patch?.body?.duration_sec}`);
    ok('the end reason is the real one, not a fallback',
      patch?.body?.end_reason === 'unpublish', `-> ${patch?.body?.end_reason}`);
  }

  section('#5 - the stream ends BEFORE its insert lands');
  {
    // The insert is queued and fire-and-forget. Make it lose the race on purpose:
    // by the time the id comes back, the record has already been reaped.
    insertDelayMs = 2500;
    const before = pg.seen('PATCH', 'stream_sessions').length;

    await backend.publish({ stream: 'shortlived', client_id: 'c-short' });
    await sleep(100);
    await backend.unpublish({ stream: 'shortlived' });

    const gone = await waitFor(async () => !(await liveKeys()).includes('shortlived'),
      { timeoutMs: 6000 });
    ok('the stream is reaped while its insert is still in flight', gone);
    ok('nothing was closed yet - there was no id to close',
      pg.seen('PATCH', 'stream_sessions').length === before,
      `-> ${pg.seen('PATCH', 'stream_sessions').length} vs ${before}`);

    // Now the insert finally returns sess-2, addressed to a stream that is gone.
    const rescued = await waitFor(() => patchesFor('sess-2').length >= 1, { timeoutMs: 8000 });
    ok('the stranded row is closed anyway rather than left reading as live', rescued,
      `-> ${JSON.stringify(pg.seen('PATCH', 'stream_sessions').map((r) => r.query))}`);

    const patch = patchesFor('sess-2')[0];
    ok('it has an ended_at', Boolean(patch?.body?.ended_at));
    ok('the end reason names the race so these are distinguishable in history',
      /before its session row was created/i.test(String(patch?.body?.end_reason)),
      `-> ${patch?.body?.end_reason}`);
    insertDelayMs = 0;
  }

  section('#6 - a re-publish on a live key closes the previous session');
  {
    // Keep SRS reporting this stream as live for the whole section. Without it
    // the poller's vanish-detection reaps the first publisher before the second
    // arrives, and what looks like a displacement test is really testing a
    // cold start on a free key.
    srs.state.streams = [livePublisherFixture({ id: 'vid-t', name: 'takeover' })];
    srs.state.clients = [publisherClientFixture({
      id: 'pub-t', stream: 'vid-t', name: 'takeover', url: '/live/takeover',
    })];

    await backend.publish({ stream: 'takeover', client_id: 'c-first', ip: '203.0.113.60' });
    const opened = await waitFor(() => pg.seen('POST', 'stream_sessions').length >= 3);
    ok('the first session row is open', opened);
    await sleep(200); // let attachSessionId land

    const firstStartedAt = (await backend.json('/api/streams')).body?.streams
      ?.find((s) => s.stream_key === 'takeover')?.started_at;
    ok('the first publisher is live', Boolean(firstStartedAt));

    await backend.publish({ stream: 'takeover', client_id: 'c-second', ip: '203.0.113.61' });

    const closedOld = await waitFor(() => Boolean(closePatchFor('sess-3')), { timeoutMs: 5000 });
    ok('the displaced session row is closed, not abandoned', closedOld,
      `-> patches ${JSON.stringify(patchesFor('sess-3').map((r) => Object.keys(r.body || {})))}`);
    ok('the end reason records the takeover',
      /replaced by a new publisher/i.test(String(closePatchFor('sess-3')?.body?.end_reason)),
      `-> ${closePatchFor('sess-3')?.body?.end_reason}`);
    ok('the closed row carries its final metrics',
      Number.isFinite(closePatchFor('sess-3')?.body?.bytes_received),
      `-> ${JSON.stringify(closePatchFor('sess-3')?.body)}`);

    const reopened = await waitFor(() => pg.seen('POST', 'stream_sessions').length >= 4,
      { timeoutMs: 5000 });
    ok('a fresh row is opened for the new publisher', reopened);

    const streams = (await backend.json('/api/streams')).body?.streams ?? [];
    const takeover = streams.filter((s) => s.stream_key === 'takeover');
    ok('exactly one live record is held for the key', takeover.length === 1,
      `-> ${takeover.length}`);
    // NOTE: source_ip is deliberately NOT asserted here. The poller overwrites it
    // from the SRS client list every tick, and SRS is the authority on who is
    // actually connected - the hook's `ip` field is only the first guess.
    ok('the live record is the new session, not the displaced one',
      takeover[0]?.started_at !== firstStartedAt && takeover[0]?.reconnect_count === 0,
      `-> ${takeover[0]?.started_at} vs ${firstStartedAt}`);
  }

  section('#29 - the transport backfill must not lose the race with its own insert');
  {
    // The setup IS the bug. Two facts have to meet before the history row can
    // record how the publisher connected:
    //   - the transport, known from the SRS client list on the first poll tick;
    //   - the session_id, returned by a queued insert we deliberately do not wait for.
    // Delay the insert so the transport is identified FIRST. The original code
    // fired the backfill exactly once, on the identifying tick, found session_id
    // still null and gave up - so protocol and connection_mode stayed blank.
    insertDelayMs = 1500;
    srs.state.streams = [livePublisherFixture({ id: 'vid-b', name: 'backfill' })];
    srs.state.clients = [publisherClientFixture({
      id: 'pub-b', stream: 'vid-b', name: 'backfill', url: '/live/backfill', ip: '203.0.113.70',
    })];

    const seqBefore = sessionSeq;
    await backend.publish({ stream: 'backfill', client_id: 'c-backfill' });

    const identified = await waitFor(async () => {
      const s = (await backend.json('/api/streams')).body?.streams
        ?.find((x) => x.stream_key === 'backfill');
      return s?.protocol === 'SRT';
    }, { timeoutMs: 5000 });
    ok('the transport is identified while the insert is still in flight', identified);

    const rowId = `sess-${seqBefore + 1}`;
    // The mock has RECEIVED the insert (so the id is allocated) but has not
    // ANSWERED it, so the backend cannot know the id yet. That is precisely the
    // window in which the old code fired its one and only backfill attempt.
    ok('nothing has been backfilled at the moment of identification',
      patchesFor(rowId).length === 0, `-> ${patchesFor(rowId).length} patches already`);
    const backfilled = await waitFor(
      () => patchesFor(rowId).some((r) => r.body?.protocol === 'SRT'),
      { timeoutMs: 8000 },
    );
    ok('the backfill still lands once the id arrives', backfilled,
      `-> ${JSON.stringify(patchesFor(rowId).map((r) => r.body))}`);

    const patch = patchesFor(rowId).find((r) => r.body?.protocol === 'SRT');
    ok('connection mode is written too', patch?.body?.connection_mode === 'listener',
      `-> ${patch?.body?.connection_mode}`);
    ok('the source IP is corrected to what SRS actually reports',
      patch?.body?.source_ip === '203.0.113.70', `-> ${patch?.body?.source_ip}`);

    await sleep(1200); // several more poll ticks
    ok('it is written exactly ONCE, not on every subsequent tick',
      patchesFor(rowId).filter((r) => r.body?.protocol !== undefined).length === 1,
      `-> ${patchesFor(rowId).filter((r) => r.body?.protocol !== undefined).length} backfills`);

    insertDelayMs = 0;
    srs.state.streams = [];
    srs.state.clients = [];
  }

  section('no secret reached the logs');
  ok('the service role key never appears in a log line',
    !backend.logText().includes('test-service-role-key-not-a-real-one'));
  ok('the SRT passphrase never appears in a log line',
    !backend.logText().includes('sessiontestpassphrase'));
} finally {
  await backend.stop();
  await pg.close();
  await srs.close();
}

finish();

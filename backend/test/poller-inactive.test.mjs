/**
 * Live Bridge - the poller must not resurrect a finished stream (#1).
 *
 * The hypothesis behind the fix: SRS keeps a stream object in /api/v1/streams
 * after the publisher leaves, with `publish.active: false`. Folding those in as
 * live flipped a record that on_unpublish had moved to `reconnecting` straight
 * back to `online` on the very next tick, so reapStaleStreams() never fired, the
 * relay was never stopped and the Supabase session row was never closed.
 *
 * HONESTY NOTE, carried over from BUGFIX_PLAN.md §2 #1: against the real SRS
 * 6.0.191 container the failure was NOT reproduced - SRS removed the stream
 * object entirely on unpublish rather than keeping it inactive. So the guard is
 * defence against a payload we have not observed in the wild. This suite pins
 * BOTH shapes: the inactive-entry payload the guard targets, and the
 * disappears-entirely payload real SRS actually produced. If a future SRS
 * version switches between them, neither case regresses silently.
 *
 * The positive control matters as much as the fix: a guard that is too eager
 * would reap LIVE streams, which is far worse than the bug it replaces.
 */

import { createHarness, waitFor, sleep } from './lib/harness.mjs';
import { startBackend } from './lib/backend.mjs';
import {
  startMockSrs, livePublisherFixture, publisherClientFixture,
} from './lib/mock-srs.mjs';

const { ok, section, finish } = createHarness('poller-inactive');

const srs = await startMockSrs(11989);

const backend = await startBackend({
  SRS_API_URL: srs.url,
  POLL_INTERVAL_MS: '300',
  RECONNECT_GRACE_SEC: '3',
  SRT_PASSPHRASE: 'pollertestpassphrase',
}, { port: 18004 });

const streamState = async (key) => {
  const res = await backend.json('/api/streams');
  return (res.body?.streams ?? []).find((s) => s.stream_key === key) || null;
};

try {
  section('positive control: an ACTIVE stream stays online');
  await backend.publish({ stream: 'ghost', client_id: 'pub-g' });
  srs.state.streams = [livePublisherFixture({
    id: 'vid-g', name: 'ghost', recv_bytes: 5_000_000, publish: { active: true, cid: 'pub-g' },
  })];
  srs.state.clients = [publisherClientFixture({
    id: 'pub-g', stream: 'vid-g', name: 'ghost', url: '/live/ghost', alive: 12,
  })];

  // Wait for the poller to have FOLDED a tick, not merely for the hook to have
  // set status='online' - publisherConnected does that synchronously, so waiting
  // on status alone races ahead of the data being asserted below.
  const folded = await waitFor(async () => (await streamState('ghost'))?.protocol === 'SRT');
  ok('the publisher is tracked and a poll tick has been folded in', folded);
  ok('status is online', (await streamState('ghost'))?.status === 'online');
  {
    const s = await streamState('ghost');
    ok('connection mode inferred from the transport', s?.connection_mode === 'listener',
      `-> ${s?.connection_mode}`);
    ok('metrics are folded from the active entry',
      s?.metrics?.bytes_received === 5_000_000, `-> ${s?.metrics?.bytes_received}`);
    ok('uptime comes from the client list alive figure',
      s?.metrics?.uptime_sec === 12, `-> ${s?.metrics?.uptime_sec}`);
  }

  await sleep(1200); // several ticks
  ok('and it is STILL online several ticks later - the guard does not over-reap',
    (await streamState('ghost'))?.status === 'online');

  section('SRS keeps the object but marks publish.active false');
  {
    // The exact payload the guard targets. Absurd numbers so any accidental fold
    // is unmistakable rather than a subtle drift.
    srs.state.streams = [livePublisherFixture({
      id: 'vid-g',
      name: 'ghost',
      recv_bytes: 999_999_999,
      kbps: { recv_30s: 99_999, send_30s: 0 },
      publish: { active: false, cid: 'pub-g' },
    })];
    srs.state.clients = [];

    const flipped = await waitFor(async () => (await streamState('ghost'))?.status === 'reconnecting',
      { timeoutMs: 5000, intervalMs: 60 });
    ok('the stream is detected as gone despite still being listed', flipped,
      `-> ${(await streamState('ghost'))?.status}`);

    const s = await streamState('ghost');
    ok('the inactive entry did NOT feed metrics',
      s?.metrics?.bytes_received === 5_000_000, `-> ${s?.metrics?.bytes_received}`);
    ok('and did not resurrect the bitrate',
      s?.metrics?.peak_bitrate_kbps !== 99_999, `-> ${s?.metrics?.peak_bitrate_kbps}`);

    const reaped = await waitFor(async () => (await streamState('ghost')) === null,
      { timeoutMs: 8000 });
    ok('it is finalised after the grace period instead of ghosting forever', reaped);
  }

  section('SRS removes the object entirely (what the real container actually did)');
  {
    await backend.publish({ stream: 'vanisher', client_id: 'pub-v' });
    srs.state.streams = [livePublisherFixture({
      id: 'vid-v', name: 'vanisher', publish: { active: true, cid: 'pub-v' },
    })];
    srs.state.clients = [publisherClientFixture({
      id: 'pub-v', stream: 'vid-v', name: 'vanisher', url: '/live/vanisher', alive: 4,
    })];

    ok('it goes online', await waitFor(async () => (await streamState('vanisher'))?.status === 'online'));

    // No on_unpublish at all - this is the hard-kill / network-drop path.
    srs.state.streams = [];
    srs.state.clients = [];

    ok('a vanished publisher is noticed without an on_unpublish hook',
      await waitFor(async () => (await streamState('vanisher'))?.status === 'reconnecting',
        { timeoutMs: 5000, intervalMs: 60 }));
    ok('and is finalised after the grace period',
      await waitFor(async () => (await streamState('vanisher')) === null, { timeoutMs: 8000 }));
  }

  section('a stream we never admitted is never tracked');
  {
    srs.state.streams = [livePublisherFixture({
      id: 'vid-x', name: 'unadmitted', publish: { active: true, cid: 'pub-x' },
    })];
    srs.state.clients = [publisherClientFixture({
      id: 'pub-x', stream: 'vid-x', name: 'unadmitted', url: '/live/unadmitted',
    })];
    await sleep(900);
    ok('SRS listing a stream is not sufficient - on_publish is the only admission point',
      (await streamState('unadmitted')) === null);
  }

  section('logging');
  {
    const events = backend.events();
    ok('going offline is logged as a structured event',
      events.some((e) => e.event === 'stream_offline' && e.stream_key === 'ghost'),
      `-> ${[...new Set(events.map((e) => e.event).filter(Boolean))].join(',')}`);
    ok('the vanish path records WHY it ended',
      events.some((e) => e.event === 'stream_offline' && /vanished/i.test(String(e.end_reason))),
      `-> ${events.filter((e) => e.event === 'stream_offline').map((e) => e.end_reason).join('|')}`);
    ok('the passphrase never appears in a log line',
      !backend.logText().includes('pollertestpassphrase'));
  }
} finally {
  await backend.stop();
  await srs.close();
}

finish();

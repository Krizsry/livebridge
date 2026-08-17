/**
 * Live Bridge - integration test.
 *
 * Boots the REAL backend process against a mock SRS HTTP API and exercises:
 *   - the SRS on_publish authorisation gate (allow + deny paths)
 *   - protocol detection from the SRS client list (SRT vs RTMP)
 *   - the live metrics poll loop
 *   - relay pulls being excluded from the viewer count (#7)
 *   - the WebSocket push channel
 *   - graceful degradation when Supabase is unavailable
 *   - input validation on every write endpoint
 *
 * Promoted from the 2026-08-15 scratchpad harness; the mock SRS moved into
 * test/lib so other suites share it, and the fixtures now carry the real trap
 * that `client.stream` is an object id rather than a stream name.
 */

import { WebSocket } from 'ws';
import { createHarness, sleep, waitFor } from './lib/harness.mjs';
import { startBackend } from './lib/backend.mjs';
import {
  startMockSrs, livePublisherFixture, publisherClientFixture, viewerClientFixture,
} from './lib/mock-srs.mjs';
import { RELAY_PAGE_URL } from '../src/relay.js';

const { ok, section, finish } = createHarness('integration');

const API_PORT = 18000;

const srs = await startMockSrs(11985, {
  streams: [livePublisherFixture()],
  clients: [
    publisherClientFixture(),
    viewerClientFixture(),
    viewerClientFixture({ id: 'view-2', ip: '198.51.100.11', type: 'flash-play', alive: 5 }),
  ],
});

const backend = await startBackend({
  SRS_API_URL: srs.url,
  SRS_INTERNAL_RTMP: 'rtmp://livebridge-srs:1935',
  SUPABASE_ENABLED: 'false',
  AUTH_FAILURE_MODE: 'open',
  POLL_INTERVAL_MS: '400',
  RECONNECT_GRACE_SEC: '1',
  SRT_PASSPHRASE: 'integrationtestpass',
}, { port: API_PORT });

const { json, post } = backend;

try {
  section('health');
  {
    const health = await json('/api/health');
    ok('health returns 200 when SRS is reachable', health.status === 200, `-> ${health.status}`);
    ok('reports the SRS version', health.body?.engine?.srs_version === '6.0.mock');
    ok('reports app name "Live Bridge"', health.body?.app === 'Live Bridge');
    ok('health is NOT gated on Supabase',
      health.status === 200 && health.body?.supabase?.configured === false);
    ok('registry reports mode=disabled, not a permanent outage (#9)',
      health.body?.registry?.mode === 'disabled', `-> ${health.body?.registry?.mode}`);
  }

  section('SRS on_publish gate');
  {
    const goodPub = await post('/api/hooks/srs/publish', {
      action: 'on_publish',
      client_id: 'pub-1',
      ip: '203.0.113.50',
      vhost: '__defaultVhost__',
      app: 'live',
      stream: 'studio_a',
      param: '',
    });
    ok('allows a publisher (fail-open, registry unavailable)',
      goodPub.status === 200 && String(goodPub.body) === '0',
      `-> ${goodPub.status} ${goodPub.body}`);

    const badName = await post('/api/hooks/srs/publish', {
      action: 'on_publish', client_id: 'x', ip: '203.0.113.99',
      app: 'live', stream: '../../etc/passwd', param: '',
    });
    ok('rejects a path-traversal stream name', String(badName.body) === '1', `-> ${badName.body}`);

    const badChars = await post('/api/hooks/srs/publish', {
      action: 'on_publish', client_id: 'y', ip: '203.0.113.98',
      app: 'live', stream: 'evil;rm -rf /', param: '',
    });
    ok('rejects a stream name with shell metacharacters', String(badChars.body) === '1');
  }

  section('live state + poller');
  {
    await waitFor(async () => {
      const r = await json('/api/streams');
      return (r.body?.streams?.[0]?.history?.length ?? 0) >= 2;
    });

    const streams = await json('/api/streams');
    const s = streams.body?.streams?.[0];
    ok('the publisher appears in live state', Boolean(s), `-> ${JSON.stringify(streams.body)}`);
    ok('stream key is correct', s?.stream_key === 'studio_a');
    ok('protocol was detected as SRT from the client list', s?.protocol === 'SRT', `-> ${s?.protocol}`);
    ok('connection mode resolved to listener',
      s?.connection_mode === 'listener', `-> ${s?.connection_mode}`);
    ok('source IP captured', s?.source_ip === '203.0.113.50', `-> ${s?.source_ip}`);
    ok('status is online', s?.status === 'online', `-> ${s?.status}`);
    ok('bitrate read from SRS', s?.metrics?.bitrate_kbps === 4500, `-> ${s?.metrics?.bitrate_kbps}`);
    ok('uptime derived from the client list alive figure, not live_ms',
      s?.metrics?.uptime_sec === 42, `-> ${s?.metrics?.uptime_sec}`);
    ok('average bitrate computed', s?.metrics?.avg_bitrate_kbps === 4500);
    ok('viewer count is 2', s?.metrics?.viewer_count === 2, `-> ${s?.metrics?.viewer_count}`);
    ok('viewer protocols classified',
      s?.viewers?.some((v) => v.protocol === 'HLS') && s?.viewers?.some((v) => v.protocol === 'RTMP'),
      `-> ${JSON.stringify(s?.viewers?.map((v) => v.protocol))}`);
    ok('video metadata captured', s?.metrics?.video?.width === 1920);
    ok('SRT packet loss reported as null, not a fake zero',
      s?.metrics?.packet_loss_pct === null, `-> ${s?.metrics?.packet_loss_pct}`);
    ok('configured SRT latency surfaced (#12)',
      Number.isFinite(s?.metrics?.configured_latency_ms),
      `-> ${s?.metrics?.configured_latency_ms}`);
    ok('HLS preview URL built', s?.hls_url === '/hls/live/studio_a.m3u8', `-> ${s?.hls_url}`);
    ok('bitrate history is accumulating', (s?.history?.length ?? 0) >= 2, `-> ${s?.history?.length}`);
  }

  section('our own relay pull is not an audience member (#7)');
  {
    // An egress relay pulls from SRS over RTMP, so SRS lists it as a play client
    // exactly like a browser. buildEgressArgs stamps RELAY_PAGE_URL on the pull.
    srs.state.clients = [
      ...srs.state.clients,
      viewerClientFixture({
        id: 'relay-1', ip: '172.18.0.4', type: 'fmle-play', alive: 30, pageUrl: RELAY_PAGE_URL,
      }),
    ];

    const settled = await waitFor(async () => {
      const r = await json('/api/streams');
      return (r.body?.streams?.[0]?.viewers?.length ?? 0) === 2;
    }, { timeoutMs: 4000 });

    const s = (await json('/api/streams')).body?.streams?.[0];
    ok('the relay pull is filtered out of the viewer list', settled,
      `-> ${JSON.stringify(s?.viewers?.map((v) => v.client_id))}`);
    ok('viewer_count still reads 2, not 3', s?.metrics?.viewer_count === 2,
      `-> ${s?.metrics?.viewer_count}`);
    ok('no viewer record carries the relay marker',
      !s?.viewers?.some((v) => String(v.page_url).includes(RELAY_PAGE_URL)));

    // Restore, so later assertions see the original set.
    srs.state.clients = srs.state.clients.filter((c) => c.id !== 'relay-1');
  }

  section('websocket push');
  {
    const wsMsgs = [];
    const sock = new WebSocket(`ws://127.0.0.1:${API_PORT}/ws`);
    await new Promise((resolve, reject) => {
      sock.on('open', resolve);
      sock.on('error', reject);
      setTimeout(() => reject(new Error('ws connect timeout')), 5000);
    });
    sock.on('message', (d) => { try { wsMsgs.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
    await sleep(1400);
    ok('receives an initial snapshot', wsMsgs[0]?.type === 'snapshot', `-> ${wsMsgs[0]?.type}`);
    ok('snapshot contains the live stream',
      wsMsgs[0]?.data?.streams?.[0]?.stream_key === 'studio_a');
    ok('receives periodic tick frames',
      wsMsgs.filter((m) => m.type === 'tick').length >= 2,
      `-> ${wsMsgs.filter((m) => m.type === 'tick').length} ticks`);
    ok('tick frames carry relay status',
      Array.isArray(wsMsgs.find((m) => m.type === 'tick')?.data?.relays));

    // #9's dashboard half reads registry.mode off the live feed to tell
    // "not configured" apart from "temporarily down". The frame replaces the
    // dashboard's whole data object, so this must be on EVERY tick, not just
    // the snapshot - sending it once would make the notice vanish after 1 s.
    const tick = wsMsgs.find((m) => m.type === 'tick');
    ok('the snapshot carries registry status', Boolean(wsMsgs[0]?.data?.registry),
      `-> ${JSON.stringify(wsMsgs[0]?.data?.registry)}`);
    ok('EVERY tick frame carries it too, not just the snapshot',
      wsMsgs.filter((m) => m.type === 'tick').every((m) => Boolean(m.data?.registry)),
      `-> ${wsMsgs.filter((m) => m.type === 'tick' && !m.data?.registry).length} frames missing it`);
    ok('mode is reported as disabled when Supabase is not configured',
      tick?.data?.registry?.mode === 'disabled', `-> ${tick?.data?.registry?.mode}`);
    ok('registry status carries no secrets',
      !JSON.stringify(tick?.data?.registry ?? {}).includes('integrationtestpass'));
    sock.close();
  }

  section('graceful degradation without Supabase');
  {
    const sessions = await json('/api/sessions');
    ok('GET /api/sessions returns 200, not an error', sessions.status === 200, `-> ${sessions.status}`);
    ok('sessions flagged degraded', sessions.body?.degraded === true);
    ok('degraded reason is human-readable',
      typeof sessions.body?.reason === 'string' && sessions.body.reason.includes('unavailable'),
      `-> ${sessions.body?.reason}`);
    ok('sessions list is empty rather than missing', Array.isArray(sessions.body?.sessions));

    const dests = await json('/api/destinations');
    ok('GET /api/destinations degrades to 200', dests.status === 200);
    ok('destinations flagged degraded', dests.body?.degraded === true);

    const createDest = await post('/api/destinations', {
      name: 'YouTube Main',
      platform: 'youtube',
      source_stream_key: 'studio_a',
      url: 'rtmp://a.rtmp.youtube.com/live2',
      dest_stream_key: 'abcd-efgh-ijkl-mnop',
    });
    ok('creating a destination without Supabase returns 503 (write needs storage)',
      createDest.status === 503, `-> ${createDest.status}`);
    ok('503 explains itself', typeof createDest.body?.error === 'string');
  }

  section('input validation on the dashboard API');
  {
    const badUrl = await post('/api/destinations', {
      name: 'evil', source_stream_key: 'studio_a', url: 'file:///etc/shadow',
    });
    ok('rejects a file: destination URL with 400', badUrl.status === 400, `-> ${badUrl.status}`);
    ok('names the offending field', badUrl.body?.field === 'url', `-> ${badUrl.body?.field}`);

    const badInject = await post('/api/destinations', {
      name: 'evil2', source_stream_key: 'studio_a', url: 'rtmp://x.com/$(id)',
    });
    ok('rejects command substitution in a URL with 400', badInject.status === 400);

    const badIngest = await post('/api/ingest', {
      stream_key: 'remote', mode: 'caller', remote_host: 'a;rm -rf /', remote_port: 9000,
    });
    ok('rejects a malicious ingest hostname', badIngest.status === 400, `-> ${badIngest.status}`);

    const malformed = await json('/api/destinations', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    });
    ok('malformed JSON returns 400, not 500', malformed.status === 400, `-> ${malformed.status}`);

    const notFound = await json('/api/streams/does_not_exist');
    ok('unknown stream returns 404', notFound.status === 404);
  }

  section('unpublish + offline reaping');
  {
    await post('/api/hooks/srs/unpublish', {
      action: 'on_unpublish', client_id: 'pub-1', ip: '203.0.113.50',
      app: 'live', stream: 'studio_a',
    });
    const reconn = await json('/api/streams');
    ok('stream flips to reconnecting, not straight to gone',
      reconn.body?.streams?.[0]?.status === 'reconnecting',
      `-> ${reconn.body?.streams?.[0]?.status}`);

    // Remove it from the mock SRS so the reaper finalises it.
    srs.state.streams = [];
    srs.state.clients = [];
    const gone = await waitFor(async () => {
      const r = await json('/api/streams');
      return (r.body?.streams?.length ?? -1) === 0;
    }, { timeoutMs: 6000 });
    ok('stream is removed after the grace period', gone);
  }

  section('structured JSON logging (rule 9)');
  {
    const raw = backend.logText();
    const lines = raw.split('\n').filter((l) => l.trim().startsWith('{'));
    let malformedLines = 0;
    const events = new Set();
    for (const l of lines) {
      try {
        const o = JSON.parse(l);
        if (o.event) events.add(o.event);
      } catch { malformedLines += 1; }
    }
    ok('all log lines are valid JSON', malformedLines === 0, `-> ${malformedLines} malformed`);
    ok('logs carry ts/level/service/msg', (() => {
      const o = JSON.parse(lines[0]);
      return Boolean(o.ts && o.level && o.service && o.msg);
    })());
    ok('publisher_connect event logged', events.has('publisher_connect'), `-> ${[...events]}`);
    ok('publish_rejected event logged', events.has('publish_rejected'));
    ok('stream_offline event logged', events.has('stream_offline'));
    ok('no passphrase leaked into logs', !raw.includes('integrationtestpass'));
  }
} finally {
  await backend.stop();
  await srs.close();
}

finish();

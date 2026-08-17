/**
 * Live Bridge - in-memory state machine.
 *
 * Covers the session-lifecycle fixes that have no HTTP surface of their own:
 *   #5  attachSessionId must REPORT when there is nothing to attach to, so the
 *       caller can close the stranded row instead of leaving ended_at NULL.
 *   #6  a re-publish on a key we still hold live must finalise the previous
 *       record (and hand it to onDisplace) instead of overwriting the map entry
 *       and abandoning its session_id.
 *   #11 uptime comes from the client list's `alive`, applied on the same tick.
 *   #12 configured_latency_ms is set AND cleared in one place.
 *
 * Pure module tests - no processes, no sockets, no network.
 */

import { createHarness, sleep } from './lib/harness.mjs';

process.env.SUPABASE_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.RECONNECT_GRACE_SEC = '1';
process.env.SRT_PASSPHRASE = 'statetestpassphrase';

// Dynamic, and AFTER the assignments above - see the note in unit.test.mjs.
const { config } = await import('../src/config.js');
const state = await import('../src/state.js');

const { ok, section, finish } = createHarness('state');

section('computeUptimeSec - never live_ms (#11)');
ok('uses the SRS client-list alive figure', state.computeUptimeSec(42, null) === 42);
ok('rounds a float alive', state.computeUptimeSec(41.6, null) === 42);
ok('accepts zero seconds connected', state.computeUptimeSec(0, null) === 0);
{
  const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();
  const fallback = state.computeUptimeSec(null, tenSecondsAgo);
  ok('falls back to our own admission time before the first client-list read',
    fallback >= 9 && fallback <= 11, `-> ${fallback}`);
}
ok('returns 0 rather than NaN when nothing is knowable',
  state.computeUptimeSec(null, 'not-a-date') === 0);
{
  // The bug this replaced: live_ms is SRS's wall clock, and dividing it by 1000
  // produced ~496358 hours. Guard the shape of the answer, not just the value.
  const absurd = state.computeUptimeSec(Date.now(), null);
  ok('a wall-clock epoch would be absurd - proving why live_ms is banned here',
    absurd > 1_000_000_000, `-> ${absurd}`);
}

section('attachSessionId reports failure instead of silently dropping (#5)');
{
  const rec = state.publisherConnected({
    streamKey: 'attach_a', app: 'live', protocol: 'unknown', connectionMode: 'unknown',
    sourceIp: '203.0.113.1', clientId: 'c1', streamId: 'attach_a', authorized: true,
  });
  ok('attaches to the live record', state.attachSessionId('attach_a', 'sess-1', rec.started_at));
  ok('the id landed on the record', state.getStream('attach_a').session_id === 'sess-1');
  ok('refuses a session id belonging to a DIFFERENT session on the same key',
    state.attachSessionId('attach_a', 'sess-2', '2020-01-01T00:00:00.000Z') === false);
  ok('the original id was not clobbered', state.getStream('attach_a').session_id === 'sess-1');
  ok('refuses when the stream is not tracked at all',
    state.attachSessionId('never_existed', 'sess-3') === false);
}

section('a stream that ends before its insert lands is reported, not dropped (#5)');
{
  state.publisherConnected({
    streamKey: 'shortlived', app: 'live', protocol: 'unknown', connectionMode: 'unknown',
    sourceIp: '203.0.113.2', clientId: 'c2', streamId: 'shortlived', authorized: true,
  });
  state.publisherDisconnected('shortlived', 'unpublish');
  ok('enters reconnecting, not straight to gone',
    state.getStream('shortlived').status === 'reconnecting');

  await sleep((config.reconnectGraceSec * 1000) + 250);
  const finalised = state.reapStaleStreams();
  ok('the reaper finalises it after the grace period',
    finalised.some((r) => r.stream_key === 'shortlived'), `-> ${finalised.length} finalised`);
  ok('and removes it from live state', state.getStream('shortlived') === null);
  ok('a late-arriving session id now reports false so the caller can close the row',
    state.attachSessionId('shortlived', 'sess-late') === false);
}

section('re-publish on a live key finalises the old session (#6)');
{
  const first = state.publisherConnected({
    streamKey: 'takeover', app: 'live', protocol: 'unknown', connectionMode: 'unknown',
    sourceIp: '203.0.113.10', clientId: 'c10', streamId: 'takeover', authorized: true,
  });
  state.attachSessionId('takeover', 'sess-old', first.started_at);

  const displaced = [];
  const second = state.publisherConnected({
    streamKey: 'takeover', app: 'live', protocol: 'unknown', connectionMode: 'unknown',
    sourceIp: '203.0.113.11', clientId: 'c11', streamId: 'takeover', authorized: true,
    onDisplace: (old) => displaced.push(old),
  });

  ok('onDisplace fired exactly once', displaced.length === 1, `-> ${displaced.length}`);
  ok('the displaced record still carries its session_id (so it CAN be closed)',
    displaced[0]?.session_id === 'sess-old', `-> ${displaced[0]?.session_id}`);
  ok('the displaced record is marked offline', displaced[0]?.status === 'offline');
  ok('it has an ended_at to write', Boolean(displaced[0]?.ended_at));
  ok('the end reason explains the takeover',
    String(displaced[0]?.end_reason || '').includes('replaced'),
    `-> ${displaced[0]?.end_reason}`);
  ok('the new record is a fresh session, not the old one',
    second.session_id === null && second.source_ip === '203.0.113.11');
  ok('exactly one record is held for the key', state.allStreams()
    .filter((r) => r.stream_key === 'takeover').length === 1);
}

section('a reconnect inside the grace window is NOT a takeover (#6 boundary)');
{
  state.publisherConnected({
    streamKey: 'flappy', app: 'live', protocol: 'unknown', connectionMode: 'unknown',
    sourceIp: '203.0.113.20', clientId: 'c20', streamId: 'flappy', authorized: true,
  });
  state.attachSessionId('flappy', 'sess-flappy', state.getStream('flappy').started_at);
  state.publisherDisconnected('flappy', 'unpublish');

  const displaced = [];
  const resumed = state.publisherConnected({
    streamKey: 'flappy', app: 'live', protocol: 'unknown', connectionMode: 'unknown',
    sourceIp: '203.0.113.20', clientId: 'c21', streamId: 'flappy', authorized: true,
    onDisplace: (old) => displaced.push(old),
  });

  ok('onDisplace does NOT fire for a reconnect', displaced.length === 0);
  ok('the same session row continues', resumed.session_id === 'sess-flappy');
  ok('it counts as a reconnect', resumed.reconnect_count === 1);
  ok('and it is back online', resumed.status === 'online');
}

section('transport identification: latency set AND cleared in one place (#12)');
{
  state.publisherConnected({
    streamKey: 'transport', app: 'live', protocol: 'unknown', connectionMode: 'unknown',
    sourceIp: '203.0.113.30', clientId: 'c30', streamId: 'transport', authorized: true,
  });

  const srt = state.updatePublisherTransport('transport', {
    protocol: 'SRT', sourceIp: '203.0.113.30', clientId: 'c30', aliveSec: 77,
  });
  ok('reports that the transport was just identified', srt?.identified === true);
  ok('protocol resolved to SRT', srt.record.protocol === 'SRT');
  ok('connection mode inferred as listener', srt.record.connection_mode === 'listener');
  ok('configured latency populated for SRT',
    srt.record.metrics.configured_latency_ms === config.srt.latencyMs,
    `-> ${srt.record.metrics.configured_latency_ms} vs ${config.srt.latencyMs}`);
  ok('uptime applied on the SAME call, not one tick later (#11)',
    srt.record.metrics.uptime_sec === 77, `-> ${srt.record.metrics.uptime_sec}`);

  const rtmp = state.updatePublisherTransport('transport', {
    protocol: 'RTMP', sourceIp: '203.0.113.30', clientId: 'c30', aliveSec: 80,
  });
  ok('configured latency is CLEARED when the transport is not SRT',
    rtmp.record.metrics.configured_latency_ms === null,
    `-> ${rtmp.record.metrics.configured_latency_ms}`);
  ok('a second identification is not reported as new', rtmp.identified === false);
  ok('uptime tracked forward', rtmp.record.metrics.uptime_sec === 80);
}

section('protocol restriction is an ALERT, not a block');
{
  state.publisherConnected({
    streamKey: 'restricted', app: 'live', protocol: 'unknown', connectionMode: 'unknown',
    sourceIp: '203.0.113.40', clientId: 'c40', streamId: 'restricted', authorized: true,
    enforceProtocol: 'RTMP',
  });
  const res = state.updatePublisherTransport('restricted', {
    protocol: 'SRT', sourceIp: '203.0.113.40', clientId: 'c40', aliveSec: 5,
  });
  ok('a violation is flagged', res.record.protocol_violation === true);
  ok('and the stream is de-authorised in the dashboard', res.record.authorized === false);
  ok('but the publisher is still tracked - we cannot disconnect it',
    state.getStream('restricted') !== null);
}

section('metrics folding');
{
  state.publisherConnected({
    streamKey: 'metrics_a', app: 'live', protocol: 'unknown', connectionMode: 'unknown',
    sourceIp: '203.0.113.50', clientId: 'c50', streamId: 'metrics_a', authorized: true,
  });
  state.updatePublisherTransport('metrics_a', { protocol: 'RTMP', aliveSec: 3 });

  state.applySrsSample('metrics_a', { kbps: { recv_30s: 4000 }, recv_bytes: 1000 });
  state.applySrsSample('metrics_a', { kbps: { recv_30s: 0 }, recv_bytes: 1000 });
  state.applySrsSample('metrics_a', { kbps: { recv_30s: 6000 }, recv_bytes: 2000 });

  const m = state.getStream('metrics_a').metrics;
  ok('peak tracks the maximum', m.peak_bitrate_kbps === 6000, `-> ${m.peak_bitrate_kbps}`);
  ok('idle samples do not drag the average toward zero',
    m.avg_bitrate_kbps === 5000, `-> ${m.avg_bitrate_kbps}`);
  ok('current bitrate is the latest sample', m.bitrate_kbps === 6000);
  ok('bytes taken from SRS', m.bytes_received === 2000);
  ok('history accumulated one point per sample',
    state.getStream('metrics_a').history.length === 3);
  ok('SRT stats stay null rather than a fabricated zero',
    m.packet_loss_pct === null && m.rtt_ms === null);
}

section('serialisation sent to the dashboard');
{
  const s = state.serializeStream(state.getStream('metrics_a'));
  ok('HLS url built from app + key', s.hls_url === '/hls/live/metrics_a.m3u8', `-> ${s.hls_url}`);
  ok('FLV url includes the app segment (see the 13:45 nginx path bug)',
    s.flv_url === '/live/live/metrics_a.flv', `-> ${s.flv_url}`);
  ok('internal accumulators are not leaked to the client',
    !('_sampleSum' in s) && !('_aliveSec' in s) && !('session_id' in s),
    `-> ${Object.keys(s).filter((k) => k.startsWith('_')).join(',')}`);
  ok('no process handle or secret-bearing field is serialised',
    !JSON.stringify(s).includes('statetestpassphrase'));
}

finish();

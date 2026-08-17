/**
 * Live Bridge - unit checks for the pure logic:
 *   - input validators (project rule 8: no raw string ever reaches a shell)
 *   - FFmpeg argv builders (must produce an argv ARRAY, never a shell string)
 *
 * Promoted from the 2026-08-15 scratchpad harness. Two changes from the
 * original: the absolute `file:///c:/...` imports are now relative, and the
 * internal SRS host is asserted as `livebridge-srs` (hyphen). The old suite
 * asserted the underscore form, which SRS 6.x's URI parser rejects outright -
 * see PROGRESS.md 12:52. A test that pins the broken value is worse than none.
 */

import { createHarness } from './lib/harness.mjs';

process.env.SUPABASE_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.SRT_PASSPHRASE = 'testpassphrase123';

// Dynamic, and AFTER the assignments above. `import` declarations are hoisted
// and evaluated before any top-level statement, so a static import of config.js
// would read the environment before this suite had configured it - which is
// exactly how the first run of this file silently used production defaults.
const v = await import('../src/validate.js');
const relay = await import('../src/relay.js');

const { ok, throws, section, finish } = createHarness('unit');

const SRS_RTMP = 'rtmp://livebridge-srs:1935';

section('validators: stream keys');
ok('accepts a normal key', v.validateStreamKey('vmix-main-1') === 'vmix-main-1');
ok('trims whitespace', v.validateStreamKey('  studio_a  ') === 'studio_a');
throws('rejects path traversal', () => v.validateStreamKey('../../etc/passwd'));
throws('rejects a slash', () => v.validateStreamKey('live/stream'));
throws('rejects a dot', () => v.validateStreamKey('stream.m3u8'));
throws('rejects a space', () => v.validateStreamKey('my stream'));
throws('rejects shell metacharacters', () => v.validateStreamKey('a;rm -rf /'));
throws('rejects too short', () => v.validateStreamKey('ab'));
throws('rejects too long', () => v.validateStreamKey('x'.repeat(65)));
throws('rejects a non-string', () => v.validateStreamKey(12345));

section('validators: relay URLs');
ok('accepts a YouTube RTMP URL',
  v.validateRelayUrl('rtmp://a.rtmp.youtube.com/live2') === 'rtmp://a.rtmp.youtube.com/live2');
ok('accepts RTMPS',
  v.validateRelayUrl('rtmps://live-api-s.facebook.com:443/rtmp').startsWith('rtmps://'));
ok('accepts SRT', v.validateRelayUrl('srt://198.51.100.9:9001').startsWith('srt://'));
throws('rejects file: (local file read)', () => v.validateRelayUrl('file:///etc/shadow'));
throws('rejects http:', () => v.validateRelayUrl('http://evil.example.com/x'));
throws('rejects a command substitution', () => v.validateRelayUrl('rtmp://x.com/$(whoami)'));
throws('rejects a semicolon', () => v.validateRelayUrl('rtmp://x.com/a;id'));
throws('rejects a backtick', () => v.validateRelayUrl('rtmp://x.com/`id`'));
throws('rejects a pipe', () => v.validateRelayUrl('rtmp://x.com/a|nc'));
throws('rejects a leading dash (ffmpeg flag injection)', () => v.validateRelayUrl('-i'));
throws('rejects whitespace', () => v.validateRelayUrl('rtmp://x.com/a b'));

section('validators: misc');
ok('validateInt clamps with fallback', v.validateInt(undefined, 'x', { fallback: 7 }) === 7);
throws('validateInt rejects out of range', () => v.validateInt(999, 'x', { min: 0, max: 10 }));
throws('validateUuid rejects garbage', () => v.validateUuid('not-a-uuid'));
ok('validateUuid accepts a real one',
  v.validateUuid('3F2504E0-4F89-11D3-9A0C-0305E82C3301') === '3f2504e0-4f89-11d3-9a0c-0305e82c3301');
ok('sanitizeIp accepts IPv4', v.sanitizeIp('203.0.113.7') === '203.0.113.7');
ok('sanitizeIp rejects junk', v.sanitizeIp('not an ip') === null);
ok('validateString strips control characters',
  v.validateString('abc\u0000\u001bdef', 'f') === 'abcdef',
  `-> got ${JSON.stringify(v.validateString('abc\u0000\u001bdef', 'f'))}`);

section('ffmpeg argv: egress (copy)');
const copyArgs = relay.buildEgressArgs({
  id: 'd1',
  name: 'YouTube Main',
  platform: 'youtube',
  source_stream_key: 'studio_a',
  url: 'rtmp://a.rtmp.youtube.com/live2',
  dest_stream_key: 'abcd-efgh-ijkl-mnop',
  transcode: false,
}, 'live');

ok('argv is an array', Array.isArray(copyArgs));
ok('every element is a string', copyArgs.every((a) => typeof a === 'string'));
ok('no element contains a shell metacharacter',
  !copyArgs.some((a) => /[;&|`$]/.test(a)),
  `-> ${copyArgs.filter((a) => /[;&|`$]/.test(a))}`);
ok('pulls from internal SRS RTMP over the HYPHENATED alias',
  copyArgs.includes(`${SRS_RTMP}/live/studio_a`),
  `-> ${copyArgs.find((a) => a.startsWith('rtmp://livebridge'))}`);
ok('never addresses SRS with an underscore (SRS 6.x rejects it)',
  !copyArgs.some((a) => a.includes('livebridge_srs')));
ok('uses -c copy (no transcode)', copyArgs.join(' ').includes('-c copy'));
ok('output is flv', copyArgs.includes('-f') && copyArgs.includes('flv'));
ok('destination URL is the last argument',
  copyArgs[copyArgs.length - 1] === 'rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl-mnop',
  `-> ${copyArgs[copyArgs.length - 1]}`);
ok('reads no stdin', copyArgs.includes('-nostdin'));
ok('emits machine-readable progress', copyArgs.includes('-progress'));

section('ffmpeg argv: relay pull is tagged so it is not counted as a viewer (#7)');
ok('RELAY_PAGE_URL is exported for the poller to match on',
  typeof relay.RELAY_PAGE_URL === 'string' && relay.RELAY_PAGE_URL.length > 0,
  `-> ${relay.RELAY_PAGE_URL}`);
ok('egress argv stamps the relay page url',
  copyArgs.includes('-rtmp_pageurl') && copyArgs.includes(relay.RELAY_PAGE_URL),
  `-> ${copyArgs.join(' ')}`);
ok('the tag sits immediately before its value',
  copyArgs[copyArgs.indexOf('-rtmp_pageurl') + 1] === relay.RELAY_PAGE_URL);

section('ffmpeg argv: egress (transcode)');
const txArgs = relay.buildEgressArgs({
  id: 'd2',
  source_stream_key: 'studio_b',
  url: 'rtmps://live-api-s.facebook.com:443/rtmp',
  dest_stream_key: 'FB-KEY-123',
  transcode: true,
  transcode_profile: {
    video_bitrate_kbps: 3000,
    audio_bitrate_kbps: 128,
    width: 1280,
    height: 720,
    preset: 'veryfast',
    gop: 60,
  },
}, 'live');
ok('uses libx264', txArgs.includes('libx264'));
ok('applies the video bitrate', txArgs.includes('3000k'));
ok('applies the scale filter', txArgs.includes('scale=1280:720'));
ok('sets a fixed GOP', txArgs.includes('-g') && txArgs.includes('60'));
ok('still an array of strings', txArgs.every((a) => typeof a === 'string'));

section('ffmpeg argv: SRT ingest (caller / rendezvous)');
const callerArgs = relay.buildIngressArgs({
  mode: 'caller',
  remoteHost: '198.51.100.20',
  remotePort: 9000,
  streamKey: 'remote_feed',
  passphrase: 'supersecretpass',
  latencyMs: 200,
  app: 'live',
});
const callerUrl = callerArgs[callerArgs.indexOf('-i') + 1];
ok('builds an srt:// input URL', callerUrl.startsWith('srt://198.51.100.20:9000?'));
ok('sets mode=caller', callerUrl.includes('mode=caller'));
ok('sets transtype=live', callerUrl.includes('transtype=live'));
ok('carries the latency', callerUrl.includes('latency=200'));
ok('carries the passphrase', callerUrl.includes('passphrase=supersecretpass'));
ok('republishes to local RTMP',
  callerArgs[callerArgs.length - 1] === `${SRS_RTMP}/live/remote_feed`,
  `-> ${callerArgs[callerArgs.length - 1]}`);

const rzArgs = relay.buildIngressArgs({
  mode: 'rendezvous',
  remoteHost: 'peer.example.com',
  remotePort: 9001,
  streamKey: 'nat_feed',
});
ok('rendezvous mode is set',
  rzArgs[rzArgs.indexOf('-i') + 1].includes('mode=rendezvous'));
ok('omits the passphrase when none is given',
  !rzArgs[rzArgs.indexOf('-i') + 1].includes('passphrase'));

section('injection attempt through a destination URL');
// Even if a malicious URL somehow bypassed validation, it stays ONE argv
// element and is never interpreted by a shell.
const evil = relay.buildEgressArgs({
  id: 'd3',
  source_stream_key: 'studio_c',
  url: 'rtmp://evil.example.com/live',
  dest_stream_key: 'key',
  transcode: false,
}, 'live');
ok('destination stays a single argv element',
  evil.filter((a) => a.includes('evil.example.com')).length === 1);

finish();

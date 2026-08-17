/**
 * Live Bridge - relay process supervision.
 *
 * The bug under test (#2): editing a destination while its relay is running
 * spawned a SECOND FFmpeg. `PATCH /api/destinations/:id` stops then immediately
 * restarts; `stopRelay` only sends SIGTERM, so the child is still alive when
 * `startRelay` runs. The old start guard did not cover `stopping`, so it spawned
 * child two - and when child one finally died, its exit handler nulled
 * `record.process` (which by then pointed at child two) and scheduled child
 * three. Result: an orphaned FFmpeg still pushing to the platform, invisible to
 * the dashboard and unstoppable from it.
 *
 * Two independent guards fix it and both are exercised below:
 *   (a) startRelay defers to `restartRequested` while status === 'stopping'
 *   (b) the exit handler bails unless `child === record.process`
 *
 * FFmpeg is replaced with a controllable fake via relay.__setSpawnForTests, so
 * exits happen exactly when the test says. Everything else is the real module.
 */

import { EventEmitter } from 'node:events';
import { createHarness, sleep } from './lib/harness.mjs';

process.env.SUPABASE_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.SRT_PASSPHRASE = 'relaytestpassphrase';
// Keep the backoff short so the restart assertions do not need a long sleep.
process.env.RELAY_BACKOFF_MIN_MS = '100';

// Dynamic, and AFTER the assignments above - see the note in unit.test.mjs.
// A static import here read the production 1000 ms backoff and made the restart
// assertion fail against correct code.
const relay = await import('../src/relay.js');
const { config } = await import('../src/config.js');

const { ok, section, finish } = createHarness('relay-supervision');

// -----------------------------------------------------------------------------
// A fake FFmpeg child: an EventEmitter with the surface relay.js touches.
// -----------------------------------------------------------------------------
let nextPid = 4000;
const spawned = [];

function fakeChild(args) {
  const child = new EventEmitter();
  child.pid = nextPid += 1;
  child.args = args;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.signals = [];
  child.kill = (sig) => { child.signals.push(sig); return true; };
  /** Simulate the process actually terminating. */
  child.exit = (code = 0, signal = null) => child.emit('exit', code, signal);
  return child;
}

relay.__setSpawnForTests((_path, args) => {
  const c = fakeChild(args);
  spawned.push(c);
  return c;
});

const DEST = {
  id: 'dest-1',
  name: 'Self relay sink',
  platform: 'custom',
  source_stream_key: 'testkey',
  url: 'rtmp://livebridge-srs:1935/relaytest',
  // Deliberately distinctive: the leak check below is a substring search, and a
  // key that also appears in the destination's display name would pass it for
  // the wrong reason.
  dest_stream_key: 'zzq7-probe-key',
  enabled: true,
  transcode: false,
};

relay.setDestinations([DEST]);

const statusOf = () => relay.relayStatus().find((r) => r.destination_id === DEST.id);

section('start');
{
  const rec = relay.startRelay(DEST, 'live');
  ok('one child spawned', spawned.length === 1, `-> ${spawned.length}`);
  ok('status is running', rec.status === 'running', `-> ${rec.status}`);
  ok('pid recorded', rec.pid === spawned[0].pid);
  ok('argv went to the child as an array', Array.isArray(spawned[0].args));
  ok('the dashboard view exposes only the target host:port, never the full URL',
    statusOf().target_host === 'livebridge-srs:1935',
    `-> ${statusOf().target_host}`);
  ok('the destination stream key is never in the dashboard payload',
    !JSON.stringify(statusOf()).includes(DEST.dest_stream_key),
    `-> ${JSON.stringify(statusOf())}`);
}

section('start is idempotent while running');
{
  relay.startRelay(DEST, 'live');
  relay.startRelay(DEST, 'live');
  ok('no extra child spawned for an already-running relay',
    spawned.length === 1, `-> ${spawned.length}`);
}

section('edit mid-relay: stop then immediately start (#2a)');
{
  relay.stopRelay(DEST.id, 'destination edited');
  ok('status moved to stopping', statusOf().status === 'stopping', `-> ${statusOf().status}`);
  ok('SIGTERM was sent to the running child',
    spawned[0].signals.includes('SIGTERM'), `-> ${spawned[0].signals}`);

  // This is the exact race: the child has NOT exited yet.
  const rec = relay.startRelay({ ...DEST, name: 'Self relay probe (edited)' }, 'live');
  ok('NO second child is spawned while the first is still dying',
    spawned.length === 1, `-> ${spawned.length} children`);
  ok('the restart is recorded as pending instead', Boolean(rec.restartRequested));
  ok('status is still stopping', rec.status === 'stopping', `-> ${rec.status}`);

  // Now let the first child actually die.
  spawned[0].exit(0, 'SIGTERM');
  await sleep(50);

  ok('the deferred restart is honoured once the child is genuinely gone',
    spawned.length === 2, `-> ${spawned.length} children`);
  ok('exactly one restart, not two', spawned.length === 2);
  ok('the new child is the one being supervised',
    statusOf().status === 'running' && relay.relayStatus()
      .find((r) => r.destination_id === DEST.id) !== undefined);
  ok('the pending restart flag was cleared',
    !relay.listDestinations().some((d) => d.restartRequested));
}

section('the SIGKILL grace timer must not kill the successor (#31)');
{
  // Found live, not by reading the code: after a PATCH the deferred restart
  // brought a healthy relay up in 200 ms, and five seconds later it died with
  // signal=SIGKILL and sat out a 30 s backoff. stopRelay's grace timer captured
  // `record`, so it fired against whatever `record.process` pointed at by then -
  // which is normally the replacement, not the child it was meant to reap.
  const successor = spawned[1];
  ok('the successor is the supervised child', statusOf().status === 'running');
  ok('it has not been signalled', successor.signals.length === 0,
    `-> ${successor.signals}`);

  // The grace timer from the stop above is hard-coded at 5 s. Wait it out.
  await sleep(5200);

  ok('the successor was NOT SIGKILLed by the previous stop\'s grace timer',
    !successor.signals.includes('SIGKILL'), `-> ${successor.signals}`);
  ok('and it is still running', statusOf().status === 'running', `-> ${statusOf().status}`);
  ok('no backoff was triggered', statusOf().restarts === 0, `-> ${statusOf().restarts}`);
  ok('no replacement was spawned', spawned.length === 2, `-> ${spawned.length}`);
}

section('a stale child exiting must not disturb its successor (#2b)');
{
  const stale = spawned[0];
  const current = spawned[1];
  const pidBefore = statusOf() && current.pid;

  // The late exit of an already-replaced child. Without the identity guard this
  // nulls the successor's handle and schedules another spawn on top of it.
  stale.exit(1, null);
  // Longer than one backoff period, so a wrongly-scheduled restart would land
  // rather than merely being pending when we look.
  await sleep(config.relay.backoffMinMs + 150);

  ok('no third child was spawned', spawned.length === 2, `-> ${spawned.length}`);
  ok('the live relay is still running', statusOf().status === 'running', `-> ${statusOf().status}`);
  ok('the successor kept its pid', pidBefore === current.pid);
  ok('restart counter was not bumped by a stale exit',
    statusOf().restarts === 0, `-> ${statusOf().restarts}`);
}

section('a genuine unexpected exit DOES restart, with backoff');
{
  spawned[1].exit(1, null);
  await sleep(60);
  ok('status flips to retrying', statusOf().status === 'retrying', `-> ${statusOf().status}`);
  ok('restart counter incremented', statusOf().restarts === 1, `-> ${statusOf().restarts}`);
  ok('no immediate respawn - the backoff timer has not fired',
    spawned.length === 2, `-> ${spawned.length}`);

  await sleep(config.relay.backoffMinMs + 200);
  ok('the relay comes back after the backoff', spawned.length === 3, `-> ${spawned.length}`);
  ok('and is running again', statusOf().status === 'running', `-> ${statusOf().status}`);
}

section('stderr classification (#10)');
{
  const child = spawned[2];
  child.stderr.emit('data', Buffer.from(
    'frame= 120 fps= 30 q=-1.0 size= 512kB time=00:00:04.00 bitrate=1048.6kbits/s speed=1x\n',
  ));
  await sleep(20);
  ok('benign FFmpeg chatter does NOT paint the relay red',
    statusOf().last_error === null, `-> ${statusOf().last_error}`);

  child.stderr.emit('data', Buffer.from('Connection to tcp://a.rtmp.example failed: refused\n'));
  await sleep(20);
  ok('a real error IS recorded',
    String(statusOf().last_error).includes('refused'), `-> ${statusOf().last_error}`);
}

section('deliberate stop does not restart');
{
  relay.stopRelay(DEST.id, 'manual');
  spawned[spawned.length - 1].exit(0, 'SIGTERM');
  await sleep(config.relay.backoffMinMs + 200);
  ok('status is stopped', statusOf().status === 'stopped', `-> ${statusOf().status}`);
  ok('no respawn after a deliberate stop',
    spawned.length === 3, `-> ${spawned.length}`);
}

section('source going offline stops the relay and resets backoff');
{
  relay.startRelay(DEST, 'live');
  await sleep(20);
  const before = spawned.length;
  relay.onStreamOffline('testkey');
  ok('a relay for that source is asked to stop',
    statusOf().status === 'stopping', `-> ${statusOf().status}`);
  ok('backoff counter reset for the next show', statusOf().restarts === 0);
  spawned[spawned.length - 1].exit(0, 'SIGTERM');
  await sleep(200);
  ok('and it stays stopped', spawned.length === before, `-> ${spawned.length}`);
}

section('a child that ignores SIGTERM IS still force-killed');
{
  // The #31 guard must not disable the grace timer for the case it exists for.
  // Runs last, and on its own destination id, so it cannot perturb the child
  // indices the sections above depend on.
  const before = spawned.length;
  relay.startRelay({ ...DEST, id: 'dest-2' }, 'live');
  ok('a second destination starts its own child', spawned.length === before + 1,
    `-> ${spawned.length}`);
  const child = spawned[before];

  relay.stopRelay('dest-2', 'manual');
  ok('SIGTERM is sent first', child.signals.includes('SIGTERM'), `-> ${child.signals}`);
  ok('it is not killed immediately', !child.signals.includes('SIGKILL'));

  // This child never exits, so record.process still points at it when the grace
  // timer fires - which is exactly when SIGKILL is the right answer.
  await sleep(5200);
  ok('a wedged child IS force-killed after the grace period',
    child.signals.includes('SIGKILL'), `-> ${child.signals}`);

  child.exit(null, 'SIGKILL');
  await sleep(50);
  relay.removeDestination('dest-2');
  ok('and the relay record is cleaned up',
    !relay.relayStatus().some((r) => r.destination_id === 'dest-2'));
}

relay.__setSpawnForTests(null);
finish();

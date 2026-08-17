/**
 * Live Bridge - test runner. `npm test`.
 *
 * Runs each suite as its own process, sequentially. Sequential is deliberate:
 * the process-based suites bind fixed loopback ports for their mock SRS, mock
 * PostgREST and the backend under test, and a parallel run would have them
 * fight over the ports and produce failures that look like real bugs.
 *
 * Each suite exits non-zero on any failed assertion and prints its own
 * `PASSED n FAILED m` line; this file aggregates those into one total.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));

const SUITES = [
  // Pure logic first - fastest feedback, no ports, no child processes.
  ['unit', 'unit.test.mjs'],
  ['state', 'state.test.mjs'],
  ['relay-supervision', 'relay-supervision.test.mjs'],
  // Process-based: each boots the real backend against mock SRS / PostgREST.
  ['integration', 'integration.test.mjs'],
  ['auth-closed', 'auth-closed.test.mjs'],
  ['supabase-errors', 'supabase-errors.test.mjs'],
  ['session-lifecycle', 'session-lifecycle.test.mjs'],
  ['poller-inactive', 'poller-inactive.test.mjs'],
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const suites = only.length
  ? SUITES.filter(([name]) => only.some((o) => name.includes(o)))
  : SUITES;

if (suites.length === 0) {
  console.error(`No suite matched ${only.join(', ')}. Known: ${SUITES.map((s) => s[0]).join(', ')}`);
  process.exit(2);
}

const SUMMARY_RE = /PASSED\s+(\d+)\s+FAILED\s+(\d+)/;

function runSuite(name, file) {
  return new Promise((resolve) => {
    console.log(`\n${'#'.repeat(66)}`);
    console.log(`# ${name}`);
    console.log('#'.repeat(66));

    const started = Date.now();
    const child = spawn(process.execPath, [file], {
      cwd: TEST_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let out = '';
    const capture = (d) => {
      const text = d.toString();
      out += text;
      process.stdout.write(text);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    child.on('exit', (code) => {
      const m = out.match(SUMMARY_RE);
      resolve({
        name,
        code: code ?? 1,
        pass: m ? Number(m[1]) : 0,
        // A suite that crashed before printing a summary counts as one failure,
        // otherwise a boot-time crash would silently read as "0 failures".
        fail: m ? Number(m[2]) : 1,
        crashed: !m,
        ms: Date.now() - started,
      });
    });
  });
}

const results = [];
for (const [name, file] of suites) {
  // eslint-disable-next-line no-await-in-loop
  results.push(await runSuite(name, file));
}

const totalPass = results.reduce((a, r) => a + r.pass, 0);
const totalFail = results.reduce((a, r) => a + r.fail, 0);
const totalMs = results.reduce((a, r) => a + r.ms, 0);

console.log(`\n${'='.repeat(66)}`);
console.log('  Live Bridge test summary');
console.log('='.repeat(66));
for (const r of results) {
  const verdict = r.crashed ? 'CRASHED' : (r.fail === 0 ? 'ok' : 'FAILED');
  console.log(
    `  ${r.name.padEnd(20)} ${String(r.pass).padStart(4)} passed  `
    + `${String(r.fail).padStart(3)} failed  ${String(r.ms).padStart(6)} ms  ${verdict}`,
  );
}
console.log('-'.repeat(66));
console.log(`  TOTAL: ${totalPass} passed, ${totalFail} failed in ${(totalMs / 1000).toFixed(1)}s`);
console.log('='.repeat(66));

process.exit(totalFail === 0 ? 0 : 1);

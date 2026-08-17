/**
 * Live Bridge - minimal test harness.
 *
 * Deliberately hand-rolled: rule 14 caps dependencies at what the product needs,
 * and a test runner is not one of them. Node's built-in `node:test` would also
 * do, but these suites predate it in this project and their pass/fail counts are
 * quoted throughout PROGRESS.md; keeping the same reporting shape keeps those
 * numbers comparable across the log.
 *
 * Each suite prints `PASS`/`FAIL` per assertion and exits non-zero on any
 * failure, so `test/run.mjs` can treat a suite as a single subprocess.
 */

export function createHarness(suiteName) {
  let pass = 0;
  let fail = 0;
  const failures = [];

  const ok = (name, cond, detail = '') => {
    if (cond) {
      pass += 1;
      console.log(`  PASS  ${name}`);
    } else {
      fail += 1;
      failures.push(`${name} ${detail}`.trim());
      console.log(`  FAIL  ${name} ${detail}`);
    }
    return Boolean(cond);
  };

  /** Assert `fn` throws, and that the throw is a deliberate ValidationError. */
  const throws = (name, fn, expectedName = 'ValidationError') => {
    try {
      fn();
      return ok(name, false, '-> did NOT throw');
    } catch (e) {
      return ok(name, e.name === expectedName, `-> threw ${e.name}: ${e.message}`);
    }
  };

  const section = (name) => console.log(`\n=== ${name} ===`);

  const finish = () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ${suiteName}:  PASSED ${pass}   FAILED ${fail}`);
    if (fail > 0) {
      console.log('  failing assertions:');
      for (const f of failures) console.log(`    - ${f}`);
    }
    console.log('='.repeat(60));
    // Explicit exit: some suites hold unref'd timers or an open agent socket and
    // would otherwise linger. The counts above are already final.
    process.exit(fail === 0 ? 0 : 1);
  };

  return { ok, throws, section, finish, counts: () => ({ pass, fail }) };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `predicate` until it is truthy or the deadline passes.
 * Returns true if it became truthy. Used instead of a flat sleep so a slow
 * machine does not turn a correct implementation into a red test.
 */
export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }
}

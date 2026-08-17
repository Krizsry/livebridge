/**
 * Live Bridge - boot the REAL backend process for a suite.
 *
 * Spawns `src/index.js` exactly as production does, with the suite's env. No
 * module stubbing: the value of these tests is that they run the shipped code
 * path, so the only things faked are the two things over the network (SRS and
 * Supabase), each behind its own mock HTTP server.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sleep } from './harness.mjs';

const BACKEND_DIR = fileURLToPath(new URL('../..', import.meta.url));

export async function startBackend(env, { port, waitMs = 12000 } = {}) {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      // Defaults every suite wants; each suite overrides what it cares about.
      LOG_LEVEL: 'info',
      SUPABASE_ENABLED: 'false',
      ...env,
      BACKEND_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const logChunks = [];
  child.stdout.on('data', (d) => logChunks.push(d.toString()));
  child.stderr.on('data', (d) => logChunks.push(d.toString()));

  const base = `http://127.0.0.1:${port}`;

  let up = false;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fetch(`${base}/healthz`);
      up = true;
      break;
    } catch {
      // eslint-disable-next-line no-await-in-loop
      await sleep(150);
    }
  }

  const logText = () => logChunks.join('');

  if (!up) {
    console.log('backend never came up. captured output:\n', logText());
    throw new Error(`backend did not answer on ${base} within ${waitMs}ms`);
  }

  const json = async (path, opts) => {
    const res = await fetch(base + path, opts);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  };

  const post = (path, obj) => json(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj),
  });

  /** Every structured log line the process has emitted, parsed. */
  const events = () => logText()
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => { try { return JSON.parse(l); } catch { return { __unparseable: l }; } });

  return {
    base,
    child,
    json,
    post,
    logText,
    events,
    publish: (fields) => post('/api/hooks/srs/publish', {
      action: 'on_publish',
      client_id: 'c1',
      ip: '203.0.113.50',
      vhost: '__defaultVhost__',
      app: 'live',
      param: '',
      ...fields,
    }),
    unpublish: (fields) => post('/api/hooks/srs/unpublish', {
      action: 'on_unpublish',
      client_id: 'c1',
      ip: '203.0.113.50',
      app: 'live',
      ...fields,
    }),
    async stop() {
      child.kill('SIGTERM');
      await sleep(400);
      child.kill('SIGKILL');
    },
  };
}

/**
 * Live Bridge - backend entrypoint.
 *
 * Responsibilities:
 *   - serve the SRS callback endpoints (authorisation + session logging)
 *   - serve the dashboard REST API
 *   - run the WebSocket hub and the 1 Hz SRS poller
 *   - supervise FFmpeg relays and SRT ingest jobs
 *
 * Design rule that shapes everything here: the ingest path must survive a
 * Supabase outage untouched (requirement 21). Nothing on the hook path awaits
 * a network call to anything except SRS itself.
 */

import http from 'node:http';
import express from 'express';

import { config, validateConfig } from './config.js';
import { createLogger } from './logger.js';
import hooksRouter from './routes/hooks.js';
import apiRouter from './routes/api.js';
import { attachWebSocket, broadcast, closeWebSocket } from './ws.js';
import { startPoller, stopPoller, setBroadcaster, currentSnapshot } from './poller.js';
import { startAutoRefresh, stopAutoRefresh } from './registry.js';
import { setDestinations, stopAllRelays } from './relay.js';
import { fetchDestinations, closeOrphanedSessions } from './supabase.js';
import { ValidationError } from './validate.js';

const log = createLogger('server');

const app = express();

// Behind the Nginx reverse proxy - trust exactly one hop so req.ip is the real
// client address and not the proxy's. Never `true`, which would let a client
// spoof its own IP through X-Forwarded-For.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// SRS posts JSON; keep the limit small since these bodies are tiny and a large
// body limit on an unauthenticated endpoint is a free memory-exhaustion vector.
app.use(express.json({ limit: '64kb' }));

// -----------------------------------------------------------------------------
// Structured access logging (project rule 9)
// -----------------------------------------------------------------------------
// SRS hook traffic is logged at debug (it is high-volume and already logged in
// detail by the hook handlers); dashboard traffic is logged at info.
// -----------------------------------------------------------------------------
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const isHook = req.path.startsWith('/api/hooks/');
    const level = res.statusCode >= 500 ? 'error' : (isHook ? 'debug' : 'info');
    log[level]('http request', {
      event: isHook ? 'srs_hook_request' : 'dashboard_request',
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 100) / 100,
      source_ip: req.ip,
      user_agent: isHook ? undefined : String(req.get('user-agent') || '').slice(0, 200),
    });
  });
  next();
});

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------
// SRS calls /api/hooks/srs/* - see srs/conf/livebridge.conf.template.
app.use('/api/hooks/srs', hooksRouter);
app.use('/api', apiRouter);

// Liveness probe for the container healthcheck. Deliberately trivial and
// dependency-free: it answers "is this process up", not "is everything happy".
// /api/health is the deep check.
app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));

app.use((req, res) => {
  res.status(404).json({ error: 'not found', path: req.path });
});

// -----------------------------------------------------------------------------
// Error handler
// -----------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof ValidationError) {
    log.warn('request rejected by validation', {
      event: 'validation_error',
      path: req.path,
      field: err.field,
      detail: err.message,
      source_ip: req.ip,
    });
    res.status(400).json({ error: err.message, field: err.field });
    return;
  }

  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'malformed JSON body' });
    return;
  }

  log.error('unhandled request error', {
    event: 'server_error',
    path: req.path,
    detail: err?.message,
    stack: err?.stack,
  });
  res.status(500).json({ error: 'internal server error' });
});

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
const server = http.createServer(app);

attachWebSocket(server, currentSnapshot);
setBroadcaster(broadcast);

async function loadDestinations() {
  const result = await fetchDestinations();
  if (!result.ok) {
    log.warn('could not load relay destinations at boot - will retry on first API read', {
      detail: result.error,
    });
    return;
  }
  setDestinations(result.data || []);
}

/**
 * Close any session rows a previous process left open. Live state is in-memory,
 * so a restart abandons every session it was tracking and those rows would
 * otherwise read "live" in the dashboard forever. Best-effort: a Supabase
 * outage here must not stop the backend from serving ingest (requirement 21).
 */
async function reconcileOrphanedSessions() {
  const result = await closeOrphanedSessions();
  if (!result.ok) {
    log.warn('could not reconcile orphaned sessions at boot', { detail: result.error });
    return;
  }
  const count = Array.isArray(result.data) ? result.data.length : 0;
  if (count > 0) {
    log.info('closed sessions orphaned by a previous backend process', {
      event: 'sessions_reconciled',
      count,
    });
  }
}

server.listen(config.port, '0.0.0.0', () => {
  validateConfig();

  log.info('Live Bridge backend listening', {
    event: 'server_start',
    port: config.port,
    node_version: process.version,
  });

  startAutoRefresh();
  startPoller();
  loadDestinations();
  reconcileOrphanedSessions();
});

// -----------------------------------------------------------------------------
// Graceful shutdown
// -----------------------------------------------------------------------------
// Without this, a `docker compose restart` orphans every FFmpeg child and the
// next start hits "address already in use" on the relay targets.
// -----------------------------------------------------------------------------
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info('shutdown initiated', { event: 'server_stop', signal });

  stopPoller();
  stopAutoRefresh();
  stopAllRelays();
  closeWebSocket();

  server.close(() => {
    log.info('shutdown complete', { event: 'server_stopped' });
    process.exit(0);
  });

  // Don't hang forever on a stuck connection.
  const timer = setTimeout(() => {
    log.warn('forced exit after shutdown timeout');
    process.exit(1);
  }, 10000);
  timer.unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  log.error('unhandled promise rejection', {
    detail: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on('uncaughtException', (err) => {
  log.error('uncaught exception - exiting for the supervisor to restart us', {
    detail: err.message,
    stack: err.stack,
  });
  // Exiting is correct: the process is in an unknown state, and both the Docker
  // restart policy and the systemd unit will bring it straight back.
  process.exit(1);
});

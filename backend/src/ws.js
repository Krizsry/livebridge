/**
 * Live Bridge - WebSocket hub for the dashboard.
 *
 * WHY A CUSTOM WEBSOCKET RATHER THAN SUPABASE REALTIME (requirement 17)
 * ---------------------------------------------------------------------
 * The live numbers - bitrate, uptime, viewer count, relay state - are produced
 * locally by the poller once a second. Pushing them through Supabase Realtime
 * would mean: backend -> WAN -> Supabase Postgres write -> logical replication
 * -> Realtime server -> WAN -> browser. That adds a full internet round trip to
 * a metric that originated three processes away on the same host, and it costs
 * roughly 86,400 row writes per stream per day purely to move a number to a
 * browser on the same LAN.
 *
 * It also violates requirement 21: the dashboard's live view would stop working
 * whenever Supabase had a bad minute, and the write amplification could push the
 * backend into retry storms right when a show is live.
 *
 * So: this WebSocket carries everything sub-second and local. Supabase Realtime
 * remains available (and is documented in the README) for the one thing it is
 * genuinely better at - notifying other clients about durable changes to
 * session history and destination config, which are low-frequency and already
 * live in Postgres.
 *
 * There is no authentication here, by design (requirement 12). Access control
 * is at the network layer - see the README's firewall/VPN section.
 */

import { WebSocketServer } from 'ws';
import { createLogger } from './logger.js';

const log = createLogger('ws');

let wss = null;
const clients = new Set();
let heartbeatTimer = null;

/**
 * @param {import('node:http').Server} server
 * @param {() => object} snapshotFn produces the initial state for a new client
 */
export function attachWebSocket(server, snapshotFn) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (socket, req) => {
    const ip = req.socket.remoteAddress;
    socket.isAlive = true;
    clients.add(socket);

    // Dashboard access logging (project rule 9).
    log.info('dashboard client connected', {
      event: 'dashboard_connect',
      source_ip: ip,
      user_agent: String(req.headers['user-agent'] || '').slice(0, 200),
      client_count: clients.size,
    });

    // Send the full picture immediately so the UI has data before the next tick.
    send(socket, { type: 'snapshot', data: snapshotFn() });

    socket.on('pong', () => { socket.isAlive = true; });

    socket.on('message', (raw) => {
      // The dashboard is read-only over the socket - all mutations go through
      // the REST API, where they are validated. Anything else is ignored.
      let msg;
      try {
        msg = JSON.parse(raw.toString().slice(0, 1024));
      } catch {
        return;
      }
      if (msg?.type === 'ping') send(socket, { type: 'pong', ts: Date.now() });
    });

    socket.on('close', (code) => {
      clients.delete(socket);
      log.info('dashboard client disconnected', {
        event: 'dashboard_disconnect',
        source_ip: ip,
        code,
        client_count: clients.size,
      });
    });

    socket.on('error', (err) => {
      log.warn('dashboard socket error', { source_ip: ip, detail: err.message });
      clients.delete(socket);
    });
  });

  // Drop half-open connections - without this, a laptop that closed its lid
  // leaves a socket we keep serialising frames into forever.
  heartbeatTimer = setInterval(() => {
    for (const socket of clients) {
      if (socket.isAlive === false) {
        clients.delete(socket);
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch {
        clients.delete(socket);
      }
    }
  }, 30000);
  heartbeatTimer.unref?.();

  log.info('websocket hub attached', { path: '/ws' });
  return wss;
}

function send(socket, payload) {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch (err) {
    log.warn('websocket send failed', { detail: err.message });
  }
}

/** Fan a frame out to every connected dashboard. */
export function broadcast(payload) {
  if (clients.size === 0) return;
  let json;
  try {
    json = JSON.stringify(payload);
  } catch (err) {
    log.error('broadcast serialisation failed', { detail: err.message });
    return;
  }
  for (const socket of clients) {
    if (socket.readyState !== socket.OPEN) continue;
    try {
      socket.send(json);
    } catch {
      clients.delete(socket);
    }
  }
}

/** Push a one-off event (stream up/down, relay change) outside the tick cadence. */
export function pushEvent(event, data) {
  broadcast({ type: 'event', event, data, ts: Date.now() });
}

export function wsClientCount() {
  return clients.size;
}

export function closeWebSocket() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  for (const socket of clients) socket.close(1001, 'server shutting down');
  clients.clear();
  wss?.close();
  log.info('websocket hub closed');
}

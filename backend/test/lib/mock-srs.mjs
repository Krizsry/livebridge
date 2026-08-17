/**
 * Live Bridge - mock SRS HTTP API.
 *
 * Serves the three endpoints the backend polls. State is mutable so a suite can
 * change what SRS "reports" mid-test (publisher vanishes, publish.active flips
 * to false, a relay pull appears in the client list).
 *
 * KNOWN LIMIT, stated so nobody over-trusts a green run: this mock has no vhost
 * concept, no URI parser and no SRT stack. Three of the worst bugs in this
 * project's history - the hostname-underscore parse failure, `srt disabled` on
 * the vhost, and the HLS master-playlist path collision - were all invisible to
 * a mock and only ever surfaced against the real container. Passing here means
 * the backend's logic is right, not that the stack works.
 */

import http from 'node:http';

export function livePublisherFixture(overrides = {}) {
  return {
    id: 'vid-1',
    name: 'studio_a',
    vhost: '__defaultVhost__',
    app: 'live',
    live_ms: 42000,
    clients: 2,
    recv_bytes: 15_000_000,
    kbps: { recv_30s: 4500, send_30s: 9000 },
    publish: { active: true, cid: 'pub-1' },
    video: {
      codec: 'H264', width: 1920, height: 1080, fps: 30, profile: 'High',
    },
    audio: { codec: 'AAC', sample_rate: 48000, channel: 2 },
    ...overrides,
  };
}

export function publisherClientFixture(overrides = {}) {
  return {
    id: 'pub-1',
    vhost: '__defaultVhost__',
    // TRAP encoded as a fixture: `stream` is SRS's internal object id and never
    // matches a stream key. `name` carries the real one. See poller.clientStreamKey.
    stream: 'vid-1',
    name: 'studio_a',
    url: '/live/studio_a',
    app: 'live',
    ip: '203.0.113.50',
    type: 'srt-publish',
    publish: true,
    alive: 42,
    ...overrides,
  };
}

export function viewerClientFixture(overrides = {}) {
  return {
    id: 'view-1',
    vhost: '__defaultVhost__',
    stream: 'vid-1',
    name: 'studio_a',
    url: '/live/studio_a',
    app: 'live',
    ip: '198.51.100.10',
    type: 'hls-play',
    publish: false,
    alive: 12,
    ...overrides,
  };
}

/**
 * @returns {{ state: {streams: object[], clients: object[]}, port: number,
 *             url: string, requests: string[], close: () => Promise<void> }}
 */
export async function startMockSrs(port, initial = {}) {
  const state = {
    streams: initial.streams ?? [],
    clients: initial.clients ?? [],
    version: initial.version ?? '6.0.mock',
  };
  const requests = [];

  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/api/v1/versions')) {
      res.end(JSON.stringify({ code: 0, data: { version: state.version } }));
    } else if (req.url.startsWith('/api/v1/streams')) {
      res.end(JSON.stringify({ code: 0, streams: state.streams }));
    } else if (req.url.startsWith('/api/v1/clients')) {
      res.end(JSON.stringify({ code: 0, clients: state.clients }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));

  return {
    state,
    requests,
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

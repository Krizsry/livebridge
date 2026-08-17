import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Live Bridge - WebSocket feed for sub-second stream metrics.
 *
 * Why this and not Supabase Realtime: the numbers are produced locally by the
 * backend once a second. Round-tripping them through Supabase would add a WAN
 * hop and make the live view depend on an external service that must never be
 * load-bearing (requirement 21). See backend/src/ws.js for the full rationale.
 *
 * Reconnects with exponential backoff so a backend restart or a laptop waking
 * from sleep recovers on its own, without a page refresh.
 */
export function useLiveData() {
  const [data, setData] = useState({ streams: [], relays: [], engine: {}, viewer_total: 0 });
  const [connection, setConnection] = useState('connecting');
  const [lastUpdate, setLastUpdate] = useState(null);

  const socketRef = useRef(null);
  const attemptRef = useRef(0);
  const timerRef = useRef(null);
  const closedByUs = useRef(false);
  // Mirrors lastUpdate. The staleness check reads this instead of the state
  // value so its interval does not depend on a value that changes every second.
  const lastUpdateRef = useRef(null);

  const connect = useCallback(() => {
    if (closedByUs.current) return;

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/ws`;

    let socket;
    try {
      socket = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    socketRef.current = socket;

    socket.onopen = () => {
      attemptRef.current = 0;
      setConnection('connected');
    };

    socket.onmessage = (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (msg.type === 'snapshot' || msg.type === 'tick') {
        setData(msg.data);
        lastUpdateRef.current = Date.now();
        setLastUpdate(lastUpdateRef.current);
      }
    };

    socket.onclose = () => {
      if (closedByUs.current) return;
      setConnection('reconnecting');
      scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose always follows, so the reconnect is scheduled there.
      socket.close();
    };

    function scheduleReconnect() {
      attemptRef.current += 1;
      const delay = Math.min(1000 * 2 ** Math.min(attemptRef.current - 1, 5), 30000);
      timerRef.current = setTimeout(connect, delay);
    }
  }, []);

  useEffect(() => {
    closedByUs.current = false;
    connect();
    return () => {
      closedByUs.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      socketRef.current?.close();
    };
  }, [connect]);

  /**
   * Force an immediate reconnect, for the header's Refresh control.
   *
   * Backoff can leave the socket waiting up to 30 s after a backend restart, and
   * an operator who can see the feed is stale should not have to sit through
   * that or reload the page. Clearing the pending timer and resetting the
   * attempt counter makes the retry immediate rather than queued behind it.
   */
  const reconnect = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    attemptRef.current = 0;
    setConnection('connecting');

    const socket = socketRef.current;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      // onclose would schedule its own backoff reconnect and race this one, so
      // detach the handler before closing.
      socket.onclose = null;
      socket.close();
    }
    connect();
  }, [connect]);

  // If frames stop arriving but the socket stays open, surface it as stale
  // rather than silently showing frozen numbers as if they were current.
  // Mounted once. Depending on `lastUpdate` tore this interval down and rebuilt
  // it on every single tick - 1 Hz of clearInterval/setInterval churn for a check
  // that only ever needs to run every 2 s.
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const id = setInterval(() => {
      const last = lastUpdateRef.current;
      setStale(last !== null && Date.now() - last > 6000);
    }, 2000);
    return () => clearInterval(id);
  }, []);

  return { data, connection, stale, lastUpdate, reconnect };
}

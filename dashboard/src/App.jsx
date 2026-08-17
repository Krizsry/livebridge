import React, { useCallback, useEffect, useState } from 'react';
import { useLiveData } from './hooks/useLiveData.js';
import { api } from './api.js';
import { StreamList, RelayList } from './components/StreamList.jsx';
import { SessionHistory } from './components/SessionHistory.jsx';
import { Destinations } from './components/Destinations.jsx';
import { StreamKeys } from './components/StreamKeys.jsx';
import { Endpoints } from './components/Endpoints.jsx';
import { Preview } from './components/Preview.jsx';
import { Panel } from './components/common.jsx';
import { timeOnly } from './format.js';

/**
 * Live Bridge dashboard.
 *
 * No login screen by design (requirement 12) - this assumes network-level
 * access control (firewall / VPN). See the README's security section.
 */
export default function App() {
  const { data, connection, stale, reconnect } = useLiveData();
  const [config, setConfig] = useState(null);
  // Distinguishes "not loaded yet" from "failed to load". Without it a failed
  // /api/config left the Endpoints panel showing "Loading…" forever, with no way
  // to tell a slow request from a dead one.
  const [configError, setConfigError] = useState(null);
  const [health, setHealth] = useState(null);
  // Owned here, not inside Preview, so a stream card's Preview button can select
  // which feed the player shows.
  const [previewKey, setPreviewKey] = useState(null);
  // Bumped by the header's Refresh control. Panels that own fetched (rather than
  // WebSocket-pushed) data watch this and reload, so one click refreshes the
  // whole page's data without an actual browser reload.
  const [refreshToken, setRefreshToken] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    api.getConfig()
      .then((c) => { setConfig(c); setConfigError(null); })
      .catch((err) => { setConfig(null); setConfigError(err?.message || 'Backend unreachable'); });
  }, [refreshToken]);

  useEffect(() => {
    const poll = () => api.getHealth().then(setHealth).catch(() => setHealth(null));
    poll();
    const id = setInterval(poll, 15000);
    return () => clearInterval(id);
  }, [refreshToken]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    reconnect();
    setRefreshToken((n) => n + 1);
    // Purely cosmetic: without a floor the spinner can vanish before it is
    // visible, making the button feel unresponsive even though it worked.
    setTimeout(() => setRefreshing(false), 600);
  }, [reconnect]);

  // Selecting from a stream card scrolls the player into view - otherwise the
  // button appears to do nothing when the Preview panel is below the fold.
  const handlePreview = useCallback((key) => {
    setPreviewKey(key);
    document.getElementById('stream-preview')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, []);

  const streams = data.streams || [];
  const relays = data.relays || [];
  const liveStreamKeys = streams.map((s) => s.stream_key);

  const srtCount = streams.filter((s) => s.protocol === 'SRT').length;
  const rtmpCount = streams.filter((s) => s.protocol === 'RTMP').length;

  return (
    <div className="min-h-screen">
      <Header
        connection={connection}
        stale={stale}
        health={health}
        streamCount={streams.length}
        viewerCount={data.viewer_total || 0}
        srtCount={srtCount}
        rtmpCount={rtmpCount}
        onRefresh={handleRefresh}
        refreshing={refreshing}
      />

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        <StreamList
          streams={streams}
          engine={data.engine || {}}
          registry={data.registry || {}}
          onPreview={handlePreview}
        />

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <div id="stream-preview">
            <Preview streams={streams} selected={previewKey} onSelect={setPreviewKey} />
          </div>

          <Panel
            title="Active Relays"
            subtitle="Outbound republishing to external platforms"
            actions={<span className="text-xs text-slate-500">{relays.length} relay(s)</span>}
          >
            <RelayList
              relays={relays}
              onStop={(destinationId) => api.stopDestination(destinationId).catch(() => {})}
            />
          </Panel>

          <Endpoints config={config} error={configError} />
        </div>

        <Destinations liveStreamKeys={liveStreamKeys} relays={relays} refreshToken={refreshToken} />
        <StreamKeys liveStreamKeys={liveStreamKeys} refreshToken={refreshToken} />
        <SessionHistory refreshToken={refreshToken} />
      </main>

      <footer className="max-w-7xl mx-auto px-4 pb-8 pt-2">
        <p className="text-[11px] text-slate-600">
          Live Bridge — SRT + RTMP ingest, HLS output, protocol bridging.
          No application-level authentication: restrict access with a firewall or VPN.
        </p>
      </footer>
    </div>
  );
}

function Header({
  connection, stale, health, streamCount, viewerCount, srtCount, rtmpCount,
  onRefresh, refreshing,
}) {
  const engineOk = health?.engine?.srs_reachable;
  const supabaseOk = health?.supabase?.available;
  const supabaseConfigured = health?.supabase?.configured;

  // The clock ticks on its own timer. It used to render `new Date()` inline,
  // which meant it only advanced when something else re-rendered the header - so
  // the instant the WebSocket dropped, it froze showing a stale time as if it
  // were current. A frozen clock is worse than no clock: it misleads precisely
  // when an operator glances at it to check whether the page is still live.
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="sticky top-0 z-10 bg-bridge-bg/95 backdrop-blur border-b border-bridge-border">
      <div className="max-w-7xl mx-auto px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-3">
          {/* The logo carries the wordmark, so the h1 wraps the image and takes
              its accessible name from the alt text rather than repeating it
              visibly. width/height are the asset's intrinsic pixels: without
              them the header reflows once the PNG decodes.

              This is the dark-surface variant of the logo - the navy ink of the
              original is remapped to slate. The full-colour original
              (/livebridge-logo.png) is for light backgrounds only; on
              bg-bridge-bg (#0b1017) its wordmark is effectively invisible. */}
          <h1 className="leading-none">
            <img
              src="/livebridge-logo-dark.png"
              alt="Live Bridge"
              width={660}
              height={152}
              className="h-10 w-auto"
            />
          </h1>
          <p className="hidden sm:block text-[10px] text-slate-500 leading-tight
                        border-l border-bridge-border pl-3">
            SRT + RTMP<br />streaming server
          </p>
        </div>

        <div className="flex items-center gap-4 text-xs">
          <Stat label="Streams" value={streamCount} detail={`${srtCount} SRT / ${rtmpCount} RTMP`} />
          <Stat label="Viewers" value={viewerCount} />
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Indicator
            ok={connection === 'connected' && !stale}
            warn={connection === 'reconnecting' || stale}
            label={stale ? 'Live feed stale' : (connection === 'connected' ? 'Live' : connection)}
            title="WebSocket connection to the backend"
          />
          <Indicator
            ok={engineOk}
            label={engineOk ? 'Engine OK' : 'Engine down'}
            title="SRS SRT/RTMP engine reachability"
          />
          {supabaseConfigured ? (
            <Indicator
              ok={supabaseOk}
              warn={!supabaseOk}
              label={supabaseOk ? 'Supabase OK' : 'Supabase down'}
              title={supabaseOk
                ? 'History and config storage available'
                : 'History unavailable - live ingest is unaffected'}
            />
          ) : (
            <Indicator
              warn
              label="Supabase off"
              title="Supabase is not configured. Live streaming works; history and stored config do not."
            />
          )}
          {health?.uptime_sec !== undefined && (
            <span className="text-[11px] text-slate-600 font-mono" title="Backend uptime">
              up {Math.floor(health.uptime_sec / 3600)}h{Math.floor((health.uptime_sec % 3600) / 60)}m
            </span>
          )}
          <span className="text-[11px] text-slate-700 font-mono">{timeOnly(now)}</span>

          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded border border-bridge-border
                       bg-bridge-panel text-[11px] text-slate-300 hover:text-slate-100
                       hover:border-slate-600 disabled:opacity-60 transition-colors"
            title="Reconnect the live feed and reload history, stream keys and destinations"
          >
            <svg
              viewBox="0 0 16 16"
              className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <path d="M14 8a6 6 0 1 1-1.76-4.24" strokeLinecap="round" />
              <path d="M14 2v4h-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Refresh
          </button>
        </div>
      </div>
    </header>
  );
}

function Stat({ label, value, detail }) {
  return (
    <div className="leading-tight">
      <div className="lb-label">{label}</div>
      <div className="font-mono text-slate-100">
        {value}
        {detail && <span className="ml-2 text-[10px] text-slate-600">{detail}</span>}
      </div>
    </div>
  );
}

function Indicator({ ok, warn, label, title }) {
  const style = ok
    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
    : (warn
      ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
      : 'border-red-500/40 bg-red-500/10 text-red-300');

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded border text-[11px] ${style}`}
      title={title}
    >
      <span className={`w-1.5 h-1.5 rounded-full bg-current ${ok ? 'animate-pulse-slow' : ''}`} />
      {label}
    </span>
  );
}

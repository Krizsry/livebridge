import React, { useState } from 'react';
import {
  Panel, StatusPill, ProtocolBadge, Metric, Sparkline, EmptyState, DegradedNotice,
} from './common.jsx';
import { bitrate, duration, bytes, timeOnly } from '../format.js';

/**
 * Live publishers (requirement 10): stream ID/key, protocol, source IP,
 * connection mode, bitrate, latency, SRT packet loss, uptime and status - plus
 * the viewer list per stream.
 */
export function StreamList({
  streams = [], engine = {}, registry = {}, onPreview,
}) {
  // `mode` separates two states that used to look identical (#9):
  //   'disabled'    - Supabase is not configured at all. Nothing is wrong; the
  //                   registry is simply not part of this install.
  //   'unavailable' - it IS configured but cannot be reached right now. That is
  //                   a genuine outage and the operator should see it.
  // Both left `loadedOk` false, so previously EVERY stream wore an amber
  // UNVERIFIED badge on a perfectly healthy no-Supabase install - permanent
  // amber that an operator learns to ignore, which is worse than no warning.
  const registryDisabled = registry.mode === 'disabled';
  const registryUnavailable = registry.mode === 'unavailable';
  if (!engine.srs_reachable) {
    return (
      <Panel title="Live Publishers" subtitle="Streams currently being ingested">
        <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-3 text-sm text-red-200">
          <p className="font-medium">Streaming engine unreachable</p>
          <p className="text-xs mt-1 text-red-300/80">
            The backend cannot reach SRS on its API port. Ingest may still be running -
            this only means live statistics are unavailable.
            {engine.last_error ? ` Last error: ${engine.last_error}` : ''}
          </p>
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="Live Publishers"
      subtitle="Streams currently being ingested over SRT or RTMP"
      actions={<span className="text-xs text-slate-500">{streams.length} active</span>}
    >
      {(registryDisabled || registryUnavailable) && (
        <div className="mb-3">
          <DegradedNotice>
            {registryDisabled ? (
              <>
                <strong>Stream-key registry disabled.</strong> Supabase is not configured, so
                publishers cannot be checked against a registered key list. Any stream key is
                accepted. This is a configuration state, not a fault.
              </>
            ) : (
              <>
                <strong>Stream-key registry unavailable.</strong> Supabase is configured but
                unreachable, so publishers are being admitted from the last-known cache
                {typeof registry.cached_keys === 'number' ? ` (${registry.cached_keys} cached)` : ''}.
                Ingest is unaffected.
              </>
            )}
          </DegradedNotice>
        </div>
      )}

      {streams.length === 0 ? (
        <EmptyState
          title="No publishers connected"
          hint="Point vMix, Kiloview, OBS or Resi at the SRT or RTMP endpoint shown in the Endpoints panel."
        />
      ) : (
        <div className="space-y-3">
          {streams.map((s) => (
            <StreamCard
              key={s.stream_key}
              stream={s}
              onPreview={onPreview}
              // The per-stream badge is meaningless when the registry is switched
              // off - it would be on every card, always. The panel notice above
              // says it once instead.
              showUnverified={!registryDisabled}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

function StreamCard({ stream, onPreview, showUnverified = true }) {
  const [showViewers, setShowViewers] = useState(false);
  const m = stream.metrics || {};

  // Packet loss thresholds chosen for contribution feeds: under 0.5% is fine,
  // over 2% is visible to the audience.
  const lossTone = m.packet_loss_pct === null || m.packet_loss_pct === undefined
    ? 'muted'
    : (m.packet_loss_pct >= 2 ? 'bad' : (m.packet_loss_pct >= 0.5 ? 'warn' : 'good'));

  return (
    <article className="bg-bridge-raised border border-bridge-border rounded-lg overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 border-b border-bridge-border/70">
        <ProtocolBadge protocol={stream.protocol} />
        <h3 className="font-mono text-sm text-slate-100 font-medium">{stream.stream_key}</h3>
        <StatusPill status={stream.status} />
        {showUnverified && !stream.authorized && (
          <span
            className="px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-300"
            title="Admitted while the stream-key registry was unavailable (AUTH_FAILURE_MODE=open)"
          >
            UNVERIFIED
          </span>
        )}
        <div className="ml-auto flex items-center gap-3 text-xs text-slate-500">
          <span title="Source IP address">{stream.source_ip || 'unknown IP'}</span>
          <span className="text-slate-700">|</span>
          <span title="SRT connection mode / RTMP push">{stream.connection_mode}</span>
        </div>
      </div>

      <div className="px-4 py-3 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
        <Metric label="Bitrate" value={bitrate(m.bitrate_kbps)} />
        <Metric label="Avg bitrate" value={bitrate(m.avg_bitrate_kbps)} />
        <Metric label="Uptime" value={duration(m.uptime_sec)} />
        {/* Latency: prefer a real measurement (FFmpeg ingest jobs report one).
            Falling back to the configured SRT buffer depth is not a
            measurement, so it is labelled "set" and toned down - never dressed
            up as something that was observed. */}
        <Metric
          label="Latency"
          value={m.latency_ms !== null && m.latency_ms !== undefined
            ? `${m.latency_ms} ms`
            : (m.configured_latency_ms ? `${m.configured_latency_ms} ms` : 'n/a')}
          suffix={m.latency_ms === null && m.configured_latency_ms ? 'set' : undefined}
          tone={m.latency_ms === null ? 'muted' : 'default'}
          hint={m.latency_ms !== null && m.latency_ms !== undefined
            ? 'Measured by the FFmpeg ingest job'
            : (m.configured_latency_ms
              ? `Configured SRT receive-buffer target (SRT_LATENCY_MS=${m.configured_latency_ms}), `
                + 'not a live measurement. SRS 6.x does not report per-connection SRT latency.'
              : 'No latency figure exists for this ingest path')}
        />
        <Metric
          label="Packet loss"
          value={m.packet_loss_pct === null || m.packet_loss_pct === undefined
            ? 'not reported' : `${m.packet_loss_pct}%`}
          tone={lossTone}
          hint={m.packet_loss_pct === null
            ? 'SRS 6.x exposes no packet-loss counter for its native SRT listener. Shown as '
              + '"not reported" rather than 0% so a healthy-looking figure is never invented. '
              + 'Watch bitrate stability and reconnect count instead.'
            : undefined}
        />
        <Metric label="Viewers" value={m.viewer_count ?? 0} />
      </div>

      <div className="px-4 pb-3">
        <Sparkline points={stream.history} />
      </div>

      <div className="px-4 py-2 border-t border-bridge-border/70 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
        <span>{bytes(m.bytes_received)} received</span>
        {m.video && (
          <span>
            {m.video.codec} {m.video.width}×{m.video.height}
            {m.video.fps ? ` @ ${m.video.fps}fps` : ''}
          </span>
        )}
        {m.audio && <span>{m.audio.codec} {m.audio.sample_rate}Hz</span>}
        {stream.reconnect_count > 0 && (
          <span className="text-amber-400">{stream.reconnect_count} reconnect(s)</span>
        )}

        {/* These were <a href> links to the .m3u8 and .flv URLs. No browser can
            play either natively - Flash is gone and .m3u8 only plays in Safari -
            so clicking one started an ever-growing download instead of showing
            the stream. That is what the Preview panel was built to solve, but
            the links stayed and kept doing it. They are now a button that points
            the Preview panel at this stream, plus copy actions for anyone who
            wants the URL for VLC or ffplay. */}
        <div className="ml-auto flex items-center gap-3">
          {onPreview && stream.status === 'online' && (
            <button
              type="button"
              onClick={() => onPreview(stream.stream_key)}
              className="text-bridge-accent hover:underline"
              title="Show this stream in the Stream Preview panel"
            >
              Preview
            </button>
          )}
          <CopyUrlButton
            label="Copy HLS"
            path={stream.hls_url}
            title="Copy the HLS playlist URL - plays in VLC, ffplay or Safari"
          />
          <CopyUrlButton
            label="Copy FLV"
            path={stream.flv_url}
            title="Copy the HTTP-FLV URL - lower latency than HLS; plays in VLC or ffplay"
          />
          <button
            type="button"
            onClick={() => setShowViewers((v) => !v)}
            className="text-slate-400 hover:text-slate-200"
          >
            {showViewers ? 'Hide' : 'Show'} viewers ({stream.viewers?.length ?? 0})
          </button>
        </div>
      </div>

      {showViewers && (
        <ViewerTable viewers={stream.viewers || []} />
      )}
    </article>
  );
}

/**
 * Copies a playback URL instead of navigating to it.
 *
 * The stored value is absolute (origin + path) because the point of copying is
 * to paste it into VLC or ffplay, where a bare "/hls/live/key.m3u8" is useless.
 */
function CopyUrlButton({ label, path, title }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${path}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access needs a secure context; a self-signed cert that the
      // browser has not accepted will refuse it. Say nothing rather than
      // claiming a copy that did not happen.
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      className="text-bridge-accent hover:underline"
      title={title}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

function ViewerTable({ viewers }) {
  if (viewers.length === 0) {
    return (
      <div className="px-4 py-3 border-t border-bridge-border/70 text-xs text-slate-600">
        No viewers connected to this stream.
      </div>
    );
  }

  return (
    <div className="border-t border-bridge-border/70 overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-slate-500 border-b border-bridge-border/70">
            <th className="px-4 py-2 font-medium">Client</th>
            <th className="px-4 py-2 font-medium">Protocol</th>
            <th className="px-4 py-2 font-medium">Source IP</th>
            <th className="px-4 py-2 font-medium">Connected for</th>
          </tr>
        </thead>
        <tbody>
          {viewers.map((v) => (
            <tr key={v.client_id} className="border-b border-bridge-border/40 last:border-0">
              <td className="px-4 py-2 font-mono text-slate-400">{v.client_id}</td>
              <td className="px-4 py-2"><ProtocolBadge protocol={v.protocol} /></td>
              <td className="px-4 py-2 font-mono text-slate-400">{v.source_ip || 'unknown'}</td>
              <td className="px-4 py-2 font-mono text-slate-400">{duration(v.connected_since_sec)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Compact relay + ingest status list. */
export function RelayList({ relays = [], onStop }) {
  if (relays.length === 0) {
    return (
      <EmptyState
        title="No relays running"
        hint="Relays start automatically when a destination's source stream goes live."
      />
    );
  }

  return (
    <div className="space-y-2">
      {relays.map((r) => (
        <div
          key={r.id}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-bridge-raised border border-bridge-border rounded px-3 py-2"
        >
          <StatusPill status={r.status} />
          <span className="text-sm text-slate-200">{r.name || r.source_stream_key}</span>
          <span className="text-xs text-slate-500 font-mono">
            {r.source_stream_key} → {r.target_host}
          </span>
          <div className="ml-auto flex items-center gap-3 text-xs text-slate-500">
            <span className="font-mono">{bitrate(r.stats?.bitrate_kbps)}</span>
            {r.stats?.dropped_frames > 0 && (
              <span className="text-amber-400">{r.stats.dropped_frames} dropped</span>
            )}
            {r.restarts > 0 && <span className="text-amber-400">{r.restarts} restart(s)</span>}
            <span>{r.started_at ? timeOnly(r.started_at) : ''}</span>
            {onStop && (r.status === 'running' || r.status === 'retrying') && (
              <button type="button" onClick={() => onStop(r.destination_id)} className="lb-btn-ghost text-[11px] px-2 py-1">
                Stop
              </button>
            )}
          </div>
          {r.last_error && r.status !== 'running' && (
            <p className="w-full text-[11px] text-red-300/80 font-mono truncate" title={r.last_error}>
              {r.last_error}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

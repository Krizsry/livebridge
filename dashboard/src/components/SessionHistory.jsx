import React, { useEffect, useState, useCallback } from 'react';
import { Panel, EmptyState, DegradedNotice, ProtocolBadge } from './common.jsx';
import { bitrate, duration, timestamp } from '../format.js';
import { api } from '../api.js';

/**
 * Historical log of past sessions (requirement 10).
 *
 * Backed by Supabase through the backend. When Supabase is unreachable the
 * endpoint answers 200 with `degraded: true`, and this panel renders
 * "History unavailable" rather than an error - live streaming is unaffected
 * (requirement 21).
 */
export function SessionHistory({ refreshToken = 0 }) {
  const [state, setState] = useState({ sessions: [], degraded: false, loading: true, error: null });
  const [protocolFilter, setProtocolFilter] = useState('');

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const res = await api.getSessions({ limit: 100, protocol: protocolFilter || undefined });
      setState({
        sessions: res.sessions || [],
        degraded: Boolean(res.degraded),
        reason: res.reason,
        loading: false,
        error: null,
      });
    } catch (err) {
      setState({ sessions: [], degraded: false, loading: false, error: err.message });
    }
  }, [protocolFilter]);

  // `refreshToken` changes when the header's Refresh control is used, which
  // reloads this panel on demand instead of waiting out the 30 s interval.
  useEffect(() => {
    load();
    // History is durable data, not live telemetry - a 30 s refresh is plenty and
    // keeps load off Supabase.
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load, refreshToken]);

  return (
    <Panel
      title="Session History"
      subtitle="Past publisher sessions, stored in Supabase"
      actions={(
        <>
          <select
            value={protocolFilter}
            onChange={(e) => setProtocolFilter(e.target.value)}
            className="bg-bridge-bg border border-bridge-border rounded px-2 py-1 text-xs text-slate-300"
            aria-label="Filter by protocol"
          >
            <option value="">All protocols</option>
            <option value="SRT">SRT only</option>
            <option value="RTMP">RTMP only</option>
          </select>
          <button type="button" onClick={load} className="lb-btn-ghost text-xs">Refresh</button>
        </>
      )}
    >
      {state.degraded && (
        <div className="mb-3">
          <DegradedNotice>
            <strong>History unavailable.</strong>{' '}
            {state.reason || 'Supabase is unreachable.'} Live ingest and the dashboard&apos;s
            real-time view are unaffected - only stored history is missing.
          </DegradedNotice>
        </div>
      )}

      {state.error && (
        <div className="mb-3">
          <DegradedNotice>History could not be loaded: {state.error}</DegradedNotice>
        </div>
      )}

      {state.loading && state.sessions.length === 0 && (
        <p className="py-6 text-center text-sm text-slate-500">Loading history…</p>
      )}

      {!state.loading && state.sessions.length === 0 && !state.degraded && !state.error && (
        <EmptyState
          title="No past sessions recorded"
          hint="Sessions are written when a publisher connects and closed when it disconnects."
        />
      )}

      {state.sessions.length > 0 && (
        <div className="overflow-x-auto -mx-4 px-4">
          <table className="w-full text-xs min-w-[52rem]">
            <thead>
              <tr className="text-left text-slate-500 border-b border-bridge-border">
                <th className="py-2 pr-4 font-medium">Stream</th>
                <th className="py-2 pr-4 font-medium">Protocol</th>
                <th className="py-2 pr-4 font-medium">Mode</th>
                <th className="py-2 pr-4 font-medium">Source IP</th>
                <th className="py-2 pr-4 font-medium">Started</th>
                <th className="py-2 pr-4 font-medium">Ended</th>
                <th className="py-2 pr-4 font-medium">Duration</th>
                <th className="py-2 pr-4 font-medium">Avg bitrate</th>
                <th className="py-2 font-medium">End reason</th>
              </tr>
            </thead>
            <tbody>
              {state.sessions.map((s) => (
                <tr key={s.id} className="border-b border-bridge-border/40 last:border-0">
                  <td className="py-2 pr-4 font-mono text-slate-200">{s.stream_key}</td>
                  <td className="py-2 pr-4">
                    {s.protocol ? <ProtocolBadge protocol={s.protocol} /> : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="py-2 pr-4 text-slate-400">{s.connection_mode || '—'}</td>
                  <td className="py-2 pr-4 font-mono text-slate-400">{s.source_ip || '—'}</td>
                  <td className="py-2 pr-4 text-slate-400 whitespace-nowrap">{timestamp(s.started_at)}</td>
                  <td className="py-2 pr-4 text-slate-400 whitespace-nowrap">
                    {s.ended_at ? timestamp(s.ended_at) : <span className="text-emerald-400">live</span>}
                  </td>
                  <td className="py-2 pr-4 font-mono text-slate-300">{duration(s.duration_sec)}</td>
                  <td className="py-2 pr-4 font-mono text-slate-300">{bitrate(s.avg_bitrate_kbps)}</td>
                  <td className="py-2 text-slate-500">{s.end_reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

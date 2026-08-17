import React, { useEffect, useState, useCallback } from 'react';
import { Panel, EmptyState, DegradedNotice, ErrorNotice, StatusPill } from './common.jsx';
import { api } from '../api.js';

/**
 * "Add new stream destination" UI (requirement 10) - configure external RTMP
 * relay targets such as a YouTube ingest URL + key.
 *
 * Security note: the backend never sends the platform stream key back to the
 * browser, only a masked form. There is no login on this dashboard, so a key
 * echoed into an API response would be readable by anyone who reached the page.
 */

const PLATFORM_PRESETS = {
  youtube: {
    label: 'YouTube Live',
    url: 'rtmp://a.rtmp.youtube.com/live2',
    hint: 'Stream key from YouTube Studio → Go Live → Stream settings.',
  },
  facebook: {
    label: 'Facebook Live',
    url: 'rtmps://live-api-s.facebook.com:443/rtmp',
    hint: 'Stream key from Facebook Live Producer. Facebook requires RTMPS.',
  },
  twitch: {
    label: 'Twitch',
    url: 'rtmp://live.twitch.tv/app',
    hint: 'Stream key from the Twitch creator dashboard. Use your nearest ingest server.',
  },
  custom: {
    label: 'Custom RTMP / SRT',
    url: '',
    hint: 'Any rtmp://, rtmps:// or srt:// endpoint.',
  },
};

export function Destinations({ liveStreamKeys = [], relays = [], refreshToken = 0 }) {
  const [state, setState] = useState({ destinations: [], degraded: false, loading: true });
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.getDestinations();
      setState({
        destinations: res.destinations || [],
        degraded: Boolean(res.degraded),
        reason: res.reason,
        loading: false,
      });
    } catch (err) {
      setState({ destinations: [], degraded: true, reason: err.message, loading: false });
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
    // refreshToken changes when the header's Refresh control is used.
  }, [load, refreshToken]);

  const relayFor = (destinationId) => relays.find((r) => r.destination_id === destinationId);

  const act = async (fn, ...args) => {
    setError(null);
    try {
      await fn(...args);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Panel
      title="Relay Destinations"
      subtitle="Republish any incoming stream to YouTube, Facebook, Twitch or any RTMP/SRT endpoint"
      actions={(
        <button type="button" onClick={() => setShowForm((v) => !v)} className="lb-btn-primary text-xs">
          {showForm ? 'Cancel' : '+ Add destination'}
        </button>
      )}
    >
      <div className="space-y-3">
        {state.degraded && (
          <DegradedNotice>
            {state.reason || 'Supabase is unreachable.'} Destinations cannot be added or changed
            until it recovers. Relays that are already running keep running.
          </DegradedNotice>
        )}

        <ErrorNotice onDismiss={() => setError(null)}>{error}</ErrorNotice>

        {showForm && (
          <DestinationForm
            liveStreamKeys={liveStreamKeys}
            onCancel={() => setShowForm(false)}
            onSaved={async () => { setShowForm(false); await load(); }}
            onError={setError}
          />
        )}

        {!state.loading && state.destinations.length === 0 && !showForm && (
          <EmptyState
            title="No relay destinations configured"
            hint="Add one to forward a live stream on to an external platform. Relays start automatically when the source stream goes live."
          />
        )}

        {state.destinations.map((d) => {
          const relay = relayFor(d.id);
          return (
            <div key={d.id} className="bg-bridge-raised border border-bridge-border rounded px-3 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="text-sm text-slate-100 font-medium">{d.name}</span>
                <span className="px-1.5 py-0.5 rounded border border-bridge-border text-[10px] uppercase tracking-wide text-slate-400">
                  {d.platform}
                </span>
                {relay
                  ? <StatusPill status={relay.status} />
                  : <StatusPill status={d.enabled ? 'stopped' : 'offline'}>{d.enabled ? 'idle' : 'disabled'}</StatusPill>}

                <div className="ml-auto flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => act(api.startDestination, d.id)}
                    className="lb-btn-ghost text-[11px] px-2 py-1"
                    disabled={!d.enabled}
                    title={d.enabled ? 'Start relaying now' : 'Destination is disabled'}
                  >
                    Start
                  </button>
                  <button
                    type="button"
                    onClick={() => act(api.stopDestination, d.id)}
                    className="lb-btn-ghost text-[11px] px-2 py-1"
                  >
                    Stop
                  </button>
                  <button
                    type="button"
                    onClick={() => act(api.updateDestination, d.id, { enabled: !d.enabled })}
                    className="lb-btn-ghost text-[11px] px-2 py-1"
                  >
                    {d.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      // eslint-disable-next-line no-alert
                      if (window.confirm(`Delete destination "${d.name}"? Any running relay to it will stop.`)) {
                        act(api.deleteDestination, d.id);
                      }
                    }}
                    className="lb-btn-danger text-[11px] px-2 py-1"
                  >
                    Delete
                  </button>
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 font-mono">
                <span className="text-slate-400">{d.source_stream_key}</span>
                <span aria-hidden="true">→</span>
                <span>{d.url_masked}</span>
                {d.has_dest_stream_key && <span title="Stream key is stored on the backend and never sent to the browser">/{d.dest_stream_key_masked}</span>}
                {d.transcode && <span className="text-amber-400">transcoding</span>}
              </div>

              {relay?.last_error && relay.status !== 'running' && (
                <p className="mt-2 text-[11px] text-red-300/80 font-mono truncate" title={relay.last_error}>
                  {relay.last_error}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function DestinationForm({ liveStreamKeys, onCancel, onSaved, onError }) {
  const [platform, setPlatform] = useState('youtube');
  const [form, setForm] = useState({
    name: '',
    source_stream_key: '',
    url: PLATFORM_PRESETS.youtube.url,
    dest_stream_key: '',
    transcode: false,
  });
  const [saving, setSaving] = useState(false);

  const set = (field) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [field]: value }));
  };

  const changePlatform = (e) => {
    const next = e.target.value;
    setPlatform(next);
    setForm((f) => ({ ...f, url: PLATFORM_PRESETS[next].url }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    onError(null);
    try {
      await api.addDestination({ ...form, platform });
      await onSaved();
    } catch (err) {
      onError(err.field ? `${err.field}: ${err.message}` : err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="bg-bridge-bg border border-bridge-border rounded p-4 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="dest-name" className="lb-label block mb-1">Name</label>
          <input
            id="dest-name" className="lb-input" required value={form.name} onChange={set('name')}
            placeholder="Sunday service - YouTube"
          />
        </div>

        <div>
          <label htmlFor="dest-platform" className="lb-label block mb-1">Platform</label>
          <select id="dest-platform" className="lb-input" value={platform} onChange={changePlatform}>
            {Object.entries(PLATFORM_PRESETS).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="dest-source" className="lb-label block mb-1">Source stream key</label>
          <input
            id="dest-source" className="lb-input" required list="live-stream-keys"
            value={form.source_stream_key} onChange={set('source_stream_key')}
            placeholder="studio_a"
          />
          <datalist id="live-stream-keys">
            {liveStreamKeys.map((k) => <option key={k} value={k} />)}
          </datalist>
          <p className="text-[11px] text-slate-600 mt-1">
            The Live Bridge stream to forward. Works for both SRT and RTMP sources.
          </p>
        </div>

        <div>
          <label htmlFor="dest-url" className="lb-label block mb-1">Destination URL</label>
          <input
            id="dest-url" className="lb-input" required value={form.url} onChange={set('url')}
            placeholder="rtmp://a.rtmp.youtube.com/live2"
          />
          <p className="text-[11px] text-slate-600 mt-1">{PLATFORM_PRESETS[platform].hint}</p>
        </div>

        <div className="sm:col-span-2">
          <label htmlFor="dest-key" className="lb-label block mb-1">Platform stream key</label>
          <input
            id="dest-key" className="lb-input" type="password" autoComplete="off"
            value={form.dest_stream_key} onChange={set('dest_stream_key')}
            placeholder="xxxx-xxxx-xxxx-xxxx-xxxx"
          />
          <p className="text-[11px] text-slate-600 mt-1">
            Stored on the backend only. It is never sent back to this page - the list above
            shows a masked form.
          </p>
        </div>
      </div>

      <label className="flex items-start gap-2 text-xs text-slate-400">
        <input type="checkbox" checked={form.transcode} onChange={set('transcode')} className="mt-0.5" />
        <span>
          Transcode instead of passing through.{' '}
          <span className="text-slate-600">
            Leave off unless the platform rejects your source format - transcoding costs real CPU,
            pass-through costs almost none.
          </span>
        </span>
      </label>

      <div className="flex items-center gap-2 pt-1">
        <button type="submit" className="lb-btn-primary text-xs" disabled={saving}>
          {saving ? 'Saving…' : 'Add destination'}
        </button>
        <button type="button" onClick={onCancel} className="lb-btn-ghost text-xs">Cancel</button>
      </div>
    </form>
  );
}

import React, { useEffect, useState, useCallback } from 'react';
import { Panel, EmptyState, DegradedNotice, ErrorNotice, ProtocolBadge } from './common.jsx';
import { timestamp } from '../format.js';
import { api } from '../api.js';

/**
 * Registered stream IDs / stream keys - the authorisation registry.
 *
 * A key registered here is what an SRT stream ID or an RTMP stream key must
 * match for the publisher to be admitted (requirement 5). Adding a key takes
 * effect on the very next publish attempt: the backend mirrors the write into
 * its in-memory cache immediately.
 */
export function StreamKeys({ liveStreamKeys = [], refreshToken = 0 }) {
  const [state, setState] = useState({ keys: [], registry: {}, loading: true, degraded: false });
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.getKeys();
      setState({
        keys: res.keys || [],
        registry: res.registry || {},
        degraded: Boolean(res.degraded),
        loading: false,
      });
    } catch (err) {
      setState({ keys: [], registry: {}, degraded: true, loading: false });
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
    // refreshToken changes when the header's Refresh control is used.
  }, [load, refreshToken]);

  const act = async (fn, ...args) => {
    setError(null);
    try {
      await fn(...args);
      await load();
    } catch (err) {
      setError(err.field ? `${err.field}: ${err.message}` : err.message);
    }
  };

  const failOpen = state.registry?.auth_failure_mode === 'open';

  return (
    <Panel
      title="Registered Stream Keys"
      subtitle="Stream IDs (SRT) and stream keys (RTMP) permitted to publish"
      actions={(
        <button type="button" onClick={() => setShowForm((v) => !v)} className="lb-btn-primary text-xs">
          {showForm ? 'Cancel' : '+ Add stream key'}
        </button>
      )}
    >
      <div className="space-y-3">
        {state.degraded && (
          <DegradedNotice>
            <strong>Registry unavailable.</strong> Supabase is unreachable, so keys cannot be
            listed or changed.{' '}
            {failOpen
              ? 'AUTH_FAILURE_MODE is "open": publishers are currently admitted without verification and each one is logged at critical level.'
              : 'AUTH_FAILURE_MODE is "closed": new publishers are being rejected until the registry recovers.'}
          </DegradedNotice>
        )}

        <ErrorNotice onDismiss={() => setError(null)}>{error}</ErrorNotice>

        {showForm && (
          <StreamKeyForm
            onCancel={() => setShowForm(false)}
            onSaved={async () => { setShowForm(false); await load(); }}
            onError={setError}
          />
        )}

        {!state.loading && state.keys.length === 0 && !showForm && !state.degraded && (
          <EmptyState
            title="No stream keys registered"
            hint="Until a key is registered, publishers are rejected (or admitted unverified, depending on AUTH_FAILURE_MODE). Add one per encoder."
          />
        )}

        {state.keys.length > 0 && (
          <div className="overflow-x-auto -mx-4 px-4">
            <table className="w-full text-xs min-w-[44rem]">
              <thead>
                <tr className="text-left text-slate-500 border-b border-bridge-border">
                  <th className="py-2 pr-4 font-medium">Stream key</th>
                  <th className="py-2 pr-4 font-medium">Label</th>
                  <th className="py-2 pr-4 font-medium">Protocol</th>
                  <th className="py-2 pr-4 font-medium">Secret</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Added</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {state.keys.map((k) => {
                  const isLive = liveStreamKeys.includes(k.stream_key);
                  return (
                    <tr key={k.id} className="border-b border-bridge-border/40 last:border-0">
                      <td className="py-2 pr-4 font-mono text-slate-200">
                        {k.stream_key}
                        {isLive && <span className="ml-2 text-[10px] text-emerald-400">● live</span>}
                      </td>
                      <td className="py-2 pr-4 text-slate-400">{k.label}</td>
                      <td className="py-2 pr-4">
                        {k.protocol === 'ANY'
                          ? <span className="text-slate-500">SRT + RTMP</span>
                          : <ProtocolBadge protocol={k.protocol} />}
                      </td>
                      <td className="py-2 pr-4 text-slate-500">
                        {k.has_secret ? 'required' : <span className="text-slate-700">none</span>}
                      </td>
                      <td className="py-2 pr-4">
                        {k.enabled
                          ? <span className="text-emerald-400">enabled</span>
                          : <span className="text-slate-500">disabled</span>}
                      </td>
                      <td className="py-2 pr-4 text-slate-500 whitespace-nowrap">{timestamp(k.created_at)}</td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => act(api.updateKey, k.id, { enabled: !k.enabled })}
                          className="lb-btn-ghost text-[11px] px-2 py-1 mr-2"
                        >
                          {k.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            // eslint-disable-next-line no-alert
                            if (window.confirm(`Delete stream key "${k.stream_key}"? Any encoder using it will be rejected on its next connection.`)) {
                              act(api.deleteKey, k.id);
                            }
                          }}
                          className="lb-btn-danger text-[11px] px-2 py-1"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  );
}

function StreamKeyForm({ onCancel, onSaved, onError }) {
  const [form, setForm] = useState({
    stream_key: '', label: '', protocol: 'ANY', secret: '', notes: '',
  });
  const [saving, setSaving] = useState(false);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const generate = () => {
    // Crypto-strength suggestion, restricted to the character class the backend
    // accepts for stream keys.
    const bytesArr = new Uint8Array(12);
    crypto.getRandomValues(bytesArr);
    const suffix = [...bytesArr].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    setForm((f) => ({ ...f, stream_key: `stream_${suffix}` }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    onError(null);
    try {
      await api.addKey({
        ...form,
        secret: form.secret || undefined,
        notes: form.notes || undefined,
      });
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
          <label htmlFor="key-value" className="lb-label block mb-1">Stream key / stream ID</label>
          <div className="flex gap-2">
            <input
              id="key-value" className="lb-input" required value={form.stream_key}
              onChange={set('stream_key')} placeholder="studio_a"
              pattern="[A-Za-z0-9_-]{3,64}"
            />
            <button type="button" onClick={generate} className="lb-btn-ghost text-xs shrink-0">
              Generate
            </button>
          </div>
          <p className="text-[11px] text-slate-600 mt-1">
            3–64 characters, letters/digits/underscore/dash only.
          </p>
        </div>

        <div>
          <label htmlFor="key-label" className="lb-label block mb-1">Label</label>
          <input
            id="key-label" className="lb-input" required value={form.label}
            onChange={set('label')} placeholder="Studio A - vMix"
          />
        </div>

        <div>
          <label htmlFor="key-protocol" className="lb-label block mb-1">Allowed protocol</label>
          <select id="key-protocol" className="lb-input" value={form.protocol} onChange={set('protocol')}>
            <option value="ANY">SRT + RTMP</option>
            <option value="SRT">SRT only</option>
            <option value="RTMP">RTMP only</option>
          </select>
        </div>

        <div>
          <label htmlFor="key-secret" className="lb-label block mb-1">
            Extra secret <span className="text-slate-600 normal-case">(optional)</span>
          </label>
          <input
            id="key-secret" className="lb-input" type="password" autoComplete="off"
            value={form.secret} onChange={set('secret')} placeholder="min 8 characters"
          />
          <p className="text-[11px] text-slate-600 mt-1">
            If set, the encoder must also send <code className="font-mono">?secret=…</code> after
            the stream key.
          </p>
        </div>

        <div className="sm:col-span-2">
          <label htmlFor="key-notes" className="lb-label block mb-1">
            Notes <span className="text-slate-600 normal-case">(optional)</span>
          </label>
          <input
            id="key-notes" className="lb-input" value={form.notes} onChange={set('notes')}
            placeholder="Kiloview encoder in the sanctuary rack"
          />
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button type="submit" className="lb-btn-primary text-xs" disabled={saving}>
          {saving ? 'Saving…' : 'Add stream key'}
        </button>
        <button type="button" onClick={onCancel} className="lb-btn-ghost text-xs">Cancel</button>
      </div>
    </form>
  );
}

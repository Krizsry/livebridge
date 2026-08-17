import React, { useState, useEffect, useRef } from 'react';
import { Panel, CopyField } from './common.jsx';

/** How long a revealed passphrase stays on screen before re-masking. */
const REVEAL_SECONDS = 15;

/**
 * Connection strings for encoders. Reads the public config from the backend so
 * the hostname is never hardcoded into the bundle.
 *
 * Note the SRT passphrase is deliberately NOT shown: the backend reports only
 * whether encryption is on. The passphrase lives in .env on the server, and an
 * unauthenticated dashboard is exactly the wrong place to display it.
 */
export function Endpoints({ config, error }) {
  const [streamKey, setStreamKey] = useState('studio_a');
  const [passphrase, setPassphrase] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [passErr, setPassErr] = useState(null);
  const hideTimer = useRef(null);

  const canReveal = Boolean(config?.passphraseRevealEnabled);

  // Fetched on demand, never on mount: the passphrase should not be sitting in
  // browser memory (or in a devtools network log) just because someone opened
  // the dashboard to look at bitrates.
  async function loadPassphrase() {
    if (passphrase) return passphrase;
    try {
      const res = await fetch('/api/credentials');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!body.srt_passphrase) throw new Error('no passphrase configured');
      setPassphrase(body.srt_passphrase);
      setPassErr(null);
      return body.srt_passphrase;
    } catch (e) {
      setPassErr(e.message);
      return null;
    }
  }

  async function toggleReveal() {
    if (revealed) {
      setRevealed(false);
      return;
    }
    if (!(await loadPassphrase())) return;
    setRevealed(true);
  }

  // Re-mask on a timer, and clear it on unmount so a revealed passphrase can
  // never be left on a screen nobody is watching.
  useEffect(() => {
    if (!revealed) return undefined;
    hideTimer.current = setTimeout(() => setRevealed(false), REVEAL_SECONDS * 1000);
    return () => clearTimeout(hideTimer.current);
  }, [revealed]);

  // A failed /api/config used to be indistinguishable from a slow one - both
  // rendered "Loading…", so a dead backend looked like a pending request and the
  // panel sat there forever.
  if (error) {
    return (
      <Panel title="Encoder Endpoints">
        <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-3 text-sm text-red-200">
          <p className="font-medium">Endpoint configuration unavailable</p>
          <p className="text-xs mt-1 text-red-300/80">
            {error}. The connection strings below are built from the backend&apos;s public config,
            so they cannot be shown. Ingest itself is unaffected — this is the dashboard failing to
            read config, not the streaming engine. Use the Refresh control to retry.
          </p>
        </div>
      </Panel>
    );
  }

  if (!config) {
    return (
      <Panel title="Encoder Endpoints">
        <p className="text-sm text-slate-500">Loading endpoint configuration…</p>
      </Panel>
    );
  }

  const host = config.publicHost;
  const safeKey = streamKey.replace(/[^A-Za-z0-9_-]/g, '') || 'YOUR_STREAM_KEY';
  // Follow however the dashboard is actually being served. Hardcoding https://
  // handed out URLs that fail outright when the stack is reached over plain HTTP.
  const webScheme = window.location.protocol;

  const srtUrl = `srt://${host}:${config.srtPort}?streamid=#!::r=live/${safeKey},m=publish&latency=${config.srtLatencyMs}`;
  const rtmpUrl = `rtmp://${host}:${config.rtmpPort}/live`;
  const srtPlayUrl = `srt://${host}:${config.srtPort}?streamid=#!::r=live/${safeKey},m=request&latency=${config.srtLatencyMs}`;

  // OBS and FFmpeg have no separate passphrase input - the whole thing has to
  // live in the URL. vMix, Kiloview and Resi do have a field, so they use the
  // plain URL above and never need the passphrase embedded.
  const obsUrl = passphrase
    ? `${srtUrl}&passphrase=${encodeURIComponent(passphrase)}`
    : null;

  return (
    <Panel
      title="Encoder Endpoints"
      subtitle="Point vMix, Kiloview, OBS or Resi at one of these"
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="endpoint-key" className="lb-label block mb-1">Stream key to build URLs for</label>
          <input
            id="endpoint-key"
            className="lb-input font-mono"
            value={streamKey}
            onChange={(e) => setStreamKey(e.target.value)}
            placeholder="studio_a"
          />
        </div>

        <div className="space-y-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="lb-label">SRT ingest (listener mode)</span>
              {config.srtEncrypted ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
                  ENCRYPTED
                </span>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300">
                  NO PASSPHRASE SET
                </span>
              )}
            </div>
            <CopyField value={srtUrl} />
            <p className="text-[11px] text-slate-600 mt-1">
              Set your encoder to <strong>Caller</strong> mode.{' '}
              {config.srtEncrypted
                ? 'For vMix, Kiloview and Resi, paste this URL and put the passphrase in the encoder\'s own passphrase field.'
                : 'No passphrase is configured, so this stream is unencrypted.'}
            </p>
          </div>

          {config.srtEncrypted && (
            <div>
              <div className="lb-label mb-1">SRT passphrase</div>
              {canReveal ? (
                <>
                  <div className="flex items-center gap-2">
                    <code className="lb-input font-mono flex-1 truncate" aria-live="polite">
                      {revealed && passphrase ? passphrase : '•'.repeat(24)}
                    </code>
                    <button type="button" onClick={toggleReveal} className="lb-btn shrink-0">
                      {revealed ? 'Hide' : 'Reveal'}
                    </button>
                    <button
                      type="button"
                      className="lb-btn shrink-0"
                      onClick={async () => {
                        const p = await loadPassphrase();
                        if (p) navigator.clipboard?.writeText(p);
                      }}
                    >
                      Copy
                    </button>
                  </div>
                  {revealed && (
                    <p className="text-[11px] text-amber-400/80 mt-1">
                      Hides again in {REVEAL_SECONDS}s. Send it over Signal or a password-manager
                      link — never email or plain chat.
                    </p>
                  )}
                  {passErr && (
                    <p className="text-[11px] text-red-300 mt-1">
                      Could not read the passphrase: {passErr}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-[11px] text-slate-600">
                  Not shown. Set <code className="text-slate-400">EXPOSE_PASSPHRASE_IN_DASHBOARD=true</code>{' '}
                  in <code className="text-slate-400">.env</code> to enable the reveal control — only
                  safe while port 443 stays restricted to your LAN.
                </p>
              )}
            </div>
          )}

          {config.srtEncrypted && canReveal && (
            <div>
              <div className="lb-label mb-1">SRT for OBS / FFmpeg (passphrase included)</div>
              {obsUrl ? (
                <CopyField value={obsUrl} />
              ) : (
                <button
                  type="button"
                  className="lb-btn"
                  onClick={async () => {
                    const p = await loadPassphrase();
                    if (p) {
                      navigator.clipboard?.writeText(
                        `${srtUrl}&passphrase=${encodeURIComponent(p)}`,
                      );
                    }
                  }}
                >
                  Build &amp; copy OBS URL
                </button>
              )}
              <p className="text-[11px] text-slate-600 mt-1">
                <strong className="text-slate-500">OBS has no passphrase field</strong> — it must be
                in the URL. Paste this whole string into Settings → Stream → Server, and leave
                Stream Key empty. This link contains the passphrase, so treat it as a secret.
              </p>
            </div>
          )}

          <div>
            <div className="lb-label mb-1">RTMP ingest</div>
            <CopyField label="Server / URL" value={rtmpUrl} />
            <div className="mt-2">
              <CopyField label="Stream key" value={safeKey} />
            </div>
            <p className="text-[11px] text-slate-600 mt-1">
              In OBS: Settings → Stream → Service &ldquo;Custom…&rdquo;, then paste the two fields above.
            </p>
          </div>

          <div>
            <div className="lb-label mb-1">SRT playback (bridge any RTMP source out over SRT)</div>
            <CopyField value={srtPlayUrl} />
            <p className="text-[11px] text-slate-600 mt-1">
              Works for RTMP-ingested streams too - SRS serves any ingested stream over SRT with
              no extra process.
            </p>
          </div>

          <div>
            <div className="lb-label mb-1">Browser preview</div>
            <CopyField label="HLS" value={`${webScheme}//${host}/hls/live/${safeKey}.m3u8`} />
            <div className="mt-2">
              <CopyField label="HTTP-FLV (lower latency)" value={`${webScheme}//${host}/live/live/${safeKey}.flv`} />
            </div>
          </div>
        </div>

        <div className="rounded border border-bridge-border bg-bridge-bg px-3 py-2">
          <p className="text-[11px] text-slate-500">
            <strong className="text-slate-400">No login on this dashboard.</strong>{' '}
            Access is controlled at the network layer only. Restrict port 443 to known IPs or a
            VPN - anyone who can reach this page can add relay destinations and disable stream keys.
          </p>
        </div>
      </div>
    </Panel>
  );
}

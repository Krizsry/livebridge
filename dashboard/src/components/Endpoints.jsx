import React, { useState } from 'react';
import { Panel, CopyField } from './common.jsx';

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
                ? 'Enter the SRT passphrase from your server .env in the encoder\'s passphrase field - it is not shown here on purpose.'
                : 'No passphrase is configured, so this stream is unencrypted.'}
            </p>
          </div>

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

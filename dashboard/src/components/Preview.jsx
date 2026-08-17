import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import flvjs from 'flv.js';
import { Panel, EmptyState, ErrorNotice, ProtocolBadge } from './common.jsx';

/**
 * Low-latency confidence monitor.
 *
 * Why this exists: SRS publishes each ingest three ways - HLS (~15-20 s behind,
 * governed by HLS_WINDOW_SEC), HTTP-FLV (~1-3 s) and SRT playback. Only HTTP-FLV
 * is fast enough to answer "does what I am sending right now look and sound
 * right?", which is the entire point of a confidence monitor.
 *
 * Browsers cannot play FLV natively - Flash was removed in 2020 - so clicking an
 * .flv link just downloads an ever-growing file. flv.js solves that by demuxing
 * FLV in JavaScript and feeding the result to Media Source Extensions. Same for
 * .m3u8 outside Safari, which is why the fallback below points at VLC/ffplay
 * rather than pretending the browser can cope.
 *
 * Playback is opt-in per stream: starting it pulls the full contribution bitrate
 * down to the browser, and auto-playing every stream on page load would quietly
 * multiply the operator's own bandwidth by the number of live streams.
 */
// --- Live-edge tuning -------------------------------------------------------
// How close to the buffered edge we aim to sit. Not zero: MSE needs a little
// runway or the element stalls, and a stall costs far more than 150 ms.
const LIVE_TARGET_SEC = 0.15;
// Below this we are "at the live edge" and the badge reads LIVE.
const LIVE_TOLERANCE_SEC = 0.6;
// Beyond this, catch up smoothly by speeding playback very slightly. This is
// what YouTube does - a seek is visible, a 6% speed-up is not.
const CATCHUP_ABOVE_SEC = 0.4;
const CATCHUP_RATE = 1.06;
// Beyond this, a speed-up would take too long; jump instead.
const HARD_SEEK_ABOVE_SEC = 2;

/**
 * `selected` is owned by App rather than by this panel, so the "Preview" button
 * on a stream card can point this player at that stream. It was previously local
 * state, which meant nothing outside this component could choose the feed.
 */
export function Preview({ streams = [], selected = null, onSelect }) {
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState(null);
  const [drift, setDrift] = useState(null);
  // Live mode pins playback to the buffered edge. Turning it off lets the
  // operator pause or scrub back to inspect something without the player
  // yanking them forward again.
  const [liveMode, setLiveMode] = useState(true);
  const [catchingUp, setCatchingUp] = useState(false);

  const videoRef = useRef(null);
  const playerRef = useRef(null);

  const supported = flvjs.isSupported();
  // Memoised: `streams` is replaced wholesale by every 1 Hz WebSocket tick, so an
  // un-memoised filter produced a new array identity on every render and re-ran
  // the selection effect below continuously.
  const live = useMemo(() => streams.filter((s) => s.status === 'online'), [streams]);

  // Keep the selection valid as streams come and go, without clobbering a
  // deliberate choice while it is still live.
  useEffect(() => {
    if (!onSelect) return;
    if (live.length === 0) {
      if (selected !== null) onSelect(null);
      return;
    }
    if (!selected || !live.some((s) => s.stream_key === selected)) {
      onSelect(live[0].stream_key);
    }
  }, [live, selected, onSelect]);

  const stream = live.find((s) => s.stream_key === selected) || null;

  const teardown = useCallback(() => {
    const player = playerRef.current;
    playerRef.current = null;
    if (player) {
      try {
        player.pause();
        player.unload();
        player.detachMediaElement();
        player.destroy();
      } catch {
        // Destroying an already-errored player can throw; nothing useful to do.
      }
    }
    setPlaying(false);
    setDrift(null);
    setCatchingUp(false);
    // Every fresh preview should start pinned to live, whatever the last one did.
    setLiveMode(true);
  }, []);

  // Stop cleanly whenever the chosen stream changes or the component unmounts,
  // so a hidden player never keeps pulling bitrate in the background.
  useEffect(() => teardown, [teardown]);
  useEffect(() => { teardown(); setError(null); }, [selected, teardown]);

  // If the publisher drops, tear the player down rather than leaving a frozen
  // frame that looks like a healthy feed.
  useEffect(() => {
    if (playing && !stream) teardown();
  }, [playing, stream, teardown]);

  const start = useCallback(() => {
    if (!stream || !videoRef.current || !supported) return;
    setError(null);

    const player = flvjs.createPlayer(
      { type: 'flv', url: stream.flv_url, isLive: true, hasAudio: true, hasVideo: true },
      {
        // Latency-first tuning. The stash buffer trades latency for smoothness;
        // for a confidence monitor latency is the whole point.
        enableStashBuffer: false,
        stashInitialSize: 128,
        autoCleanupSourceBuffer: true,
        lazyLoad: false,
      },
    );

    // Register the player BEFORE anything can fail.
    //
    // flv.js can raise ERROR synchronously from load() - a bad URL or an
    // immediately-closed socket does exactly that. The ERROR handler calls
    // teardown(), and teardown() destroys whatever is in playerRef. With the
    // assignment left until after load(), that teardown saw a NULL ref: the
    // player was never destroyed, stayed attached to the media element and kept
    // pulling the full contribution bitrate in the background, while the line
    // below then set playing=true - so the UI showed a live preview backed by a
    // dead player, and the only way out was reloading the page.
    playerRef.current = player;
    setPlaying(true);
    setLiveMode(true);

    player.on(flvjs.Events.ERROR, (type, detail) => {
      setError(`${type}: ${detail}. The stream may have ended, or the browser blocked playback.`);
      teardown();
    });

    player.attachMediaElement(videoRef.current);
    player.load();
    player.play().catch((e) => {
      // Autoplay policies reject unmuted playback without a gesture. The video
      // element is muted by default, so this is rare - report it rather than
      // leaving a dead black rectangle.
      setError(`Playback rejected by the browser: ${e?.message || e}`);
      teardown();
    });
  }, [stream, supported, teardown]);

  /**
   * Live-edge pinning.
   *
   * MSE playback drifts backwards after any hiccup and never recovers on its
   * own, so a monitor left running for an hour can end up many seconds behind
   * while still looking perfectly healthy. With live mode on we continuously
   * pull back toward the edge: a gentle speed-up for small drift (invisible),
   * a seek for large drift (visible, but better than being 10 s late).
   *
   * Runs at 250 ms rather than 1 s so a correction starts before the drift is
   * large enough to need a seek.
   */
  const snapToLive = useCallback(() => {
    const v = videoRef.current;
    if (!v || v.buffered.length === 0) return;
    const edge = v.buffered.end(v.buffered.length - 1);
    v.currentTime = Math.max(0, edge - LIVE_TARGET_SEC);
    v.playbackRate = 1;
    if (v.paused) v.play().catch(() => {});
    setLiveMode(true);
  }, []);

  useEffect(() => {
    if (!playing) return undefined;

    const id = setInterval(() => {
      const v = videoRef.current;
      if (!v || v.buffered.length === 0) return;

      const edge = v.buffered.end(v.buffered.length - 1);
      const behind = edge - v.currentTime;
      setDrift(behind);

      if (!liveMode || v.paused) {
        if (v.playbackRate !== 1) v.playbackRate = 1;
        setCatchingUp(false);
        return;
      }

      if (behind > HARD_SEEK_ABOVE_SEC) {
        v.currentTime = Math.max(0, edge - LIVE_TARGET_SEC);
        v.playbackRate = 1;
        setCatchingUp(false);
      } else if (behind > CATCHUP_ABOVE_SEC) {
        if (v.playbackRate !== CATCHUP_RATE) v.playbackRate = CATCHUP_RATE;
        setCatchingUp(true);
      } else if (v.playbackRate !== 1) {
        v.playbackRate = 1;
        setCatchingUp(false);
      }
    }, 250);

    return () => clearInterval(id);
  }, [playing, liveMode]);

  // A manual pause or scrub is an explicit "I want to look at something", so
  // drop out of live mode instead of fighting the operator's own controls.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !playing) return undefined;
    const onPause = () => setLiveMode(false);
    const onSeeking = () => {
      if (v.buffered.length === 0) return;
      const behind = v.buffered.end(v.buffered.length - 1) - v.currentTime;
      if (behind > LIVE_TOLERANCE_SEC) setLiveMode(false);
    };
    v.addEventListener('pause', onPause);
    v.addEventListener('seeking', onSeeking);
    return () => {
      v.removeEventListener('pause', onPause);
      v.removeEventListener('seeking', onSeeking);
    };
  }, [playing]);

  return (
    <Panel
      title="Stream Preview"
      subtitle="HTTP-FLV confidence monitor — pinned to the live edge"
      actions={
        <div className="flex items-center gap-2">
          <ProtocolBadge protocol="HTTP-FLV" />
        </div>
      }
    >
      {!supported ? (
        <UnsupportedNotice stream={stream} />
      ) : live.length === 0 ? (
        <EmptyState
          icon="◻"
          title="No live stream to preview"
          hint="Start publishing over SRT or RTMP and the feed will appear here."
        />
      ) : (
        <div className="space-y-3">
          {live.length > 1 && (
            <div>
              <label htmlFor="preview-stream" className="lb-label block mb-1">Stream</label>
              <select
                id="preview-stream"
                className="lb-input"
                value={selected || ''}
                onChange={(e) => onSelect?.(e.target.value)}
              >
                {live.map((s) => (
                  <option key={s.stream_key} value={s.stream_key}>{s.stream_key}</option>
                ))}
              </select>
            </div>
          )}

          <div className="relative bg-black rounded border border-bridge-border overflow-hidden aspect-video">
            {/* muted: browsers block unmuted autoplay, and a monitor that
                unexpectedly makes noise in a control room is worse than silent. */}
            <video
              ref={videoRef}
              className="w-full h-full"
              muted
              playsInline
              controls={playing}
            />

            {/* Overlaid on the video itself, top-right, the way a broadcast
                monitor carries its live indicator. It cannot go in the bottom
                control bar: those are the browser's native <video> controls and
                nothing can be injected into them. Top-right also keeps it clear
                of the mute/fullscreen buttons at every player size. */}
            {playing && (
              <div className="absolute top-2 right-2">
                <LiveControl
                  drift={drift}
                  liveMode={liveMode}
                  catchingUp={catchingUp}
                  onGoLive={snapToLive}
                  onLeaveLive={() => setLiveMode(false)}
                />
              </div>
            )}
            {!playing && (
              <button
                type="button"
                onClick={start}
                className="absolute inset-0 flex flex-col items-center justify-center gap-2
                           text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-colors"
              >
                <span className="text-3xl" aria-hidden="true">▶</span>
                <span className="text-xs">
                  Preview <span className="font-mono text-slate-300">{selected}</span>
                </span>
                <span className="text-[10px] text-slate-600 max-w-xs text-center">
                  Pulls the full stream bitrate to this browser
                </span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {playing ? (
              <button type="button" onClick={teardown} className="lb-btn-ghost text-xs">Stop preview</button>
            ) : (
              <button type="button" onClick={start} className="lb-btn-ghost text-xs" disabled={!stream}>
                Start preview
              </button>
            )}
            {stream && (
              <span className="text-[11px] text-slate-600 font-mono truncate">{stream.flv_url}</span>
            )}
          </div>

          <ErrorNotice onDismiss={() => setError(null)}>{error}</ErrorNotice>
        </div>
      )}
    </Panel>
  );
}

/**
 * YouTube-style live control.
 *
 * At the edge it is a status badge with a pulsing dot. Once the player falls
 * behind - because the operator paused, scrubbed back, or the network hiccuped -
 * it becomes a GO LIVE button that snaps straight back to the edge.
 *
 * The number is deliberately labelled "player" in the tooltip: it measures this
 * player's distance from its own buffered edge, which is only the last hop of
 * the end-to-end delay. It is not glass-to-glass latency and must not be read
 * as such.
 */
function LiveControl({ drift, liveMode, catchingUp, onGoLive, onLeaveLive }) {
  const atEdge = liveMode && drift !== null && drift <= LIVE_TOLERANCE_SEC;

  if (atEdge) {
    return (
      <button
        type="button"
        onClick={onLeaveLive}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded
                   bg-black/70 backdrop-blur-sm border border-red-500/50
                   text-[11px] font-semibold tracking-wide text-red-400
                   hover:border-red-500 transition-colors"
        title={`Pinned to the live edge — ${drift.toFixed(2)}s behind this player's buffer.${
          catchingUp ? ' Currently easing forward at 1.06x.' : ''
        } Click to unpin so you can pause or scrub.`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse-slow" />
        LIVE
        {catchingUp && <span className="text-red-400/70">·</span>}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onGoLive}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded
                 bg-black/70 backdrop-blur-sm border border-white/25
                 text-[11px] font-semibold tracking-wide text-slate-200
                 hover:bg-black/85 hover:border-white/50 transition-colors"
      title="Jump to the latest frame"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
      GO LIVE
      {drift !== null && drift > LIVE_TOLERANCE_SEC && (
        <span className="font-mono font-normal text-slate-400">−{drift.toFixed(1)}s</span>
      )}
    </button>
  );
}

/**
 * flv.js needs Media Source Extensions. Where MSE is missing (notably iOS
 * Safari) there is no in-browser path, so point at players that do work rather
 * than offering a link that would silently download a growing file.
 */
function UnsupportedNotice({ stream }) {
  const url = stream?.flv_url || '/live/live/<stream>.flv';
  return (
    <div className="space-y-2 text-xs text-slate-400">
      <p>
        This browser does not support Media Source Extensions, so FLV cannot be played here.
        Open the feed in a player instead:
      </p>
      <code className="block bg-bridge-bg border border-bridge-border rounded px-2 py-1.5 font-mono text-slate-300 overflow-x-auto">
        ffplay -fflags nobuffer -flags low_delay "{url}"
      </code>
      <p className="text-slate-600">VLC works too: Media → Open Network Stream → paste the same URL.</p>
    </div>
  );
}

import React from 'react';

/** Panel wrapper with a title row and optional right-hand actions. */
export function Panel({ title, subtitle, actions, children, className = '' }) {
  return (
    <section className={`lb-card ${className}`}>
      <header className="flex items-start justify-between gap-4 px-4 py-3 border-b border-bridge-border">
        <div>
          <h2 className="text-sm font-semibold text-slate-200">{title}</h2>
          {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

const STATUS_STYLES = {
  online: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  running: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  reconnecting: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  retrying: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  starting: 'bg-sky-500/15 text-sky-300 border-sky-500/40',
  stopping: 'bg-slate-500/15 text-slate-300 border-slate-500/40',
  offline: 'bg-slate-500/15 text-slate-400 border-slate-600/40',
  stopped: 'bg-slate-500/15 text-slate-400 border-slate-600/40',
  failed: 'bg-red-500/15 text-red-300 border-red-500/40',
};

export function StatusPill({ status, children }) {
  const style = STATUS_STYLES[status] || STATUS_STYLES.offline;
  const live = status === 'online' || status === 'running';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-medium ${style}`}>
      <span className={`w-1.5 h-1.5 rounded-full bg-current ${live ? 'animate-pulse-slow' : ''}`} />
      {children || status}
    </span>
  );
}

const PROTOCOL_STYLES = {
  SRT: 'bg-violet-500/15 text-violet-300 border-violet-500/40',
  RTMP: 'bg-blue-500/15 text-blue-300 border-blue-500/40',
  HLS: 'bg-teal-500/15 text-teal-300 border-teal-500/40',
  'HTTP-FLV': 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40',
  WebRTC: 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/40',
  unknown: 'bg-slate-500/15 text-slate-400 border-slate-600/40',
};

export function ProtocolBadge({ protocol }) {
  const style = PROTOCOL_STYLES[protocol] || PROTOCOL_STYLES.unknown;
  return (
    <span className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold tracking-wide ${style}`}>
      {protocol === 'unknown' ? 'DETECTING' : protocol}
    </span>
  );
}

/** Label + value pair used throughout the metric grids. */
/**
 * `suffix` is a small qualifier rendered after the value - used to mark a
 * figure that is configured rather than measured, so the two are never
 * mistaken for each other at a glance.
 */
export function Metric({ label, value, hint, tone = 'default', suffix }) {
  const toneClass = {
    default: 'text-slate-100',
    muted: 'text-slate-500',
    good: 'text-emerald-300',
    warn: 'text-amber-300',
    bad: 'text-red-300',
  }[tone];

  return (
    <div>
      <div className="lb-label">{label}</div>
      <div className={`lb-metric text-sm mt-0.5 ${toneClass}`} title={hint}>
        {value}
        {suffix && (
          <span className="ml-1 text-[10px] uppercase tracking-wide text-slate-600">{suffix}</span>
        )}
      </div>
    </div>
  );
}

/**
 * Bitrate sparkline. Pure inline SVG - no charting dependency for what is
 * ultimately a polyline.
 */
export function Sparkline({ points = [], height = 32, className = '' }) {
  if (points.length < 2) {
    return <div className={`h-8 flex items-center text-[11px] text-slate-600 ${className}`}>collecting…</div>;
  }

  const values = points.map((p) => p.kbps);
  const max = Math.max(...values, 1);
  const width = 100;
  const step = width / (values.length - 1);

  const path = values
    .map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(2)} ${(height - (v / max) * (height - 2) - 1).toFixed(2)}`)
    .join(' ');
  const area = `${path} L ${width} ${height} L 0 ${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={`w-full h-8 ${className}`}
      role="img"
      aria-label={`Bitrate trend, peak ${Math.round(max)} kb/s`}
    >
      <path d={area} fill="rgb(56 189 248 / 0.12)" />
      <path d={path} fill="none" stroke="rgb(56 189 248)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Copy-to-clipboard field for connection strings. */
export function CopyField({ label, value, mono = true }) {
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div>
      {label && <div className="lb-label mb-1">{label}</div>}
      <div className="flex items-stretch gap-2">
        <code className={`flex-1 min-w-0 bg-bridge-bg border border-bridge-border rounded px-2 py-1.5
                          text-xs text-slate-300 overflow-x-auto whitespace-nowrap
                          ${mono ? 'font-mono' : ''}`}
        >
          {value}
        </code>
        <button type="button" onClick={copy} className="lb-btn-ghost text-xs px-2 shrink-0">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export function EmptyState({ icon = '○', title, hint }) {
  return (
    <div className="py-10 text-center">
      <div className="text-2xl text-slate-700">{icon}</div>
      <p className="mt-2 text-sm text-slate-400">{title}</p>
      {hint && <p className="mt-1 text-xs text-slate-600 max-w-md mx-auto">{hint}</p>}
    </div>
  );
}

/**
 * Banner for the "Supabase is down" case. This is a first-class UI state, not
 * an error: live streaming is completely unaffected (requirement 21).
 */
export function DegradedNotice({ children }) {
  return (
    <div className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
      <span aria-hidden="true">⚠</span>
      <span>{children}</span>
    </div>
  );
}

export function ErrorNotice({ children, onDismiss }) {
  if (!children) return null;
  return (
    <div className="flex items-start justify-between gap-2 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
      <span>{children}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="text-red-300 hover:text-red-100">✕</button>
      )}
    </div>
  );
}

/** Live Bridge - display formatters. */

/** Bitrate in kbps -> human string. Null/undefined renders as "n/a", never 0. */
export function bitrate(kbps) {
  if (kbps === null || kbps === undefined) return 'n/a';
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(2)} Mb/s`;
  return `${Math.round(kbps)} kb/s`;
}

export function duration(sec) {
  if (sec === null || sec === undefined) return 'n/a';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(r).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${String(r).padStart(2, '0')}s`;
  return `${r}s`;
}

export function bytes(n) {
  if (n === null || n === undefined) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Metrics that are genuinely unmeasurable render as "n/a".
 * A fabricated 0 would tell an operator their SRT link is perfect when in fact
 * we simply have no data - see backend/src/state.js emptyMetrics().
 */
export function metricOrNa(value, suffix = '') {
  if (value === null || value === undefined) return 'n/a';
  return `${value}${suffix}`;
}

export function timestamp(iso) {
  if (!iso) return 'n/a';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'n/a';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function timeOnly(iso) {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return d.toLocaleTimeString();
}

export function relativeSince(iso) {
  if (!iso) return 'n/a';
  const started = new Date(iso).getTime();
  if (Number.isNaN(started)) return 'n/a';
  return duration((Date.now() - started) / 1000);
}

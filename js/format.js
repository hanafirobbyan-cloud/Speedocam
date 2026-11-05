// Formatting helpers. All output is English / locale-neutral on purpose.

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const KB = 1024, MB = KB * 1024, GB = MB * 1024;
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / KB))} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
  return `${(bytes / GB).toFixed(2)} GB`;
}

export function formatDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatTime(d, h24 = true) {
  const H = d.getHours(), M = d.getMinutes(), S = d.getSeconds();
  if (h24) return `${pad(H)}:${pad(M)}:${pad(S)}`;
  const h = H % 12 || 12;
  return `${h}:${pad(M)}:${pad(S)} ${H < 12 ? 'AM' : 'PM'}`;
}

export function fileStamp(d) {
  return `${formatDate(d)}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** SRT cue time: HH:MM:SS,mmm */
export function formatSrtTime(ms) {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(t % 1000, 3)}`;
}

export function formatDateLong(d, h24 = true) {
  const date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const time = h24
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
    : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

export function formatDistance(meters, unit) {
  if (!Number.isFinite(meters)) return '--';
  if (unit === 'mph') {
    const mi = meters / 1609.344;
    return `${mi.toFixed(mi < 10 ? 2 : 1)} mi`;
  }
  const km = meters / 1000;
  return `${km.toFixed(km < 10 ? 2 : 1)} km`;
}

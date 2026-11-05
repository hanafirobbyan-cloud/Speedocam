// Export helpers: share sheet / download, plus GPS track exports synced to the video timeline
// (SRT subtitles show speed in any player; GPX works with mapping and telemetry-overlay tools).

import { fileStamp, formatSrtTime, formatDate, formatTime } from './format.js';
import { displaySpeed, unitInfo } from './units.js';
import { extensionFor } from './recorder.js';

export function baseName(rec) {
  return `speedocam_${fileStamp(new Date(rec.createdAt))}`;
}

export function videoFileName(rec) {
  return `${baseName(rec)}.${extensionFor(rec.mimeType)}`;
}

/** SRT subtitle track: one cue per GPS sample, timed on the video timeline. */
export function toSRT(samples, unit, { clock24h = true, durationMs = null } = {}) {
  const label = unitInfo(unit).label;
  const list = (samples || []).filter((s) => Number.isFinite(s.t));
  const out = [];
  list.forEach((s, i) => {
    const start = s.t;
    let end = i + 1 < list.length ? list[i + 1].t : start + 1000;
    if (durationMs != null) end = Math.min(end, durationMs);
    if (end <= start) end = start + 1;
    const v = displaySpeed(s.spd, unit);
    const when = Number.isFinite(s.ts) ? `${formatDate(new Date(s.ts))} ${formatTime(new Date(s.ts), clock24h)}` : '';
    out.push(`${out.length + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${v == null ? '--' : v} ${label}${when ? `\n${when}` : ''}\n`);
  });
  return out.join('\n');
}

const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

/** GPX 1.1 track. Speed (m/s) is written to <extensions><speed>. */
export function toGPX(samples, name = 'SpeedoCam track') {
  const pts = (samples || [])
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
    .map((s) => {
      const ele = Number.isFinite(s.alt) ? `<ele>${s.alt.toFixed(1)}</ele>` : '';
      const time = Number.isFinite(s.ts) ? `<time>${new Date(s.ts).toISOString()}</time>` : '';
      const spd = Number.isFinite(s.spd) ? `<extensions><speed>${s.spd.toFixed(2)}</speed></extensions>` : '';
      return `      <trkpt lat="${s.lat.toFixed(7)}" lon="${s.lon.toFixed(7)}">${ele}${time}${spd}</trkpt>`;
    });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="SpeedoCam" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <trk><name>${esc(name)}</name>`,
    '    <trkseg>',
    ...pts,
    '    </trkseg>',
    '  </trk>',
    '</gpx>',
    '',
  ].join('\n');
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function canShareFile(file) {
  try {
    return !!(navigator.canShare && navigator.canShare({ files: [file] }));
  } catch {
    return false;
  }
}

/**
 * Opens the iOS share sheet (where "Save Video" puts the clip in Photos).
 * Must be called directly from a tap handler. Returns 'shared' | 'cancelled' | 'unsupported'.
 */
export async function shareFile(file) {
  if (!canShareFile(file)) return 'unsupported';
  try {
    await navigator.share({ files: [file] });
    return 'shared';
  } catch (e) {
    if (e?.name === 'AbortError') return 'cancelled';
    throw e;
  }
}

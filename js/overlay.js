// Overlay renderer: draws the dashboard (speed, unit, limit, max, REC time, date/time, GPS status)
// into video frames. The overlay is rendered into a cached bottom "band" canvas only when its
// visible content changes (~1-2 times per second); every video frame just blits the cache.

import { formatDuration, formatDate, formatTime } from './format.js';

export const FONT = 'system-ui, -apple-system, "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif';
export const ACCENTS = Object.freeze({ white: '#FFFFFF', amber: '#FFB340', cyan: '#64D2FF', green: '#30D158' });
export const COLORS = Object.freeze({
  warn: '#FF453A',
  caution: '#FFD60A',
  ok: '#30D158',
  muted: 'rgba(255,255,255,0.62)',
  dim: 'rgba(255,255,255,0.45)',
  panel: 'rgba(0,0,0,0.48)',
  panelWarn: 'rgba(150,18,10,0.62)',
  track: 'rgba(255,255,255,0.18)',
});
const SIZE = Object.freeze({ s: 0.8, m: 1, l: 1.25 });
const ARC_START = (135 * Math.PI) / 180;
const ARC_SWEEP = (270 * Math.PI) / 180;

export function gpsLabel(status, accuracy) {
  const a = Number.isFinite(accuracy) ? ` ±${Math.round(accuracy)} m` : '';
  switch (status) {
    case 'good': return { text: `GPS${a}`, level: 'ok' };
    case 'weak': return { text: `GPS WEAK${a}`, level: 'caution' };
    case 'poor': return { text: `GPS POOR${a}`, level: 'warn' };
    case 'lost': return { text: 'GPS SIGNAL LOST', level: 'warn' };
    case 'acquiring': return { text: 'GPS ACQUIRING', level: 'caution' };
    case 'denied': return { text: 'GPS PERMISSION DENIED', level: 'warn' };
    case 'unavailable': return { text: 'GPS UNAVAILABLE', level: 'warn' };
    default: return { text: 'GPS OFF', level: 'warn' };
  }
}

/** Converts overlay state into the exact strings that will be drawn. */
export function overlayTexts(s) {
  const gps = gpsLabel(s.gpsStatus, s.accuracy);
  let rec = '';
  if (s.showDuration) {
    if (s.recording) rec = `${s.paused ? 'PAUSED' : 'REC'} ${formatDuration(s.recMs)}`;
    else rec = 'PREVIEW';
  }
  return {
    speed: s.speed == null ? '--' : String(s.speed),
    unit: s.unit,
    max: s.showMax ? `MAX ${s.max == null ? '--' : s.max}` : '',
    limit: s.showWarning && s.limit ? `LIMIT ${s.limit}` : '',
    rec,
    datetime: s.showDateTime && s.now ? `${formatDate(s.now)}  ${formatTime(s.now, s.clock24h)}` : '',
    gps: s.showGps ? gps.text : '',
    gpsLevel: gps.level,
  };
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const font = (weight, px) => `${weight} ${Math.max(1, px).toFixed(1)}px ${FONT}`;

function textW(ctx, f, text) {
  ctx.font = f;
  return ctx.measureText(text).width;
}

function levelColor(level) {
  return level === 'ok' ? COLORS.ok : level === 'caution' ? COLORS.caution : COLORS.warn;
}

function measure(ctx, u, s, t) {
  const m = 22 * u;
  const L = { u, m, r: 18 * u };

  if (s.style === 'dial') {
    const pad = 12 * u;
    const D = 172 * u;
    L.speed = { kind: 'dial', pad, D, w: D + 2 * pad, h: D + 2 * pad };
  } else {
    const pad = 16 * u;
    const fsSpeed = 90 * u, fsUnit = 24 * u, fsSub = 16 * u, gap = 8 * u;
    const fSpeed = font(700, fsSpeed), fUnit = font(600, fsUnit), fSub = font(600, fsSub);
    const digitW = Math.max(textW(ctx, fSpeed, '000'), textW(ctx, fSpeed, t.speed));
    const unitW = textW(ctx, fUnit, t.unit);
    const maxW = t.max ? textW(ctx, fSub, t.max) : 0;
    const limitW = t.limit ? textW(ctx, fSub, t.limit) : 0;
    const subW = maxW + limitW + (maxW && limitW ? 18 * u : 0);
    const hasSub = subW > 0;
    const capH = 0.72 * fsSpeed;
    const w = pad * 2 + Math.max(digitW + gap + unitW, subW);
    const h = pad * 2 + capH + (hasSub ? fsSub + 12 * u : 0);
    L.speed = { kind: 'digital', pad, fsSpeed, fsUnit, fsSub, gap, fSpeed, fUnit, fSub, digitW, hasSub, w, h };
  }

  // Info panel lines
  const pad = 14 * u;
  const lines = [];
  if (t.rec) lines.push({ key: 'rec', fs: 21 * u, weight: 700, text: t.rec, dot: s.recording });
  if (t.datetime) {
    const tmpl = s.clock24h ? '0000-00-00  00:00:00' : '0000-00-00  00:00:00 PM';
    lines.push({ key: 'dt', fs: 19 * u, weight: 600, text: t.datetime, template: tmpl });
  }
  if (t.gps) lines.push({ key: 'gps', fs: 15 * u, weight: 600, text: t.gps, dot: true });
  let iw = 0, ih = 0;
  for (const ln of lines) {
    ln.font = font(ln.weight, ln.fs);
    const dotW = ln.dot ? ln.fs * 0.85 : 0;
    const w = Math.max(textW(ctx, ln.font, ln.text), ln.template ? textW(ctx, ln.font, ln.template) : 0);
    // Reserve width for the longest GPS label so the panel does not jump around.
    const reserve = ln.key === 'gps' ? textW(ctx, ln.font, 'GPS WEAK ±00 m') : 0;
    iw = Math.max(iw, dotW + Math.max(w, reserve));
    ih += ln.fs * 1.3;
  }
  L.info = lines.length
    ? { pad, lines, w: iw + pad * 2, h: ih - lines[lines.length - 1].fs * 0.3 + pad * 2 }
    : { pad, lines, w: 0, h: 0 };

  L.needed = L.info.w > 0 ? 3 * m + L.speed.w + L.info.w : 2 * m + L.speed.w;
  L.bandH = m + Math.max(L.speed.h, L.info.h) + 4 * u;
  return L;
}

function drawPanel(ctx, x, y, w, h, L, warn) {
  roundRect(ctx, x, y, w, h, L.r);
  ctx.fillStyle = warn ? COLORS.panelWarn : COLORS.panel;
  ctx.fill();
  if (warn) {
    ctx.lineWidth = 3 * L.u;
    ctx.strokeStyle = COLORS.warn;
    ctx.stroke();
  }
}

function drawDigital(ctx, x, y, L, s, t, warn) {
  const P = L.speed;
  drawPanel(ctx, x, y, P.w, P.h, L, warn);
  ctx.textBaseline = 'alphabetic';
  if (P.hasSub) {
    const by = y + P.pad + P.fsSub * 0.78;
    ctx.font = P.fSub;
    if (t.max) {
      ctx.textAlign = 'left';
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(t.max, x + P.pad, by);
    }
    if (t.limit) {
      ctx.textAlign = 'right';
      ctx.fillStyle = warn ? '#FFFFFF' : COLORS.muted;
      ctx.fillText(t.limit, x + P.w - P.pad, by);
    }
  }
  const base = y + P.h - P.pad;
  ctx.font = P.fSpeed;
  ctx.textAlign = 'right';
  ctx.fillStyle = s.speed == null ? COLORS.dim : warn ? '#FFFFFF' : ACCENTS[s.accent] || ACCENTS.white;
  ctx.fillText(t.speed, x + P.pad + P.digitW, base);
  ctx.font = P.fUnit;
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(t.unit, x + P.pad + P.digitW + P.gap, base);
}

function drawDial(ctx, x, y, L, s, t, warn) {
  const P = L.speed, u = L.u;
  drawPanel(ctx, x, y, P.w, P.h, L, warn);
  const cx = x + P.w / 2, cy = y + P.h / 2;
  const R = P.D / 2 - 8 * u;
  const accent = warn ? COLORS.warn : ACCENTS[s.accent] || ACCENTS.white;
  ctx.lineCap = 'round';
  ctx.lineWidth = 9 * u;
  ctx.strokeStyle = COLORS.track;
  ctx.beginPath();
  ctx.arc(cx, cy, R, ARC_START, ARC_START + ARC_SWEEP);
  ctx.stroke();
  if (s.speed != null && s.gaugeMax > 0) {
    const frac = Math.min(1, Math.max(0, s.speed / s.gaugeMax));
    if (frac > 0) {
      ctx.strokeStyle = accent;
      ctx.beginPath();
      ctx.arc(cx, cy, R, ARC_START, ARC_START + ARC_SWEEP * frac);
      ctx.stroke();
    }
  }
  if (s.showWarning && s.limit && s.gaugeMax > 0) {
    const a = ARC_START + ARC_SWEEP * Math.min(1, s.limit / s.gaugeMax);
    ctx.lineCap = 'butt';
    ctx.lineWidth = 3 * u;
    ctx.strokeStyle = warn ? '#FFFFFF' : COLORS.warn;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (R - 11 * u), cy + Math.sin(a) * (R - 11 * u));
    ctx.lineTo(cx + Math.cos(a) * (R + 11 * u), cy + Math.sin(a) * (R + 11 * u));
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = font(700, 58 * u);
  ctx.fillStyle = s.speed == null ? COLORS.dim : warn ? '#FFFFFF' : ACCENTS[s.accent] || ACCENTS.white;
  ctx.fillText(t.speed, cx, cy + 18 * u);
  ctx.font = font(600, 15 * u);
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(t.unit, cx, cy + 42 * u);
  if (t.limit) {
    ctx.font = font(600, 12 * u);
    ctx.fillStyle = warn ? '#FFFFFF' : COLORS.muted;
    ctx.fillText(t.limit, cx, cy - 38 * u);
  }
  if (t.max) {
    ctx.font = font(600, 13 * u);
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(t.max, cx, cy + R * 0.95);
  }
}

function drawInfo(ctx, x, y, L, s, t) {
  const P = L.info;
  drawPanel(ctx, x, y, P.w, P.h, L, false);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  let cursor = y + P.pad;
  for (const ln of P.lines) {
    const base = cursor + ln.fs * 0.78;
    let tx = x + P.pad;
    let color = '#FFFFFF';
    if (ln.key === 'rec') color = !s.recording ? COLORS.muted : s.paused ? COLORS.caution : '#FFFFFF';
    if (ln.key === 'gps') color = levelColor(t.gpsLevel);
    if (ln.dot) {
      const r = ln.fs * 0.27;
      let dc = color;
      if (ln.key === 'rec') dc = s.paused ? COLORS.caution : COLORS.warn;
      ctx.fillStyle = dc;
      ctx.beginPath();
      ctx.arc(tx + r, base - ln.fs * 0.34, r, 0, Math.PI * 2);
      ctx.fill();
      tx += ln.fs * 0.85;
    }
    ctx.font = ln.font;
    ctx.fillStyle = color;
    ctx.fillText(ln.text, tx, base);
    cursor += ln.fs * 1.3;
  }
}

export class OverlayRenderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.key = '';
    this.renders = 0;
    this.bandY = 0;
    this.bandH = 0;
  }

  /** Draw the overlay onto ctx (W x H). Re-renders the cached band only when the content changed. */
  paint(ctx, W, H, state) {
    const t = overlayTexts(state);
    const warn = !!(state.over && state.showWarning);
    const key = [
      W, H, state.style, state.accent, state.size, state.position, warn, state.recording, state.paused,
      state.gaugeMax, state.limit, state.speed, t.speed, t.unit, t.max, t.limit, t.rec, t.datetime, t.gps, t.gpsLevel,
    ].join('|');
    if (key !== this.key) {
      this._render(W, H, state, t, warn);
      this.key = key;
      this.renders++;
    }
    if (this.bandH > 0) ctx.drawImage(this.canvas, 0, this.bandY);
  }

  _render(W, H, s, t, warn) {
    const ctx = this.ctx;
    let u = (Math.min(W, H) / 720) * (SIZE[s.size] || 1);
    let L = measure(ctx, u, s, t);
    if (L.needed > W) {
      u *= (W / L.needed) * 0.98; // narrow (portrait) frames: shrink to fit side by side
      L = measure(ctx, u, s, t);
    }
    const bandH = Math.max(1, Math.ceil(L.bandH));
    if (this.canvas.width !== W || this.canvas.height !== bandH) {
      this.canvas.width = W;
      this.canvas.height = bandH;
    } else {
      ctx.clearRect(0, 0, W, bandH);
    }
    this.bandY = H - bandH;
    this.bandH = bandH;

    const speedLeft = s.position !== 'right';
    const sx = speedLeft ? L.m : W - L.m - L.speed.w;
    const sy = bandH - L.m - L.speed.h;
    if (L.speed.kind === 'dial') drawDial(ctx, sx, sy, L, s, t, warn);
    else drawDigital(ctx, sx, sy, L, s, t, warn);

    if (L.info.w > 0) {
      const ix = speedLeft ? W - L.m - L.info.w : L.m;
      const iy = bandH - L.m - L.info.h;
      drawInfo(ctx, ix, iy, L, s, t);
    }
  }
}

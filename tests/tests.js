// SpeedoCam browser test suite. Open tests/index.html (works on iPhone too) — results also at window.__results.

import { UNITS, fromMps, toMps, displaySpeed, defaultUnitForLocale } from '../js/units.js';
import { formatDuration, formatSrtTime, formatBytes, formatTime, formatDate, fileStamp } from '../js/format.js';
import { Settings, sanitize, defaults } from '../js/settings.js';
import { SpeedEstimator, GpsTracker, haversine, classifyAccuracy, GPS } from '../js/gps.js';
import { TripStats } from '../js/trip.js';
import { toSRT, toGPX, videoFileName } from '../js/exporters.js';
import { OverlayRenderer, overlayTexts, gpsLabel } from '../js/overlay.js';
import { Compositor, outputSize } from '../js/compositor.js';
import { DashRecorder, bitrateFor, pickMimeType, extensionFor } from '../js/recorder.js';
import { Store } from '../js/storage.js';
import { videoConstraints, presetFor } from '../js/camera.js';

const results = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

class AssertError extends Error {}
const assert = (cond, msg = 'assertion failed') => { if (!cond) throw new AssertError(msg); };
const eq = (a, b, msg = '') => assert(Object.is(a, b) || a === b, `${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const near = (a, b, eps, msg = '') => assert(Math.abs(a - b) <= eps, `${msg} expected ${b}±${eps}, got ${a}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rafRate(ms = 400) {
  return new Promise((resolve) => {
    let n = 0;
    const t0 = performance.now();
    const tick = () => { n++; if (performance.now() - t0 < ms) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    setTimeout(() => resolve((n * 1000) / ms), ms + 100);
  });
}

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

// ---------------------------------------------------------------- units & format
test('units: conversions', () => {
  eq(fromMps(10, 'kmh'), 36);
  near(fromMps(26.8224, 'mph'), 60, 1e-6);
  near(toMps(100, 'kmh'), 27.7778, 1e-4);
  eq(displaySpeed(27.7778, 'kmh'), 100);
  eq(displaySpeed(26.8224, 'mph'), 60);
  eq(displaySpeed(null, 'kmh'), null);
  eq(displaySpeed(NaN, 'kmh'), null);
  eq(UNITS.kmh.label, 'km/h');
  eq(UNITS.mph.label, 'mph');
});

test('units: default unit by locale', () => {
  eq(defaultUnitForLocale('en-US'), 'mph');
  eq(defaultUnitForLocale('en-GB'), 'mph');
  eq(defaultUnitForLocale('de-DE'), 'kmh');
  eq(defaultUnitForLocale('id-ID'), 'kmh');
  eq(defaultUnitForLocale('en'), 'kmh');
});

test('format: durations, sizes, times', () => {
  eq(formatDuration(0), '00:00');
  eq(formatDuration(61_000), '01:01');
  eq(formatDuration(3_723_000), '1:02:03');
  eq(formatSrtTime(3_723_004), '01:02:03,004');
  eq(formatBytes(1.5 * 1024 * 1024), '1.5 MB');
  eq(formatBytes(0), '0 MB');
  const d = new Date(2026, 0, 2, 13, 5, 9);
  eq(formatTime(d, true), '13:05:09');
  eq(formatTime(d, false), '1:05:09 PM');
  eq(formatTime(new Date(2026, 0, 2, 0, 1, 2), false), '12:01:02 AM');
  eq(formatDate(d), '2026-01-02');
  eq(fileStamp(d), '2026-01-02_13-05-09');
});

// ---------------------------------------------------------------- settings
test('settings: defaults, validation, persistence', () => {
  const store = memStorage();
  const s = new Settings(store, 'test');
  eq(s.get('style'), 'digital');
  eq(s.get('limitKmh'), 80);
  eq(s.set({ limitKmh: 9999 }).length, 1);
  eq(s.get('limitKmh'), 400, 'clamped');
  s.set({ style: 'bogus' });
  eq(s.get('style'), 'digital', 'invalid enum rejected');
  s.set({ segmentMinutes: '3' });
  eq(s.get('segmentMinutes'), 3, 'enum string coerced to number');
  s.set({ units: 'mph', limitMph: 65 });
  eq(s.limit, 65);
  s.set({ units: 'kmh' });
  eq(s.limit, 400, 'limit kept per unit');
  const s2 = new Settings(store, 'test');
  eq(s2.get('segmentMinutes'), 3, 'persisted');
  eq(s2.get('limitMph'), 65, 'persisted');
});

test('settings: corrupt storage falls back to defaults', () => {
  const store = memStorage();
  store.setItem('test', '{not json');
  const s = new Settings(store, 'test');
  eq(s.get('quality'), defaults().quality);
  eq(sanitize('audio', 'yes'), false);
});

test('settings: change event lists changed keys only', () => {
  const s = new Settings(memStorage(), 'test');
  let keys = null;
  s.addEventListener('change', (e) => { keys = e.detail.keys; });
  s.set({ style: 'dial', accent: s.get('accent') });
  eq(JSON.stringify(keys), '["style"]');
});

// ---------------------------------------------------------------- GPS
const T0 = 1_800_000_000_000;
const fix = (o) => ({ lat: 52, lon: 13, accuracy: 5, speed: null, heading: null, altitude: null, timestamp: T0, ...o });

test('gps: haversine and accuracy classes', () => {
  near(haversine(0, 0, 1, 0), 111195, 5);
  eq(classifyAccuracy(5), 'good');
  eq(classifyAccuracy(35), 'weak');
  eq(classifyAccuracy(80), 'poor');
  eq(classifyAccuracy(NaN), 'poor');
});

test('gps: uses device speed when present', () => {
  const e = new SpeedEstimator();
  const r = e.ingest(fix({ speed: 13.9 }), 1000, T0);
  eq(r.source, 'device');
  eq(r.speedMps, 13.9);
  eq(r.status, 'good');
  eq(r.maxable, true);
});

test('gps: hides speed when accuracy is poor', () => {
  const e = new SpeedEstimator();
  const r = e.ingest(fix({ speed: 20, accuracy: 120 }), 1000, T0);
  eq(r.status, 'poor');
  eq(r.speedMps, null);
  eq(r.maxable, false);
});

test('gps: weak accuracy shows speed but never sets max', () => {
  const e = new SpeedEstimator();
  const r = e.ingest(fix({ speed: 20, accuracy: 35 }), 1000, T0);
  eq(r.status, 'weak');
  eq(r.speedMps, 20);
  eq(r.maxable, false);
});

test('gps: computes speed from positions when device speed is missing', () => {
  const e = new SpeedEstimator();
  e.ingest(fix({}), 0, T0);
  const dLat = 20 / 111195; // 20 m north
  const r = e.ingest(fix({ lat: 52 + dLat, timestamp: T0 + 1000 }), 1000, T0 + 1000);
  eq(r.source, 'computed');
  near(r.speedMps, 20, 0.2);
});

test('gps: movement within position noise counts as stopped', () => {
  const e = new SpeedEstimator();
  e.ingest(fix({ accuracy: 10 }), 0, T0);
  const r = e.ingest(fix({ accuracy: 10, lat: 52 + 2 / 111195, timestamp: T0 + 1000 }), 1000, T0 + 1000);
  eq(r.speedMps, 0);
});

test('gps: clamps creeping speed to zero', () => {
  const e = new SpeedEstimator();
  eq(e.ingest(fix({ speed: 0.3 }), 0, T0).speedMps, 0);
});

test('gps: signal lost after STALE_MS', () => {
  const e = new SpeedEstimator();
  e.ingest(fix({ speed: 10 }), 1000, T0);
  eq(e.evaluate(1000 + GPS.STALE_MS - 10), null);
  const lost = e.evaluate(1000 + GPS.STALE_MS + 10);
  eq(lost.status, 'lost');
  eq(lost.speedMps, null);
});

test('gps: ignores stale cached fixes', () => {
  const e = new SpeedEstimator();
  eq(e.ingest(fix({ speed: 10, timestamp: T0 - 20_000 }), 0, T0), null);
});

test('gps: holds value on an isolated implausible spike', () => {
  const e = new SpeedEstimator();
  e.ingest(fix({ speed: 10 }), 0, T0);
  const spike = e.ingest(fix({ speed: 40, timestamp: T0 + 1000 }), 1000, T0 + 1000);
  eq(spike.outlier, true);
  eq(spike.speedMps, 10, 'held previous');
  eq(spike.maxable, false);
  const next = e.ingest(fix({ speed: 12, timestamp: T0 + 2000 }), 2000, T0 + 2000);
  eq(next.outlier, false);
  eq(next.speedMps, 12);
});

test('gps: accepts a persistent change after holding', () => {
  const e = new SpeedEstimator();
  e.ingest(fix({ speed: 10 }), 0, T0);
  e.ingest(fix({ speed: 50, timestamp: T0 + 1000 }), 1000, T0 + 1000);
  e.ingest(fix({ speed: 50, timestamp: T0 + 2000 }), 2000, T0 + 2000);
  const r = e.ingest(fix({ speed: 50, timestamp: T0 + 3000 }), 3000, T0 + 3000);
  eq(r.speedMps, 50);
});

test('gps: tracker handles permission denial', () => {
  let errCb;
  const geo = { watchPosition: (_ok, err) => { errCb = err; return 7; }, clearWatch: () => {} };
  const t = new GpsTracker(geo);
  t.start();
  eq(t.status, 'acquiring');
  errCb({ code: 1, message: 'denied' });
  eq(t.status, 'denied');
  eq(t.running, false);
});

test('gps: tracker emits readings from watchPosition', () => {
  let okCb;
  const geo = { watchPosition: (ok) => { okCb = ok; return 1; }, clearWatch: () => {} };
  const t = new GpsTracker(geo);
  const seen = [];
  t.addEventListener('reading', (e) => seen.push(e.detail.status));
  t.start();
  okCb({ coords: { latitude: 1, longitude: 2, accuracy: 4, speed: 5, heading: null, altitude: null }, timestamp: Date.now() });
  eq(t.reading.speedMps, 5);
  eq(seen.join(','), 'acquiring,good');
  t.stop();
});

// ---------------------------------------------------------------- trip stats
test('trip: max, moving average, distance', () => {
  const s = new TripStats();
  for (let i = 0; i <= 10; i++) s.add(10, i * 1000);
  near(s.distanceM, 100, 1e-9);
  near(s.avgMps, 10, 1e-9);
  eq(s.maxMps, 10);
  // standing still does not dilute the moving average
  for (let i = 11; i <= 20; i++) s.add(0, i * 1000);
  near(s.avgMps, 10, 0.5);
});

test('trip: gaps and untrusted samples', () => {
  const s = new TripStats();
  s.add(10, 0);
  s.add(null, 1000);
  s.add(10, 2000);
  eq(s.distanceM, 0, 'null breaks integration');
  s.add(10, 9000);
  eq(s.distanceM, 0, 'gap > 5 s not integrated');
  s.add(50, 10000, false);
  eq(s.maxMps, 10, 'untrusted sample does not set max');
});

// ---------------------------------------------------------------- exporters
const SAMPLES = [
  { t: 0, ts: T0, lat: 52.1, lon: 13.2, alt: 40, acc: 5, spd: 13.8889, q: 1 },
  { t: 1000, ts: T0 + 1000, lat: 52.1001, lon: 13.2, alt: 40, acc: 5, spd: 16.6667, q: 1 },
  { t: 2000, ts: T0 + 2000, spd: null, q: 0 },
];

test('export: SRT cues on the video timeline', () => {
  const srt = toSRT(SAMPLES, 'kmh', { durationMs: 2500 });
  const cues = srt.trim().split(/\n\n/);
  eq(cues.length, 3);
  assert(cues[0].startsWith('1\n00:00:00,000 --> 00:00:01,000\n50 km/h'), cues[0]);
  assert(cues[1].includes('60 km/h'), cues[1]);
  assert(cues[2].includes('00:00:02,000 --> 00:00:02,500\n-- km/h'), cues[2]);
});

test('export: GPX is valid XML with track points', () => {
  const gpx = toGPX(SAMPLES, 'A & B');
  const doc = new DOMParser().parseFromString(gpx, 'application/xml');
  eq(doc.getElementsByTagName('parsererror').length, 0, 'parse error');
  eq(doc.getElementsByTagName('trkpt').length, 2);
  eq(doc.getElementsByTagName('speed')[0].textContent, '13.89');
  eq(doc.getElementsByTagName('name')[0].textContent, 'A & B');
});

test('export: file names', () => {
  const rec = { createdAt: new Date(2026, 10, 5, 7, 8, 9).getTime(), mimeType: 'video/mp4;codecs=avc1' };
  eq(videoFileName(rec), 'speedocam_2026-11-05_07-08-09.mp4');
  eq(extensionFor('video/webm;codecs=vp9'), 'webm');
});

// ---------------------------------------------------------------- recording helpers
test('recorder: bitrate and output size', () => {
  near(bitrateFor(1920, 1080, 60, 'standard'), 9.95e6, 1e4);
  eq(bitrateFor(320, 240, 30, 'low'), 3e6, 'min clamp');
  eq(bitrateFor(3840, 2160, 60, 'high'), 24e6, 'max clamp');
  eq(JSON.stringify(outputSize(1920, 1080, 1920, 1080)), '{"width":1920,"height":1080}');
  eq(JSON.stringify(outputSize(3840, 2160, 1920, 1080)), '{"width":1920,"height":1080}');
  eq(JSON.stringify(outputSize(1080, 1920, 1920, 1080)), '{"width":1080,"height":1920}', 'portrait kept');
  eq(JSON.stringify(outputSize(2160, 3840, 1280, 720)), '{"width":720,"height":1280}');
  eq(JSON.stringify(outputSize(1281, 721, 1920, 1080)), '{"width":1282,"height":722}', 'even dims');
});

test('camera: constraints per preset', () => {
  const c = videoConstraints('720p30', '');
  eq(c.width.ideal, 1280);
  eq(c.frameRate.max, 30);
  eq(c.facingMode.ideal, 'environment');
  eq(videoConstraints('auto', 'abc').deviceId.exact, 'abc');
  eq(presetFor('auto').fps, 60);
});

// ---------------------------------------------------------------- overlay
const baseState = (o = {}) => ({
  speed: 87, unit: 'km/h', gaugeMax: 240, limit: 80, over: false, showWarning: true, max: 102, showMax: true,
  gpsStatus: 'good', accuracy: 4, showGps: true, showDateTime: true, showDuration: true, clock24h: true,
  recording: true, paused: false, recMs: 5000, now: new Date(2026, 10, 5, 14, 5, 9),
  style: 'digital', accent: 'white', size: 'm', position: 'left', ...o,
});

test('overlay: texts', () => {
  const t = overlayTexts(baseState());
  eq(t.speed, '87');
  eq(t.rec, 'REC 00:05');
  eq(t.max, 'MAX 102');
  eq(t.limit, 'LIMIT 80');
  eq(t.datetime, '2026-11-05  14:05:09');
  eq(t.gps, 'GPS ±4 m');
  eq(overlayTexts(baseState({ speed: null })).speed, '--');
  eq(overlayTexts(baseState({ paused: true })).rec, 'PAUSED 00:05');
  eq(overlayTexts(baseState({ recording: false })).rec, 'PREVIEW');
  eq(overlayTexts(baseState({ showMax: false, showGps: false, showDateTime: false })).max, '');
  eq(gpsLabel('lost').text, 'GPS SIGNAL LOST');
});

function regionStats(ctx, x, y, w, h) {
  const d = ctx.getImageData(x, y, w, h).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  return { r: r / n, g: g / n, b: b / n };
}

function frame(W, H, color = '#3a7bd5') {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, H);
  return { c, ctx };
}

test('overlay: renders in landscape/portrait, both styles, all sizes', () => {
  for (const [W, H] of [[1920, 1080], [1080, 1920], [1280, 720], [720, 1280]]) {
    for (const style of ['digital', 'dial']) {
      for (const size of ['s', 'm', 'l']) {
        const o = new OverlayRenderer();
        const { ctx } = frame(W, H);
        o.paint(ctx, W, H, baseState({ style, size }));
        assert(o.bandH > 0 && o.bandH < H * 0.45, `band height ${o.bandH} for ${W}x${H} ${style} ${size}`);
        const top = regionStats(ctx, 0, 0, W, Math.floor(H * 0.3));
        const band = regionStats(ctx, 0, o.bandY, Math.floor(W * 0.25), o.bandH);
        assert(Math.abs(top.b - 213) < 2, 'top of frame untouched');
        assert(band.b < top.b - 15, `overlay visible in band (${W}x${H} ${style} ${size})`);
      }
    }
  }
});

test('overlay: over-limit warning turns the speed panel red', () => {
  const W = 1280, H = 720;
  const a = frame(W, H, '#808080'), b = frame(W, H, '#808080');
  const o1 = new OverlayRenderer(), o2 = new OverlayRenderer();
  o1.paint(a.ctx, W, H, baseState({ over: false }));
  o2.paint(b.ctx, W, H, baseState({ over: true }));
  const n = regionStats(a.ctx, 30, o1.bandY + o1.bandH - 60, 120, 30);
  const w = regionStats(b.ctx, 30, o2.bandY + o2.bandH - 60, 120, 30);
  assert(w.r - w.g > 40, `warning panel should be red (r=${w.r.toFixed(0)} g=${w.g.toFixed(0)})`);
  assert(Math.abs(n.r - n.g) < 10, 'normal panel is neutral');
});

test('overlay: band cache re-renders only on visible changes', () => {
  const o = new OverlayRenderer();
  const { ctx } = frame(1280, 720);
  const s = baseState();
  o.paint(ctx, 1280, 720, s);
  o.paint(ctx, 1280, 720, { ...s, recMs: 5400 }); // same second -> same text
  eq(o.renders, 1);
  o.paint(ctx, 1280, 720, { ...s, speed: 88 });
  eq(o.renders, 2);
});

// ---------------------------------------------------------------- storage
test('storage: chunks round-trip, ordering and delete', async () => {
  const store = new Store(`speedocam-test-${Date.now()}`);
  try {
    await store.putRec({ id: 'b', createdAt: 2, mimeType: 'video/mp4' });
    await store.putRec({ id: 'a', createdAt: 1, mimeType: 'video/mp4' });
    for (let i = 0; i < 12; i++) await store.addChunk('b', i, new Blob([new Uint8Array(10 + i)]), [{ t: i * 1000 }]);
    await store.addChunk('a', 0, new Blob([new Uint8Array(5)]), []);
    eq((await store.listRecs()).map((r) => r.id).join(','), 'b,a');
    const blob = await store.getVideoBlob({ id: 'b', mimeType: 'video/mp4;codecs=avc1' });
    eq(blob.size, 12 * 10 + 66);
    eq(blob.type, 'video/mp4');
    eq((await store.getSamples('b')).map((s) => s.t).join(','), Array.from({ length: 12 }, (_, i) => i * 1000).join(','), 'chunk order (seq 10, 11 after 9)');
    await store.deleteRec('b');
    eq((await store.getChunks('b')).length, 0);
    eq((await store.getChunks('a')).length, 1, 'other recording untouched');
  } finally {
    store._db?.close();
    indexedDB.deleteDatabase(store.name);
  }
});

// ---------------------------------------------------------------- pipeline (synthetic source, test only)
test('pipeline: compositor + recorder burn the overlay into a playable file', async () => {
  if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder unavailable in this browser');
  const stage = document.getElementById('stage');
  // Synthetic "camera": a solid blue animated canvas stream. Test page only.
  const src = frame(640, 360, '#2266ff');
  let n = 0;
  const anim = setInterval(() => {
    src.ctx.fillStyle = '#2266ff';
    src.ctx.fillRect(0, 0, 640, 360);
    src.ctx.fillStyle = '#ffffff';
    src.ctx.fillRect((n++ * 7) % 600, 20, 40, 40);
  }, 33);
  const srcStream = src.c.captureStream(30);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = srcStream;
  stage.append(video);
  await video.play();
  await sleep(300);

  const host = document.createElement('div');
  stage.append(host);
  const overlay = new OverlayRenderer();
  let speed = 50;
  const comp = new Compositor({ video, host, paintOverlay: (ctx, W, H) => overlay.paint(ctx, W, H, baseState({ speed, recMs: rec.elapsedMs() })) });
  const store = new Store(`speedocam-test-pipe-${Date.now()}`);
  const rec = new DashRecorder(store);
  try {
    comp.run({ width: 640, height: 360, fps: 30, lock: true });
    const stream = comp.captureStream(30);
    const meta = await rec.start({ stream, mimeType: pickMimeType(false), videoBitsPerSecond: 2e6, meta: { width: 640, height: 360, fps: 30, mode: 'overlay' } });
    eq(rec.state, 'recording');
    rec.addSample({ spd: 13.9, lat: 1, lon: 2, ts: Date.now(), q: 1 });
    await sleep(1500);
    rec.pause();
    eq(rec.state, 'paused');
    const tPause = rec.elapsedMs();
    await sleep(800);
    near(rec.elapsedMs(), tPause, 1, 'clock frozen while paused');
    rec.resume();
    rec.addSample({ spd: 20, lat: 1, lon: 2.0001, ts: Date.now(), q: 1 });
    speed = 120;
    await sleep(1500);
    const done = await rec.stop();
    stream.getTracks().forEach((t) => t.stop());
    comp.halt();

    eq(done.status, 'complete');
    near(done.durationMs, 3000, 400, 'duration excludes pause');
    assert(done.size > 1000, 'file has data');
    assert(done.chunks >= 2, `chunked persistence (got ${done.chunks} chunks)`);
    const samples = await store.getSamples(meta.id);
    eq(samples.length, 2);
    assert(samples[1].t >= samples[0].t && samples[1].t < tPause + 100, `sample timeline excludes pause (t=${samples[1].t}, pause at ${tPause})`);
    eq(done.stats.maxMps, 20);
    // Hidden/occluded pages throttle frame callbacks, so only check the rate when rendering is live.
    const throttled = document.hidden || (await rafRate()) < 20;
    assert(comp.framesDrawn > (throttled ? 3 : 40), `compositor drew frames (${comp.framesDrawn}, throttled=${throttled})`);

    // Play the stored file back and verify the overlay is burned into the pixels.
    const blob = await store.getVideoBlob(done);
    eq(blob.size, done.size);
    const out = document.createElement('video');
    out.muted = true;
    out.playsInline = true;
    out.src = URL.createObjectURL(blob);
    stage.append(out);
    await new Promise((res, rej) => { out.onloadeddata = res; out.onerror = () => rej(new Error('recorded file failed to load')); setTimeout(() => rej(new Error('load timeout')), 5000); });
    eq(out.videoWidth, 640);
    eq(out.videoHeight, 360);
    const check = frame(640, 360, '#000');
    for (const t of [0, 1.0, 2.5]) {
      out.currentTime = t;
      await new Promise((res) => { out.onseeked = res; setTimeout(res, 2000); });
      check.ctx.drawImage(out, 0, 0);
      const top = regionStats(check.ctx, 0, 100, 640, 60);
      const band = regionStats(check.ctx, 10, 360 - 40, 120, 20);
      assert(top.b > 180, `source frame visible at ${t}s (b=${top.b.toFixed(0)})`);
      assert(band.b < top.b - 40, `overlay burned into recording at ${t}s (band b=${band.b.toFixed(0)} vs ${top.b.toFixed(0)})`);
    }
    stage.append(check.c);
  } finally {
    clearInterval(anim);
    srcStream.getTracks().forEach((t) => t.stop());
    store._db?.close();
    indexedDB.deleteDatabase(store.name);
  }
});

// ---------------------------------------------------------------- runner
(async () => {
  const list = document.getElementById('results');
  for (const t of tests) {
    const li = document.createElement('li');
    try {
      await t.fn();
      results.push({ name: t.name, ok: true });
      li.className = 'ok';
      li.textContent = `✓ ${t.name}`;
      list.append(li);
    } catch (e) {
      results.push({ name: t.name, ok: false, error: String(e?.message || e) });
      li.className = 'fail';
      li.textContent = `✗ ${t.name}`;
      const pre = document.createElement('pre');
      pre.textContent = e?.stack || String(e);
      list.append(li, pre);
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  const sum = document.getElementById('summary');
  sum.textContent = `${results.length - failed}/${results.length} passed`;
  sum.className = failed ? 'fail' : 'ok';
  window.__results = { done: true, passed: results.length - failed, failed, results };
})();

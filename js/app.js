// SpeedoCam controller: wires camera, GPS, compositor/overlay, recorder, storage and UI together,
// and handles iOS interruptions (background, screen lock, calls, camera loss).

import { Settings } from './settings.js';
import { Store } from './storage.js';
import { GpsTracker } from './gps.js';
import { TripStats } from './trip.js';
import { Camera, presetFor } from './camera.js';
import { Compositor, outputSize } from './compositor.js';
import { OverlayRenderer } from './overlay.js';
import { DashRecorder, pickMimeType, bitrateFor } from './recorder.js';
import { ScreenWake } from './wakelock.js';
import { unitInfo, displaySpeed } from './units.js';
import { formatDuration, formatBytes } from './format.js';
import { isIOS, isStandalone, features } from './platform.js';
import { $, toast, openSheet, closeSheet, wireSheetCloseButtons, banner, hideBanner } from './ui/dom.js';
import { Dashboard } from './ui/dashboard.js';
import { SettingsView } from './ui/settings-view.js';
import { LibraryView } from './ui/library.js';
import { DiagnosticsView } from './ui/diagnostics.js';

export const BUILD = 'dev'; // replaced with the commit SHA by the deploy workflow
export const VERSION = `1.0.0 (${BUILD})`;

const MB = 1024 * 1024;
const KEEP_FREE = 300 * MB;   // loop recording keeps at least this much free
const MIN_START = 60 * MB;    // refuse to start below this
const MIN_RUNNING = 40 * MB;  // stop gracefully below this

// ---------- Core objects ----------
const settings = new Settings();
const store = new Store();
const gps = new GpsTracker();
const trip = new TripStats();
const camera = new Camera();
const overlay = new OverlayRenderer();
const wake = new ScreenWake();
const recorder = new DashRecorder(store);

const appEl = $('#app');
const video = $('#camVideo');
const previewEl = $('#preview');
const recordBtn = $('#recordBtn');
const pauseBtn = $('#pauseBtn');

const compositor = new Compositor({
  video,
  host: $('#outputHost'),
  paintOverlay: (ctx, W, H) => overlay.paint(ctx, W, H, overlayState()),
});
const dash = new Dashboard(appEl);

const state = {
  session: null,        // { startedAt, clips } — one ride, may span several clips
  interrupted: null,    // why the current session's clip was cut by iOS
  autoPaused: false,    // paused because the camera was interrupted (mute)
  previewMode: 'camera',
  recStream: null,      // canvas capture stream fed to MediaRecorder
  cameraState: 'off',   // off | starting | live | error
  cameraError: null,
  pendingCameraRestart: false,
  rotating: false,
  handlingError: false,
  lastStorageCheck: 0,
  wakeWarned: false,
  updateWorker: null,
  updateRequested: false,
};

// All state transitions run one at a time.
let ops = Promise.resolve();
function exclusive(fn) {
  const p = ops.then(fn);
  ops = p.catch((e) => console.error(e));
  return p;
}

// ---------- Derived state ----------
function speedNow() {
  return displaySpeed(gps.reading.speedMps, settings.get('units'));
}

function overlayState() {
  const s = settings.all;
  const r = gps.reading;
  const u = unitInfo(s.units);
  const speed = displaySpeed(r.speedMps, s.units);
  const limit = settings.limit;
  return {
    speed,
    unit: u.label,
    gaugeMax: u.gaugeMax,
    limit: s.limitWarning ? limit : null,
    over: s.limitWarning && speed != null && speed > limit,
    showWarning: s.limitWarning && s.overlayWarning,
    max: displaySpeed(trip.maxMps, s.units),
    showMax: s.showMax,
    gpsStatus: r.status,
    accuracy: r.accuracy,
    showGps: s.showGps,
    showDateTime: s.showDateTime,
    showDuration: s.showDuration,
    clock24h: s.clock24h,
    recording: recorder.active,
    paused: recorder.state === 'paused',
    recMs: recorder.elapsedMs(),
    now: new Date(),
    style: s.style,
    accent: s.accent,
    size: s.overlaySize,
    position: s.overlayPosition,
  };
}

// ---------- Rendering ----------
function renderDash() {
  const s = settings.all;
  const u = unitInfo(s.units);
  const speed = speedNow();
  dash.render({
    speed,
    unit: u.label,
    gaugeMax: u.gaugeMax,
    limit: settings.limit,
    limitOn: s.limitWarning,
    over: s.limitWarning && speed != null && speed > settings.limit,
    max: displaySpeed(trip.maxMps, s.units),
    avg: displaySpeed(trip.avgMps, s.units),
    gpsStatus: gps.reading.status,
    accuracy: gps.reading.accuracy,
  });
  const accent = { white: '#ffffff', amber: '#ffb340', cyan: '#64d2ff', green: '#30d158' }[s.accent];
  appEl.style.setProperty('--speed', accent || '#ffffff');
}

function renderCamera() {
  const live = state.cameraState === 'live' && camera.live;
  previewEl.classList.toggle('live', live);
  let text = 'Camera off', level = 'warn';
  if (state.cameraState === 'starting') { text = 'Starting camera…'; level = 'caution'; }
  else if (live && camera.muted) { text = 'Camera interrupted'; level = 'warn'; }
  else if (live) {
    const a = camera.actual || {};
    const short = Math.min(video.videoWidth || a.width || 0, video.videoHeight || a.height || 0);
    text = `${short ? `${short}p` : 'Live'}${a.frameRate ? ` · ${a.frameRate} fps` : ''}`;
    level = 'ok';
  } else if (state.cameraState === 'error') { text = 'Camera error'; }
  dash.setCamera(text, level);
  $('#previewMsgText').textContent = state.cameraState === 'error'
    ? state.cameraError?.message || 'Camera unavailable'
    : state.cameraState === 'starting' ? 'Starting camera…' : 'Camera is off';
  $('#previewStartBtn').hidden = state.cameraState === 'starting';
  $('#previewStartBtn').textContent = state.cameraState === 'error' ? 'Try again' : 'Start camera';
  $('#previewModeBtn').hidden = settings.get('recordMode') === 'raw';
}

function renderRec() {
  const st = recorder.state;
  appEl.dataset.rec = st === 'inactive' ? 'idle' : st;
  $('#recPill').hidden = st === 'inactive';
  $('#recTime').textContent = formatDuration(recorder.elapsedMs());
  const fps = recorder.rec?.mode === 'overlay' && compositor.measuredFps ? ` · ${Math.round(compositor.measuredFps)} fps` : '';
  $('#recSize').textContent = `${formatBytes(recorder.bytes)}${fps}`;
  pauseBtn.disabled = st === 'inactive';
  const paused = st === 'paused';
  pauseBtn.querySelector('use').setAttribute('href', paused ? '#i-play' : '#i-pause');
  pauseBtn.setAttribute('aria-label', paused ? 'Resume recording' : 'Pause recording');
  recordBtn.setAttribute('aria-label', st === 'inactive' ? 'Start recording' : 'Stop recording');
  recordBtn.disabled = state.cameraState === 'starting';
}

function renderAll() {
  renderDash();
  renderCamera();
  renderRec();
}

// ---------- Camera ----------
function waitForVideoSize(timeout = 3000) {
  if (video.videoWidth) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener('loadedmetadata', done); resolve(); };
    video.addEventListener('loadedmetadata', done);
    setTimeout(done, timeout);
  });
}

async function startCamera() {
  if (state.cameraState === 'starting') return false;
  state.cameraState = 'starting';
  renderCamera();
  renderRec();
  const s = settings.all;
  try {
    await camera.start({ quality: s.quality, deviceId: s.cameraId, audio: s.audio });
    video.srcObject = camera.stream;
    await video.play().catch(() => {});
    await waitForVideoSize();
    state.cameraState = 'live';
    state.cameraError = null;
    if (camera.audioError) toast(camera.audioError, 4000);
  } catch (e) {
    state.cameraState = 'error';
    state.cameraError = e;
    video.srcObject = null;
  }
  applyKeepAwake();
  if (state.previewMode === 'output') startOutputPreview();
  renderCamera();
  renderRec();
  return state.cameraState === 'live';
}

async function recoverCamera() {
  for (const wait of [800, 2000, 4000]) {
    if (document.hidden) return false;
    await new Promise((r) => setTimeout(r, wait));
    if (await startCamera()) return true;
  }
  return false;
}

camera.addEventListener('mute', () => {
  if (recorder.state === 'recording') {
    recorder.pause();
    state.autoPaused = true;
    if (!document.hidden) banner('iOS interrupted the camera — recording paused. It resumes automatically when the camera returns.', { warn: true });
  }
  renderCamera();
  renderRec();
});

camera.addEventListener('unmute', () => {
  if (state.autoPaused && recorder.state === 'paused') {
    recorder.resume();
    hideBanner();
  }
  state.autoPaused = false;
  renderCamera();
  renderRec();
});

camera.addEventListener('ended', () => exclusive(async () => {
  if (recorder.active) {
    state.interrupted = 'camera';
    await stopClip('camera-ended');
  }
  state.cameraState = 'off';
  renderAll();
  if (document.hidden) return; // handled when the app becomes visible again
  const ok = await recoverCamera();
  if (ok && state.interrupted) await resumeAfterInterruption();
  else if (!ok && state.session) {
    state.session = null;
    banner('The camera stopped and could not be restarted. Your footage so far was saved.', { warn: true, action: 'Retry', onAction: () => exclusive(startCamera) });
  }
  renderAll();
}));

video.addEventListener('resize', () => {
  renderCamera();
  // Phone rotated while previewing the overlay: match the new frame shape (never while recording).
  if (compositor.running && !compositor.locked) startOutputPreview(true);
});

// ---------- Preview ----------
function startOutputPreview(reconfigure = false) {
  if (!camera.live || settings.get('recordMode') === 'raw') return;
  if (compositor.running && (compositor.locked || !reconfigure)) return;
  const s = settings.all;
  const preset = presetFor(s.quality);
  const a = camera.refreshSettings();
  const { width, height } = outputSize(video.videoWidth || a.width, video.videoHeight || a.height, preset.w, preset.h);
  compositor.run({ width, height, fps: Math.min(preset.fps, a.frameRate || 30) });
}

function applyPreviewMode() {
  if (settings.get('recordMode') === 'raw') state.previewMode = 'camera';
  previewEl.dataset.mode = state.previewMode;
  $('#previewModeBtn').textContent = state.previewMode === 'output' ? 'Overlay view' : 'Camera view';
  if (state.previewMode === 'output') startOutputPreview();
  else if (!recorder.active) compositor.halt();
  renderCamera();
}

// ---------- Recording ----------
function applyKeepAwake() {
  const want = camera.live && (settings.get('keepAwake') === 'always' || recorder.active);
  if (!want) return void wake.disable();
  wake.enable().then((ok) => {
    if (!ok && recorder.active && !state.wakeWarned) {
      state.wakeWarned = true;
      banner('This browser could not keep the screen on. Set Settings › Display & Brightness › Auto-Lock › Never while riding — locking the screen stops recording.', { warn: true });
    }
  });
}

function cleanupRecStream() {
  for (const t of state.recStream?.getVideoTracks() || []) t.stop(); // canvas track only; camera tracks stay alive
  state.recStream = null;
}

let thumbTimer = 0;
function scheduleThumbnail(recId) {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(async () => {
    if (recorder.rec?.id !== recId) return;
    const useCanvas = recorder.rec.mode === 'overlay' && compositor.canvas;
    const src = useCanvas ? compositor.canvas : video;
    const sw = useCanvas ? src.width : video.videoWidth;
    const sh = useCanvas ? src.height : video.videoHeight;
    if (!sw || !sh) return;
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = Math.round((320 * sh) / sw);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.7));
    if (blob && recorder.rec?.id === recId) await recorder.setMeta({ thumb: blob }).catch(() => {});
  }, 1500);
}

async function startClip() {
  const s = settings.all;
  if (!(await ensureStorage(true))) return false;
  const preset = presetFor(s.quality);
  const a = camera.refreshSettings();
  const vw = video.videoWidth || a.width, vh = video.videoHeight || a.height;
  const fps = Math.max(1, Math.min(preset.fps, a.frameRate || preset.fps));
  let stream, width, height;
  if (s.recordMode === 'overlay') {
    ({ width, height } = outputSize(vw, vh, preset.w, preset.h));
    compositor.run({ width, height, fps, lock: true });
    stream = compositor.captureStream(fps);
    state.recStream = stream;
  } else {
    width = vw;
    height = vh;
    stream = new MediaStream([camera.videoTrack]);
    state.recStream = null;
  }
  for (const t of camera.audioTracks) stream.addTrack(t);
  try {
    await recorder.start({
      stream,
      mimeType: pickMimeType(camera.audioTracks.length > 0),
      videoBitsPerSecond: bitrateFor(width, height, fps, s.bitrate),
      meta: {
        width, height, fps,
        mode: s.recordMode,
        quality: s.quality,
        camera: camera.label,
        audio: camera.audioTracks.length > 0,
        part: state.session ? state.session.clips + 1 : 1,
      },
    });
  } catch (e) {
    cleanupRecStream();
    if (state.previewMode !== 'output') compositor.halt(); else compositor.unlock();
    toast(`Could not start recording: ${e.message}`, 4000);
    return false;
  }
  if (state.session) state.session.clips++;
  state.autoPaused = false;
  if (camera.muted) {
    recorder.pause();
    state.autoPaused = true;
  }
  applyKeepAwake();
  scheduleThumbnail(recorder.rec.id);
  renderRec();
  return true;
}

async function stopClip(reason, { keepCompositor = false } = {}) {
  if (!recorder.active) return null;
  clearTimeout(thumbTimer);
  const measuredFps = recorder.rec?.mode === 'overlay' ? Math.round(compositor.measuredFps) || null : null;
  let rec = null;
  try {
    rec = await recorder.stop({ endReason: reason, measuredFps });
  } catch (e) {
    toast(`Saving failed: ${e.message}`, 4000);
  }
  cleanupRecStream();
  state.autoPaused = false;
  if (keepCompositor) compositor.unlock();
  else if (state.previewMode === 'output' && camera.live) { compositor.unlock(); startOutputPreview(true); }
  else compositor.halt();
  renderRec();
  return rec;
}

async function startSession() {
  if (!features().mediaRecorder) {
    banner('Recording is not supported in this browser (MediaRecorder is missing). Update iOS or use Safari.', { warn: true });
    return;
  }
  if (!camera.live && !(await startCamera())) {
    toast('Camera is not available', 3000);
    return;
  }
  trip.reset();
  state.session = { startedAt: Date.now(), clips: 0 };
  state.interrupted = null;
  hideBanner();
  if (!(await startClip())) state.session = null;
  renderAll();
}

async function stopSession(reason = 'user') {
  const rec = await stopClip(reason);
  state.session = null;
  state.interrupted = null;
  applyKeepAwake();
  if (state.pendingCameraRestart) {
    state.pendingCameraRestart = false;
    await startCamera();
  }
  if (rec && rec.status !== 'empty' && reason === 'user') {
    toast(`Saved · ${formatDuration(rec.durationMs)} · ${formatBytes(rec.size)}`);
  }
  if (state.updateWorker) showUpdate(state.updateWorker);
  renderAll();
}

async function resumeAfterInterruption() {
  if (!state.session || !state.interrupted || recorder.active) return;
  if (!settings.get('autoResume')) {
    state.interrupted = null;
    banner('Recording stopped because iOS interrupted the camera. Your footage was saved.', {
      action: 'Resume',
      onAction: () => exclusive(async () => {
        if (!state.session) state.session = { startedAt: Date.now(), clips: 0 };
        await startClip();
        renderAll();
      }),
    });
    return;
  }
  state.interrupted = null;
  if (await startClip()) toast('Recording resumed in a new clip', 3000);
  else state.session = null;
}

recorder.addEventListener('statechange', renderRec);
recorder.addEventListener('progress', renderRec);
recorder.addEventListener('error', (e) => {
  if (state.handlingError) return;
  state.handlingError = true;
  const err = e.detail;
  exclusive(async () => {
    try {
      const quota = err?.name === 'QuotaExceededError';
      if (recorder.active) await stopSession('error');
      banner(quota
        ? 'Storage is full — recording stopped. Your footage so far was saved. Export or delete clips, or enable Loop recording.'
        : `Recording stopped: ${err?.message || 'unknown error'}. Your footage so far was saved.`, { warn: true });
    } finally {
      state.handlingError = false;
    }
  });
});

// ---------- Storage management ----------
async function ensureStorage(beforeStart) {
  const est = await store.estimate();
  if (!est || !est.quota) return true;
  let free = est.free;
  if (free >= KEEP_FREE) return true;
  if (settings.get('loopRecording')) {
    const activeId = recorder.rec?.id;
    const victims = (await store.listRecs())
      .filter((r) => !r.locked && r.id !== activeId && r.status !== 'recording')
      .sort((a, b) => a.createdAt - b.createdAt);
    let deleted = 0;
    for (const r of victims) {
      if (free >= KEEP_FREE) break;
      await store.deleteRec(r.id);
      free += r.size || 0;
      deleted++;
    }
    if (deleted) toast(`Loop recording: removed ${deleted} oldest clip${deleted > 1 ? 's' : ''}`, 3000);
    if (free >= KEEP_FREE) return true;
  }
  if (beforeStart && free < MIN_START) {
    banner('Not enough storage to record. Export and delete clips, or enable Loop recording.', { warn: true });
    return false;
  }
  if (!beforeStart && free < MIN_RUNNING && recorder.active) {
    await stopSession('storage');
    banner('Storage is almost full — recording stopped and saved.', { warn: true });
    return false;
  }
  if (free < KEEP_FREE) toast(`Storage low: ${formatBytes(free)} left`, 3000);
  return true;
}

async function recoverInterrupted() {
  const recs = await store.listRecs();
  let n = 0;
  for (const r of recs.filter((x) => x.status === 'recording')) {
    const chunks = await store.getChunks(r.id);
    const withVideo = chunks.filter((c) => c.blob && c.size);
    if (!withVideo.length) {
      await store.deleteRec(r.id);
      continue;
    }
    const samples = chunks.flatMap((c) => c.samples || []);
    const lastT = samples.length ? samples[samples.length - 1].t : 0;
    Object.assign(r, {
      status: 'recovered',
      size: withVideo.reduce((a, c) => a + c.size, 0),
      chunks: withVideo.length,
      durationMs: Math.max(lastT, withVideo.length * 1000),
      endedAt: r.endedAt || Date.now(),
      stats: TripStats.fromSamples(samples).toJSON(),
    });
    await store.putRec(r);
    n++;
  }
  if (n) toast(`Recovered ${n} interrupted recording${n > 1 ? 's' : ''}`, 3500);
}

// ---------- GPS ----------
gps.addEventListener('reading', (e) => {
  const r = e.detail;
  if (r.speedMps == null || r.status === 'lost') trip.add(null, performance.now());
  else trip.add(r.speedMps, r.receivedAt, r.maxable);

  if (recorder.state === 'recording') {
    if (r.status === 'lost') recorder.addSample({ ts: Date.now(), spd: null, q: 0 });
    else if (r.lat != null) {
      recorder.addSample({
        ts: r.fixTime, lat: r.lat, lon: r.lon, alt: r.altitude, acc: r.accuracy,
        spd: r.speedMps, hdg: r.heading, q: r.maxable ? 1 : 0,
      });
    }
  }
  if (r.status === 'denied') {
    banner('Location access is denied, so speed cannot be shown. Enable it in iOS Settings › Privacy & Security › Location Services › Safari Websites › While Using the App, then reopen SpeedoCam.', { warn: true });
  }
  renderDash();
});

// ---------- Lifecycle / iOS interruptions ----------
async function onHidden() {
  // iOS suspends web apps in the background and stops the camera: finalize the clip now.
  if (recorder.active) {
    state.interrupted = 'background';
    await stopClip('background');
  }
}

async function onVisible() {
  if (!settings.get('onboarded')) return;
  if (gps.status !== 'denied') {
    if (!gps.running) gps.start();
    else if (['lost', 'acquiring', 'unavailable'].includes(gps.status)) gps.restart();
  }
  if (!camera.live || state.cameraState !== 'live') await startCamera();
  if (camera.live && state.interrupted) await resumeAfterInterruption();
  applyKeepAwake();
  renderAll();
}

document.addEventListener('visibilitychange', () => exclusive(document.hidden ? onHidden : onVisible));
window.addEventListener('pagehide', () => exclusive(onHidden));
window.addEventListener('pageshow', (e) => { if (e.persisted) exclusive(onVisible); });

// ---------- Service worker / updates ----------
function showUpdate(worker) {
  state.updateWorker = worker;
  if (recorder.active) return; // offered again after the recording stops
  banner('A new version of SpeedoCam is ready.', {
    action: 'Update',
    onAction: () => {
      if (recorder.active) return toast('Stop recording before updating');
      state.updateRequested = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    },
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (state.updateRequested) location.reload();
  });
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const watch = (w) => w?.addEventListener('statechange', () => {
      if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(w);
    });
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => watch(reg.installing));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch((e) => console.warn('Service worker registration failed', e));
}

// ---------- Views ----------
const settingsView = new SettingsView(settings, {
  overlayState,
  isRecording: () => recorder.active,
  store,
  version: VERSION,
  openDiagnostics: () => { diagnosticsView.open(); openSheet('diagSheet'); },
  openAbout: () => openSheet('aboutSheet'),
  onDeleteUnprotected: async () => {
    const activeId = recorder.rec?.id;
    const victims = (await store.listRecs()).filter((r) => !r.locked && r.id !== activeId);
    if (!victims.length) return toast('No unprotected clips to delete');
    if (!confirm(`Delete ${victims.length} unprotected clip${victims.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
    for (const r of victims) await store.deleteRec(r.id);
    toast(`Deleted ${victims.length} clip${victims.length > 1 ? 's' : ''}`);
    settingsView.updateStorage();
  },
});

const libraryView = new LibraryView(store, settings, { activeRecordingId: () => recorder.rec?.id || null });

const diagnosticsView = new DiagnosticsView({
  camera, compositor, gps, settings, video,
  version: VERSION,
  isRecording: () => recorder.active,
  outputPreviewActive: () => state.previewMode === 'output',
  restartCamera: () => startCamera(),
});

settings.addEventListener('change', (e) => {
  const keys = e.detail.keys;
  if (keys.some((k) => ['quality', 'cameraId', 'audio'].includes(k))) {
    if (recorder.active) state.pendingCameraRestart = true;
    else if (settings.get('onboarded')) exclusive(startCamera);
  }
  if (keys.includes('keepAwake')) applyKeepAwake();
  if (keys.includes('recordMode')) applyPreviewMode();
  renderAll();
});

// ---------- UI bindings ----------
function bindUI() {
  wireSheetCloseButtons();
  recordBtn.addEventListener('click', () => exclusive(() => (recorder.active ? stopSession('user') : startSession())));
  pauseBtn.addEventListener('click', () => {
    if (recorder.state === 'recording') recorder.pause();
    else if (recorder.state === 'paused') { recorder.resume(); state.autoPaused = false; }
    renderRec();
  });
  $('#previewStartBtn').addEventListener('click', () => {
    if (!settings.get('onboarded')) return openSheet('setupSheet');
    exclusive(startCamera);
  });
  $('#previewModeBtn').addEventListener('click', () => {
    state.previewMode = state.previewMode === 'camera' ? 'output' : 'camera';
    applyPreviewMode();
  });
  $('#rideBtn').addEventListener('click', () => {
    const on = appEl.classList.toggle('ride');
    $('#rideBtn').classList.toggle('on', on);
    toast(on ? 'Ride display: preview hidden, recording continues' : 'Preview visible');
  });
  $('#unitBtn').addEventListener('click', () => {
    const next = settings.get('units') === 'kmh' ? 'mph' : 'kmh';
    settings.set({ units: next });
    toast(`Units: ${unitInfo(next).label}`, 1500);
  });
  $('#limitBadge').addEventListener('click', () => settingsView.open());
  $('#settingsBtn').addEventListener('click', () => settingsView.open());
  $('#libraryBtn').addEventListener('click', () => libraryView.open());

  // Long-press the stats to reset the trip (only when not recording, to keep the video overlay consistent).
  const stats = $('#stats');
  let pressTimer = 0;
  stats.addEventListener('pointerdown', () => {
    pressTimer = setTimeout(() => {
      if (recorder.active) return toast('Trip stats reset automatically when a recording starts');
      trip.reset();
      renderDash();
      toast('Trip stats reset');
    }, 700);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) stats.addEventListener(ev, () => clearTimeout(pressTimer));

  $('#setupGrantBtn').addEventListener('click', () => exclusive(async () => {
    settings.set({ onboarded: true });
    closeSheet('setupSheet');
    await startCamera();
    gps.start();
    maybeInstallHint();
  }));
  $('#setupAboutBtn').addEventListener('click', () => openSheet('aboutSheet'));
  $('#setupInstallNote').hidden = !(isIOS && !isStandalone());
  $('#aboutVersion').textContent = `SpeedoCam ${VERSION}`;
}

function maybeInstallHint() {
  if (isIOS && !isStandalone() && !settings.get('installHintDismissed')) {
    banner('For full-screen use, install SpeedoCam: tap Share › Add to Home Screen.', {
      action: 'Got it',
      onAction: () => settings.set({ installHintDismissed: true }),
    });
  }
}

function checkEnvironment() {
  const f = features();
  if (!f.secureContext) {
    banner('Camera and GPS require HTTPS. Open SpeedoCam from its https:// address.', { warn: true });
    return false;
  }
  if (!f.getUserMedia) {
    banner('This browser does not allow camera access. On iPhone use Safari (iOS 14.3 or later).', { warn: true });
    return false;
  }
  if (!f.mediaRecorder) banner('This browser cannot record video (MediaRecorder missing). Update iOS.', { warn: true });
  return true;
}

// UI tick: recording time, segment rotation and storage checks.
setInterval(() => {
  if (document.hidden) return;
  renderRec();
  if (recorder.state !== 'recording') return;
  const seg = settings.get('segmentMinutes');
  if (seg > 0 && recorder.elapsedMs() >= seg * 60000 && !state.rotating) {
    state.rotating = true;
    exclusive(async () => {
      try {
        if (recorder.active && state.session) {
          await stopClip('segment', { keepCompositor: true });
          if (!(await startClip())) state.session = null;
        }
      } finally {
        state.rotating = false;
        renderAll();
      }
    });
  }
  if (Date.now() - state.lastStorageCheck > 30000) {
    state.lastStorageCheck = Date.now();
    exclusive(() => ensureStorage(false));
  }
}, 500);

// ---------- Boot ----------
async function init() {
  bindUI();
  applyPreviewMode();
  renderAll();
  registerServiceWorker();
  try {
    await store.open();
    await recoverInterrupted();
    store.persist();
  } catch (e) {
    banner(`Local storage is unavailable (${e.message}). Recordings cannot be saved.`, { warn: true });
  }
  const envOk = checkEnvironment();
  if (!settings.get('onboarded')) {
    openSheet('setupSheet');
    return;
  }
  if (!envOk) return;
  gps.start();
  await exclusive(startCamera);
  maybeInstallHint();
}

init();

// Exposed for debugging from the console.
window.speedocam = { settings, store, gps, trip, camera, compositor, recorder, overlay, state, VERSION };

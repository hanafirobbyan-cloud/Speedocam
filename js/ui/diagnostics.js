// Device test: measures what this iPhone really supports instead of assuming.
//  1. Browser features (MediaRecorder, captureStream, wake lock, ...) and recordable formats.
//  2. Camera modes: requested vs delivered resolution/fps, and measured frame delivery rate.
//  3. Recording test: 4 s burned-in recording -> output size, bitrate, chunking, playback FPS.
//  4. GPS: live status, source of speed, accuracy and update interval.

import { $, h, toast } from './dom.js';
import { features, isIOS, isStandalone, safariVersion } from '../platform.js';
import { PRESETS, PRESET_ORDER, measureVideoFps } from '../camera.js';
import { supportedMimeTypes, pickMimeType, bitrateFor } from '../recorder.js';
import { outputSize } from '../compositor.js';
import { formatBytes } from '../format.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Effective frame rate of a recorded file, counting distinct media timestamps during playback. */
export function measurePlaybackFps(video, maxMs = 6000) {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const times = new Set();
    let first = null, last = null, handle = 0, done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { video.cancelVideoFrameCallback(handle); } catch { /* ignore */ }
      video.pause();
      if (first == null || last == null || last - first < 0.5) return resolve(null);
      resolve((times.size - 1) / (last - first));
    };
    const cb = (_now, meta) => {
      times.add(meta.mediaTime);
      if (first == null) first = meta.mediaTime;
      last = meta.mediaTime;
      handle = video.requestVideoFrameCallback(cb);
    };
    handle = video.requestVideoFrameCallback(cb);
    video.addEventListener('ended', finish, { once: true });
    video.currentTime = 0;
    video.muted = true;
    video.play().catch(() => finish());
    setTimeout(finish, maxMs);
  });
}

export class DiagnosticsView {
  /** @param {object} ctx { camera, compositor, gps, settings, video, restartCamera(), isRecording(), version } */
  constructor(ctx) {
    this.ctx = ctx;
    this.body = $('#diagBody');
    this.busy = false;
    this.camResults = null;
    this.recResult = null;
    this._gpsTimer = 0;
    $('#diagSheet').addEventListener('sheetclose', () => clearInterval(this._gpsTimer));
  }

  open() {
    this.render();
    clearInterval(this._gpsTimer);
    this._gpsTimer = setInterval(() => this.renderGps(), 1000);
  }

  row(k, v, cls) {
    return h('tr', {}, h('th', {}, k), h('td', { class: cls || '' }, v));
  }

  yes(b) {
    return [b ? 'Yes' : 'No', b ? 'ok-txt' : 'bad-txt'];
  }

  render() {
    const f = features();
    const mimes = supportedMimeTypes();
    const env = h('table', { class: 'diag-table' },
      this.row('Platform', `${isIOS ? 'iOS' : 'Other'}${safariVersion() ? ` · Safari ${safariVersion()}` : ''}`),
      this.row('Installed (Home Screen)', isStandalone() ? 'Yes' : 'No — Share › Add to Home Screen', isStandalone() ? 'ok-txt' : 'warn-txt'),
      this.row('Secure context (HTTPS)', ...this.yes(f.secureContext)),
      this.row('Camera API', ...this.yes(f.getUserMedia)),
      this.row('MediaRecorder', ...this.yes(f.mediaRecorder)),
      this.row('Canvas captureStream', ...this.yes(f.canvasCaptureStream)),
      this.row('Frame-accurate callbacks', ...this.yes(f.videoFrameCallback)),
      this.row('Geolocation', ...this.yes(f.geolocation)),
      this.row('Screen wake lock', ...this.yes(f.wakeLock)),
      this.row('Share files', ...this.yes(f.shareFiles)),
      this.row('Recordable formats', mimes.length ? mimes.map((m) => h('div', {}, m)) : 'None', mimes.length ? '' : 'bad-txt'),
      this.row('Will record as', pickMimeType(false) || 'browser default'),
      this.row('App version', this.ctx.version),
    );

    const blocked = this.ctx.isRecording();
    this.camOut = h('div', { class: 'diag-out' }, this.camResults ? this.camTable() : 'Tests each camera mode and measures the frames actually delivered.');
    this.recOut = h('div', { class: 'diag-out' }, this.recResult ? this.recView() : 'Records 4 seconds with the overlay (not saved) and measures the real output frame rate.');
    this.gpsOut = h('div', { class: 'diag-out' });

    this.body.replaceChildren(
      h('div', { class: 'group-title' }, 'Browser'),
      h('div', { class: 'group' }, h('div', { class: 'row stack' }, env)),
      h('div', { class: 'group-title' }, 'Camera modes'),
      h('div', { class: 'group' }, h('div', { class: 'row stack' }, this.camOut,
        h('div', { class: 'diag-actions' }, h('button', { class: 'btn small', type: 'button', disabled: blocked || this.busy, onclick: () => this.runCamera() }, 'Test camera modes')))),
      h('div', { class: 'group-title' }, 'Recording'),
      h('div', { class: 'group' }, h('div', { class: 'row stack' }, this.recOut,
        h('div', { class: 'diag-actions' }, h('button', { class: 'btn small', type: 'button', disabled: blocked || this.busy, onclick: () => this.runRecording() }, 'Run 4-second recording test')))),
      h('div', { class: 'group-title' }, 'GPS'),
      h('div', { class: 'group' }, h('div', { class: 'row stack' }, this.gpsOut)),
      blocked ? h('p', { class: 'group-foot' }, 'Stop recording to run camera and recording tests.') : null,
    );
    this.renderGps();
  }

  renderGps() {
    if (!this.gpsOut) return;
    const g = this.ctx.gps;
    const r = g.reading;
    const age = r.receivedAt != null ? ((performance.now() - r.receivedAt) / 1000).toFixed(1) : null;
    const interval = g.updateIntervalMs;
    this.gpsOut.replaceChildren(h('table', { class: 'diag-table' },
      this.row('Status', r.status, r.status === 'good' ? 'ok-txt' : r.status === 'weak' || r.status === 'acquiring' ? 'warn-txt' : 'bad-txt'),
      this.row('Speed source', r.source === 'device' ? 'Device (Doppler)' : r.source === 'computed' ? 'Computed from positions' : '—'),
      this.row('Speed', r.rawSpeedMps != null ? `${(r.rawSpeedMps * 3.6).toFixed(1)} km/h · ${(r.rawSpeedMps * 2.23694).toFixed(1)} mph` : '—'),
      this.row('Horizontal accuracy', r.accuracy != null ? `±${r.accuracy.toFixed(0)} m` : '—'),
      this.row('Update interval', interval ? `${(interval / 1000).toFixed(2)} s` : '—'),
      this.row('Last fix age', age != null ? `${age} s` : '—'),
      g.error ? this.row('Last error', g.error.message || String(g.error.code), 'bad-txt') : null,
    ));
  }

  camTable() {
    const rows = this.camResults.map((r) => {
      const ok = r.error ? false : r.measured != null ? r.measured >= r.target * 0.85 && r.short >= r.wantShort * 0.95 : r.reportedFps >= r.target * 0.85;
      return h('tr', {},
        h('td', {}, PRESETS[r.preset].label),
        h('td', {}, r.error ? '—' : `${r.width}×${r.height}`),
        h('td', {}, r.error ? '—' : `${r.reportedFps || '?'} / ${r.measured != null ? r.measured.toFixed(0) : '?'}`),
        h('td', { class: r.error ? 'bad-txt' : ok ? 'ok-txt' : 'warn-txt' }, r.error ? r.error : ok ? 'Supported' : 'Fallback'));
    });
    const best = this.camResults.find((r) => !r.error && r.measured != null && r.measured >= r.target * 0.85 && r.short >= r.wantShort * 0.95);
    return h('div', {},
      h('table', { class: 'diag-table' }, h('tr', {}, h('th', {}, 'Requested'), h('th', {}, 'Delivered'), h('th', {}, 'FPS rep./meas.'), h('th', {}, 'Result')), rows),
      h('p', {}, best ? `Best camera mode: ${PRESETS[best.preset].label}.` : 'No mode reached its target frame rate (the phone may be warm, or in Low Power Mode).'));
  }

  recView() {
    const r = this.recResult;
    if (r.error) return h('p', { class: 'bad-txt' }, r.error);
    const ok = r.playbackFps != null && r.playbackFps >= r.fps * 0.85;
    const v = h('video', { class: 'diag-video', src: r.url, controls: true, playsinline: true, muted: true });
    return h('div', {},
      h('table', { class: 'diag-table' },
        this.row('Mode', `${r.width}×${r.height} @ ${r.fps} fps target`),
        this.row('Format', r.mime || 'browser default'),
        this.row('Compositor (drawn)', `${r.drawFps.toFixed(1)} fps`),
        this.row('Recorded file (played back)', r.playbackFps != null ? `${r.playbackFps.toFixed(1)} fps` : 'Not measurable', ok ? 'ok-txt' : 'warn-txt'),
        this.row('Size / bitrate', `${formatBytes(r.size)} · ${(r.bitrate / 1e6).toFixed(1)} Mbit/s`),
        this.row('Chunks during 4 s', String(r.chunks), r.chunks > 1 ? 'ok-txt' : 'warn-txt'),
      ),
      h('p', {}, ok ? `Verified: this iPhone records ${Math.min(r.width, r.height)}p at ~${Math.round(r.playbackFps)} fps with the overlay.`
        : `Output frame rate is below target. Choose a lower quality (e.g. ${r.fps >= 60 ? '1080p · 30 fps' : '720p · 30 fps'}) for smooth video.`),
      r.chunks <= 1 ? h('p', { class: 'warn-txt' }, 'This browser delivered the video in one piece: if the app is killed mid-recording that clip may be lost. Use short clip splitting.') : null,
      v);
  }

  async runCamera() {
    if (this.busy || this.ctx.isRecording()) return;
    this.busy = true;
    this.render();
    const { camera, video, settings } = this.ctx;
    const results = [];
    try {
      for (const preset of PRESET_ORDER) {
        this.camOut.textContent = `Testing ${PRESETS[preset].label}…`;
        try {
          await camera.start({ quality: preset, deviceId: settings.get('cameraId'), audio: false });
          video.srcObject = camera.stream;
          await video.play().catch(() => {});
          await sleep(700); // let auto-exposure and frame pacing settle
          const measured = await measureVideoFps(video, 1500);
          const a = camera.refreshSettings();
          results.push({
            preset, target: PRESETS[preset].fps, wantShort: PRESETS[preset].h,
            width: a.width, height: a.height, short: Math.min(a.width, a.height), reportedFps: a.frameRate, measured,
          });
        } catch (e) {
          results.push({ preset, target: PRESETS[preset].fps, error: e.message || 'Failed' });
        }
      }
      this.camResults = results;
    } finally {
      this.busy = false;
      await this.ctx.restartCamera();
      this.render();
    }
  }

  async runRecording() {
    if (this.busy || this.ctx.isRecording()) return;
    if (typeof MediaRecorder === 'undefined') {
      this.recResult = { error: 'MediaRecorder is not available in this browser.' };
      return this.render();
    }
    const { camera, compositor, video, settings } = this.ctx;
    if (!camera.live) {
      toast('Start the camera first');
      return;
    }
    this.busy = true;
    if (this.recResult?.url) URL.revokeObjectURL(this.recResult.url);
    this.recResult = null;
    this.render();
    this.recOut.textContent = 'Recording 4 seconds…';
    let stream = null;
    try {
      const preset = PRESETS[settings.get('quality')] || PRESETS['1080p60'];
      const a = camera.refreshSettings();
      const fps = Math.min(preset.fps, a.frameRate || preset.fps);
      const { width, height } = outputSize(video.videoWidth || a.width, video.videoHeight || a.height, preset.w, preset.h);
      compositor.run({ width, height, fps, lock: true });
      stream = compositor.captureStream(fps);
      const mime = pickMimeType(false);
      const bitrate = bitrateFor(width, height, fps, settings.get('bitrate'));
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: bitrate } : { videoBitsPerSecond: bitrate });
      const chunks = [];
      mr.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      const stopped = new Promise((r) => { mr.onstop = r; });
      const drawn0 = compositor.framesDrawn, t0 = performance.now();
      mr.start(1000);
      await sleep(4000);
      mr.stop();
      await Promise.race([stopped, sleep(4000)]);
      const drawFps = ((compositor.framesDrawn - drawn0) * 1000) / (performance.now() - t0);
      const blob = new Blob(chunks, { type: (mr.mimeType || mime || 'video/mp4').split(';')[0] });
      const url = URL.createObjectURL(blob);
      this.recOut.textContent = 'Measuring playback frame rate…';
      const probe = h('video', { playsinline: true, muted: true, src: url });
      probe.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;';
      document.body.append(probe);
      await new Promise((r) => { probe.onloadeddata = r; probe.onerror = r; setTimeout(r, 3000); });
      const playbackFps = await measurePlaybackFps(probe);
      probe.remove();
      this.recResult = {
        width, height, fps, mime: mr.mimeType || mime, size: blob.size, bitrate: (blob.size * 8) / 4,
        chunks: chunks.length, drawFps, playbackFps, url,
      };
    } catch (e) {
      this.recResult = { error: `Recording test failed: ${e.message}` };
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      compositor.unlock();
      if (!this.ctx.outputPreviewActive()) compositor.halt();
      this.busy = false;
      this.render();
    }
  }
}

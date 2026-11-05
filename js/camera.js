// Camera module: getUserMedia with quality presets, real capability reporting and interruption events.
// Emits: 'ended' (track ended), 'mute', 'unmute'.

export const PRESETS = Object.freeze({
  '1080p60': { label: '1080p · 60 fps', w: 1920, h: 1080, fps: 60 },
  '1080p30': { label: '1080p · 30 fps', w: 1920, h: 1080, fps: 30 },
  '720p60': { label: '720p · 60 fps', w: 1280, h: 720, fps: 60 },
  '720p30': { label: '720p · 30 fps', w: 1280, h: 720, fps: 30 },
});
export const PRESET_ORDER = ['1080p60', '1080p30', '720p60', '720p30'];

/** 'auto' asks for the best mode (1080p60); the browser returns the closest it can deliver. */
export function presetFor(quality) {
  return PRESETS[quality] || PRESETS['1080p60'];
}

export function videoConstraints(quality, deviceId) {
  const p = presetFor(quality);
  const v = {
    width: { ideal: p.w },
    height: { ideal: p.h },
    frameRate: { ideal: p.fps, max: p.fps },
  };
  if (deviceId) v.deviceId = { exact: deviceId };
  else v.facingMode = { ideal: 'environment' };
  return v;
}

export class CameraError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.code = code;
    this.cause = cause;
  }
}

export function mapCameraError(e) {
  if (e instanceof CameraError) return e;
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CameraError('denied',
        'Camera access was denied. On iPhone open Settings › Apps › Safari › Camera and choose Allow (or tap "aA" › Website Settings in Safari), then reopen the app.', e);
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new CameraError('notfound', 'The selected camera is not available on this device.', e);
    case 'NotReadableError':
    case 'AbortError':
      return new CameraError('busy',
        'The camera is busy or was interrupted (another app, a call, or Control Center). Close other camera apps and try again.', e);
    default:
      return new CameraError('error', `Camera error: ${e?.message || e}`, e);
  }
}

export class Camera extends EventTarget {
  constructor() {
    super();
    this.stream = null;
    this.videoTrack = null;
    this.audioTracks = [];
    this.actual = null; // { width, height, frameRate, deviceId }
    this.label = '';
    this.quality = 'auto';
    this.audioError = null;
    this._ac = null;
  }

  get live() {
    return this.videoTrack?.readyState === 'live';
  }

  get muted() {
    return !!this.videoTrack?.muted;
  }

  static get supported() {
    return !!(typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia);
  }

  async start({ quality = 'auto', deviceId = '', audio = false } = {}) {
    this.stop();
    if (!Camera.supported) {
      throw new CameraError('unsupported',
        'Camera access is not available here. Open the app in Safari over HTTPS (or from the Home Screen icon).');
    }
    const md = navigator.mediaDevices;
    let stream;
    try {
      stream = await md.getUserMedia({ video: videoConstraints(quality, deviceId), audio: false });
    } catch (e) {
      if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') throw mapCameraError(e);
      // Retry with the most permissive request (e.g. a saved lens no longer exists).
      try {
        stream = await md.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      } catch (e2) {
        throw mapCameraError(e2);
      }
    }

    this.audioError = null;
    let audioTracks = [];
    if (audio) {
      try {
        const a = await md.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
        audioTracks = a.getAudioTracks();
      } catch (e) {
        this.audioError = e?.name === 'NotAllowedError' ? 'Microphone access denied — recording without audio.' : 'Microphone unavailable — recording without audio.';
      }
    }

    this.quality = quality;
    this.videoTrack = stream.getVideoTracks()[0];
    this.audioTracks = audioTracks;
    this.stream = new MediaStream([this.videoTrack, ...audioTracks]);
    this.label = this.videoTrack.label || 'Camera';
    this.refreshSettings();

    this._ac = new AbortController();
    const opt = { signal: this._ac.signal };
    this.videoTrack.addEventListener('ended', () => this.dispatchEvent(new Event('ended')), opt);
    this.videoTrack.addEventListener('mute', () => this.dispatchEvent(new Event('mute')), opt);
    this.videoTrack.addEventListener('unmute', () => this.dispatchEvent(new Event('unmute')), opt);
    return this.stream;
  }

  refreshSettings() {
    const s = this.videoTrack?.getSettings?.() || {};
    this.actual = {
      width: s.width || 0,
      height: s.height || 0,
      frameRate: s.frameRate ? Math.round(s.frameRate) : 0,
      deviceId: s.deviceId || '',
    };
    return this.actual;
  }

  capabilities() {
    try {
      return this.videoTrack?.getCapabilities?.() || null;
    } catch {
      return null;
    }
  }

  stop() {
    this._ac?.abort();
    this._ac = null;
    for (const t of this.stream?.getTracks() || []) t.stop();
    this.stream = null;
    this.videoTrack = null;
    this.audioTracks = [];
    this.actual = null;
  }

  /** Lists video inputs. Labels are only available after camera permission was granted. */
  static async listCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((d) => d.kind === 'videoinput' && d.deviceId)
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
    } catch {
      return [];
    }
  }
}

/**
 * Measures the real frame delivery rate of a playing <video> using requestVideoFrameCallback.
 * Returns frames per second, or null if the API is unavailable.
 */
export function measureVideoFps(video, durationMs = 1500) {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let first = null, last = null, frames = 0, pf0 = null, pf1 = null, handle = 0, done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { video.cancelVideoFrameCallback(handle); } catch { /* ignore */ }
      if (first == null || last == null || last <= first || frames < 2) return resolve(0);
      // presentedFrames also counts frames whose callbacks were coalesced, so prefer it.
      const n = pf0 != null && pf1 != null && pf1 > pf0 ? pf1 - pf0 : frames - 1;
      resolve((n * 1000) / (last - first));
    };
    const cb = (now, meta) => {
      const t = now;
      if (first == null) { first = t; pf0 = meta?.presentedFrames ?? null; }
      last = t;
      pf1 = meta?.presentedFrames ?? null;
      frames += 1;
      if (t - first >= durationMs) return finish();
      handle = video.requestVideoFrameCallback(cb);
    };
    handle = video.requestVideoFrameCallback(cb);
    setTimeout(finish, durationMs + 1500);
  });
}

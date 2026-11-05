// Recorder: MediaRecorder wrapper with Start/Pause/Resume/Stop, chunked persistence to IndexedDB,
// live size/duration, and GPS samples timestamped on the video timeline (paused time excluded).
// Emits: 'statechange', 'progress', 'error'.

import { TripStats } from './trip.js';

const VIDEO_ONLY = [
  'video/mp4;codecs=avc1.640028',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];
const WITH_AUDIO = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function supportedMimeTypes() {
  if (typeof MediaRecorder === 'undefined') return [];
  return [...new Set([...VIDEO_ONLY, ...WITH_AUDIO])].filter((t) => {
    try { return MediaRecorder.isTypeSupported(t); } catch { return false; }
  });
}

/** MP4 (H.264) first: it plays everywhere and saves straight to the iOS Photos library. */
export function pickMimeType(withAudio) {
  if (typeof MediaRecorder === 'undefined') return null;
  const list = withAudio ? WITH_AUDIO : VIDEO_ONLY;
  return list.find((t) => {
    try { return MediaRecorder.isTypeSupported(t); } catch { return false; }
  }) || '';
}

export function extensionFor(mime) {
  return /webm/i.test(mime || '') ? 'webm' : 'mp4';
}

const BPP = { low: 0.05, standard: 0.08, high: 0.12 };

/** Bitrate from pixel rate (bits per pixel per frame), clamped to sane bounds. */
export function bitrateFor(width, height, fps, level = 'standard') {
  const bpp = BPP[level] || BPP.standard;
  return Math.round(Math.min(24e6, Math.max(3e6, width * height * (fps || 30) * bpp)));
}

export function newRecordingId() {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `rec-${Date.now()}-${rnd}`;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export class DashRecorder extends EventTarget {
  constructor(store) {
    super();
    this.store = store;
    this.mr = null;
    this.rec = null;
    this._reset();
  }

  _reset() {
    this.seq = 0;
    this.bytes = 0;
    this.chunkCount = 0;
    this._acc = 0;
    this._since = null;
    this._pending = [];
    this.samples = [];
    this._writes = Promise.resolve();
    this.writeError = null;
    this._stopped = null;
  }

  get state() {
    return this.mr ? this.mr.state : 'inactive';
  }

  /** True from start() until stop() has fully finalized the clip. */
  get active() {
    return !!this.mr;
  }

  elapsedMs(now = performance.now()) {
    return this._acc + (this._since != null ? now - this._since : 0);
  }

  async start({ stream, mimeType, videoBitsPerSecond, audioBitsPerSecond = 128000, meta = {}, timeslice = 1000 }) {
    if (this.mr) throw new Error('Recording already in progress.');
    if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder is not supported in this browser.');
    this._reset();

    const opts = {};
    if (mimeType) opts.mimeType = mimeType;
    if (videoBitsPerSecond) opts.videoBitsPerSecond = videoBitsPerSecond;
    if (stream.getAudioTracks().length) opts.audioBitsPerSecond = audioBitsPerSecond;
    // Frequent keyframes let muxers flush data every ~second (crash safety). Browsers that
    // do not know this option ignore it.
    opts.videoKeyFrameIntervalDuration = timeslice;
    let mr;
    try {
      mr = new MediaRecorder(stream, opts);
    } catch {
      mr = new MediaRecorder(stream); // let the browser choose
    }

    const rec = {
      id: newRecordingId(),
      createdAt: Date.now(),
      endedAt: null,
      status: 'recording',
      mimeType: mr.mimeType || mimeType || 'video/mp4',
      durationMs: 0,
      size: 0,
      chunks: 0,
      locked: false,
      thumb: null,
      videoBitsPerSecond: videoBitsPerSecond || null,
      ...meta,
    };
    await this.store.putRec(rec);

    mr.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) this._persist(e.data);
    });
    mr.addEventListener('error', (e) => {
      this.dispatchEvent(new CustomEvent('error', { detail: e.error || new Error('MediaRecorder error') }));
    });
    this._stopped = new Promise((resolve) => mr.addEventListener('stop', resolve, { once: true }));

    this.mr = mr;
    this.rec = rec;
    mr.start(timeslice);
    this._since = performance.now();
    this.dispatchEvent(new Event('statechange'));
    return rec;
  }

  _persist(blob) {
    const seq = this.seq++;
    const samples = this._pending;
    this._pending = [];
    this.bytes += blob.size;
    this.chunkCount++;
    if (blob.type && this.rec && !/^video\//.test(this.rec.mimeType)) this.rec.mimeType = blob.type;
    const id = this.rec.id;
    this._writes = this._writes
      .then(() => this.store.addChunk(id, seq, blob, samples))
      .catch((err) => {
        this.writeError = err;
        this.dispatchEvent(new CustomEvent('error', { detail: err }));
      });
    this.dispatchEvent(new Event('progress'));
  }

  /** Add a GPS sample; it gets the current position on the video timeline (t, ms). */
  addSample(sample) {
    if (this.state !== 'recording') return;
    const s = { ...sample, t: Math.round(this.elapsedMs()) };
    this._pending.push(s);
    this.samples.push(s);
  }

  pause() {
    if (this.state !== 'recording') return false;
    this.mr.pause();
    this._acc += performance.now() - this._since;
    this._since = null;
    this.dispatchEvent(new Event('statechange'));
    return true;
  }

  resume() {
    if (this.state !== 'paused') return false;
    this.mr.resume();
    this._since = performance.now();
    this.dispatchEvent(new Event('statechange'));
    return true;
  }

  /** Merge extra metadata into the clip (e.g. thumbnail). */
  async setMeta(patch) {
    if (!this.rec) return;
    Object.assign(this.rec, patch);
    await this.store.putRec(this.rec);
  }

  /** Stops, flushes all chunks and finalizes metadata. Resolves with the saved recording. */
  async stop(extra = {}) {
    if (!this.mr) return null;
    const mr = this.mr, rec = this.rec;
    const durationMs = this.elapsedMs();
    this._acc = durationMs;
    this._since = null;
    if (mr.state !== 'inactive') {
      try { mr.stop(); } catch { /* already stopped */ }
    }
    await Promise.race([this._stopped, delay(5000)]);
    // Samples that arrived after the last chunk are stored in a data-only chunk.
    if (this._pending.length) {
      const seq = this.seq++, samples = this._pending;
      this._pending = [];
      this._writes = this._writes.then(() => this.store.addChunk(rec.id, seq, null, samples)).catch(() => {});
    }
    await this._writes;
    const stats = TripStats.fromSamples(this.samples).toJSON();
    Object.assign(rec, {
      status: this.chunkCount ? 'complete' : 'empty',
      endedAt: Date.now(),
      durationMs: Math.round(durationMs),
      size: this.bytes,
      chunks: this.chunkCount,
      stats,
      ...extra,
    });
    if (rec.status === 'empty') {
      await this.store.deleteRec(rec.id).catch(() => {});
    } else {
      await this.store.putRec(rec);
    }
    this.mr = null;
    this.rec = null;
    this.dispatchEvent(new Event('statechange'));
    return rec;
  }
}

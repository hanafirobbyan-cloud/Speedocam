// Compositor: draws every camera frame plus the dashboard overlay into a canvas, whose
// captureStream() feeds MediaRecorder. Frames are driven by requestVideoFrameCallback, so the
// overlay is composited onto exactly the camera frame it belongs to (falls back to rAF).

const HAS_RVFC = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

export class Compositor {
  /**
   * @param {object} o
   * @param {HTMLVideoElement} o.video     playing camera video
   * @param {HTMLElement} o.host           element that will hold the output canvas (kept in the DOM;
   *                                       iOS Safari is more reliable capturing attached canvases)
   * @param {(ctx:CanvasRenderingContext2D, W:number, H:number) => void} o.paintOverlay
   */
  constructor({ video, host, paintOverlay }) {
    this.video = video;
    this.host = host;
    this.paintOverlay = paintOverlay;
    this.canvas = null;
    this.ctx = null;
    this.running = false;
    this.locked = false;
    this.fps = 30;
    this.lastDraw = 0;
    this.lastCallback = 0;
    this._handle = 0;
    this._raf = 0;
    this._watch = 0;
    this._win = { start: 0, frames: 0 };
    this.measuredFps = 0;
    this.framesDrawn = 0;
  }

  get width() { return this.canvas?.width || 0; }
  get height() { return this.canvas?.height || 0; }

  _ensureCanvas() {
    if (this.canvas) return;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'output-canvas';
    this.host?.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d', { alpha: false });
  }

  /**
   * Start (or reconfigure) drawing.
   * @param {{width:number, height:number, fps:number, lock?:boolean}} cfg
   * lock=true keeps the canvas size fixed (required while MediaRecorder is consuming it).
   */
  run({ width, height, fps, lock = false }) {
    this._ensureCanvas();
    if (!this.locked && (this.canvas.width !== width || this.canvas.height !== height)) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.fps = fps || 30;
    if (lock) this.locked = true;
    if (!this.running) {
      this.running = true;
      this.draw(); // paint immediately so a recorder never captures an empty first frame
      this.lastDraw = 0;
      this.lastCallback = performance.now();
      this._win = { start: performance.now(), frames: 0 };
      this._schedule();
      this._watch = setInterval(() => this._watchdog(), 250);
    }
  }

  unlock() {
    this.locked = false;
  }

  captureStream(fps) {
    this._ensureCanvas();
    return this.canvas.captureStream(fps || this.fps);
  }

  halt() {
    this.running = false;
    this.locked = false;
    clearInterval(this._watch);
    this._watch = 0;
    this._cancel();
    this.measuredFps = 0;
  }

  _cancel() {
    if (this._handle && HAS_RVFC) {
      try { this.video.cancelVideoFrameCallback(this._handle); } catch { /* ignore */ }
    }
    if (this._raf) cancelAnimationFrame(this._raf);
    this._handle = 0;
    this._raf = 0;
  }

  _schedule() {
    if (!this.running) return;
    if (HAS_RVFC) {
      this._handle = this.video.requestVideoFrameCallback((now) => {
        this._handle = 0;
        this.lastCallback = now;
        this._frame(now, false);
        this._schedule();
      });
    } else {
      this._raf = requestAnimationFrame((now) => {
        this._raf = 0;
        this.lastCallback = now;
        this._frame(now, false);
        this._schedule();
      });
    }
  }

  // Keeps the overlay alive when the camera stops delivering frames and re-arms a dead callback chain.
  _watchdog() {
    if (!this.running) return;
    const now = performance.now();
    if (now - this.lastDraw > 400) this._frame(now, true);
    if (now - this.lastCallback > 1500) {
      this._cancel();
      this.lastCallback = now;
      this._schedule();
    }
  }

  _frame(now, forced) {
    // Throttle when the camera runs faster than the target output rate.
    if (!forced && this.lastDraw && now - this.lastDraw < (1000 / this.fps) * 0.75) return;
    this.draw();
    this.lastDraw = now;
    this.framesDrawn++;
    const w = this._win;
    w.frames++;
    if (now - w.start >= 1000) {
      this.measuredFps = (w.frames * 1000) / (now - w.start);
      this._win = { start: now, frames: 0 };
    }
  }

  draw() {
    const { ctx, canvas, video } = this;
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (vw && vh && video.readyState >= 2) {
      // "Contain" fit: if the phone is rotated mid-recording the frame is letterboxed, never cropped.
      const scale = Math.min(W / vw, H / vh);
      const dw = Math.round(vw * scale), dh = Math.round(vh * scale);
      const dx = Math.round((W - dw) / 2), dy = Math.round((H - dh) / 2);
      if (dw < W || dh < H) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
      }
      ctx.drawImage(video, dx, dy, dw, dh);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
    }
    this.paintOverlay(ctx, W, H);
  }
}

/** Output size for recording: the camera's real frame size, scaled down to fit the chosen preset. */
export function outputSize(videoW, videoH, maxLong, maxShort) {
  if (!videoW || !videoH) return { width: maxLong, height: maxShort };
  const long = Math.max(videoW, videoH), short = Math.min(videoW, videoH);
  const scale = Math.min(1, maxLong / long, maxShort / short);
  // Even dimensions keep H.264 encoders happy.
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(videoW * scale), height: even(videoH * scale) };
}

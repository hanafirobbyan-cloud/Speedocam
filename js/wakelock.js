// Screen Wake Lock: keeps the display on while riding (iOS 16.4+; Home Screen apps since iOS 18.4).
// iOS releases the lock whenever the app is hidden, so it is re-acquired on return.

export class ScreenWake {
  constructor() {
    this.sentinel = null;
    this.wanted = false;
    this.failed = false;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.wanted) this._acquire();
    });
  }

  get supported() {
    return 'wakeLock' in navigator;
  }

  get active() {
    return !!this.sentinel;
  }

  async enable() {
    this.wanted = true;
    return this._acquire();
  }

  async disable() {
    this.wanted = false;
    const s = this.sentinel;
    this.sentinel = null;
    try { await s?.release(); } catch { /* ignore */ }
  }

  async _acquire() {
    if (!this.supported || this.sentinel || document.hidden) return !!this.sentinel;
    try {
      const s = await navigator.wakeLock.request('screen');
      this.sentinel = s;
      this.failed = false;
      s.addEventListener('release', () => {
        if (this.sentinel === s) this.sentinel = null;
      });
      return true;
    } catch {
      this.failed = true;
      return false;
    }
  }
}

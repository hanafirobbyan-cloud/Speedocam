// Platform detection and feature support.

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';

export const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);

export function isStandalone() {
  return navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

export function safariVersion() {
  const m = ua.match(/Version\/(\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

export function features() {
  const proto = (C, k) => typeof C !== 'undefined' && k in C.prototype;
  return {
    secureContext: !!window.isSecureContext,
    getUserMedia: !!navigator.mediaDevices?.getUserMedia,
    mediaRecorder: typeof MediaRecorder !== 'undefined',
    canvasCaptureStream: proto(window.HTMLCanvasElement, 'captureStream'),
    videoFrameCallback: proto(window.HTMLVideoElement, 'requestVideoFrameCallback'),
    geolocation: 'geolocation' in navigator,
    wakeLock: 'wakeLock' in navigator,
    shareFiles: typeof navigator.canShare === 'function',
    indexedDB: 'indexedDB' in window,
    serviceWorker: 'serviceWorker' in navigator,
    storageEstimate: !!navigator.storage?.estimate,
  };
}

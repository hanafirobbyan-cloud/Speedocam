// GPS module: wraps navigator.geolocation and turns raw fixes into trustworthy speed readings.
//
// Rules (designed to never show a misleading speed):
//  * Prefer the device-reported speed (coords.speed, from Core Location's Doppler measurement).
//  * Fall back to distance/time between consecutive fixes only when both fixes are accurate.
//  * Hide the speed ("--") when horizontal accuracy is worse than MAX_ACC or no fix arrived for STALE_MS.
//  * Hold the previous value for an isolated physically implausible jump (> MAX_ACCEL).
//  * Only "good" non-outlier readings may set a new maximum speed.

export const GPS = Object.freeze({
  STALE_MS: 4000,        // no fix for this long -> signal lost
  GOOD_ACC: 20,          // m, accuracy considered good
  MAX_ACC: 50,           // m, worse than this -> speed hidden
  STOP_MPS: 0.5,         // below this the vehicle is treated as stopped (removes GPS jitter)
  MAX_ACCEL: 15,         // m/s^2 (~1.5 g), larger jumps are treated as outliers
  MAX_COMPUTE_GAP_S: 10, // max gap between fixes for computed speed
  MAX_FIX_AGE_MS: 10000, // ignore cached fixes older than this
});

const EARTH_R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function classifyAccuracy(acc) {
  if (!Number.isFinite(acc)) return 'poor';
  if (acc <= GPS.GOOD_ACC) return 'good';
  if (acc <= GPS.MAX_ACC) return 'weak';
  return 'poor';
}

export function idleReading(status) {
  return {
    status, speedMps: null, rawSpeedMps: null, source: null, accuracy: null,
    lat: null, lon: null, altitude: null, heading: null,
    fixTime: null, receivedAt: null, outlier: false, maxable: false,
  };
}

/** Pure speed logic, independent of the browser API so it can be unit tested. */
export class SpeedEstimator {
  constructor() {
    this.reset();
  }

  reset() {
    this.prevFix = null;
    this.lastAccepted = null; // { speed, fixTime }
    this.outlierRun = 0;
    this.last = null;
  }

  /**
   * @param {{lat:number, lon:number, accuracy:number, speed:number|null, heading:number|null,
   *          altitude:number|null, timestamp:number}} fix
   * @param {number} now      monotonic ms (performance.now)
   * @param {number} wallNow  epoch ms (Date.now) used to reject stale cached fixes
   */
  ingest(fix, now, wallNow = Date.now()) {
    if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return null;
    if (Number.isFinite(fix.timestamp) && wallNow - fix.timestamp > GPS.MAX_FIX_AGE_MS) return null;

    const quality = classifyAccuracy(fix.accuracy);
    let speed = null;
    let source = null;

    if (Number.isFinite(fix.speed) && fix.speed >= 0) {
      speed = fix.speed;
      source = 'device';
    } else if (this.prevFix) {
      const p = this.prevFix;
      const dt = (fix.timestamp - p.timestamp) / 1000;
      if (dt > 0.2 && dt <= GPS.MAX_COMPUTE_GAP_S && fix.accuracy <= GPS.MAX_ACC && p.accuracy <= GPS.MAX_ACC) {
        const d = haversine(p.lat, p.lon, fix.lat, fix.lon);
        // Movement smaller than the position uncertainty is indistinguishable from standing still.
        const noise = Math.min(fix.accuracy, p.accuracy) * 0.5;
        speed = d <= noise ? 0 : d / dt;
        source = 'computed';
      }
    }
    this.prevFix = fix;

    let outlier = false;
    if (speed != null) {
      if (speed < GPS.STOP_MPS) speed = 0;
      const la = this.lastAccepted;
      let accept = true;
      if (la) {
        const dt = (fix.timestamp - la.fixTime) / 1000;
        const implausible = dt > 0 && dt < 3 && Math.abs(speed - la.speed) / dt > GPS.MAX_ACCEL;
        if (implausible && this.outlierRun < 2) {
          this.outlierRun++;
          outlier = true;
          accept = false;
        }
      }
      if (accept) {
        this.outlierRun = 0;
        this.lastAccepted = { speed, fixTime: fix.timestamp };
      } else {
        speed = la.speed; // hold the last plausible value
      }
    }

    const visible = quality !== 'poor' && speed != null;
    this.last = {
      status: quality,
      speedMps: visible ? speed : null,
      rawSpeedMps: speed,
      source,
      accuracy: Number.isFinite(fix.accuracy) ? fix.accuracy : null,
      lat: fix.lat,
      lon: fix.lon,
      altitude: Number.isFinite(fix.altitude) ? fix.altitude : null,
      heading: Number.isFinite(fix.heading) ? fix.heading : null,
      fixTime: fix.timestamp,
      receivedAt: now,
      outlier,
      maxable: visible && quality === 'good' && !outlier,
    };
    return this.last;
  }

  /** Returns a 'lost' reading when the last fix is stale, otherwise null. */
  evaluate(now) {
    if (this.last && now - this.last.receivedAt > GPS.STALE_MS) {
      return { ...this.last, status: 'lost', speedMps: null, maxable: false };
    }
    return null;
  }
}

/**
 * Status values: off | unsupported | denied | acquiring | good | weak | poor | lost | unavailable
 * Emits 'reading' events with detail = reading.
 */
export class GpsTracker extends EventTarget {
  constructor(geo = typeof navigator !== 'undefined' ? navigator.geolocation : null) {
    super();
    this.geo = geo || null;
    this.est = new SpeedEstimator();
    this.watchId = null;
    this._timer = null;
    this.error = null;
    this.reading = idleReading(this.geo ? 'off' : 'unsupported');
    this._intervals = [];
  }

  get status() {
    return this.reading.status;
  }

  get running() {
    return this.watchId != null;
  }

  /** Average time between fixes over the last few seconds (ms), for diagnostics. */
  get updateIntervalMs() {
    const a = this._intervals;
    return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  }

  start() {
    if (!this.geo) return this._set(idleReading('unsupported'));
    if (this.watchId != null) return;
    this.est.reset();
    this._intervals = [];
    this._set(idleReading('acquiring'));
    this.watchId = this.geo.watchPosition(
      (p) => this._onPosition(p),
      (e) => this._onError(e),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
    this._timer = setInterval(() => this._tick(), 500);
  }

  stop(status = 'off') {
    if (this.watchId != null) this.geo.clearWatch(this.watchId);
    this.watchId = null;
    clearInterval(this._timer);
    this._timer = null;
    this._set(idleReading(status));
  }

  restart() {
    if (this.watchId == null) return this.start();
    this.geo.clearWatch(this.watchId);
    this.watchId = null;
    clearInterval(this._timer);
    this.start();
  }

  _onPosition(p) {
    const c = p.coords;
    const now = performance.now();
    const prevAt = this.est.last?.receivedAt;
    const r = this.est.ingest({
      lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, speed: c.speed,
      heading: c.heading, altitude: c.altitude, timestamp: p.timestamp,
    }, now);
    if (!r) return;
    if (prevAt != null) {
      this._intervals.push(now - prevAt);
      if (this._intervals.length > 10) this._intervals.shift();
    }
    this.error = null;
    this._set(r);
  }

  _onError(e) {
    this.error = e;
    if (e.code === 1) {
      // PERMISSION_DENIED: stop watching, the user must change it in iOS Settings.
      this.stop('denied');
      return;
    }
    if (e.code === 2 && !this.est.last) this._set(idleReading('unavailable'));
    // TIMEOUT (3): keep watching; staleness is handled by _tick().
  }

  _tick() {
    if (this.watchId == null) return;
    const r = this.est.evaluate(performance.now());
    if (r && this.reading.status !== 'lost') this._set(r);
  }

  _set(reading) {
    this.reading = reading;
    this.dispatchEvent(new CustomEvent('reading', { detail: reading }));
  }
}

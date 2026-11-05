// Trip statistics: max speed, moving-average speed and distance.
// Average speed is a trip-computer style "moving average": distance / time spent moving.

export const MOVING_MPS = 0.5;
const MAX_GAP_MS = 5000; // never integrate across gaps longer than this (signal loss, pauses)

export class TripStats {
  constructor() {
    this.reset();
  }

  reset() {
    this.maxMps = null;
    this.distanceM = 0;
    this.movingMs = 0;
    this._prev = null;
  }

  /**
   * @param {number|null} speedMps  speed, or null when unknown (breaks integration)
   * @param {number} tMs            monotonic time of the sample in ms
   * @param {boolean} maxable       whether this sample is trustworthy enough for the max
   */
  add(speedMps, tMs, maxable = true) {
    if (speedMps == null || !Number.isFinite(speedMps) || !Number.isFinite(tMs)) {
      this._prev = null;
      return;
    }
    if (maxable && (this.maxMps == null || speedMps > this.maxMps)) this.maxMps = speedMps;
    const p = this._prev;
    if (p) {
      const dt = tMs - p.t;
      if (dt > 0 && dt <= MAX_GAP_MS) {
        const v = (speedMps + p.v) / 2;
        if (v >= MOVING_MPS) {
          this.distanceM += (v * dt) / 1000;
          this.movingMs += dt;
        }
      }
    }
    this._prev = { v: speedMps, t: tMs };
  }

  get avgMps() {
    return this.movingMs >= 1000 ? this.distanceM / (this.movingMs / 1000) : null;
  }

  toJSON() {
    return { maxMps: this.maxMps, avgMps: this.avgMps, distanceM: this.distanceM, movingMs: this.movingMs };
  }

  /** Build stats from recorded GPS samples ({t, spd, q}). */
  static fromSamples(samples) {
    const s = new TripStats();
    for (const x of samples || []) s.add(x.spd ?? null, x.t, x.q === 1);
    return s;
  }
}

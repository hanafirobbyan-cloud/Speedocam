// Speed unit definitions and conversions. All speeds are handled internally in m/s.

export const UNITS = Object.freeze({
  kmh: Object.freeze({ id: 'kmh', label: 'km/h', perMps: 3.6, gaugeMax: 240 }),
  mph: Object.freeze({ id: 'mph', label: 'mph', perMps: 2.2369362920544025, gaugeMax: 150 }),
});

export function unitInfo(id) {
  return UNITS[id] || UNITS.kmh;
}

export function fromMps(mps, unit) {
  return mps * unitInfo(unit).perMps;
}

export function toMps(value, unit) {
  return value / unitInfo(unit).perMps;
}

/** Rounded display value in the given unit, or null when the speed is unknown. */
export function displaySpeed(mps, unit) {
  if (mps == null || !Number.isFinite(mps)) return null;
  return Math.round(fromMps(mps, unit));
}

/** Countries that sign road speeds in mph. */
export function defaultUnitForLocale(lang) {
  const tag = lang || (typeof navigator !== 'undefined' ? navigator.language : '') || 'en';
  const region = (tag.split('-')[1] || '').toUpperCase();
  return ['US', 'GB', 'LR', 'MM'].includes(region) ? 'mph' : 'kmh';
}

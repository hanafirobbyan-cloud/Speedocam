// Settings store: validated, persisted in localStorage, emits 'change' events.

import { defaultUnitForLocale } from './units.js';

const KEY = 'speedocam.settings.v1';

export const QUALITY_OPTIONS = ['auto', '1080p60', '1080p30', '720p60', '720p30'];

export const SCHEMA = Object.freeze({
  onboarded: { type: 'boolean', def: false },
  installHintDismissed: { type: 'boolean', def: false },

  // Speed
  units: { type: 'enum', values: ['kmh', 'mph'], def: () => defaultUnitForLocale() },
  limitKmh: { type: 'int', min: 5, max: 400, def: 80 },
  limitMph: { type: 'int', min: 5, max: 250, def: 50 },
  limitWarning: { type: 'boolean', def: true },
  overlayWarning: { type: 'boolean', def: true },

  // Appearance
  style: { type: 'enum', values: ['digital', 'dial'], def: 'digital' },
  accent: { type: 'enum', values: ['white', 'amber', 'cyan', 'green'], def: 'white' },
  overlaySize: { type: 'enum', values: ['s', 'm', 'l'], def: 'm' },
  overlayPosition: { type: 'enum', values: ['left', 'right'], def: 'left' },
  showMax: { type: 'boolean', def: true },
  showGps: { type: 'boolean', def: true },
  showDateTime: { type: 'boolean', def: true },
  showDuration: { type: 'boolean', def: true },
  clock24h: { type: 'boolean', def: true },

  // Recording
  quality: { type: 'enum', values: QUALITY_OPTIONS, def: 'auto' },
  bitrate: { type: 'enum', values: ['low', 'standard', 'high'], def: 'standard' },
  recordMode: { type: 'enum', values: ['overlay', 'raw'], def: 'overlay' },
  audio: { type: 'boolean', def: false },
  segmentMinutes: { type: 'enum', values: [0, 3, 5, 10], def: 5 },
  loopRecording: { type: 'boolean', def: false },
  autoResume: { type: 'boolean', def: true },
  keepAwake: { type: 'enum', values: ['always', 'recording'], def: 'always' },
  cameraId: { type: 'string', def: '' },
});

function defaultFor(key) {
  const d = SCHEMA[key].def;
  return typeof d === 'function' ? d() : d;
}

export function sanitize(key, value) {
  const spec = SCHEMA[key];
  if (!spec) return undefined;
  switch (spec.type) {
    case 'boolean':
      return typeof value === 'boolean' ? value : defaultFor(key);
    case 'int': {
      const n = typeof value === 'string' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) return defaultFor(key);
      return Math.min(spec.max, Math.max(spec.min, Math.round(n)));
    }
    case 'enum': {
      const hit = spec.values.find((v) => v === value || String(v) === String(value));
      return hit !== undefined ? hit : defaultFor(key);
    }
    case 'string':
      return typeof value === 'string' ? value : defaultFor(key);
    default:
      return defaultFor(key);
  }
}

export function defaults() {
  const out = {};
  for (const k of Object.keys(SCHEMA)) out[k] = defaultFor(k);
  return out;
}

function safeStorage() {
  try {
    const s = window.localStorage;
    const probe = '__speedocam_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null; // Private mode or storage disabled: settings live in memory only.
  }
}

export class Settings extends EventTarget {
  constructor(storage = safeStorage(), key = KEY) {
    super();
    this._storage = storage;
    this._key = key;
    this.values = this._load();
  }

  _load() {
    let raw = {};
    try {
      raw = JSON.parse(this._storage?.getItem(this._key) || '{}') || {};
    } catch {
      raw = {};
    }
    const out = {};
    for (const k of Object.keys(SCHEMA)) out[k] = sanitize(k, raw[k]);
    return out;
  }

  _save() {
    try {
      this._storage?.setItem(this._key, JSON.stringify(this.values));
    } catch {
      /* quota or private mode; keep in-memory values */
    }
  }

  get all() {
    return this.values;
  }

  get(key) {
    return this.values[key];
  }

  /** Apply a partial update. Returns the list of keys that actually changed. */
  set(patch) {
    const changed = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in SCHEMA)) continue;
      const val = sanitize(k, v);
      if (val !== this.values[k]) {
        this.values[k] = val;
        changed.push(k);
      }
    }
    if (changed.length) {
      this._save();
      this.dispatchEvent(new CustomEvent('change', { detail: { keys: changed } }));
    }
    return changed;
  }

  /** Speed limit in the currently selected unit. */
  get limit() {
    return this.values.units === 'mph' ? this.values.limitMph : this.values.limitKmh;
  }

  setLimit(value) {
    return this.set(this.values.units === 'mph' ? { limitMph: value } : { limitKmh: value });
  }

  reset() {
    const keep = { onboarded: this.values.onboarded, installHintDismissed: this.values.installHintDismissed };
    this.values = { ...defaults(), ...keep };
    this._save();
    this.dispatchEvent(new CustomEvent('change', { detail: { keys: Object.keys(SCHEMA) } }));
  }
}

// Live dashboard (HTML): big speed readout, arc gauge with limit tick, trip stats and status pills.

import { $ } from './dom.js';
import { gpsLabel } from '../overlay.js';

const CX = 100, CY = 100, R = 86;
const ARC_LEN = R * 1.5 * Math.PI; // 270° arc

export class Dashboard {
  constructor(app) {
    this.app = app;
    this.el = {
      speed: $('#speed'),
      unit: $('#unitBtn'),
      value: $('#gaugeValue'),
      limitTick: $('#gaugeLimit'),
      limitBadge: $('#limitBadge'),
      max: $('#statMax'),
      avg: $('#statAvg'),
      acc: $('#statAcc'),
      gpsPill: $('#gpsPill'),
      camPill: $('#camPill'),
    };
    this._last = {};
  }

  /**
   * @param {{speed:number|null, unit:string, gaugeMax:number, limit:number, limitOn:boolean, over:boolean,
   *          max:number|null, avg:number|null, gpsStatus:string, accuracy:number|null}} s
   */
  render(s) {
    const e = this.el;
    const speedText = s.speed == null ? '--' : String(s.speed);
    if (this._last.speed !== speedText) {
      e.speed.textContent = speedText;
      e.speed.classList.toggle('nodata', s.speed == null);
      this._last.speed = speedText;
    }
    if (this._last.unit !== s.unit) {
      e.unit.textContent = s.unit;
      this._last.unit = s.unit;
    }

    const frac = s.speed == null ? 0 : Math.min(1, Math.max(0, s.speed / s.gaugeMax));
    e.value.style.strokeDasharray = `${(frac * ARC_LEN).toFixed(1)} 1000`;
    e.value.style.visibility = frac > 0 ? 'visible' : 'hidden'; // round caps would draw a dot at 0

    if (s.limit > 0) {
      const a = ((135 + 270 * Math.min(1, s.limit / s.gaugeMax)) * Math.PI) / 180;
      e.limitTick.setAttribute('x1', (CX + Math.cos(a) * (R - 10)).toFixed(1));
      e.limitTick.setAttribute('y1', (CY + Math.sin(a) * (R - 10)).toFixed(1));
      e.limitTick.setAttribute('x2', (CX + Math.cos(a) * (R + 10)).toFixed(1));
      e.limitTick.setAttribute('y2', (CY + Math.sin(a) * (R + 10)).toFixed(1));
      e.limitTick.style.display = s.limitOn ? '' : 'none';
    }
    e.limitBadge.textContent = s.limitOn ? `LIMIT ${s.limit}` : 'LIMIT OFF';
    e.limitBadge.classList.toggle('off', !s.limitOn);
    this.app.classList.toggle('over', !!s.over);

    e.max.textContent = s.max == null ? '--' : String(s.max);
    e.avg.textContent = s.avg == null ? '--' : String(s.avg);
    e.acc.textContent = Number.isFinite(s.accuracy) && s.gpsStatus !== 'lost' ? `±${Math.round(s.accuracy)}m` : '--';

    const g = gpsLabel(s.gpsStatus, s.accuracy);
    const gpsText = {
      good: Number.isFinite(s.accuracy) ? `GPS ±${Math.round(s.accuracy)} m` : 'GPS',
      weak: 'GPS weak',
      poor: 'GPS poor',
      lost: 'GPS lost',
      acquiring: 'Locating…',
      denied: 'GPS denied',
      unavailable: 'GPS unavailable',
      unsupported: 'No GPS',
      off: 'GPS off',
    }[s.gpsStatus] || 'GPS';
    this.setPill(e.gpsPill, gpsText, g.level);
  }

  setCamera(text, level) {
    this.setPill(this.el.camPill, text, level);
  }

  setPill(pill, text, level) {
    pill.querySelector('.txt').textContent = text;
    if (level) pill.dataset.level = level;
    else delete pill.dataset.level;
  }
}

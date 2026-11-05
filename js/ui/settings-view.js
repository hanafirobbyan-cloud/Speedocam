// Settings sheet, generated from the settings store. Re-renders on every settings change.

import { $, h, openSheet, toast } from './dom.js';
import { OverlayRenderer, ACCENTS } from '../overlay.js';
import { unitInfo } from '../units.js';
import { formatBytes } from '../format.js';
import { Camera } from '../camera.js';

export class SettingsView {
  /**
   * @param {import('../settings.js').Settings} settings
   * @param {object} ctx  { overlayState(), isRecording(), store, onDeleteUnprotected(), openDiagnostics(), openAbout(), version }
   */
  constructor(settings, ctx) {
    this.s = settings;
    this.ctx = ctx;
    this.body = $('#settingsBody');
    this.sheet = $('#settingsSheet');
    this.preview = new OverlayRenderer();
    this.cameras = [];
    this._timer = 0;
    settings.addEventListener('change', () => { if (this.isOpen) this.render(); });
    this.sheet.addEventListener('sheetclose', () => clearInterval(this._timer));
  }

  get isOpen() {
    return this.sheet.classList.contains('open');
  }

  async open() {
    this.render();
    openSheet('settingsSheet');
    clearInterval(this._timer);
    this._timer = setInterval(() => this.drawPreview(), 1000);
    this.cameras = await Camera.listCameras();
    this.render();
  }

  // ---------- row builders ----------
  toggle(key, label, hint) {
    const input = h('input', { type: 'checkbox', class: 'switch', checked: !!this.s.get(key), 'aria-label': label });
    input.addEventListener('change', () => this.s.set({ [key]: input.checked }));
    return h('label', { class: 'row' }, h('span', { class: 'row-label' }, label, hint && h('span', { class: 'hint' }, hint)), input);
  }

  seg(key, label, options, { stack = false, hint } = {}) {
    const cur = this.s.get(key);
    const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label },
      options.map(([value, text]) => h('button', {
        type: 'button',
        class: String(value) === String(cur) ? 'sel' : '',
        role: 'radio',
        'aria-checked': String(String(value) === String(cur)),
        onclick: () => this.s.set({ [key]: value }),
      }, text)));
    return h('div', { class: `row${stack ? ' stack' : ''}` }, h('span', { class: 'row-label' }, label, hint && h('span', { class: 'hint' }, hint)), seg);
  }

  select(key, label, options, hint) {
    const cur = String(this.s.get(key));
    const sel = h('select', { class: 'select', 'aria-label': label },
      options.map(([value, text]) => h('option', { value: String(value), selected: String(value) === cur }, text)));
    sel.addEventListener('change', () => this.s.set({ [key]: sel.value }));
    return h('div', { class: 'row' }, h('span', { class: 'row-label' }, label, hint && h('span', { class: 'hint' }, hint)), sel);
  }

  limitStepper() {
    const unit = unitInfo(this.s.get('units'));
    const input = h('input', { type: 'number', inputmode: 'numeric', min: '5', max: '400', value: String(this.s.limit), 'aria-label': 'Speed limit' });
    const step = (d) => this.s.setLimit(this.s.limit + d);
    input.addEventListener('change', () => this.s.setLimit(Number(input.value)));
    return h('div', { class: 'row' },
      h('span', { class: 'row-label' }, 'Speed limit', h('span', { class: 'hint' }, `Saved separately for km/h and mph`)),
      h('div', { class: 'stepper' },
        h('button', { type: 'button', 'aria-label': 'Decrease limit', onclick: () => step(-5) }, '−'),
        input,
        h('button', { type: 'button', 'aria-label': 'Increase limit', onclick: () => step(5) }, '+'),
        h('span', { class: 'u' }, unit.label)));
  }

  swatches() {
    const cur = this.s.get('accent');
    const names = { white: 'White', amber: 'Amber', cyan: 'Cyan', green: 'Green' };
    return h('div', { class: 'row' }, h('span', { class: 'row-label' }, 'Speed color'),
      h('div', { class: 'swatches' }, Object.entries(ACCENTS).map(([k, color]) =>
        h('button', {
          type: 'button', class: `swatch${k === cur ? ' sel' : ''}`, style: `background:${color}`,
          'aria-label': names[k], onclick: () => this.s.set({ accent: k }),
        }))));
  }

  link(label, onClick, hint) {
    return h('button', { type: 'button', class: 'row link', onclick: onClick },
      h('span', { class: 'row-label' }, label, hint && h('span', { class: 'hint' }, hint)));
  }

  group(title, rows, foot) {
    return [h('div', { class: 'group-title' }, title), h('div', { class: 'group' }, rows.filter(Boolean)), foot && h('p', { class: 'group-foot' }, foot)].filter(Boolean);
  }

  // ---------- render ----------
  render() {
    const top = this.body.scrollTop;
    const recording = this.ctx.isRecording();
    this.canvas = h('canvas', { class: 'overlay-preview', width: 640, height: 360, 'aria-label': 'Overlay appearance preview' });

    const cams = [['', 'Default back camera'], ...this.cameras.map((c) => [c.id, c.label])];
    const storageRow = h('div', { class: 'row stack' },
      h('span', { class: 'row-label' }, 'Storage', h('span', { class: 'hint', id: 'storageHint' }, 'Checking…')),
      h('div', { class: 'meter' }, h('i', { id: 'storageMeter' })));

    this.body.replaceChildren(
      ...this.group('Speed', [
        this.seg('units', 'Units', [['kmh', 'km/h'], ['mph', 'mph']]),
        this.limitStepper(),
        this.toggle('limitWarning', 'Over-limit warning', 'Speed turns red above the limit'),
        this.toggle('overlayWarning', 'Show limit in video', 'Limit badge and red warning in recordings'),
      ]),
      ...this.group('Speedometer appearance', [
        h('div', { class: 'row stack' }, this.canvas),
        this.seg('style', 'Style', [['digital', 'Digital'], ['dial', 'Dial']]),
        this.swatches(),
        this.seg('overlaySize', 'Overlay size', [['s', 'S'], ['m', 'M'], ['l', 'L']]),
        this.seg('overlayPosition', 'Speed position', [['left', 'Left'], ['right', 'Right']]),
        this.toggle('showMax', 'Max speed in video'),
        this.toggle('showGps', 'GPS status in video'),
        this.toggle('showDateTime', 'Date & time in video'),
        this.toggle('showDuration', 'Recording time in video'),
        this.toggle('clock24h', '24-hour clock'),
      ], 'Preview uses live values. "--" means there is no reliable GPS speed yet.'),
      ...this.group('Recording', [
        this.select('quality', 'Quality', [
          ['auto', 'Auto (best available)'], ['1080p60', '1080p · 60 fps'], ['1080p30', '1080p · 30 fps'],
          ['720p60', '720p · 60 fps'], ['720p30', '720p · 30 fps'],
        ]),
        this.select('cameraId', 'Camera lens', cams),
        this.seg('bitrate', 'Bitrate', [['low', 'Low'], ['standard', 'Std'], ['high', 'High']], { hint: 'Higher = sharper, larger files' }),
        this.select('recordMode', 'Overlay', [['overlay', 'Burned into video'], ['raw', 'Off (raw camera)']],
          'Raw mode: no overlay, speed exported as SRT/GPX'),
        this.toggle('audio', 'Record audio', 'Microphone (wind noise is likely)'),
        this.select('segmentMinutes', 'Split clips every', [[0, 'Never'], [3, '3 minutes'], [5, '5 minutes'], [10, '10 minutes']]),
        this.toggle('loopRecording', 'Loop recording', 'Delete oldest unprotected clips when storage runs low'),
        this.toggle('autoResume', 'Auto-resume', 'Start a new clip after an interruption'),
        this.seg('keepAwake', 'Keep screen on', [['always', 'Always'], ['recording', 'Recording']]),
      ], recording ? 'Camera changes apply when the current recording stops.' : 'Run the device test to see which modes your iPhone really supports.'),
      ...this.group('Storage', [
        storageRow,
        this.link('Delete all unprotected clips', () => this.ctx.onDeleteUnprotected()),
      ]),
      ...this.group('Help', [
        this.link('Device test', () => this.ctx.openDiagnostics(), 'Measure camera modes, recording FPS and GPS'),
        this.link('iOS limitations', () => this.ctx.openAbout()),
        this.link('Reset settings', () => {
          if (confirm('Reset all settings to defaults? Recordings are not affected.')) { this.s.reset(); toast('Settings reset'); }
        }),
      ], `SpeedoCam ${this.ctx.version}`),
    );
    this.body.scrollTop = top;
    this.drawPreview();
    this.updateStorage();
  }

  drawPreview() {
    const c = this.canvas;
    if (!c) return;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, c.height);
    g.addColorStop(0, '#6b7c8f');
    g.addColorStop(0.55, '#a9b4bf');
    g.addColorStop(0.56, '#3a3d42');
    g.addColorStop(1, '#232528');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.moveTo(316, 200); ctx.lineTo(324, 200); ctx.lineTo(360, 360); ctx.lineTo(280, 360); ctx.closePath();
    ctx.fill();
    this.preview.paint(ctx, c.width, c.height, this.ctx.overlayState());
  }

  async updateStorage() {
    const est = await this.ctx.store.estimate();
    const hint = document.getElementById('storageHint');
    const meter = document.getElementById('storageMeter');
    if (!hint) return;
    if (!est || !est.quota) {
      hint.textContent = 'Storage usage unavailable';
      return;
    }
    hint.textContent = `${formatBytes(est.usage)} used · ${formatBytes(est.free)} available to the app`;
    meter.style.width = `${Math.min(100, (est.usage / est.quota) * 100).toFixed(1)}%`;
  }
}

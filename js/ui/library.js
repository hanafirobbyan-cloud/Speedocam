// Recordings library + player with export (share sheet / download / GPX / SRT), protect and delete.

import { $, h, openSheet, closeSheet, toast } from './dom.js';
import { formatBytes, formatDuration, formatDateLong, formatDistance } from '../format.js';
import { displaySpeed, unitInfo } from '../units.js';
import { videoFileName, baseName, toGPX, toSRT, downloadBlob, shareFile, canShareFile } from '../exporters.js';

export class LibraryView {
  /**
   * @param {import('../storage.js').Store} store
   * @param {import('../settings.js').Settings} settings
   * @param {object} ctx { activeRecordingId(): string|null }
   */
  constructor(store, settings, ctx) {
    this.store = store;
    this.settings = settings;
    this.ctx = ctx;
    this.list = $('#recList');
    this.urls = [];
    this.current = null; // { rec, blob, samples, url }
    $('#librarySheet').addEventListener('sheetclose', () => this._revokeThumbs());
    $('#playerSheet').addEventListener('sheetclose', () => this._closePlayer());
    $('#actShare').addEventListener('click', () => this.share());
    $('#actDownload').addEventListener('click', () => this.download());
    $('#actGpx').addEventListener('click', () => this.exportTrack('gpx'));
    $('#actSrt').addEventListener('click', () => this.exportTrack('srt'));
    $('#actLock').addEventListener('click', () => this.toggleLock());
    $('#actDelete').addEventListener('click', () => this.remove());
  }

  async open() {
    openSheet('librarySheet');
    await this.refresh();
  }

  _revokeThumbs() {
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
  }

  async refresh() {
    this._revokeThumbs();
    const unit = this.settings.get('units');
    const label = unitInfo(unit).label;
    let recs = [];
    try {
      recs = await this.store.listRecs();
    } catch (e) {
      toast(`Could not read recordings: ${e.message}`);
    }
    const activeId = this.ctx.activeRecordingId();
    $('#recEmpty').hidden = recs.length > 0;
    this.list.replaceChildren(...recs.map((rec) => {
      const thumb = h('div', { class: 'rec-thumb' }, h('span', { class: 'dur' }, formatDuration(rec.durationMs)));
      if (rec.thumb instanceof Blob) {
        const u = URL.createObjectURL(rec.thumb);
        this.urls.push(u);
        thumb.style.backgroundImage = `url("${u}")`;
      }
      const st = rec.stats || {};
      const max = displaySpeed(st.maxMps, unit);
      const avg = displaySpeed(st.avgMps, unit);
      const live = rec.id === activeId;
      const badges = [
        live && h('span', { class: 'badge live' }, 'RECORDING'),
        rec.status === 'recovered' && h('span', { class: 'badge warn' }, 'RECOVERED'),
        rec.locked && h('span', { class: 'badge' }, 'PROTECTED'),
        rec.mode === 'raw' && h('span', { class: 'badge' }, 'NO OVERLAY'),
      ].filter(Boolean);
      return h('li', {},
        h('button', { type: 'button', class: 'rec-item', disabled: live, onclick: () => this.openPlayer(rec.id) },
          thumb,
          h('div', { class: 'rec-meta' },
            h('strong', {}, formatDateLong(new Date(rec.createdAt), this.settings.get('clock24h'))),
            h('span', {}, `${formatBytes(rec.size)} · ${rec.height ? `${Math.min(rec.width, rec.height)}p` : ''}${rec.fps ? `${rec.fps}` : ''}`),
            h('span', {}, `Max ${max ?? '--'} · Avg ${avg ?? '--'} ${label} · ${formatDistance(st.distanceM, unit)}`),
            badges.length ? h('span', {}, badges) : null)));
    }));
    const est = await this.store.estimate();
    const total = recs.reduce((a, r) => a + (r.size || 0), 0);
    $('#storageLine').textContent = `${recs.length} clip${recs.length === 1 ? '' : 's'} · ${formatBytes(total)}`
      + (est?.quota ? ` · ${formatBytes(est.free)} available` : '');
  }

  async openPlayer(id) {
    const rec = await this.store.getRec(id);
    if (!rec) return toast('Recording not found');
    const [blob, samples] = await Promise.all([this.store.getVideoBlob(rec), this.store.getSamples(rec.id)]);
    if (!blob.size) return toast('This recording contains no video data');
    const url = URL.createObjectURL(blob);
    this.current = { rec, blob, samples, url };
    const v = $('#playerVideo');
    v.src = url;
    $('#playerTitle').textContent = formatDateLong(new Date(rec.createdAt), this.settings.get('clock24h'));
    this._renderInfo();
    openSheet('playerSheet');
  }

  _renderInfo() {
    const { rec, samples } = this.current;
    const unit = this.settings.get('units');
    const label = unitInfo(unit).label;
    const st = rec.stats || {};
    const item = (k, v) => h('div', {}, h('dt', {}, k), h('dd', {}, v));
    const fps = rec.fps ? `${rec.fps} fps` : '—';
    const res = rec.width && rec.height ? `${rec.width}×${rec.height}` : '—';
    $('#playerInfo').replaceChildren(
      item('Duration', formatDuration(rec.durationMs)),
      item('Size', formatBytes(rec.size)),
      item('Resolution', res),
      item('Frame rate', `${fps}${rec.measuredFps ? ` (drawn ${Math.round(rec.measuredFps)})` : ''}`),
      item('Max speed', `${displaySpeed(st.maxMps, unit) ?? '--'} ${label}`),
      item('Avg speed (moving)', `${displaySpeed(st.avgMps, unit) ?? '--'} ${label}`),
      item('Distance', formatDistance(st.distanceM, unit)),
      item('GPS samples', String(samples.filter((s) => Number.isFinite(s.lat)).length)),
      item('Format', (rec.mimeType || '').split(';')[0] || '—'),
      item('Overlay', rec.mode === 'raw' ? 'Off (raw)' : 'Burned in'),
    );
    const lockBtn = $('#actLock');
    lockBtn.querySelector('use').setAttribute('href', rec.locked ? '#i-unlock' : '#i-lock');
    lockBtn.querySelector('span').textContent = rec.locked ? 'Unprotect' : 'Protect';
  }

  _closePlayer() {
    const v = $('#playerVideo');
    v.pause();
    v.removeAttribute('src');
    v.load();
    if (this.current?.url) URL.revokeObjectURL(this.current.url);
    this.current = null;
  }

  _videoFile() {
    const { rec, blob } = this.current;
    return new File([blob], videoFileName(rec), { type: blob.type || 'video/mp4' });
  }

  // Called synchronously from the tap so iOS keeps the user activation needed for the share sheet.
  async share() {
    if (!this.current) return;
    const file = this._videoFile();
    if (!canShareFile(file)) {
      toast('Sharing is not supported here — downloading instead');
      return this.download();
    }
    try {
      const r = await shareFile(file);
      if (r === 'shared') toast('Shared');
    } catch (e) {
      toast(`Share failed: ${e.message}. Try Download.`);
    }
  }

  download() {
    if (!this.current) return;
    downloadBlob(this.current.blob, videoFileName(this.current.rec));
    toast('Download started — find it in Files › Downloads');
  }

  async exportTrack(kind) {
    if (!this.current) return;
    const { rec, samples } = this.current;
    if (!samples.some((s) => Number.isFinite(s.lat))) return toast('No GPS data was recorded for this clip');
    const unit = this.settings.get('units');
    const text = kind === 'gpx'
      ? toGPX(samples, `SpeedoCam ${new Date(rec.createdAt).toISOString()}`)
      : toSRT(samples, unit, { clock24h: this.settings.get('clock24h'), durationMs: rec.durationMs });
    const type = kind === 'gpx' ? 'application/gpx+xml' : 'application/x-subrip';
    const file = new File([text], `${baseName(rec)}.${kind}`, { type });
    if (canShareFile(file)) {
      try {
        await shareFile(file);
        return;
      } catch { /* fall through to download */ }
    }
    downloadBlob(file, file.name);
  }

  async toggleLock() {
    if (!this.current) return;
    const rec = this.current.rec;
    rec.locked = !rec.locked;
    await this.store.putRec(rec);
    this._renderInfo();
    toast(rec.locked ? 'Protected from loop recording and bulk delete' : 'Protection removed');
    this.refresh();
  }

  async remove() {
    if (!this.current) return;
    const rec = this.current.rec;
    const msg = rec.locked ? 'This clip is protected. Delete it anyway?' : 'Delete this recording? This cannot be undone.';
    if (!confirm(msg)) return;
    await this.store.deleteRec(rec.id);
    closeSheet('playerSheet');
    toast('Recording deleted');
    this.refresh();
  }
}

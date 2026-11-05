// IndexedDB storage for recordings.
//   recordings: { id, createdAt, endedAt, status, mimeType, durationMs, size, width, height, fps, ... , thumb: Blob }
//   chunks:     { recId, seq, blob, size, samples: [gps samples recorded during this chunk] }
// Video data is written chunk by chunk while recording, so a crash or an iOS kill loses at most ~1 s.

const VERSION = 1;

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

export class Store {
  constructor(name = 'speedocam') {
    this.name = name;
    this._db = null;
    this._opening = null;
  }

  open() {
    if (this._opening) return this._opening;
    this._opening = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is not available.'));
      const r = indexedDB.open(this.name, VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('recordings')) db.createObjectStore('recordings', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['recId', 'seq'] });
      };
      r.onsuccess = () => {
        this._db = r.result;
        this._db.onversionchange = () => this._db.close();
        resolve(this._db);
      };
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('Storage is blocked by another open copy of the app.'));
    });
    this._opening.catch(() => { this._opening = null; });
    return this._opening;
  }

  /** Runs a single-request operation inside its own transaction; resolves after commit. */
  async _op(storeNames, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      let result;
      try {
        const r = fn(tx);
        if (r && 'onsuccess' in r) req(r).then((v) => { result = v; }, () => {});
      } catch (e) {
        try { tx.abort(); } catch { /* ignore */ }
        reject(e);
        return;
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  }

  putRec(rec) {
    return this._op(['recordings'], 'readwrite', (tx) => tx.objectStore('recordings').put(rec));
  }

  getRec(id) {
    return this._op(['recordings'], 'readonly', (tx) => tx.objectStore('recordings').get(id));
  }

  async listRecs() {
    const all = (await this._op(['recordings'], 'readonly', (tx) => tx.objectStore('recordings').getAll())) || [];
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  addChunk(recId, seq, blob, samples = []) {
    return this._op(['chunks'], 'readwrite', (tx) =>
      tx.objectStore('chunks').put({ recId, seq, blob, size: blob ? blob.size : 0, samples }));
  }

  _range(recId) {
    return IDBKeyRange.bound([recId, 0], [recId, Infinity]);
  }

  async getChunks(recId) {
    return (await this._op(['chunks'], 'readonly', (tx) => tx.objectStore('chunks').getAll(this._range(recId)))) || [];
  }

  async deleteRec(id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['recordings', 'chunks'], 'readwrite');
      tx.objectStore('chunks').delete(this._range(id));
      tx.objectStore('recordings').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Delete aborted'));
    });
  }

  /** Concatenates the stored chunks into one playable file. */
  async getVideoBlob(rec) {
    const chunks = await this.getChunks(rec.id);
    const blobs = chunks.filter((c) => c.blob && c.blob.size).map((c) => c.blob);
    const type = (rec.mimeType || 'video/mp4').split(';')[0];
    return new Blob(blobs, { type });
  }

  async getSamples(recId) {
    const chunks = await this.getChunks(recId);
    return chunks.flatMap((c) => c.samples || []);
  }

  async estimate() {
    try {
      const e = await navigator.storage?.estimate?.();
      if (!e) return null;
      return { usage: e.usage || 0, quota: e.quota || 0, free: Math.max(0, (e.quota || 0) - (e.usage || 0)) };
    } catch {
      return null;
    }
  }

  async persist() {
    try {
      if (await navigator.storage?.persisted?.()) return true;
      return (await navigator.storage?.persist?.()) || false;
    } catch {
      return false;
    }
  }
}

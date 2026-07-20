// lib/audiostore.js — simpan chunk audio rekaman TERAKHIR di IndexedDB.
// Blob tidak bisa lewat chrome.runtime.sendMessage (messaging = serialisasi
// JSON), jadi IndexedDB adalah jalur satu-satunya dari offscreen ke SW/panel.
// Classic script (globalThis).
(() => {
  const DB = 'meet-audio';
  const STORE = 'chunks';

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // fn boleh mengembalikan array request: hasilnya ikut satu transaksi yang
  // sama, jadi meta & blobs tidak bisa berasal dari dua saveAudio berbeda.
  function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(Array.isArray(out) ? out.map((r) => r.result) : (out?.result ?? null));
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  // Meta & blob dipisah: cek "ada audio?" tak boleh menarik ratusan MB blob.
  async function saveAudio({ meetingId, chunkMs, baseTime, blobs }) {
    const db = await open();
    try {
      await tx(db, 'readwrite', (s) => {
        s.put({ meetingId, chunkMs, baseTime, count: blobs.length }, 'meta');
        s.put(blobs, 'blobs');
      });
    } finally {
      db.close();
    }
  }

  async function loadAudioMeta() {
    const db = await open();
    try {
      return await tx(db, 'readonly', (s) => s.get('meta'));
    } finally {
      db.close();
    }
  }

  async function loadAudio() {
    const db = await open();
    try {
      const [meta, blobs] = await tx(db, 'readonly', (s) => [s.get('meta'), s.get('blobs')]);
      if (!meta) return null;
      if (!blobs?.length) return null;
      return { ...meta, blobs };
    } finally {
      db.close();
    }
  }

  globalThis.MeetAudioStore = { saveAudio, loadAudio, loadAudioMeta };
})();

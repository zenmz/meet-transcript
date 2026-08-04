// lib/audiostore.js — simpan chunk audio rekaman TERAKHIR di IndexedDB.
// Blob tidak bisa lewat chrome.runtime.sendMessage (messaging = serialisasi
// JSON), jadi IndexedDB adalah jalur satu-satunya dari offscreen ke SW/panel.
// Classic script (globalThis).
//
// Layout store: key 'meta' = {meetingId, chunkMs, baseTime, count}, lalu satu
// key 'chunk:<i>' per Blob. Chunk dipisah (bukan satu array) supaya rotasi
// tiap 10 menit hanya menulis potongan baru — menyimpan ulang seluruh array
// berarti menulis ratusan MB ke disk tiap rotasi.
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
      // t.error null saat abort dipicu exception di dalam handler — reject(null)
      // membuat `e.message` di pemanggil melempar TypeError dan pesan aslinya hilang.
      t.onerror = () => reject(t.error ?? new Error('Transaksi IndexedDB gagal.'));
      t.onabort = () => reject(t.error ?? new Error('Transaksi IndexedDB dibatalkan.'));
    });
  }

  const withDb = async (mode, fn) => {
    const db = await open();
    try {
      return await tx(db, mode, fn);
    } finally {
      db.close();
    }
  };

  // Dipanggil saat rekaman MULAI: rekaman lama dibuang di sini, bukan di akhir.
  // Meta ditulis lebih dulu supaya meetingId + waktu mulai sudah tersimpan
  // sebelum ada satu chunk pun — rekaman yang mati di tengah (browser ditutup,
  // offscreen dibongkar) tetap meninggalkan audio yang bisa ditemukan.
  function beginAudio({ meetingId, chunkMs, baseTime }) {
    return withDb('readwrite', (s) => {
      s.clear();
      return s.put({ meetingId, chunkMs, baseTime, count: 0 }, 'meta');
    });
  }

  // Tambah satu chunk + naikkan count dalam SATU transaksi: count yang ditulis
  // dari nilai yang dibaca di luar transaksi bisa ketinggalan kalau dua rotasi
  // beruntun, dan chunk terakhir jadi tak terhitung.
  function appendChunk(blob) {
    // Kegagalan dikumpulkan lalu dilempar SETELAH transaksi selesai, bukan
    // dilempar dari dalam handler: exception di dalam onsuccess membatalkan
    // transaksi dengan AbortError buatan browser, dan pesan aslinya hilang —
    // yang sampai ke user cuma "The transaction was aborted".
    let failure = null;
    return withDb('readwrite', (s) => {
      const g = s.get('meta');
      g.onsuccess = () => {
        const meta = g.result;
        if (!meta) { // beginAudio belum jalan / store di-clear di tengah rekaman
          failure = new Error('Meta rekaman hilang — potongan tidak bisa disimpan.');
          return;
        }
        const put = s.put(blob, `chunk:${meta.count}`);
        // Gagalnya satu blob (kuota, storage dibersihkan) TIDAK boleh
        // membatalkan transaksi: kalau count ikut batal, rotasi berikutnya
        // menulis ke indeks yang sama dan potongan itu menyamar jadi potongan
        // yang hilang. Indeksnya dilewati saja — loadAudio mengembalikan indeks
        // asli, jadi timestamp sisanya tetap benar. Tapi preventDefault juga
        // membuat kegagalan itu SENYAP, jadi errornya dicatat untuk dilempar
        // di bawah — kalau tidak, 10 menit audio hilang tanpa peringatan.
        put.onerror = (e) => {
          failure = put.error ?? new Error('Potongan audio gagal ditulis ke IndexedDB.');
          e.preventDefault();
        };
        s.put({ ...meta, count: meta.count + 1 }, 'meta');
      };
      return g;
    }).then((r) => {
      if (failure) throw failure;
      return r;
    });
  }

  // Meta & blob dipisah: cek "ada audio?" tak boleh menarik ratusan MB blob.
  function loadAudioMeta() {
    return withDb('readonly', (s) => s.get('meta'));
  }

  // Dipanggil saat record meeting diarsip (occurrence baru di ruang recurring):
  // meta rekaman sesi lama ikut menunjuk id arsipnya supaya "Unduh audio" &
  // "Transkrip ulang" tetap hidup di entri arsip, bukan yatim. Guard
  // maxBaseTime menutup balapan dengan beginAudio rekaman BARU: meta yang
  // baseTime-nya lebih muda dari aktivitas terakhir sesi lama bukan milik
  // sesi yang diarsip, jangan disentuh.
  function retagAudioMeta(oldId, newId, maxBaseTime) {
    return withDb('readwrite', (s) => {
      const g = s.get('meta');
      g.onsuccess = () => {
        const meta = g.result;
        if (meta && meta.meetingId === oldId && (meta.baseTime ?? 0) <= maxBaseTime) {
          s.put({ ...meta, meetingId: newId }, 'meta');
        }
      };
      return g;
    });
  }

  async function loadAudio() {
    // Satu transaksi untuk meta + semua chunk: dua transaksi terpisah bisa
    // disela beginAudio dari rekaman baru dan mencampur dua rekaman.
    const [meta, keys, vals] = await withDb('readonly',
      (s) => [s.get('meta'), s.getAllKeys(), s.getAll()]);
    if (!meta) return null;
    // Layout lama: semua chunk dalam satu array di key 'blobs'. Dibaca supaya
    // rekaman terakhir milik user yang meng-update extension tidak jadi
    // yatim (tak bisa ditranskrip ulang maupun diunduh).
    const old = vals[keys.indexOf('blobs')];
    if (Array.isArray(old) && old.length) {
      // legacy:true dibawa sampai ke replaceAudioSegments: hanya rekaman
      // inilah yang boleh menghapus baris transkrip ber-id tanpa cap baseTime.
      return { ...meta, blobs: old, indices: old.map((_, i) => i), legacy: true };
    }
    const found = keys
      .map((k, i) => [String(k), vals[i]])
      // Urut numerik, bukan urutan key IndexedDB: key string berurut
      // leksikografis, jadi 'chunk:10' jatuh sebelum 'chunk:2'.
      .filter(([k, v]) => k.startsWith('chunk:') && v)
      .sort((a, b) => Number(a[0].slice(6)) - Number(b[0].slice(6)));
    if (!found.length) return null;
    // indices = nomor potongan yang sebenarnya. Kalau ada yang gagal tersimpan,
    // nomornya bolong — dan tanpa nomor asli ini semua potongan sesudahnya
    // ditimestamp 10 menit terlalu awal saat transkrip ulang.
    return { ...meta, legacy: false,
      blobs: found.map(([, v]) => v), indices: found.map(([k]) => Number(k.slice(6))) };
  }

  globalThis.MeetAudioStore = { beginAudio, appendChunk, loadAudio, loadAudioMeta, retagAudioMeta };
})();

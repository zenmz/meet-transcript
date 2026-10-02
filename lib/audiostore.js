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

  // Bentuk key diparse HANYA di sini. Pemanggil lain cukup memegang `recId`
  // dan daftar `keys` yang dibawa keluar — termasuk pemangkas, yang kalau
  // harus menyusun key sendiri akan jadi salinan kedua aturan ini yang pasti
  // ketinggalan saat salah satunya diperbaiki.
  const META_NEW = /^meta:(\d+)$/;
  const PART_NEW = /^(chunk|vchunk):(\d+):(\d+)$/;
  const PART_OLD = /^(chunk|vchunk):(\d+)$/;

  // Hanya 5 rekaman terakhir yang disimpan.
  // ponytail: batas JUMLAH, bukan anggaran byte. Kalau 5 terasa sempit,
  // naiknya ke anggaran byte — video ±250 MB/jam vs audio ±30 MB/jam, jadi
  // 5 rekaman video panjang ≈ 1,2 GB sementara 5 rekaman audio ≈ 150 MB.
  const KEEP_RECORDINGS = 5;

  // allKeys: SEMUA key di store (getAllKeys tidak membaca nilai — murah).
  // metas: Map key-meta → nilai meta, yaitu 'meta:<baseTime>' dan/atau 'meta'
  // (legacy). Blob TIDAK pernah ikut ke sini: menjawab "ada rekaman apa saja?"
  // tak boleh menarik ratusan MB.
  function groupRecordings(allKeys, metas) {
    const recs = new Map(); // recId → rekaman
    const mk = (metaKey, meta, oldKeys) => {
      const recId = oldKeys ? Number(meta?.baseTime ?? 0) : Number(metaKey.slice(5));
      const rec = { ...meta, recId, oldKeys, legacy: false,
        keys: [metaKey], chunkKeys: [], videoKeys: [] };
      recs.set(recId, rec);
      return rec;
    };
    // Meta baru lebih dulu: kalau baseTime meta legacy kebetulan sama dengan
    // salah satu 'meta:<baseTime>', entri bernama itulah yang benar.
    for (const [key, meta] of metas) if (META_NEW.test(key)) mk(key, meta, false);
    const oldMeta = metas.get('meta');
    const old = oldMeta && !recs.has(Number(oldMeta.baseTime ?? 0))
      ? mk('meta', oldMeta, true) : null;
    for (const k of allKeys) {
      const key = String(k);
      if (key === 'meta' || META_NEW.test(key)) continue; // sudah ditangani
      if (key === 'blobs') {
        // Layout ≤0.3: seluruh chunk dalam satu array. legacy dibawa sampai
        // replaceAudioSegments, jadi flag ini BUKAN sekadar "bentuk key lama".
        if (old) { old.keys.push(key); old.legacy = true; }
        continue;
      }
      const n = key.match(PART_NEW);
      if (n) {
        const rec = recs.get(Number(n[2]));
        if (!rec || rec.oldKeys) continue; // yatim: metanya sudah tidak ada
        rec.keys.push(key);
        (n[1] === 'chunk' ? rec.chunkKeys : rec.videoKeys)
          .push({ key, index: Number(n[3]) });
        continue;
      }
      const o = key.match(PART_OLD);
      if (o && old) {
        old.keys.push(key);
        (o[1] === 'chunk' ? old.chunkKeys : old.videoKeys)
          .push({ key, index: Number(o[2]) });
      }
    }
    // Urut NUMERIK: key IndexedDB berurut leksikografis, jadi 'chunk:x:10'
    // jatuh sebelum 'chunk:x:2' — dan indeks potongan itulah slot waktunya.
    const byIndex = (a, b) => a.index - b.index;
    const out = [...recs.values()];
    for (const r of out) { r.chunkKeys.sort(byIndex); r.videoKeys.sort(byIndex); }
    return out.sort((a, b) => b.recId - a.recId); // terbaru dulu
  }

  // Key yang harus dihapus supaya tinggal `keep` rekaman terbaru. Urutan
  // masukan diurutkan ulang di sini, bukan diandalkan: fungsi ini dipanggil
  // dari dalam transaksi dan salah urut berarti rekaman yang salah dibuang.
  function pruneTargets(recordings, keep = KEEP_RECORDINGS) {
    return recordings.slice()
      .sort((a, b) => b.recId - a.recId)
      .slice(keep)
      .flatMap((r) => r.keys);
  }

  // Dipanggil saat rekaman MULAI: rekaman lama dibuang di sini, bukan di akhir.
  // Meta ditulis lebih dulu supaya meetingId + waktu mulai sudah tersimpan
  // sebelum ada satu chunk pun — rekaman yang mati di tengah (browser ditutup,
  // offscreen dibongkar) tetap meninggalkan audio yang bisa ditemukan.
  function beginAudio({ meetingId, chunkMs, baseTime }) {
    return withDb('readwrite', (s) => {
      s.clear();
      return s.put({ meetingId, chunkMs, baseTime, count: 0, videoCount: 0 }, 'meta');
    });
  }

  // Tambah satu potongan + naikkan counter-nya dalam SATU transaksi: counter
  // yang ditulis dari nilai yang dibaca di luar transaksi bisa ketinggalan
  // kalau dua rotasi beruntun, dan potongan terakhir jadi tak terhitung.
  // Dipakai jalur audio (chunk:/count) dan video (vchunk:/videoCount).
  function appendEntry(blob, prefix, field) {
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
        const i = meta[field] ?? 0;
        const put = s.put(blob, `${prefix}:${i}`);
        // Gagalnya satu blob (kuota, storage dibersihkan) TIDAK boleh
        // membatalkan transaksi: kalau counter ikut batal, rotasi berikutnya
        // menulis ke indeks yang sama dan potongan itu menyamar jadi potongan
        // yang hilang. Indeksnya dilewati saja — loadAudio mengembalikan indeks
        // asli, jadi timestamp sisanya tetap benar. Tapi preventDefault juga
        // membuat kegagalan itu SENYAP, jadi errornya dicatat untuk dilempar
        // di bawah — kalau tidak, 10 menit audio hilang tanpa peringatan.
        put.onerror = (e) => {
          failure = put.error ?? new Error('Potongan gagal ditulis ke IndexedDB.');
          e.preventDefault();
        };
        s.put({ ...meta, [field]: i + 1 }, 'meta');
      };
      return g;
    }).then((r) => {
      if (failure) throw failure;
      return r;
    });
  }
  const appendChunk = (blob) => appendEntry(blob, 'chunk', 'count');
  const appendVideoPart = (blob) => appendEntry(blob, 'vchunk', 'videoCount');

  // Part video dari SATU MediaRecorder ber-timeslice — BUKAN file webm
  // berdiri sendiri seperti chunk audio. Hanya gabungan berurutan seluruh part
  // yang jadi file valid; part yang hilang di tengah membuat sisanya tak
  // terbaca player.
  async function loadVideo() {
    const [meta, keys, vals] = await withDb('readonly',
      (s) => [s.get('meta'), s.getAllKeys(), s.getAll()]);
    if (!meta) return null;
    const found = keys
      .map((k, i) => [String(k), vals[i]])
      .filter(([k, v]) => k.startsWith('vchunk:') && v)
      .sort((a, b) => Number(a[0].slice(7)) - Number(b[0].slice(7)));
    if (!found.length) return null;
    return { ...meta, blobs: found.map(([, v]) => v) };
  }

  // Meta & blob dipisah: cek "ada audio?" tak boleh menarik ratusan MB blob.
  function loadAudioMeta() {
    return withDb('readonly', (s) => s.get('meta'));
  }

  // Restore dari backup (lib/backup.js): ganti seluruh isi store dalam satu
  // transaksi — gagal di tengah = batal semua, tidak ada campuran rekaman
  // lama + import setengah jadi.
  function importAudio(meta, chunks) {
    return withDb('readwrite', (s) => {
      s.clear();
      if (meta) s.put(meta, 'meta'); // null = backup tanpa rekaman: store cuma dikosongkan
      for (const c of chunks) s.put(c.blob, c.key);
    });
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

  globalThis.MeetAudioStore = { beginAudio, appendChunk, appendVideoPart, loadAudio, loadVideo, loadAudioMeta, retagAudioMeta, importAudio,
    groupRecordings, pruneTargets, KEEP_RECORDINGS };
})();

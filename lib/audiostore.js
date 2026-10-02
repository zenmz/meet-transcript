// lib/audiostore.js — simpan chunk audio & part video 5 rekaman TERAKHIR di
// IndexedDB. Blob tidak bisa lewat chrome.runtime.sendMessage (messaging =
// serialisasi JSON), jadi IndexedDB adalah jalur satu-satunya dari offscreen
// ke SW/panel. Classic script (globalThis).
//
// Layout store, berkunci per rekaman dengan recId = baseTime:
//   meta:<baseTime>        {meetingId, chunkMs, baseTime, count, videoCount}
//   chunk:<baseTime>:<i>   Blob audio (tiap chunk file webm berdiri sendiri)
//   vchunk:<baseTime>:<i>  Blob part video (valid hanya digabung berurutan)
// Chunk dipisah (bukan satu array) supaya rotasi tiap 10 menit hanya menulis
// potongan baru — menyimpan ulang seluruh array berarti menulis ratusan MB ke
// disk tiap rotasi.
//
// Kunci layout lama ('meta', 'chunk:<i>', dan 'blobs' dari ≤0.3) dibaca
// sebagai SATU rekaman, tanpa langkah migrasi: satu-satunya tempat yang wajar
// untuk migrasi adalah beginAudio, dan itu jalan persis saat rekaman mulai —
// migrasi yang gagal di situ berarti rekaman gagal start.
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

  // Rentang key meta saja. getAll() tanpa rentang menarik SELURUH blob —
  // ratusan MB untuk pertanyaan "ada rekaman apa saja?".
  const metaRange = () => IDBKeyRange.bound('meta:', 'meta:￿');

  // Request index dalam urutan tetap. Pemanggil menggantungkan diri ke
  // onsuccess request TERAKHIR: request dalam satu transaksi selesai berurutan,
  // jadi hanya di situ keempat hasilnya sudah ada.
  function indexRequests(s) {
    const allKeys = s.getAllKeys();
    const metaKeys = s.getAllKeys(metaRange());
    const metaVals = s.getAll(metaRange());
    const oldMeta = s.get('meta'); // terakhir
    return { allKeys, metaKeys, metaVals, oldMeta };
  }

  function indexFrom({ allKeys, metaKeys, metaVals, oldMeta }) {
    const metas = new Map(metaKeys.result.map((k, i) => [String(k), metaVals.result[i]]));
    if (oldMeta.result) metas.set('meta', oldMeta.result);
    return groupRecordings(allKeys.result, metas);
  }

  // Dipanggil saat rekaman MULAI. TIDAK lagi clear(): rekaman sebelumnya milik
  // user, bukan sampah. Meta ditulis lebih dulu supaya meetingId + waktu mulai
  // sudah tersimpan sebelum ada satu chunk pun — rekaman yang mati di tengah
  // (browser ditutup, offscreen dibongkar) tetap meninggalkan audio yang bisa
  // ditemukan.
  function beginAudio({ meetingId, chunkMs, baseTime }) {
    return withDb('readwrite', (s) => {
      s.put({ meetingId, chunkMs, baseTime, count: 0, videoCount: 0 }, `meta:${baseTime}`);
      // Dibaca SETELAH put di atas, dalam transaksi yang SAMA: daftarnya sudah
      // memuat rekaman baru, jadi 5 lama + 1 baru → tertua dibuang, sisa tepat
      // 5. Satu transaksi juga berarti pangkas yang gagal di tengah
      // membatalkan start — bukan meninggalkan store setengah terpangkas.
      const reqs = indexRequests(s);
      reqs.oldMeta.onsuccess = () => {
        for (const key of pruneTargets(indexFrom(reqs))) s.delete(key);
      };
      return reqs.oldMeta;
    });
  }

  // Daftar rekaman: meta saja, terbaru dulu. Menggantikan loadAudioMeta() —
  // alasan pemisahannya sama: cek "ada rekaman?" tak boleh menarik blob.
  async function listRecordings() {
    let out = [];
    await withDb('readonly', (s) => {
      const reqs = indexRequests(s);
      reqs.oldMeta.onsuccess = () => { out = indexFrom(reqs); };
      return reqs.oldMeta;
    });
    return out;
  }

  // Tambah satu potongan + naikkan counter-nya dalam SATU transaksi: counter
  // yang ditulis dari nilai yang dibaca di luar transaksi bisa ketinggalan
  // kalau dua rotasi beruntun, dan potongan terakhir jadi tak terhitung.
  // recId WAJIB dari pemanggil, bukan dibaca dari meta mana pun yang ada:
  // event recorder yang terlambat harus menulis ke rekamannya SENDIRI.
  function appendEntry(blob, recId, prefix, field) {
    // Kegagalan dikumpulkan lalu dilempar SETELAH transaksi selesai, bukan
    // dilempar dari dalam handler: exception di dalam onsuccess membatalkan
    // transaksi dengan AbortError buatan browser, dan pesan aslinya hilang.
    let failure = null;
    return withDb('readwrite', (s) => {
      const metaKey = `meta:${recId}`;
      const g = s.get(metaKey);
      g.onsuccess = () => {
        const meta = g.result;
        if (!meta) { // rekaman sudah terpangkas / beginAudio belum jalan
          failure = new Error('Meta rekaman hilang — potongan tidak bisa disimpan.');
          return;
        }
        const i = meta[field] ?? 0;
        const put = s.put(blob, `${prefix}:${recId}:${i}`);
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
        s.put({ ...meta, [field]: i + 1 }, metaKey);
      };
      return g;
    }).then((r) => {
      if (failure) throw failure;
      return r;
    });
  }
  const appendChunk = (blob, recId) => appendEntry(blob, recId, 'chunk', 'count');
  const appendVideoPart = (blob, recId) => appendEntry(blob, recId, 'vchunk', 'videoCount');

  // Field internal tidak ikut keluar: pemanggil hanya boleh tahu meta + recId,
  // supaya bentuk key tetap jadi urusan file ini sendiri.
  const publicMeta = ({ keys, chunkKeys, videoKeys, oldKeys, ...rest }) => rest;

  // Dua transaksi (daftar, lalu blob) — dan itu sekarang AMAN. Dulu keduanya
  // wajib satu transaksi karena beginAudio menimpa satu-satunya slot, jadi
  // sela di antaranya bisa mencampur dua rekaman. Sekarang key-nya per
  // rekaman: beginAudio paling jauh MEMANGKAS rekaman ini, dan hasilnya blob
  // yang tidak ketemu → null, bukan blob milik rekaman lain.
  async function loadParts(recId, audio) {
    const rec = (await listRecordings()).find((r) => r.recId === Number(recId));
    if (!rec) return null;
    // Layout ≤0.3: semua chunk dalam satu array di key 'blobs'. Dibaca supaya
    // rekaman terakhir milik user yang meng-update extension tidak jadi yatim.
    // legacy:true dibawa sampai replaceAudioSegments: hanya rekaman inilah yang
    // boleh menghapus baris transkrip ber-id tanpa cap baseTime.
    if (audio && rec.legacy) {
      const old = await withDb('readonly', (s) => s.get('blobs'));
      if (!Array.isArray(old) || !old.length) return null;
      return { ...publicMeta(rec), legacy: true,
        blobs: old, indices: old.map((_, i) => i) };
    }
    const list = audio ? rec.chunkKeys : rec.videoKeys;
    if (!list.length) return null;
    const vals = await withDb('readonly', (s) => list.map((c) => s.get(c.key)));
    // Blob yang hilang (pemangkasan separuh jalan) dibuang bersama indeksnya,
    // bukan dibiarkan jadi undefined di tengah array.
    const kept = vals.map((v, i) => [v, list[i].index]).filter(([v]) => v);
    if (!kept.length) return null;
    // indices = nomor potongan yang SEBENARNYA. Kalau ada yang gagal
    // tersimpan, nomornya bolong — dan tanpa nomor asli ini semua potongan
    // sesudahnya ditimestamp 10 menit terlalu awal saat transkrip ulang.
    return { ...publicMeta(rec), legacy: false,
      blobs: kept.map(([v]) => v), indices: kept.map(([, i]) => i) };
  }

  const loadAudio = (recId) => loadParts(recId, true);
  // Part video dari SATU MediaRecorder ber-timeslice — BUKAN file webm berdiri
  // sendiri seperti chunk audio. Hanya gabungan berurutan seluruh part yang
  // jadi file valid; part yang hilang di tengah membuat sisanya tak terbaca.
  const loadVideo = (recId) => loadParts(recId, false);

  // Dipanggil saat record meeting diarsip (occurrence baru di ruang recurring):
  // meta rekaman sesi lama ikut menunjuk id arsipnya supaya "Unduh audio" &
  // "Transkrip ulang" tetap hidup di entri arsip, bukan yatim. Guard
  // maxBaseTime menutup balapan dengan beginAudio rekaman BARU: meta yang
  // baseTime-nya lebih muda dari aktivitas terakhir sesi lama bukan milik sesi
  // yang diarsip, jangan disentuh.
  // SEMUA meta yang cocok, bukan satu: satu kode ruang bisa punya beberapa
  // rekaman. Key 'meta:<baseTime>' TIDAK berubah — hanya field meetingId —
  // kalau tidak, seluruh chunk-nya jadi yatim.
  function retagAudioMeta(oldId, newId, maxBaseTime) {
    return withDb('readwrite', (s) => {
      const reqs = indexRequests(s);
      reqs.oldMeta.onsuccess = () => {
        const metas = new Map(
          reqs.metaKeys.result.map((k, i) => [String(k), reqs.metaVals.result[i]]));
        if (reqs.oldMeta.result) metas.set('meta', reqs.oldMeta.result);
        for (const [key, m] of metas) {
          if (m && m.meetingId === oldId && (m.baseTime ?? 0) <= maxBaseTime) {
            s.put({ ...m, meetingId: newId }, key);
          }
        }
      };
      return reqs.oldMeta;
    });
  }

  // Restore dari backup (lib/backup.js): ganti seluruh isi store dalam satu
  // transaksi — gagal di tengah = batal semua, tidak ada campuran rekaman lama
  // + import setengah jadi. `chunks` sudah berisi key bentuk baru.
  function importAudio(meta, chunks) {
    return withDb('readwrite', (s) => {
      s.clear();
      // null = backup tanpa rekaman: store cuma dikosongkan. Itu BENAR, bukan
      // kelalaian — import MENGGANTI rekaman, dan rekaman lama yang dibiarkan
      // nempel ke meeting impor berkode ruang sama membuat "Transkrip ulang"
      // menimpa transkrip impor dengan audio sesi lain.
      if (meta) s.put(meta, `meta:${Number(meta.baseTime ?? 0)}`);
      for (const c of chunks) s.put(c.blob, c.key);
    });
  }

  globalThis.MeetAudioStore = { beginAudio, appendChunk, appendVideoPart,
    loadAudio, loadVideo, listRecordings, retagAudioMeta, importAudio,
    groupRecordings, pruneTargets, KEEP_RECORDINGS };
})();

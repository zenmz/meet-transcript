// lib/backup.js — export/import seluruh data extension sebagai file ZIP.
// Classic script (globalThis), dipakai panel Settings.
//
// ZIP ditulis/dibaca sendiri, method STORE saja (tanpa kompresi): isi terbesar
// adalah webm (opus/VP9) yang sudah terkompresi, dan JSON transkrip kecil —
// deflate cuma menambah dependency. Reader ini HANYA untuk membaca zip buatan
// writer ini (STORE, tanpa zip64), bukan zip umum. Tanpa zip64, total backup
// > 4 GB rusak — tambah zip64 kalau rekaman sepanjang itu benar-benar ada.
(() => {
  // CRC32 standar (IEEE), tabel dibangun sekali.
  const TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes, seed = 0xffffffff) {
    let c = seed;
    for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return c; // belum di-XOR akhir — pemanggil yang menutup
  }

  // Waktu file dalam format DOS (2 byte time, 2 byte date), lokal.
  function dosDateTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  // entries: [{name, data: Blob|string}] → Blob zip.
  // CRC butuh membaca seluruh isi, jadi tiap entry dibaca ke memori SEKALI
  // secara berurutan (potongan rekaman ≤ belasan MB per entry — aman) lalu
  // byte-nya dilepas; yang masuk `parts` adalah Blob ASLINYA (Blob-dari-Blob
  // dirujuk, bukan disalin), jadi tidak pernah ada satu salinan utuh di RAM.
  // Push `bytes` alih-alih `blob` = seluruh backup (ratusan MB video) hidup
  // di heap side panel sampai Blob akhir dibuat.
  async function makeZip(entries) {
    const enc = new TextEncoder();
    const { time, date } = dosDateTime(new Date());
    const parts = [];   // isi zip berurutan
    const central = []; // record central directory
    let offset = 0;
    for (const e of entries) {
      const blob = e.data instanceof Blob ? e.data : new Blob([e.data]);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const crc = (crc32(bytes) ^ 0xffffffff) >>> 0;
      const name = enc.encode(e.name);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); // local file header
      lh.setUint16(4, 20, true);         // version needed
      lh.setUint16(8, 0, true);          // method: STORE
      lh.setUint16(10, time, true);
      lh.setUint16(12, date, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, bytes.length, true); // compressed = uncompressed (STORE)
      lh.setUint32(22, bytes.length, true);
      lh.setUint16(26, name.length, true);
      parts.push(lh.buffer, name, blob);
      central.push({ name, crc, size: bytes.length, offset });
      offset += 30 + name.length + bytes.length;
    }
    const cdStart = offset;
    for (const c of central) {
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); // central directory header
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(10, 0, true);         // method: STORE
      ch.setUint16(12, time, true);
      ch.setUint16(14, date, true);
      ch.setUint32(16, c.crc, true);
      ch.setUint32(20, c.size, true);
      ch.setUint32(24, c.size, true);
      ch.setUint16(28, c.name.length, true);
      ch.setUint32(42, c.offset, true);
      parts.push(ch.buffer, c.name);
      offset += 46 + c.name.length;
    }
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true); // end of central directory
    eocd.setUint16(8, central.length, true);
    eocd.setUint16(10, central.length, true);
    eocd.setUint32(12, offset - cdStart, true);
    eocd.setUint32(16, cdStart, true);
    parts.push(eocd.buffer);
    return new Blob(parts, { type: 'application/zip' });
  }

  // Blob zip → [{name, blob}]. Isi entry TIDAK dibaca ke memori — dikembalikan
  // sebagai Blob.slice, jadi zip 300MB pun cuma header-nya yang dibaca.
  // CRC sengaja tidak diverifikasi: butuh membaca seluruh isi, dan sumbernya
  // file lokal buatan sendiri, bukan jaringan.
  async function readZip(file) {
    // EOCD dicari dari ekor (komentar zip bisa menggesernya, walau writer kita
    // tidak pernah menulis komentar — antisipasi zip yang di-resave tool lain).
    const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 66000)).arrayBuffer());
    let p = tail.length - 22;
    while (p >= 0 && !(tail[p] === 0x50 && tail[p + 1] === 0x4b && tail[p + 2] === 0x05 && tail[p + 3] === 0x06)) p--;
    if (p < 0) throw new Error('Bukan file ZIP (end of central directory tidak ketemu).');
    const ev = new DataView(tail.buffer, p);
    const count = ev.getUint16(10, true);
    const cdSize = ev.getUint32(12, true);
    const cdStart = ev.getUint32(16, true);
    const cd = new DataView(await file.slice(cdStart, cdStart + cdSize).arrayBuffer());
    const dec = new TextDecoder();
    const out = [];
    let q = 0;
    for (let i = 0; i < count; i++) {
      if (cd.getUint32(q, true) !== 0x02014b50) throw new Error('Central directory ZIP rusak.');
      const method = cd.getUint16(q + 10, true);
      const size = cd.getUint32(q + 20, true);
      const fnLen = cd.getUint16(q + 28, true);
      const extraLen = cd.getUint16(q + 30, true);
      const commentLen = cd.getUint16(q + 32, true);
      const localOff = cd.getUint32(q + 42, true);
      const name = dec.decode(new Uint8Array(cd.buffer, q + 46, fnLen));
      if (method !== 0) throw new Error(`Entry "${name}" terkompresi — bukan zip backup buatan extension ini.`);
      // Panjang nama/extra di LOCAL header bisa beda dari central (tool lain
      // menambah extra field), jadi offset data dihitung dari local header-nya.
      const lh = new DataView(await file.slice(localOff, localOff + 30).arrayBuffer());
      const dataStart = localOff + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      out.push({ name, blob: file.slice(dataStart, dataStart + size) });
      q += 46 + fnLen + extraLen + commentLen;
    }
    return out;
  }

  const AUDIO_RE = /^audio\/chunk-(\d+)\.webm$/;
  const VIDEO_RE = /^audio\/video-(\d+)\.webm$/;

  const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

  // Seluruh chrome.storage.local + rekaman terakhir di IndexedDB → satu zip.
  async function exportBackup() {
    const storage = await chrome.storage.local.get(null);
    const audio = await globalThis.MeetAudioStore.loadAudio().catch(() => null);
    const video = await globalThis.MeetAudioStore.loadVideo().catch(() => null);
    const meta = await globalThis.MeetAudioStore.loadAudioMeta().catch(() => null);
    const entries = [{
      name: 'backup.json',
      data: JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), storage, audioMeta: meta ?? null }),
    }];
    // Nama file memakai indeks ASLI potongan (bisa bolong kalau ada yang gagal
    // tersimpan) — indeks itulah slot waktunya di transkrip.
    // Rekaman layout lama ('blobs') ikut ter-normalisasi oleh loadAudio; flag
    // legacy-nya tidak dibawa — transkrip ulang atas hasil import rekaman
    // selama itu bisa menduplikasi baris lama alih-alih menggantinya (kasus
    // sempit: satu rekaman terakhir dari versi extension yang sudah lama mati).
    audio?.blobs.forEach((b, i) =>
      entries.push({ name: `audio/chunk-${audio.indices?.[i] ?? i}.webm`, data: b }));
    // Part video dinomori ulang rapat 0..n: gabungan berurutan tetap identik.
    video?.blobs.forEach((b, i) => entries.push({ name: `audio/video-${i}.webm`, data: b }));
    return makeZip(entries);
  }

  // Kebalikannya: MENGGANTI seluruh isi (storage di-clear, store audio ditimpa).
  // Konfirmasi ke user adalah urusan pemanggil.
  async function importBackup(file) {
    const entries = await readZip(file);
    const main = entries.find((e) => e.name === 'backup.json');
    if (!main) throw new Error('backup.json tidak ada di dalam zip — bukan file backup extension ini.');
    let j;
    try { j = JSON.parse(await main.blob.text()); } catch { throw new Error('backup.json rusak (bukan JSON).'); }
    if (j.version !== 1) throw new Error('Format backup tidak dikenal (versi beda?).');
    // Bentuk diperiksa, bukan cuma truthiness: langkah pertama di bawah adalah
    // storage.clear(), jadi backup.json yang rusak/diedit ("storage":"x", array)
    // akan MENGHAPUS seluruh data user lalu gagal saat set(). Ditolak di sini,
    // sebelum ada satu byte pun yang dihapus.
    if (!isPlainObject(j.storage)) throw new Error('backup.json rusak: bagian "storage" bukan objek.');
    if (j.audioMeta != null && !isPlainObject(j.audioMeta)) {
      throw new Error('backup.json rusak: bagian "audioMeta" bukan objek.');
    }
    // Chunk hanya berarti bersama meta-nya (loadAudio mengembalikan null tanpa
    // meta) — zip tanpa audioMeta: chunk tak ditulis dan tak dihitung.
    const chunks = [];
    if (j.audioMeta) {
      for (const e of entries) {
        const a = e.name.match(AUDIO_RE);
        const v = e.name.match(VIDEO_RE);
        if (a) chunks.push({ key: `chunk:${Number(a[1])}`, blob: e.blob });
        else if (v) chunks.push({ key: `vchunk:${Number(v[1])}`, blob: e.blob });
      }
    }
    // Storage dulu, audio belakangan: kalau penulisan blob gagal di tengah,
    // transkrip (data utama) sudah selamat; rekaman tinggal di-import ulang.
    await chrome.storage.local.clear();
    await chrome.storage.local.set(j.storage);
    // Kegagalan restore rekaman TIDAK boleh dilempar: storage sudah terlanjur
    // diganti, dan melempar dari sini membuat panel melaporkan "Import gagal"
    // untuk import yang justru sudah mengganti seluruh riwayat — user percaya
    // tak ada yang berubah padahal data lamanya sudah lenyap. Dilaporkan
    // sebagai hasil parsial supaya pesannya jujur.
    // Dipanggil juga saat audioMeta null: import MENGGANTI rekaman. Rekaman
    // lama yang dibiarkan nempel ke meeting impor berkode ruang sama (recurring),
    // dan "Transkrip ulang" lalu menimpa transkrip impor dengan audio sesi lain.
    let audioError = null;
    await globalThis.MeetAudioStore.importAudio(j.audioMeta ?? null, chunks)
      .catch((e) => { audioError = e.message; });
    return {
      meetings: (j.storage.meetings ?? []).length,
      chunks: audioError ? 0 : chunks.length,
      audioError,
    };
  }

  globalThis.MeetBackup = { makeZip, readZip, exportBackup, importBackup };
})();

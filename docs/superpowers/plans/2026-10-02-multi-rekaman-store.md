# Store Rekaman Multi-Sesi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rekaman baru berhenti menghapus rekaman sebelumnya — store menyimpan 5 rekaman terakhir berkunci `baseTime`, dan backup ZIP jadi teks saja.

**Architecture:** `lib/audiostore.js` berpindah dari satu slot (`meta`, `chunk:<i>`) ke per rekaman (`meta:<baseTime>`, `chunk:<baseTime>:<i>`). Seluruh parsing bentuk key dikumpulkan di satu fungsi murni `groupRecordings`, yang membawa keluar daftar key milik tiap rekaman — sehingga pemanggil lain (dan `pruneTargets`) tak perlu tahu bentuk key sama sekali. Kunci layout lama dibaca sebagai satu rekaman, tanpa langkah migrasi. `exportBackup` berhenti menulis blob dan `audioMeta`; format ZIP tetap `version: 1` karena format itu sudah memperlakukan `audioMeta` sebagai opsional.

**Tech Stack:** JavaScript klasik tanpa modul & tanpa dependency (`globalThis.Meet*`), IndexedDB, Chrome MV3 (offscreen document + service worker), `node --test` dengan `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-10-02-multi-rekaman-store-design.md`

## Global Constraints

- Nol dependency, tanpa `package.json`. Jangan menambah paket apa pun, termasuk `fake-indexeddb`.
- Semua file `lib/*` adalah classic script dalam IIFE yang menulis ke `globalThis` (`globalThis.MeetAudioStore = {…}`). Jangan ubah ke ES module.
- Tes dijalankan dengan `node --test test/*.test.mjs`. 96 tes yang ada sekarang harus tetap hijau di setiap commit, dengan SATU pengecualian yang disebut eksplisit di Task 6: assertion key di `import sehat: chunk & vchunk mendarat di key IndexedDB yang benar` memang berubah.
- `KEEP_RECORDINGS = 5`. Konstanta, bukan setting.
- Format backup tetap `version: 1`. Tidak ada versi 2.
- Komentar & teks UI berbahasa Indonesia, mengikuti gaya file sekitarnya: komentar menjelaskan **kenapa**, bukan apa.
- `legacy: true` HANYA untuk layout `blobs` (≤0.3) — flag itu dibawa sampai `replaceAudioSegments` dan mengubah perilaku penghapusan baris. Bentuk key lama (`meta`/`chunk:<i>`, versi 0.4–0.6) memakai flag terpisah `oldKeys`, dan **bukan** `legacy`.
- Jangan commit dengan trailer `Co-Authored-By` atau atribusi AI apa pun.

## Review Focus

1. **Meta legacy tanpa `baseTime`** (layout ≤0.3) → `recId` jatuh ke `0`; rekaman harus tetap bisa didaftar, dimuat, dan dipangkas, bukan jadi `NaN` yang hilang dari semua daftar. Tes di Task 1 & Task 6.
2. **Chunk tanpa meta** (meta terpangkas, `delete` chunk-nya gagal) → key yatim diabaikan, bukan melahirkan rekaman hantu ber-`meetingId: undefined` di menu panel. Tes di Task 1.
3. **`recId` legacy bertabrakan dengan `meta:<baseTime>` baru** → entri `meta:<baseTime>` yang menang, slot legacy tidak boleh menimpanya. Tes di Task 1.
4. **`regenerate-transcript` tanpa `recId`** (pesan dari panel versi lama, atau pesan basi setelah reload) → ditolak dengan pesan jelas, dan `rec` tidak tersangkut `transcribing: true` selamanya. Tes di Task 4.
5. **Urutan key leksikografis** → `chunk:<id>:10` tidak boleh jatuh sebelum `chunk:<id>:2`; kalau tertukar, seluruh timestamp transkrip ulang bergeser. Tes di Task 1.

---

## File Structure

| File | Tanggung jawab | Task |
|---|---|---|
| `lib/audiostore.js` | parsing key + seleksi pemangkasan (murni), lalu seluruh I/O IndexedDB | 1, 2 |
| `test/audiostore.test.mjs` | tes dua helper murni (baru) | 1 |
| `offscreen/offscreen.js` | tangkap `recId` di closure recorder, teruskan ke `append*`, muat per `recId` | 3 |
| `background/service-worker.js` | validasi `recId` sebelum menyuruh offscreen transkrip ulang | 4 |
| `test/sw.test.mjs` | tes validasi itu (perluas) | 4 |
| `panel/panel.js` | menu Unduh & Transkrip ulang per rekaman; teks + format backup | 5, 6 |
| `lib/backup.js` | export teks saja; import tetap bisa memulihkan audio ZIP lama | 6 |
| `test/backup.test.mjs` | tes export/import itu (perluas) | 6 |

---

## Task 1: Helper murni parsing key & pemangkasan

**Files:**
- Modify: `lib/audiostore.js` (tambah di dalam IIFE, sebelum `beginAudio`; tambahkan `groupRecordings` & `pruneTargets` ke objek ekspor di baris terakhir)
- Create: `test/audiostore.test.mjs`

**Interfaces:**
- Consumes: tidak ada.
- Produces:
  - `KEEP_RECORDINGS: 5`
  - `groupRecordings(allKeys: string[], metas: Map<string, object>) => Recording[]`
  - `pruneTargets(recordings: Recording[], keep?: number) => string[]`
  - `Recording = { recId: number, meetingId?: string, chunkMs?: number, baseTime?: number, count?: number, videoCount?: number, legacy: boolean, oldKeys: boolean, keys: string[], chunkKeys: {key: string, index: number}[], videoKeys: {key: string, index: number}[] }`, urut `recId` menurun, `chunkKeys`/`videoKeys` urut `index` menaik.

- [ ] **Step 1: Write the failing test**

Buat `test/audiostore.test.mjs`:

```js
// Dua helper murni di lib/audiostore.js: parsing bentuk key, dan pemilihan
// rekaman yang dipangkas. Sisa file itu I/O IndexedDB yang tak ada di Node,
// dan repo ini nol dependency — jadi yang diuji adalah bagian murninya, yang
// juga satu-satunya tempat bentuk key diparse.
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/audiostore.js'); // classic script: set globalThis.MeetAudioStore
const { groupRecordings, pruneTargets, KEEP_RECORDINGS } = globalThis.MeetAudioStore;

const metaOf = (over = {}) => ({ meetingId: 'abc-defg-hij', chunkMs: 600000,
  baseTime: 1000, count: 0, videoCount: 0, ...over });

test('layout baru: chunk & vchunk dikelompokkan ke rekamannya', () => {
  const metas = new Map([
    ['meta:1000', metaOf({ baseTime: 1000, count: 2, videoCount: 1 })],
    ['meta:2000', metaOf({ baseTime: 2000, meetingId: 'discord-1-2', count: 1 })],
  ]);
  const keys = ['meta:1000', 'chunk:1000:0', 'chunk:1000:1', 'vchunk:1000:0',
    'meta:2000', 'chunk:2000:0'];
  const recs = groupRecordings(keys, metas);
  assert.deepEqual(recs.map((r) => r.recId), [2000, 1000]); // terbaru dulu
  assert.equal(recs[1].meetingId, 'abc-defg-hij');
  assert.deepEqual(recs[1].chunkKeys.map((c) => c.key), ['chunk:1000:0', 'chunk:1000:1']);
  assert.deepEqual(recs[1].videoKeys.map((c) => c.key), ['vchunk:1000:0']);
  assert.equal(recs[1].legacy, false);
  assert.equal(recs[1].oldKeys, false);
  assert.deepEqual([...recs[1].keys].sort(),
    ['chunk:1000:0', 'chunk:1000:1', 'meta:1000', 'vchunk:1000:0']);
});

test('urutan numerik, bukan leksikografis', () => {
  // Timestamp transkrip ulang dihitung dari indeks potongan. Kalau 'chunk:10'
  // jatuh sebelum 'chunk:2', seluruh transkrip bergeser 10 menit per slot.
  const metas = new Map([['meta:1000', metaOf({ count: 11 })]]);
  const keys = ['meta:1000', ...Array.from({ length: 11 }, (_, i) => `chunk:1000:${i}`)];
  const recs = groupRecordings(keys.slice().reverse(), metas);
  assert.deepEqual(recs[0].chunkKeys.map((c) => c.index),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('indeks bolong tetap mengembalikan indeks ASLI', () => {
  // Potongan yang gagal ditulis melewati indeksnya. Penomoran ulang rapat
  // membuat potongan sesudahnya ditimestamp 10 menit terlalu awal.
  const metas = new Map([['meta:1000', metaOf({ count: 4 })]]);
  const recs = groupRecordings(
    ['meta:1000', 'chunk:1000:0', 'chunk:1000:2', 'chunk:1000:3'], metas);
  assert.deepEqual(recs[0].chunkKeys.map((c) => c.index), [0, 2, 3]);
});

test('bentuk key lama dibaca sebagai SATU rekaman, flag oldKeys', () => {
  const metas = new Map([['meta', metaOf({ baseTime: 1500, count: 2 })]]);
  const recs = groupRecordings(
    ['meta', 'chunk:0', 'chunk:1', 'vchunk:0'], metas);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].recId, 1500); // dari meta.baseTime
  assert.equal(recs[0].oldKeys, true);
  assert.equal(recs[0].legacy, false); // 'blobs' tidak ada → bukan layout ≤0.3
  assert.deepEqual(recs[0].chunkKeys.map((c) => c.index), [0, 1]);
  assert.deepEqual(recs[0].videoKeys.map((c) => c.index), [0]);
});

test("layout 'blobs' ≤0.3 menyalakan legacy, bukan oldKeys saja", () => {
  // legacy dibawa sampai replaceAudioSegments: hanya rekaman inilah yang boleh
  // menghapus baris transkrip ber-id tanpa cap baseTime.
  const metas = new Map([['meta', metaOf({ baseTime: 900 })]]);
  const recs = groupRecordings(['meta', 'blobs'], metas);
  assert.equal(recs[0].legacy, true);
  assert.equal(recs[0].oldKeys, true);
  assert.deepEqual([...recs[0].keys].sort(), ['blobs', 'meta']);
});

test('meta legacy tanpa baseTime → recId 0, bukan NaN', () => {
  // Layout ≤0.3 bisa tak punya baseTime. NaN membuat rekaman ini hilang dari
  // semua daftar DAN tak pernah terpangkas — bocor selamanya.
  const metas = new Map([['meta', { meetingId: 'abc-defg-hij', count: 1 }]]);
  const recs = groupRecordings(['meta', 'chunk:0'], metas);
  assert.equal(recs[0].recId, 0);
  assert.deepEqual(recs[0].chunkKeys.map((c) => c.key), ['chunk:0']);
});

test('chunk tanpa meta diabaikan, tidak jadi rekaman hantu', () => {
  // Meta terpangkas tapi delete chunk-nya gagal. Rekaman hantu ber-meetingId
  // undefined akan muncul di menu panel sebagai baris yang selalu gagal.
  const metas = new Map([['meta:2000', metaOf({ baseTime: 2000 })]]);
  const recs = groupRecordings(['meta:2000', 'chunk:2000:0', 'chunk:1000:0'], metas);
  assert.deepEqual(recs.map((r) => r.recId), [2000]);
});

test('recId legacy yang bertabrakan dengan meta: baru tidak menimpanya', () => {
  const metas = new Map([
    ['meta:1000', metaOf({ baseTime: 1000, meetingId: 'baru' })],
    ['meta', metaOf({ baseTime: 1000, meetingId: 'lama' })],
  ]);
  const recs = groupRecordings(['meta:1000', 'meta'], metas);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].meetingId, 'baru');
  assert.equal(recs[0].oldKeys, false);
});

test('store kosong → daftar kosong', () => {
  assert.deepEqual(groupRecordings([], new Map()), []);
});

test('pruneTargets: tepat KEEP tidak memangkas apa pun', () => {
  assert.equal(KEEP_RECORDINGS, 5);
  const recs = Array.from({ length: 5 }, (_, i) => ({ recId: i, keys: [`meta:${i}`] }));
  assert.deepEqual(pruneTargets(recs), []);
});

test('pruneTargets: lebih dari KEEP memangkas yang TERTUA beserta chunk-nya', () => {
  const recs = Array.from({ length: 6 }, (_, i) => ({
    recId: i * 1000,
    keys: [`meta:${i * 1000}`, `chunk:${i * 1000}:0`, `vchunk:${i * 1000}:0`],
  }));
  assert.deepEqual(pruneTargets(recs), ['meta:0', 'chunk:0:0', 'vchunk:0:0']);
});

test('pruneTargets tidak bergantung urutan masukan', () => {
  const recs = [{ recId: 1, keys: ['meta:1'] }, { recId: 9, keys: ['meta:9'] }];
  assert.deepEqual(pruneTargets(recs, 1), ['meta:1']);
});

test('pruneTargets: slot legacy terpangkas sebagai satu unit', () => {
  const legacy = { recId: 0, keys: ['meta', 'chunk:0', 'vchunk:0', 'blobs'] };
  const recs = [legacy, ...Array.from({ length: 5 },
    (_, i) => ({ recId: (i + 1) * 1000, keys: [`meta:${(i + 1) * 1000}`] }))];
  assert.deepEqual(pruneTargets(recs), ['meta', 'chunk:0', 'vchunk:0', 'blobs']);
});

test('pruneTargets: daftar kosong → kosong', () => {
  assert.deepEqual(pruneTargets([]), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/audiostore.test.mjs`
Expected: FAIL — `TypeError: Cannot destructure property 'groupRecordings' of 'globalThis.MeetAudioStore' as it is undefined` atau `groupRecordings is not a function`. (File `lib/audiostore.js` memakai `indexedDB` hanya di dalam fungsi, jadi import-nya sendiri tidak melempar di Node.)

- [ ] **Step 3: Write minimal implementation**

Di `lib/audiostore.js`, tepat setelah `const withDb = …` dan sebelum `beginAudio`, tambahkan:

```js
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
```

Lalu tambahkan ketiganya ke ekspor di baris terakhir file:

```js
  globalThis.MeetAudioStore = { beginAudio, appendChunk, appendVideoPart, loadAudio, loadVideo, loadAudioMeta, retagAudioMeta, importAudio,
    groupRecordings, pruneTargets, KEEP_RECORDINGS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/audiostore.test.mjs`
Expected: PASS, 14 tes.

Run: `node --test test/*.test.mjs`
Expected: PASS, 110 tes (96 lama + 14 baru).

- [ ] **Step 5: Commit**

```bash
git add lib/audiostore.js test/audiostore.test.mjs
git commit -m "refactor: helper murni parsing key & pemangkasan di audiostore"
```

---

## Task 2: Store berkunci per rekaman

**Files:**
- Modify: `lib/audiostore.js` — ganti `beginAudio`, `appendEntry`, `loadAudio`, `loadVideo`, `retagAudioMeta`, `importAudio`; hapus `loadAudioMeta`, tambah `listRecordings`
- Test: tidak ada tes baru — IndexedDB tak ada di Node dan repo nol dependency. Seluruh logika yang bisa salah sudah pindah ke helper murni Task 1; yang tersisa adalah lem get/put/delete. Gerbangnya: `node --check`, seluruh suite hijau, dan verifikasi manual di Task 6.

**Interfaces:**
- Consumes: `groupRecordings`, `pruneTargets`, `KEEP_RECORDINGS` (Task 1).
- Produces:
  - `listRecordings() => Promise<Recording[]>` — semua rekaman, meta saja, terbaru dulu. **Menggantikan `loadAudioMeta()`**, yang dihapus.
  - `beginAudio({meetingId, chunkMs, baseTime}) => Promise` — tulis `meta:<baseTime>`, pangkas ke 5.
  - `appendChunk(blob, recId) => Promise`
  - `appendVideoPart(blob, recId) => Promise`
  - `loadAudio(recId) => Promise<{meetingId, chunkMs, baseTime, count, videoCount, recId, legacy, blobs, indices} | null>`
  - `loadVideo(recId) => Promise<{… , blobs} | null>`
  - `retagAudioMeta(oldId, newId, maxBaseTime) => Promise`
  - `importAudio(meta, chunks) => Promise` — signature TIDAK berubah; `meta` ditulis ke `meta:<meta.baseTime ?? 0>`, `chunks` sudah berisi key bentuk baru.

- [ ] **Step 1: Ganti `beginAudio`**

Ganti seluruh fungsi `beginAudio` dengan:

```js
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
```

- [ ] **Step 2: Tambah `listRecordings`, hapus `loadAudioMeta`**

`tx()` me-resolve dengan `.result` request yang di-return, bukan nilai closure —
dan yang dibutuhkan pemanggil adalah daftar hasil olahan. Jadi hasilnya
ditampung di variabel luar, lalu dikembalikan setelah transaksi selesai:

```js
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
```

- [ ] **Step 3: Ganti `appendEntry` & pembungkusnya**

```js
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
```

- [ ] **Step 4: Ganti `loadAudio` & `loadVideo`**

Hapus `loadAudioMeta` dan kedua fungsi lama, ganti dengan:

```js
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
```

- [ ] **Step 5: Ganti `retagAudioMeta` & `importAudio`**

```js
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
```

- [ ] **Step 6: Perbarui ekspor & komentar header file**

Ganti baris ekspor:

```js
  globalThis.MeetAudioStore = { beginAudio, appendChunk, appendVideoPart,
    loadAudio, loadVideo, listRecordings, retagAudioMeta, importAudio,
    groupRecordings, pruneTargets, KEEP_RECORDINGS };
```

Ganti dua baris pertama komentar header file dan blok "Layout store":

```js
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
```

- [ ] **Step 7: Verifikasi**

Run: `node --check lib/audiostore.js`
Expected: tanpa keluaran (sintaks valid).

Run: `node --test test/*.test.mjs`
Expected: PASS 110 tes. (`test/audiostore.test.mjs` masih hijau karena helper murni tidak disentuh; `test/backup.test.mjs` masih hijau karena ia men-stub `MeetAudioStore` sendiri.)

Run: `grep -rn "loadAudioMeta" background panel lib offscreen`
Expected: 3 pemanggil tersisa (`background/service-worker.js`, `panel/panel.js`, `lib/backup.js`) — diperbaiki di Task 4, 5, 6. Catat daftarnya, jangan diperbaiki sekarang.

- [ ] **Step 8: Commit**

```bash
git add lib/audiostore.js
git commit -m "feat: store rekaman berkunci baseTime, simpan 5 terakhir"
```

---

## Task 3: Offscreen menulis ke rekamannya sendiri

**Files:**
- Modify: `offscreen/offscreen.js:31-48` (`startChunkRecorder`), `offscreen/offscreen.js:128-145` (`startVideoRecorder`), `offscreen/offscreen.js:317-322` (`retranscribe`)
- Test: tidak ada tes otomatis — `offscreen.js` butuh `MediaRecorder`, `AudioContext`, dan `chrome.*`. Gerbangnya `node --check` + suite hijau + verifikasi manual Task 6.

**Interfaces:**
- Consumes: `appendChunk(blob, recId)`, `appendVideoPart(blob, recId)`, `loadAudio(recId)` (Task 2).
- Produces: pesan `{target:'offscreen', op:'retranscribe', meetingId, recId, …stt}` sekarang WAJIB membawa `recId`.

- [ ] **Step 1: `recId` di closure `startChunkRecorder`**

Ganti baris pembuka fungsi dan panggilan `appendChunk`:

```js
function startChunkRecorder() {
  const data = []; // per-recorder: rotasi tak boleh menabrak data recorder lain
  // recId ditangkap SEKARANG, bukan dibaca dari cfg saat event datang: onstop
  // yang terlambat dari recorder yang sudah dibongkar harus menulis ke
  // rekamannya SENDIRI. Dulu ia menulis ke satu-satunya meta yang ada — yaitu
  // milik rekaman BERIKUTNYA, yang count-nya jadi naik untuk chunk yang bukan
  // miliknya.
  const recId = cfg.baseTime;
  // recStream = campuran tab + mic dari Web Audio, audio-only — saat mode
  // video, track video ada di `stream`, tidak di sini (MIME audio menolaknya).
  recorder = new MediaRecorder(recStream, { mimeType: MIME });
  recorder.ondataavailable = (e) => { if (e.data.size) data.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(data, { type: MIME });
    chunkBlobs.push(blob);
    // Disimpan begitu chunk selesai, bukan menunggu stop: rekaman satu jam
    // yang browsernya ditutup di menit ke-50 menyisakan 5 chunk yang bisa
    // ditranskrip ulang & diunduh, bukan nol. Kegagalan simpan tidak
    // membatalkan transkrip — chunkBlobs (memori) tetap sumber transkrip.
    pendingSaves.push(globalThis.MeetAudioStore.appendChunk(blob, recId).catch((e) =>
      toSW({ type: 'audio-warn', meetingId: cfg?.meetingId,
        error: 'Satu potongan audio gagal disimpan untuk transkrip ulang: ' + e.message })));
  };
  recorder.start();
}
```

- [ ] **Step 2: `recId` di closure `startVideoRecorder`**

Tambahkan `const recId = cfg.baseTime;` sebagai baris pertama di dalam `startVideoRecorder`, dengan komentar singkat, dan ganti panggilannya:

```js
function startVideoRecorder() {
  const recId = cfg.baseTime; // di closure, alasan sama dengan startChunkRecorder
  // Video dari tab, audio dari campuran: pakai `stream` mentah berarti file
  // video tanpa suara mic padahal rekaman audionya memuatnya.
  videoRecorder = new MediaRecorder(
    new MediaStream([...stream.getVideoTracks(), ...recStream.getAudioTracks()]), {
    mimeType: VIDEO_MIME,
    videoBitsPerSecond: 500_000, // preset seimbang: 720p 10fps ±250 MB/jam
    audioBitsPerSecond: 48_000,
  });
  videoRecorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    pendingSaves.push(globalThis.MeetAudioStore.appendVideoPart(e.data, recId).catch((err) =>
      toSW({ type: 'audio-warn', meetingId: cfg?.meetingId,
        error: 'Satu potongan video gagal disimpan — file video bisa rusak mulai menit itu: ' + err.message })));
  };
  videoRecorder.start(60000);
}
```

- [ ] **Step 3: `retranscribe` memuat per `recId`**

Ganti tiga baris pertama di dalam `try` pada `retranscribe`:

```js
    const saved = await globalThis.MeetAudioStore.loadAudio(msg.recId);
    if (!saved) throw new Error('Audio rekaman tidak tersimpan lagi — hanya 5 rekaman terakhir yang disimpan.');
    if (saved.meetingId !== msg.meetingId) {
      // Cek tetap ada walau SW sudah memvalidasi: recId dari panel bisa basi
      // (daftarnya di-cache) dan retag arsip bisa mengubah meetingId di sela.
      throw new Error('Audio tersimpan milik meeting lain.');
    }
```

- [ ] **Step 4: Verifikasi**

Run: `node --check offscreen/offscreen.js`
Expected: tanpa keluaran.

Run: `grep -n "appendChunk\|appendVideoPart\|loadAudio" offscreen/offscreen.js`
Expected: `appendChunk(blob, recId)`, `appendVideoPart(e.data, recId)`, `loadAudio(msg.recId)` — tidak ada panggilan tanpa argumen kedua.

Run: `node --test test/*.test.mjs`
Expected: PASS 110.

- [ ] **Step 5: Commit**

```bash
git add offscreen/offscreen.js
git commit -m "fix: offscreen menulis potongan ke rekamannya sendiri, bukan ke meta terakhir"
```

---

## Task 4: Service worker memvalidasi `recId`

**Files:**
- Modify: `background/service-worker.js:~330-375` (`regenerateTranscript`), dan handler `regenerate-transcript` di `chrome.runtime.onMessage`
- Test: `test/sw.test.mjs` (perluas)

**Interfaces:**
- Consumes: `listRecordings()` (Task 2); pesan `{target:'offscreen', op:'retranscribe', meetingId, recId, …}` (Task 3).
- Produces: pesan masuk `{type:'regenerate-transcript', id, recId}` — `recId` wajib angka.

- [ ] **Step 1: Write the failing test**

Harness `loadSw` perlu satu tambahan: `service-worker.js` membaca store sebagai
`globalThis.MeetAudioStore`, yang di Chrome datang dari `importScripts` — dan
`importScripts` dilewati di Node. Jadi store-nya ditanam ke global konteks vm
**sebelum** SW dimuat.

Di `test/sw.test.mjs`, ubah tanda tangan `loadSw` jadi
`function loadSw({ offscreen, recordings = [] })`, lalu ganti satu baris
`vm.runInContext(SRC, vm.createContext({ chrome, console, URL }));` menjadi:

```js
  const ctx = vm.createContext({ chrome, console, URL });
  // Ditanam lewat script, bukan lewat properti contextObject: SW membacanya
  // sebagai globalThis.MeetAudioStore / globalThis.MeetStt, dan di Chrome
  // keduanya datang dari importScripts — yang di Node dilewati.
  vm.runInContext('globalThis.MeetAudioStore = {}; globalThis.MeetStt = {};', ctx);
  ctx.MeetAudioStore.listRecordings = async () => recordings;
  // sttConfig() memanggil MeetStt.sttEndpoint (background/service-worker.js:237)
  // di jalur transkrip ulang yang SAH. Tanpa stub ini tesnya mati dengan
  // TypeError, bukan gagal karena hal yang diuji.
  ctx.MeetStt.sttEndpoint = () => ({ mode: 'api', baseUrl: 'http://localhost:1/v1',
    apiKey: '', model: 'whisper-1', language: '' });
  vm.runInContext(SRC, ctx);
```

Pemanggilan `loadSw` yang sudah ada tidak perlu diubah — `recordings` punya
nilai default `[]`.

Lalu tambahkan tes-tes ini di akhir file:

```js
test('regenerate-transcript tanpa recId ditolak, tanpa menyentuh offscreen', async () => {
  // Pesan dari panel versi lama, atau pesan basi setelah reload. Tanpa guard
  // ini rec tersangkut transcribing:true selamanya — start, stop, dan
  // transkrip ulang berikutnya ditolak sampai browser di-restart.
  const sw = loadSw({ offscreen: null,
    recordings: [{ recId: 1000, meetingId: 'abc-defg-hij', count: 2 }] });
  const res = await sw.ask({ type: 'regenerate-transcript', id: 'abc-defg-hij' });
  assert.equal(res.ok, false);
  assert.match(res.error, /recId|rekaman/i);
  assert.ok(!sw.sent.some((m) => m.op === 'retranscribe'));
  const a = await sw.ask({ type: 'get-active' });
  assert.equal(a.rec.transcribing, false);
});

test('recId yang sudah terpangkas ditolak dengan pesan yang menjelaskan', async () => {
  const sw = loadSw({ offscreen: null,
    recordings: [{ recId: 1000, meetingId: 'abc-defg-hij', count: 2 }] });
  const res = await sw.ask({ type: 'regenerate-transcript', id: 'abc-defg-hij', recId: 999 });
  assert.equal(res.ok, false);
  assert.match(res.error, /5 rekaman terakhir/);
  assert.ok(!sw.sent.some((m) => m.op === 'retranscribe'));
});

test('recId milik meeting lain ditolak', async () => {
  const sw = loadSw({ offscreen: null,
    recordings: [{ recId: 1000, meetingId: 'discord-1-2', count: 2 }] });
  const res = await sw.ask({ type: 'regenerate-transcript', id: 'abc-defg-hij', recId: 1000 });
  assert.equal(res.ok, false);
  assert.match(res.error, /meeting lain/);
  assert.ok(!sw.sent.some((m) => m.op === 'retranscribe'));
});

test('recId sah diteruskan ke offscreen bersama recId-nya', async () => {
  const sw = loadSw({ offscreen: { recording: false, transcribing: false, meetingId: null },
    recordings: [{ recId: 1000, meetingId: 'abc-defg-hij', count: 2 }] });
  const res = await sw.ask({ type: 'regenerate-transcript', id: 'abc-defg-hij', recId: 1000 });
  assert.equal(res.ok, true);
  const sent = sw.sent.find((m) => m.op === 'retranscribe');
  assert.equal(sent.recId, 1000);
  assert.equal(sent.meetingId, 'abc-defg-hij');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sw.test.mjs`
Expected: FAIL pada empat tes baru — `regenerateTranscript` belum menerima `recId`, jadi tes pertama lolos ke `ensureOffscreen`/`loadAudioMeta` dan melempar, atau `res.ok` bukan `false` dengan pesan yang diharapkan.

- [ ] **Step 3: Write minimal implementation**

Di `background/service-worker.js`, ganti tanda tangan dan isi awal `regenerateTranscript`:

```js
async function regenerateTranscript(meetingId, recId) {
  if (rec.recording || rec.transcribing) throw new Error('Rekaman/transkrip masih berjalan.');
  // Divalidasi SEBELUM rec ditandai transcribing: pesan tanpa recId (panel
  // versi lama, pesan basi setelah reload) yang lolos ke bawah akan membuat
  // rec tersangkut transcribing:true tanpa ada yang bekerja.
  if (!Number.isFinite(Number(recId))) {
    throw new Error('Rekaman yang mau ditranskrip ulang tidak disebut (recId kosong).');
  }
  // rec di-set SEBELUM await pertama: ini satu-satunya penyerialisasi transkrip.
  // Kalau dipasang setelah await (mis. setelah listRecordings), dua panggilan
  // regenerate-transcript beruntun (klik ganda dari panel) sama-sama lolos
  // guard di atas sebelum salah satu sempat menandai transcribing — dua loop
  // transkrip jalan bersamaan dan meeting yang sama dapat dua audio-transcript.
  rec = { recording: false, transcribing: true, meetingId };
  updateBadge();
  broadcastRec({ error: null }); // percobaan baru → keluhan percobaan lama dihapus
  try {
    // Tidak ada cek hasOffscreen() di sini: dokumen offscreen ditutup secara
    // fire-and-forget setelah transkrip selesai, jadi klik di sela penutupan itu
    // akan salah ditolak — dan kalau closeDocument gagal (rejection-nya ditelan),
    // transkrip ulang terblokir selamanya. Penjaganya ada di offscreen sendiri
    // (busy || recorder), yang justru selamat dari restart SW dan membalas
    // {ok:false}; balasan itu diperiksa di bawah.
    const target = (await globalThis.MeetAudioStore.listRecordings())
      .find((r) => r.recId === Number(recId));
    if (!target) {
      throw new Error('Rekaman itu sudah tidak tersimpan — hanya 5 rekaman terakhir yang disimpan.');
    }
    if (target.meetingId !== meetingId) {
      throw new Error('Rekaman itu milik meeting lain — hanya rekaman meeting ini yang bisa ditranskrip ulang.');
    }
    const stt = await sttConfig();
    await ensureOffscreen();
    // Balasan diperiksa, bukan cuma "tidak reject": side panel yang terbuka
    // juga sebuah receiving end, jadi sendMessage tetap resolve walau offscreen
    // sudah tertutup — dan rec.transcribing macet true tanpa ada yang bekerja.
    // Panel tidak pernah membalas pesan ini, jadi balasan offscreen yang menang.
    const res = await chrome.runtime.sendMessage({
      target: 'offscreen', op: 'retranscribe', meetingId, recId: target.recId, ...stt,
    });
    if (!res?.ok) throw new Error(res?.error || 'Offscreen tidak merespons — transkrip ulang tidak dimulai.');
  } catch (e) {
    // Gagal sebelum offscreen mulai kerja → rec harus balik, jangan macet di
    // transcribing (memblok start/stop rekam & regenerate berikutnya selamanya).
    rec = { recording: false, transcribing: false, meetingId: null };
    updateBadge();
    broadcastRec();
    throw e;
  }
}
```

Lalu handler pesannya:

```js
  if (msg.type === 'regenerate-transcript') {
    regenerateTranscript(msg.id, msg.recId).then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: e.message })
    );
    return true;
  }
```

Catatan: pemeriksaan `Number.isFinite` di luar `try` tidak menyentuh `rec`, jadi tes "tanpa recId" melihat `transcribing: false`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sw.test.mjs`
Expected: PASS 10 tes.

Run: `node --test test/*.test.mjs`
Expected: PASS 114.

- [ ] **Step 5: Commit**

```bash
git add background/service-worker.js test/sw.test.mjs
git commit -m "feat: SW memvalidasi recId sebelum transkrip ulang"
```

---

## Task 5: Panel menjangkau tiap rekaman

**Files:**
- Modify: `panel/panel.js:129-163` (`downloadAudio`, `downloadVideo`), `panel/panel.js:180-201` (cache `audioMeta`), `panel/panel.js:~337-388` (baris "Mentranskrip…" + blok tombol audio)
- Test: tidak ada tes otomatis — tak ada harness DOM untuk `panel.js` di repo ini. Gerbangnya `node --check` + suite hijau + verifikasi manual Task 6.

**Interfaces:**
- Consumes: `listRecordings()`, `loadAudio(recId)`, `loadVideo(recId)` (Task 2); pesan `{type:'regenerate-transcript', id, recId}` (Task 4).
- Produces: tidak ada untuk task lain.

- [ ] **Step 1: `downloadAudio`/`downloadVideo` per rekaman**

Ganti kedua fungsi (dan komentar di atasnya tetap relevan):

```js
// Satu meeting bisa punya beberapa rekaman, dan nama file harus membedakannya
// — tanpa `suffix`, rekaman kedua turun sebagai "Judul (1).webm" dari Chrome
// dan tak ada tanda rekaman mana itu.
async function downloadAudio(meeting, rec, suffix) {
  const saved = await globalThis.MeetAudioStore.loadAudio(rec.recId);
  if (!saved?.blobs?.length) return 0;
  // Kepemilikan dicek ULANG di sini, bukan cuma lewat gate tombolnya: gate itu
  // membaca daftar rekaman yang di-cache, dan view meeting di tab Riwayat tidak
  // dirender ulang saat arsip recurring me-retag meetingId sebuah rekaman.
  if (saved.meetingId !== meeting.id) return 0;
  // Dinomori dengan indeks ASLI potongan, bukan posisi di array: kalau ada
  // potongan yang gagal tersimpan, penomoran berurutan membuat file-file itu
  // tidak lagi cocok dengan slot 10 menit di transkrip.
  saved.blobs.forEach((blob, i) => download(
    saved.blobs.length > 1
      ? `${meeting.title}${suffix}-${String((saved.indices?.[i] ?? i) + 1).padStart(2, '0')}.webm`
      : `${meeting.title}${suffix}.webm`,
    blob));
  return saved.blobs.length;
}

// Kebalikan audio: part video BUKAN file berdiri sendiri — gabungan berurutan
// seluruh part = satu file webm valid, jadi diunduh sebagai SATU file.
// "-video" di nama: hindari tabrakan dengan unduhan audio satu-file.
async function downloadVideo(meeting, rec, suffix) {
  const saved = await globalThis.MeetAudioStore.loadVideo(rec.recId);
  if (!saved?.blobs?.length) return false;
  if (saved.meetingId !== meeting.id) return false; // alasan sama dengan downloadAudio
  download(`${meeting.title}${suffix}-video.webm`, new Blob(saved.blobs, { type: 'video/webm' }));
  return true;
}
```

- [ ] **Step 2: Cache `audioMeta` jadi cache DAFTAR**

Ganti deklarasi dan blok pembacaannya. Deklarasi (`panel/panel.js:169-170`):

```js
let audioMeta = null;       // daftar rekaman (listRecordings) terakhir, atau null
let audioMetaKey = null;    // view key yang menghasilkannya (null = wajib tanya lagi)
```

Blok pembacaan di `renderMeeting`:

```js
  // Daftar rekaman menentukan item "Unduh audio"/"Unduh video" dan "Transkrip
  // ulang" (5 rekaman terakhir yang disimpan). Diambil SEBELUM replaceChildren
  // supaya rerender 2-detikan tidak membuat action bar + daftar segmen
  // berkedip, dan di-cache per view karena tiap panggilan = satu indexedDB.open.
  // undefined = pembacaan GAGAL (jangan di-cache, tombolnya harus bisa muncul
  // di render berikutnya), null = memang tak ada rekaman (aman di-cache).
  let meta = audioMeta;
  let metaKey = audioMetaKey;
  if (meeting?.source !== 'audio') { meta = null; metaKey = null; }
  else if (audioMetaKey !== viewKey) {
    const res = await globalThis.MeetAudioStore.listRecordings().catch(() => undefined);
    meta = res ?? null;
    metaKey = res === undefined ? null : viewKey;
  }
```

- [ ] **Step 3: Baris "Mentranskrip…" membaca daftar**

Ganti kondisinya:

```js
  if (!live && recState.transcribing && (audioMeta ?? []).some((r) => r.meetingId === meeting.id)) {
```

- [ ] **Step 4: Blok tombol audio jadi per rekaman**

Ganti seluruh blok `if (audioMeta?.meetingId === meeting.id && …) { … }` dengan:

```js
  // Rekaman MILIK meeting ini yang punya isi. Gate audio (count) dan video
  // (videoCount) DIPISAH per rekaman: part video mendarat tiap 60 detik, chunk
  // audio baru tiap rotasi 10 menit — rekaman yang mati di menit 5 punya video
  // tersimpan tapi count audio masih 0, dan gate gabungan menyembunyikan video
  // yang sebenarnya bisa diselamatkan.
  const recs = (audioMeta ?? []).filter((r) => r.meetingId === meeting.id
    && (r.count > 0 || r.videoCount > 0));
  if (recs.length && !recState.recording && !recState.transcribing) {
    // Satu rekaman: label persis seperti sebelum fitur ini ada. Jam mulai cuma
    // muncul kalau memang ada yang perlu dibedakan.
    const many = recs.length > 1;
    const jam = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    for (const r of recs) {
      const tag = many ? ` — ${jam(r.baseTime)}` : '';
      const sfx = many ? `-${jam(r.baseTime).replace(/\D/g, '')}` : '';
      if (r.count > 0) {
        // Chunk disimpan sambil merekam, jadi item ini juga jalur penyelamat
        // kalau rekaman mati di tengah (browser ditutup) atau STT gagal total:
        // audionya tetap utuh sampai potongan terakhir yang sempat ditulis.
        dl.item(`Unduh audio${tag}${r.count > 1 ? ` (${r.count} file)` : ''}`, async () => {
          const n = await downloadAudio(meeting, r, sfx).catch(() => 0);
          flash(dl.head, n ? `Diunduh ✓${n > 1 ? ` (${n} file)` : ''}` : 'Audio tidak ditemukan', 3000);
        });
        // Chrome memblok unduhan beruntun sampai user mengizinkan sekali — tanpa
        // keterangan ini, file ke-2 dst tampak hilang begitu saja. Di dalam
        // menu, di bawah item yang dijelaskannya.
        if (r.count > 1) dl.list.append(el('span', 'muted',
          'Beberapa file: izinkan "Download multiple files" kalau Chrome bertanya.'));
      }
      if (r.videoCount > 0) {
        dl.item(`Unduh video${tag}`, async () => {
          const ok = await downloadVideo(meeting, r, sfx).catch(() => false);
          flash(dl.head, ok ? 'Diunduh ✓' : 'Video tidak ditemukan', 3000);
        });
      }
    }
    // Hanya saat Sumber transkrip = Rekam audio (pilihan user 2026-09-09): di
    // mode caption transkrip datang dari caption, tombol ini cuma membingungkan.
    // STT saat Stop sengaja TIDAK ikut digate — cuma tombolnya yang disembunyikan.
    const reable = recs.filter((r) => r.count > 0);
    if (reable.length && settingsCache.transcriptSource === 'audio') {
      const jalankan = async (r, setLabel) => {
        setLabel('Mentranskrip…');
        momErrors.delete(meeting.id);
        const res = await chrome.runtime.sendMessage(
          { type: 'regenerate-transcript', id: meeting.id, recId: r.recId }).catch(() => null);
        if (!res?.ok) {
          momErrors.set(meeting.id, res?.error ?? 'Gagal menghubungi service worker.');
          render();
        }
        // Sukses: hasil datang lewat broadcast meeting-updated, panel rerender sendiri.
      };
      if (reable.length === 1) {
        const reBtn = btn('Transkrip ulang', () => {
          reBtn.disabled = true;
          return jalankan(reable[0], (t) => { reBtn.textContent = t; });
        });
      } else {
        // Dropdown, bukan satu tombol per rekaman: tiap baris transkrip sudah
        // ditandai audio:<baseTime>:, jadi transkrip ulang per rekaman hanya
        // mengganti baris miliknya — pilihannya bermakna, bukan sekadar daftar.
        const re = dropdown('retranskrip', 'Transkrip ulang');
        for (const r of reable) {
          re.item(`dari rekaman ${jam(r.baseTime)}`,
            () => jalankan(r, (t) => { re.head.textContent = t; }));
        }
      }
    }
  }
```

- [ ] **Step 5: Verifikasi**

Run: `node --check panel/panel.js`
Expected: tanpa keluaran.

Run: `grep -n "loadAudioMeta\|audioMeta?\.meetingId\|audioMeta\.count" panel/panel.js`
Expected: tanpa hasil — semua pemakaian lama sudah tergantikan.

Run: `node --test test/*.test.mjs`
Expected: PASS 114.

- [ ] **Step 6: Commit**

```bash
git add panel/panel.js
git commit -m "feat: panel menjangkau tiap rekaman milik sebuah meeting"
```

---

## Task 6: Backup teks saja

**Files:**
- Modify: `lib/backup.js:136-160` (`exportBackup`), `lib/backup.js:162-210` (`importBackup`)
- Modify: `panel/panel.js:~743-800` (teks penjelas, format ukuran, kalimat alert)
- Test: `test/backup.test.mjs` (perluas)

**Interfaces:**
- Consumes: `importAudio(meta, chunks)` dengan key `chunk:<recId>:<i>` (Task 2).
- Produces: tidak ada untuk task lain.

- [ ] **Step 1: Write the failing test**

Tambahkan di akhir `test/backup.test.mjs`:

```js
const { exportBackup } = globalThis.MeetBackup;

test('export tidak memuat entri audio maupun field audioMeta', async () => {
  // Backup untuk teks. Audio & video bisa ratusan MB per rekaman, dan
  // audioMeta yang ikut TANPA chunk-nya membuat panel menawarkan
  // "Unduh audio (3 file)" yang selalu gagal — jatuh berdua atau tidak sama
  // sekali.
  globalThis.chrome = { storage: { local: {
    get: async () => ({ meetings: ['abc-defg-hij'], 'meeting:abc-defg-hij': { segments: [] } }),
  } } };
  let touched = false;
  globalThis.MeetAudioStore = {
    listRecordings: async () => { touched = true; return []; },
    loadAudio: async () => { touched = true; return null; },
    loadVideo: async () => { touched = true; return null; },
  };
  const entries = await readZip(await exportBackup());
  assert.deepEqual(entries.map((e) => e.name), ['backup.json']);
  const j = JSON.parse(await entries[0].blob.text());
  assert.equal(j.version, 1); // format tidak dinaikkan: audioMeta sudah opsional
  assert.ok(!('audioMeta' in j));
  assert.equal(touched, false); // store rekaman tidak dibaca sama sekali
});

test('import ZIP lama ber-audio mendarat di key chunk:<recId>:<i>', async () => {
  const calls = stubEnv();
  await importBackup(await zipOf(
    { version: 1, storage: { meetings: [] },
      audioMeta: { meetingId: 'abc-defg-hij', baseTime: 1700, count: 2, videoCount: 1 } },
    [{ name: 'audio/chunk-0.webm', data: new Blob(['a']) },
      { name: 'audio/chunk-2.webm', data: new Blob(['b']) },
      { name: 'audio/video-0.webm', data: new Blob(['v']) }]));
  assert.deepEqual(calls.imported.chunks.map((c) => c.key),
    ['chunk:1700:0', 'chunk:1700:2', 'vchunk:1700:0']);
  assert.equal(calls.imported.meta.baseTime, 1700);
});
```

`stubEnv()` dan `zipOf(json, extra)` sudah ada di file ini. `stubEnv()`
mengembalikan objek `calls` **langsung** (`{cleared, set, imported}`), bukan
`{calls}` — pakai apa adanya, jangan ubah helper-nya.

**Satu tes LAMA akan pecah, dan itu memang benar.** `import sehat: chunk &
vchunk mendarat di key IndexedDB yang benar` memakai
`audioMeta: { meetingId: 'abc', count: 1 }` — tanpa `baseTime` — dan
mengharapkan `['chunk:7', 'vchunk:0']`. Setelah task ini key-nya jadi
`['chunk:0:7', 'vchunk:0:0']`, karena `baseTime` absen → `recId = 0`. Ubah
assertion-nya, dan tambahkan komentar yang menerangkan dari mana `0` itu —
tes ini sekaligus yang mengunci "meta legacy tanpa baseTime tidak jadi NaN":

```js
  // recId = baseTime, dan audioMeta di ZIP ≤0.3 bisa tak punya baseTime → 0.
  // Bukan NaN: key 'chunk:NaN:7' tak akan pernah ditemukan lagi oleh siapa pun.
  assert.deepEqual(calls.imported.chunks.map((c) => c.key), ['chunk:0:7', 'vchunk:0:0']);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/backup.test.mjs`
Expected: FAIL tiga tes, semuanya memang harus merah di titik ini:
- `export tidak memuat entri audio…` — `exportBackup` masih memanggil `loadAudio`/`loadVideo`/`loadAudioMeta`, jadi `touched` jadi `true` dan `audioMeta` ada di JSON. (`loadAudioMeta is not a function` juga mungkin, karena Task 2 menghapusnya.)
- `import ZIP lama ber-audio mendarat di key chunk:<recId>:<i>` — key masih `chunk:0` tanpa recId.
- `import sehat: chunk & vchunk mendarat di key IndexedDB yang benar` — tes LAMA, assertion-nya baru diubah di Step 1.

- [ ] **Step 3: `exportBackup` berhenti menulis rekaman**

Ganti seluruh `exportBackup`:

```js
  // Seluruh chrome.storage.local → satu zip. TEKS SAJA: transkrip, MoM,
  // Settings. Audio & video sengaja TIDAK ikut — satu rekaman video bisa
  // ratusan MB, dan 5 rekaman tersimpan akan melewati batas 4 GB zip tanpa
  // zip64 (lihat komentar di kepala file) dengan hasil zip rusak yang baru
  // ketahuan saat restore. Rekaman diunduh sendiri dari entri Riwayat.
  // `audioMeta` juga tidak ditulis: meta tanpa chunk-nya membuat panel
  // menawarkan "Unduh audio (n file)" yang selalu gagal.
  async function exportBackup() {
    const storage = await chrome.storage.local.get(null);
    return makeZip([{
      name: 'backup.json',
      data: JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), storage }),
    }]);
  }
```

- [ ] **Step 4: `importBackup` menyusun key bentuk baru**

Di dalam `importBackup`, ganti blok penyusunan `chunks`:

```js
    // Chunk hanya berarti bersama meta-nya (loadAudio mengembalikan null tanpa
    // meta) — zip tanpa audioMeta: chunk tak ditulis dan tak dihitung. Backup
    // yang dibuat versi ini memang tak pernah memuat audio; jalur ini hidup
    // untuk ZIP lama yang masih ada di disk user, dan import adalah pintu satu
    // arah (storage.clear() lalu ganti) — jadi audionya tidak dibuang.
    const chunks = [];
    if (j.audioMeta) {
      // recId = baseTime, sama seperti rekaman yang direkam langsung. ?? 0
      // untuk meta ≤0.3 yang tak punya baseTime: 'chunk:NaN:0' tak akan pernah
      // ditemukan lagi oleh siapa pun.
      const recId = Number(j.audioMeta.baseTime ?? 0);
      for (const e of entries) {
        const a = e.name.match(AUDIO_RE);
        const v = e.name.match(VIDEO_RE);
        if (a) chunks.push({ key: `chunk:${recId}:${Number(a[1])}`, blob: e.blob });
        else if (v) chunks.push({ key: `vchunk:${recId}:${Number(v[1])}`, blob: e.blob });
      }
    }
```

`AUDIO_RE`/`VIDEO_RE` tetap pola datar `audio/chunk-<i>.webm` — tak ada ZIP yang pernah ditulis dengan pola lain.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/backup.test.mjs`
Expected: PASS 11 tes (9 lama — satu dengan assertion yang baru diubah — + 2 baru), termasuk `backup.json cacat ditolak SEBELUM storage.clear()`.

Run: `node --test test/*.test.mjs`
Expected: PASS 116.

- [ ] **Step 6: Commit**

```bash
git add lib/backup.js test/backup.test.mjs
git commit -m "feat: backup ZIP jadi teks saja, audio & video tidak ikut"
```

- [ ] **Step 7: Teks penjelas & format di panel Settings**

Di `panel/panel.js`, blok Backup. Ganti komentar pembuka blok:

```js
  // Backup data TEKS (riwayat+MoM+settings) ke satu zip, dan import-nya. Satu-
  // satunya jalur selamat data melewati uninstall. Rekaman tidak ikut — lihat
  // exportBackup di lib/backup.js.
```

Ganti dua baris di dalam handler `exportBtn` (hapus komentar "rekaman video besar", ganti format ukuran):

```js
    exportBtn.disabled = true;
    setBnote('muted', 'Menyusun zip…');
    try {
      const zip = await globalThis.MeetBackup.exportBackup();
      download(`meet-transcript-backup-${new Date().toISOString().slice(0, 10)}.zip`, zip);
      // KB di bawah 1 MB: backup teks hampir selalu di bawah itu, dan
      // "0.0 MB" terbaca seperti export yang gagal.
      setBnote('ok', `✓ Backup siap (${zip.size < 1048576
        ? `${Math.max(1, Math.round(zip.size / 1024))} KB`
        : `${(zip.size / 1048576).toFixed(1)} MB`}).`);
    } catch (e) {
      setBnote('err', '✗ Export gagal: ' + (e?.message ?? e));
    } finally {
      exportBtn.disabled = false;
    }
```

Ganti kalimat `alert` setelah import:

```js
      // Potongan rekaman hanya disebut kalau memang ada (ZIP lama): angka 0 di
      // backup teks terbaca seperti ada yang hilang.
      alert(r.audioError
        ? `Import selesai SEBAGIAN: ${r.meetings} meeting masuk, tapi rekaman audio/video gagal di-restore (${r.audioError}). Data lama sudah tergantikan.`
        : `Import selesai: ${r.meetings} meeting${r.chunks ? `, ${r.chunks} potongan rekaman` : ''}.`);
```

Tambahkan teks penjelas setelah baris yang menaruh `exportBtn`/`importBtn` ke dalam `view` (pola sama dengan blok mic: `el('div', 'muted', …)` sebagai anak terakhir):

```js
  view.append(el('div', 'muted',
    'Backup berisi transkrip, MoM, dan Settings — bukan file rekaman. Audio & '
    + 'video tidak ikut karena bisa ratusan MB per rekaman. Unduh sendiri dari '
    + 'entri Riwayat → Unduh. Yang tersimpan hanya 5 rekaman terakhir; lebih '
    + 'tua dari itu terhapus saat rekaman baru mulai.'));
```

- [ ] **Step 8: Verifikasi**

Run: `node --check panel/panel.js && node --check lib/backup.js`
Expected: tanpa keluaran.

Run: `node --test test/*.test.mjs`
Expected: PASS 116.

- [ ] **Step 9: Commit**

```bash
git add panel/panel.js
git commit -m "feat: teks penjelas backup teks-saja di Settings"
```

- [ ] **Step 10: Verifikasi manual (dijalankan user, bukan agen)**

Reload ekstensi di `chrome://extensions`, lalu minta user mengerjakan daftar ini dan melaporkan hasilnya:

1. Rekam Meet, stop, rekam lagi, stop. Riwayat → kedua entri menawarkan Unduh sendiri-sendiri, dan file rekaman pertama masih ada.
2. Rekam ruang yang sama dua kali dalam satu sesi → satu entri Riwayat, menu Unduh memuat dua rekaman berlabel jam, "Transkrip ulang" jadi dropdown dua pilihan.
3. "Transkrip ulang" dari rekaman lama hanya mengganti baris miliknya; baris rekaman lain tetap.
4. Rekam 6 kali → rekaman ke-1 hilang dari menu, 5 sisanya utuh.
5. Export backup → ukuran dalam KB, isi zip tanpa folder `audio/`. Import kembali → transkrip & Settings pulih.
6. Import ZIP backup lama (yang memuat audio) → transkrip pulih dan rekamannya muncul di entri meeting-nya.

Jangan tandai task ini selesai sebelum user melaporkan keenam poin lewat.

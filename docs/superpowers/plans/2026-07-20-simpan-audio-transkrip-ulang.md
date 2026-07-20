# Simpan Audio + Transkrip Ulang — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audio rekaman terakhir disimpan ke IndexedDB supaya transkrip bisa diulang tanpa merekam lagi, plus perbaiki tiga bug mode audio yang ditemukan saat user mencoba fitur.

**Architecture:** Offscreen document menyimpan chunk Blob ke IndexedDB **sebelum** transkrip (jadi endpoint STT salah tidak lagi menghanguskan rekaman). Loop transkrip di-extract jadi `transcribeChunks()` yang dipakai dua jalur: `op:'stop'` (setelah rekam) dan `op:'retranscribe'` (tombol Transkrip ulang). Transkrip tetap di offscreen, BUKAN dipindah ke service worker — SW MV3 bisa dimatikan di tengah loop upload yang panjang, offscreen document tidak.

**Retensi:** hanya rekaman TERAKHIR yang disimpan (keputusan user). Rekaman baru menimpa yang lama, satu key tetap.

**Tech Stack:** Chrome MV3 (offscreen document, service worker, side panel), IndexedDB, classic scripts via `globalThis`, `node --test` untuk unit test.

## Global Constraints

- Classic scripts, BUKAN ES module: lib expose via `globalThis.MeetXxx`, dipakai lewat `importScripts` (SW), `<script>` (panel/offscreen), `await import()` side-effect (test).
- Semua teks UI bahasa Indonesia, konsisten dengan yang ada.
- Panel render pakai `el()`/`textContent` — jangan pernah `innerHTML` dengan data meeting.
- Komentar kode bahasa Indonesia, gaya repo: jelaskan constraint/kenapa, bukan apa yang baris lakukan.
- Test: `node --test test/*.test.mjs` harus hijau di tiap commit (perintah dari README).
- Blob TIDAK bisa dikirim lewat `chrome.runtime.sendMessage` (messaging pakai serialisasi JSON, bukan structured clone) — IndexedDB adalah satu-satunya jalur blob dari offscreen ke konteks lain.
- Kerja di branch `feat/audio-store-retranscribe` dari `main`.

## Bug yang diperbaiki (ditemukan dari laporan user, meeting znm-iajo-upw)

1. **`meeting.startedAt` di-stamp saat SIMPAN, bukan saat mulai rekam** (`saveAudioTranscript`, service-worker.js). Akibatnya segmen ber-timestamp lebih awal dari "mulai" meeting — user melihat meeting mulai 9:33:53 tapi segmen 9:33:30. `baseTime` (waktu mulai rekam) sudah diketahui dan sudah dipakai untuk timestamp segmen, tinggal dipakai juga di sini.
2. **Transkrip kosong tersimpan diam-diam.** Kalau STT tidak mengembalikan teks yang bisa dipakai, `mergeSttChunks` menghasilkan `[]`, `saveAudioTranscript` tetap membuat meeting kosong dan `broadcastRec()` jalan tanpa error — tampil persis seperti sukses, padahal (dulu) audio sudah dibuang.
3. **Judul meeting mode audio tetap id mentah** (`title: meetingId` → "znm-iajo-upw"). Context menu punya `tab.title`; teruskan.

---

### Task 1: `lib/audiostore.js` — simpan/muat chunk audio di IndexedDB

**Files:**
- Create: `lib/audiostore.js`
- Modify: `offscreen/offscreen.html` (tambah `<script src="../lib/audiostore.js"></script>` SEBELUM `offscreen.js`)

**Interfaces:**
- Produces: `globalThis.MeetAudioStore` dengan tiga fungsi async:
  - `saveAudio({ meetingId, chunkMs, baseTime, blobs })` → Promise<void>. Menimpa rekaman sebelumnya (satu key tetap).
  - `loadAudio()` → Promise<`{ meetingId, chunkMs, baseTime, blobs }` | null>.
  - `loadAudioMeta()` → Promise<`{ meetingId, chunkMs, baseTime, count }` | null> — TANPA blob, supaya pengecekan "ada audio?" murah.

Simpan meta dan blob sebagai DUA record terpisah di object store yang sama (key `'meta'` dan `'blobs'`), supaya `loadAudioMeta()` tidak menarik ratusan MB blob ke memori hanya untuk mengecek keberadaan.

- [ ] **Step 1: Branch**

```bash
git checkout -b feat/audio-store-retranscribe
```

- [ ] **Step 2: Tulis `lib/audiostore.js`**

```js
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

  function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(out?.result ?? null);
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
      const meta = await tx(db, 'readonly', (s) => s.get('meta'));
      if (!meta) return null;
      const blobs = await tx(db, 'readonly', (s) => s.get('blobs'));
      if (!blobs?.length) return null;
      return { ...meta, blobs };
    } finally {
      db.close();
    }
  }

  globalThis.MeetAudioStore = { saveAudio, loadAudio, loadAudioMeta };
})();
```

- [ ] **Step 3: Muat di offscreen** — `offscreen/offscreen.html`, tambahkan sebelum tag script `offscreen.js`:

```html
  <script src="../lib/audiostore.js"></script>
```

- [ ] **Step 4: Test regresi**

Run: `node --test test/*.test.mjs`
Expected: PASS (25+ test; file ini tidak punya unit test — IndexedDB tak ada di Node, dan wrapper-nya tipis. Diverifikasi lewat jalur nyata di Task 2/3.)

- [ ] **Step 5: Commit**

```bash
git add lib/audiostore.js offscreen/offscreen.html
git commit -m "feat: simpan chunk audio rekaman terakhir di IndexedDB"
```

---

### Task 2: Offscreen simpan audio sebelum transkrip + jalur retranscribe

**Files:**
- Modify: `offscreen/offscreen.js`

**Interfaces:**
- Consumes: `globalThis.MeetAudioStore.saveAudio/loadAudio` (Task 1).
- Produces: pesan baru yang diterima offscreen: `{ target: 'offscreen', op: 'retranscribe', meetingId, baseUrl, apiKey, sttModel, sttLanguage }`. Balasan ke SW tetap pakai tipe yang sudah ada (`audio-progress`, `audio-transcript`, `audio-error`).

- [ ] **Step 1: Extract loop transkrip**

Di `offscreen/offscreen.js`, ganti isi `stopAndTranscribe` yang melakukan loop dengan fungsi bersama. Loop yang ada sekarang (progress → transcribeAudio per chunk → tampung error) dipindah apa adanya ke:

```js
// Dipakai dua jalur: setelah rekam selesai, dan tombol "Transkrip ulang".
async function transcribeChunks(blobs, c) {
  const results = [];
  for (let i = 0; i < blobs.length; i++) {
    toSW({ type: 'audio-progress', meetingId: c.meetingId, done: i, total: blobs.length });
    try {
      results.push(await globalThis.MeetOpenAI.transcribeAudio({
        blob: blobs[i], baseUrl: c.baseUrl, apiKey: c.apiKey,
        model: c.sttModel, language: c.sttLanguage,
      }));
    } catch (e) {
      results.push({ error: e.message });
    }
  }
  const segments = globalThis.MeetStt.mergeSttChunks(results, c.chunkMs, c.baseTime);
  toSW({ type: 'audio-transcript', meetingId: c.meetingId, segments });
}
```

- [ ] **Step 2: Simpan blob SEBELUM transkrip**

Di `stopAndTranscribe`, setelah chunk terakhir difinalisasi dan stream ditutup, SEBELUM memanggil `transcribeChunks`:

```js
  // Simpan dulu, transkrip belakangan: endpoint STT salah tidak boleh
  // menghanguskan rekaman — audio tetap bisa ditranskrip ulang.
  await globalThis.MeetAudioStore.saveAudio({
    meetingId: cfg.meetingId, chunkMs: cfg.chunkMs, baseTime: cfg.baseTime, blobs: chunkBlobs,
  }).catch((e) => toSW({ type: 'audio-warn', meetingId: cfg.meetingId,
    error: 'Audio gagal disimpan untuk transkrip ulang: ' + e.message }));
  const blobs = chunkBlobs;
  chunkBlobs = [];
  await transcribeChunks(blobs, cfg);
```

- [ ] **Step 3: Handler `retranscribe`**

Tambah di `chrome.runtime.onMessage.addListener` offscreen, sejajar dengan `op === 'stop'`:

```js
  } else if (msg.op === 'retranscribe') {
    retranscribe(msg).catch((e) =>
      toSW({ type: 'audio-error', meetingId: msg.meetingId, error: e.message }));
  }
```

dan fungsinya:

```js
async function retranscribe(msg) {
  const saved = await globalThis.MeetAudioStore.loadAudio();
  if (!saved) throw new Error('Audio rekaman tidak tersimpan lagi.');
  if (saved.meetingId !== msg.meetingId) {
    throw new Error('Audio tersimpan milik meeting lain — hanya rekaman terakhir yang disimpan.');
  }
  // chunkMs/baseTime dari rekaman asli supaya timestamp segmen tetap sama;
  // endpoint & model diambil dari settings TERBARU lewat msg.
  await transcribeChunks(saved.blobs, { ...msg, chunkMs: saved.chunkMs, baseTime: saved.baseTime });
}
```

- [ ] **Step 4: Test regresi**

Run: `node --test test/*.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add offscreen/offscreen.js
git commit -m "feat: offscreen simpan audio sebelum transkrip + jalur transkrip ulang"
```

---

### Task 3: Service worker — regenerate, cek audio, dan tiga perbaikan bug

**Files:**
- Modify: `background/service-worker.js`

**Interfaces:**
- Consumes: offscreen `op:'retranscribe'` (Task 2), `globalThis.MeetAudioStore.loadAudioMeta` (Task 1).
- Produces: dua pesan yang dijawab untuk panel:
  - `{ type: 'audio-meta' }` → `{ meetingId, count } | null` (panel memutuskan menampilkan tombol).
  - `{ type: 'regenerate-transcript', id }` → `{ ok: true } | { ok: false, error }`.

- [ ] **Step 1: Muat audiostore di SW**

Baris `importScripts` jadi:

```js
importScripts('/lib/merge.js', '/lib/openai.js', '/lib/stt.js', '/lib/audiostore.js');
```

- [ ] **Step 2: Bug 1 & 2 — `startedAt` dari waktu rekam, transkrip kosong bersuara**

Di `saveAudioTranscript({ meetingId, segments })`, terima juga `baseTime` dari pesan dan pakai untuk meeting yang baru dibuat:

```js
async function saveAudioTranscript({ meetingId, segments, baseTime }) {
  const key = 'meeting:' + meetingId;
  const data = await chrome.storage.local.get([key, 'meetings']);
  const meeting = data[key] ?? {
    // startedAt = waktu MULAI rekam, bukan waktu simpan: kalau dipakai waktu
    // simpan, segmen ber-timestamp lebih awal dari "mulai" meeting-nya.
    id: meetingId, title: recTitle || meetingId, startedAt: baseTime ?? Date.now(),
    endedAt: null, segments: [], mom: null,
  };
  ...
```

`baseTime` harus ikut di pesan `audio-transcript` — tambahkan di `transcribeChunks` (Task 2) saat mengirim: `toSW({ type: 'audio-transcript', meetingId: c.meetingId, segments, baseTime: c.baseTime })`.

Di handler `audio-transcript`, transkrip kosong tidak boleh terlihat seperti sukses:

```js
  if (msg.type === 'audio-transcript') {
    rec = { recording: false, transcribing: false, meetingId: null };
    updateBadge();
    if (!msg.segments.length) {
      // Kosong = STT tidak menghasilkan teks. Tanpa pesan ini user melihat
      // meeting kosong yang tampak seperti berhasil.
      broadcastRec({ error: 'Transkrip kosong — STT tidak menghasilkan teks. Cek endpoint/model STT di Settings, lalu coba "Transkrip ulang".' });
    } else {
      enqueueWrite(() => saveAudioTranscript(msg));
      broadcastRec();
    }
    chrome.offscreen.closeDocument?.().catch(() => {});
    return false;
  }
```

- [ ] **Step 3: Bug 3 — judul meeting dari tab**

Simpan judul tab saat rekaman dimulai dari context menu. Tambah variabel modul di dekat `let rec = ...`:

```js
let recTitle = null; // judul tab saat mulai rekam — mode audio tak punya sumber judul lain
```

Di `chrome.contextMenus.onClicked` cabang `rec-start`, sebelum `startRecording`:

```js
      recTitle = tab?.title?.replace(/\s*[-—]\s*Google Meet\s*$/, '').trim() || null;
```

`saveAudioTranscript` sudah memakainya di Step 2.

- [ ] **Step 4: Handler `audio-meta` dan `regenerate-transcript`**

Tambah di `chrome.runtime.onMessage.addListener`:

```js
  if (msg.type === 'audio-meta') {
    globalThis.MeetAudioStore.loadAudioMeta()
      .then((m) => sendResponse(m), () => sendResponse(null));
    return true; // sendResponse async
  }
  if (msg.type === 'regenerate-transcript') {
    regenerateTranscript(msg.id).then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: e.message })
    );
    return true;
  }
```

dan fungsinya, dekat `startRecording`:

```js
// Transkrip ulang dari audio tersimpan: offscreen yang mengerjakan (bukan SW —
// SW MV3 bisa dimatikan di tengah loop upload yang panjang).
async function regenerateTranscript(meetingId) {
  if (rec.recording || rec.transcribing) throw new Error('Rekaman/transkrip masih berjalan.');
  const meta = await globalThis.MeetAudioStore.loadAudioMeta();
  if (!meta) throw new Error('Tidak ada audio tersimpan.');
  if (meta.meetingId !== meetingId) {
    throw new Error('Audio tersimpan milik meeting lain — hanya rekaman terakhir yang disimpan.');
  }
  const { settings = {} } = await chrome.storage.local.get('settings');
  const stt = globalThis.MeetStt.sttEndpoint(settings);
  await ensureOffscreen();
  rec = { recording: false, transcribing: true, meetingId };
  updateBadge();
  broadcastRec();
  chrome.runtime.sendMessage({
    target: 'offscreen', op: 'retranscribe', meetingId,
    baseUrl: stt.baseUrl, apiKey: stt.apiKey,
    sttModel: settings.sttModel || 'nvidia/parakeet-ctc-1.1b-asr',
    sttLanguage: settings.sttLanguage || '',
  });
}
```

- [ ] **Step 5: Handler `audio-warn`** (dikirim offscreen kalau penyimpanan audio gagal, transkrip tetap jalan):

```js
  if (msg.type === 'audio-warn') {
    broadcastRec({ error: msg.error });
    return false;
  }
```

- [ ] **Step 6: Test regresi**

Run: `node --test test/*.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add background/service-worker.js
git commit -m "feat: SW transkrip ulang dari audio tersimpan; fix startedAt, transkrip kosong senyap, judul meeting"
```

---

### Task 4: Tombol "Transkrip ulang" di panel + README

**Files:**
- Modify: `panel/panel.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: pesan `audio-meta` dan `regenerate-transcript` (Task 3).

- [ ] **Step 1: Ambil meta audio saat render meeting**

Di `renderMeeting`, setelah `meeting` dimuat dan sebelum bar actions dibuat, ambil meta (epoch-safe seperti pemuatan async lain di fungsi ini):

```js
  // Hanya rekaman TERAKHIR yang disimpan — tombol muncul kalau audio yang
  // tersimpan memang milik meeting ini.
  const audioMeta = meeting.source === 'audio'
    ? await chrome.runtime.sendMessage({ type: 'audio-meta' }).catch(() => null)
    : null;
  if (epoch !== renderEpoch) return;
```

- [ ] **Step 2: Tombol**

Setelah tombol `momBtn` dibuat:

```js
  if (audioMeta?.meetingId === meeting.id) {
    const reBtn = btn('Transkrip ulang', async () => {
      reBtn.disabled = true;
      reBtn.textContent = 'Mentranskrip…';
      momErrors.delete(meeting.id);
      const res = await chrome.runtime.sendMessage(
        { type: 'regenerate-transcript', id: meeting.id }).catch(() => null);
      if (!res?.ok) {
        momErrors.set(meeting.id, res?.error ?? 'Gagal menghubungi service worker.');
        render();
      }
      // Sukses: hasil datang lewat broadcast meeting-updated, panel rerender sendiri.
    });
  }
```

- [ ] **Step 3: README**

Tambah di bagian mode rekam audio: audio rekaman TERAKHIR disimpan, jadi kalau endpoint/model STT salah, perbaiki di Settings lalu klik **Transkrip ulang** — tidak perlu merekam lagi. Rekaman baru menimpa audio yang lama, jadi tombol hanya muncul untuk meeting dari rekaman terakhir.

- [ ] **Step 4: Test regresi**

Run: `node --test test/*.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/panel.js README.md
git commit -m "feat: tombol Transkrip ulang untuk meeting hasil rekam audio"
```

---

## Catatan eksekusi

- Verifikasi live (Chrome + Meet + server STT) tidak bisa dilakukan subagent — deferred ke user, seperti fitur audio sebelumnya.
- `renderMeeting` sekarang punya `await` tambahan sebelum menggambar; guard `epoch !== renderEpoch` WAJIB dipasang setelahnya, kalau tidak pass render yang kalah balapan bisa menimpa DOM pass yang lebih baru.
- Selesai semua task: merge ke `main` mengikuti pola repo (superpowers:finishing-a-development-branch).

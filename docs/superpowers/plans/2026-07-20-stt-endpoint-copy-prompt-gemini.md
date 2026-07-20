# STT Endpoint Terpisah + Copy Prompt + Kirim ke Gemini — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** STT mode audio bisa diarahkan ke server Whisper lokal / 9Router terpisah dari endpoint chat; tombol Copy Prompt+Transkrip; tombol Kirim ke Gemini (auto-paste + auto-submit di gemini.google.com).

**Architecture:** Fungsi pure `sttEndpoint()` di `lib/stt.js` memilih endpoint STT dari settings (fallback ke endpoint chat). Service worker memakainya saat start rekaman. Dua tombol baru di bar actions panel memakai `fillTemplate` yang sudah ada. Gemini: SW buka tab + `chrome.scripting.executeScript` injeksi fungsi one-shot yang poll editor Quill lalu isi + klik kirim; clipboard diisi dulu sebagai fallback.

**Tech Stack:** Chrome MV3 (service worker, offscreen, side panel, chrome.scripting), classic scripts via `globalThis`, `node --test` untuk unit test.

**Spec:** `docs/superpowers/specs/2026-07-20-stt-endpoint-copy-prompt-gemini-design.md`

## Global Constraints

- Classic scripts, bukan ES module: lib diekspos via `globalThis.MeetXxx`, dipakai lewat `importScripts` (SW), `<script>` (panel/offscreen), `await import()` side-effect (test).
- Semua teks UI bahasa Indonesia, konsisten dengan yang ada.
- Panel render pakai `el()`/`textContent` — jangan pernah `innerHTML` dengan data meeting.
- Komentar kode bahasa Indonesia, gaya repo (jelaskan constraint, bukan apa yang baris lakukan).
- Test: `node --test test/*.test.mjs` harus hijau di tiap commit (perintah dari README — `node --test test/` gagal di Node 22).
- Kerja di branch `feat/stt-endpoint-gemini` dari `main`.

---

### Task 1: `sttEndpoint()` di lib/stt.js (TDD)

**Files:**
- Modify: `lib/stt.js` (tambah fungsi + export)
- Test: `test/stt.test.mjs` (tambah 4 test)

**Interfaces:**
- Produces: `globalThis.MeetStt.sttEndpoint(settings) → { baseUrl, apiKey }`. Aturan: `sttBaseUrl` terisi → `baseUrl = sttBaseUrl`, dan `apiKey = sttApiKey` (bisa `''` = tanpa auth — apiKey utama TIDAK boleh ikut). `sttBaseUrl` kosong → `baseUrl` utama; `apiKey = sttApiKey` jika terisi, selain itu `apiKey` utama.

- [ ] **Step 1: Branch**

```bash
git checkout -b feat/stt-endpoint-gemini
```

- [ ] **Step 2: Tulis test gagal** — tambah di akhir `test/stt.test.mjs`:

```js
test('sttEndpoint: STT fields kosong → ikut endpoint utama', () => {
  assert.deepEqual(
    globalThis.MeetStt.sttEndpoint({ baseUrl: 'https://x/v1', apiKey: 'k' }),
    { baseUrl: 'https://x/v1', apiKey: 'k' });
});

test('sttEndpoint: sttBaseUrl terisi → apiKey utama TIDAK ikut', () => {
  assert.deepEqual(
    globalThis.MeetStt.sttEndpoint({ baseUrl: 'https://x/v1', apiKey: 'k', sttBaseUrl: 'http://localhost:8080/v1' }),
    { baseUrl: 'http://localhost:8080/v1', apiKey: '' });
});

test('sttEndpoint: sttBaseUrl + sttApiKey terisi → dua-duanya dipakai', () => {
  assert.deepEqual(
    globalThis.MeetStt.sttEndpoint({ baseUrl: 'https://x/v1', apiKey: 'k', sttBaseUrl: 'http://localhost:20128/v1', sttApiKey: 's' }),
    { baseUrl: 'http://localhost:20128/v1', apiKey: 's' });
});

test('sttEndpoint: hanya sttApiKey terisi → baseUrl utama + sttApiKey', () => {
  assert.deepEqual(
    globalThis.MeetStt.sttEndpoint({ baseUrl: 'https://x/v1', apiKey: 'k', sttApiKey: 's' }),
    { baseUrl: 'https://x/v1', apiKey: 's' });
});
```

- [ ] **Step 3: Jalankan, pastikan gagal**

Run: `node --test test/`
Expected: 4 test baru FAIL (`sttEndpoint is not a function`).

- [ ] **Step 4: Implementasi minimal** — di `lib/stt.js`, sebelum baris `globalThis.MeetStt = ...`:

```js
  // Pilih endpoint STT dari settings. sttBaseUrl terisi → apiKey utama TIDAK
  // ikut (server whisper lokal tak butuh auth; key chat tak boleh bocor ke
  // host lain). Kosong dua-duanya → endpoint chat (perilaku lama).
  function sttEndpoint(s = {}) {
    const sttBase = (s.sttBaseUrl || '').trim();
    const sttKey = (s.sttApiKey || '').trim();
    if (sttBase) return { baseUrl: sttBase, apiKey: sttKey };
    return { baseUrl: s.baseUrl, apiKey: sttKey || s.apiKey };
  }
```

dan ubah export jadi:

```js
  globalThis.MeetStt = { parseSttResponse, mergeSttChunks, sttEndpoint };
```

- [ ] **Step 5: Jalankan, pastikan hijau**

Run: `node --test test/`
Expected: semua PASS (lama + 4 baru).

- [ ] **Step 6: Commit**

```bash
git add lib/stt.js test/stt.test.mjs
git commit -m "feat: sttEndpoint() pilih endpoint STT terpisah dengan fallback ke endpoint chat"
```

---

### Task 2: Settings STT + wiring service worker

**Files:**
- Modify: `panel/panel.js` (renderSettings — 2 field baru + simpan + izin host)
- Modify: `background/service-worker.js:2` (importScripts) dan `:100-105` (startRecording)

**Interfaces:**
- Consumes: `globalThis.MeetStt.sttEndpoint(settings)` dari Task 1.
- Produces: settings keys baru `sttBaseUrl`, `sttApiKey` (string, boleh `''`).

- [ ] **Step 1: Field settings** — di `panel/panel.js` `renderSettings`, setelah deklarasi `sttLanguage` (sekitar baris 220-221), tambah:

```js
  const sttBaseUrl = field('STT Base URL (kosong = ikut Base URL di atas; whisper lokal mis. http://localhost:8080/v1, atau URL 9Router)',
    Object.assign(document.createElement('input'), { value: settings.sttBaseUrl ?? '' }));
  const sttApiKey = field('STT API key (kosong = tanpa auth)',
    Object.assign(document.createElement('input'), { type: 'password', value: settings.sttApiKey ?? '' }));
```

- [ ] **Step 2: Simpan + izin host** — di handler `save.addEventListener('click', ...)`:

Ganti blok try/catch izin jadi (izin host STT ikut diminta — perlu user gesture yang sama):

```js
    const sttBase = sttBaseUrl.value.trim().replace(/\/+$/, '');
    let warning = null;
    try {
      await ensureOrigin(base);
      if (sttBase) await ensureOrigin(sttBase);
    } catch (e) {
      if (e.message === 'Base URL tidak valid.') return setNote('err', e.message);
      warning = e.message; // izin ditolak → tetap simpan, tapi beri tahu
    }
```

dan di objek `settings` yang di-set, tambah dua key:

```js
        sttBaseUrl: sttBase,
        sttApiKey: sttApiKey.value.trim(),
```

- [ ] **Step 3: Wiring SW** — `background/service-worker.js`:

Baris 2 jadi:

```js
importScripts('/lib/merge.js', '/lib/openai.js', '/lib/stt.js');
```

Di `startRecording`, ganti `baseUrl: settings.baseUrl, apiKey: settings.apiKey,` jadi:

```js
    const stt = globalThis.MeetStt.sttEndpoint(settings);
```

(letakkan setelah baris `const { settings = {} } = ...`), lalu di pesan ke offscreen:

```js
    baseUrl: stt.baseUrl, apiKey: stt.apiKey,
```

- [ ] **Step 4: Test regresi + verifikasi manual**

Run: `node --test test/` → PASS.
Manual: reload extension di `chrome://extensions` → Settings → isi STT Base URL `http://localhost:20128/v1` (9Router) → Simpan → prompt izin host muncul → izinkan → nilai tersimpan setelah pindah tab dan balik. Kosongkan → Simpan → tersimpan tanpa prompt.

- [ ] **Step 5: Commit**

```bash
git add panel/panel.js background/service-worker.js
git commit -m "feat: settings endpoint STT terpisah (whisper lokal / 9Router)"
```

---

### Task 3: Tombol Copy Prompt+Transkrip

**Files:**
- Modify: `panel/panel.js` (renderMeeting, bar actions — setelah tombol Copy, sekitar baris 137)

**Interfaces:**
- Consumes: `M.fillTemplate`, `M.formatTranscript`, `M.DEFAULT_MOM_TEMPLATE`, `settingsCache` (semua sudah ada).
- Produces: helper `promptText(meeting)` di `panel/panel.js` — dipakai lagi oleh Task 4.

- [ ] **Step 1: Helper + tombol** — di `panel/panel.js`, tambah helper dekat `safeName` (level atas):

```js
// Prompt MoM lengkap (template + transkrip) untuk paste ke AI web tanpa API key.
const promptText = (meeting) => M.fillTemplate(
  settingsCache.momTemplate ?? M.DEFAULT_MOM_TEMPLATE,
  M.formatTranscript(meeting.segments));
```

Di `renderMeeting`, setelah blok `copyBtn`, tambah:

```js
  const copyPromptBtn = btn('Copy Prompt+Transkrip', async () => {
    try {
      await navigator.clipboard.writeText(promptText(meeting));
      copyPromptBtn.textContent = 'Disalin ✓';
    } catch {
      copyPromptBtn.textContent = 'Gagal menyalin';
    }
  });
```

- [ ] **Step 2: Verifikasi manual**

Reload extension → buka meeting di tab Riwayat → klik "Copy Prompt+Transkrip" → paste di editor: template MoM dengan transkrip mengisi `{{transcript}}`, label berubah "Disalin ✓".

- [ ] **Step 3: Commit**

```bash
git add panel/panel.js
git commit -m "feat: tombol Copy Prompt+Transkrip untuk paste manual ke AI web"
```

---

### Task 4: Kirim ke Gemini (manifest + SW + tombol)

**Files:**
- Modify: `manifest.json` (permissions + host_permissions)
- Modify: `background/service-worker.js` (fungsi injeksi + handler `send-to-gemini`)
- Modify: `panel/panel.js` (tombol setelah `copyPromptBtn`)

**Interfaces:**
- Consumes: `promptText(meeting)` dari Task 3.
- Produces: message `{ type: 'send-to-gemini', text: string }` panel → SW.

- [ ] **Step 1: Manifest** — `manifest.json`: tambah `"scripting"` ke `permissions`, tambah `"https://gemini.google.com/*"` ke `host_permissions`:

```json
  "permissions": ["sidePanel", "storage", "unlimitedStorage", "tabCapture", "offscreen", "activeTab", "contextMenus", "scripting"],
  "host_permissions": ["https://meet.google.com/*", "https://api.openai.com/*", "https://gemini.google.com/*"],
```

- [ ] **Step 2: Fungsi injeksi + handler di SW** — `background/service-worker.js`, tambah sebelum `chrome.runtime.onMessage.addListener`:

```js
// Berjalan DI HALAMAN Gemini via executeScript — harus mandiri (di-serialize,
// tak bisa akses scope SW). Poll: Gemini SPA, editor muncul belakangan.
// Selector dipusatkan di SEL — titik perbaikan kalau DOM Gemini berubah.
function injectGeminiPrompt(text) {
  const SEL = {
    editor: 'div.ql-editor',
    send: 'button[aria-label*="Send" i], button[aria-label*="Kirim" i], button.send-button',
  };
  const deadline = Date.now() + 20000;
  const timer = setInterval(() => {
    const editor = document.querySelector(SEL.editor);
    if (!editor) {
      if (Date.now() > deadline) clearInterval(timer); // timeout → user paste manual (clipboard)
      return;
    }
    clearInterval(timer);
    editor.focus();
    editor.replaceChildren();
    // Quill: satu <p> per baris; InputEvent supaya framework Gemini deteksi isi.
    for (const line of text.split('\n')) {
      const p = document.createElement('p');
      p.textContent = line;
      editor.append(p);
    }
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    // Tombol kirim baru enable setelah framework proses input event.
    setTimeout(() => document.querySelector(SEL.send)?.click(), 500);
  }, 500);
}

function sendToGemini(text) {
  chrome.tabs.create({ url: 'https://gemini.google.com/app' }).then((tab) => {
    const onUpdated = (id, info) => {
      if (id !== tab.id || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      // Gagal inject (SW restart, DOM berubah) → diam: teks sudah di clipboard.
      chrome.scripting.executeScript({ target: { tabId: tab.id }, func: injectGeminiPrompt, args: [text] })
        .catch(() => {});
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}
```

Di `chrome.runtime.onMessage.addListener`, tambah cabang:

```js
  if (msg.type === 'send-to-gemini') {
    sendToGemini(msg.text);
    return false;
  }
```

- [ ] **Step 3: Tombol panel** — `panel/panel.js`, setelah blok `copyPromptBtn`:

```js
  const gemBtn = btn('Kirim ke Gemini', async () => {
    // Clipboard dulu: asuransi kalau injeksi gagal (DOM Gemini berubah).
    await navigator.clipboard.writeText(promptText(meeting)).catch(() => {});
    chrome.runtime.sendMessage({ type: 'send-to-gemini', text: promptText(meeting) });
    gemBtn.textContent = 'Membuka Gemini…';
  });
```

- [ ] **Step 4: Verifikasi manual**

Reload extension (manifest berubah → wajib). Buka meeting di Riwayat → klik "Kirim ke Gemini" → tab gemini.google.com terbuka → prompt terisi di kotak input → auto-terkirim. Cek fallback: teks juga ada di clipboard (paste di editor).

- [ ] **Step 5: Test regresi**

Run: `node --test test/`
Expected: PASS semua.

- [ ] **Step 6: README** — tambah subbab singkat di `README.md` (ikuti gaya yang ada): STT Base URL terpisah (whisper lokal/9Router, kosong = ikut endpoint chat), tombol Copy Prompt+Transkrip, tombol Kirim ke Gemini (butuh login Google; kalau isi otomatis gagal, prompt sudah di clipboard — paste manual).

- [ ] **Step 7: Commit**

```bash
git add manifest.json background/service-worker.js panel/panel.js README.md
git commit -m "feat: tombol Kirim ke Gemini — auto-paste + submit via chrome.scripting"
```

---

## Catatan eksekusi

- Verifikasi manual butuh Chrome dengan extension ter-load unpacked; subagent tanpa browser cukup pastikan test hijau + minta user verifikasi manual di akhir.
- SW idle-restart sebelum tab Gemini selesai load → listener onUpdated hilang → injeksi tidak jalan; fallback clipboard menutupi kasus ini. Diterima di spec.
- Selesai semua task: merge ke `main` mengikuti pola repo (lihat superpowers:finishing-a-development-branch).

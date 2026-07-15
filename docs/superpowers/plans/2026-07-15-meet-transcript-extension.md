# Meet Transcript Extension — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chrome extension (Manifest V3) yang men-scrape live caption Google Meet menjadi transkrip di side panel, menyimpan riwayat per meeting, mendukung copy/download, dan generate MoM via OpenAI API.

**Architecture:** Content script mengobservasi area caption Meet dengan MutationObserver dan mengirim segmen lewat long-lived Port ke service worker; service worker menyimpan meeting ke `chrome.storage.local` dan memanggil OpenAI; side panel merender live transcript, riwayat, dan settings dari storage.

**Tech Stack:** Vanilla JS (classic scripts + `globalThis`, tanpa build step, tanpa npm), Manifest V3, `node --test` untuk unit test.

**Spec:** `docs/superpowers/specs/2026-07-15-meet-transcript-extension-design.md`

## Global Constraints

- Manifest V3. Vanilla JS. TANPA build step, TANPA dependency npm, TANPA framework.
- Shared code = classic script yang meng-expose `globalThis.*` (content script dan `importScripts` tidak mendukung ES module).
- SEMUA selector DOM Meet hanya boleh ada di `content/selectors.js`.
- Teks caption dan nama pembicara TIDAK DIPERCAYA — render selalu dengan `textContent`, jangan pernah `innerHTML`.
- Storage keys persis: `meeting:<id>`, `meetings`, `settings`.
- API key disimpan di `chrome.storage.local` (bukan `sync`).
- Unit test: `node --test test/merge.test.mjs` (Node 18+).
- Commit setelah tiap task.
- Batasan v1 yang disengaja: satu meeting aktif pada satu waktu; meeting dianggap berakhir saat tab Meet ditutup/navigasi; tanpa icon custom.
- Task 3, 5, 6, 7 butuh verifikasi manual di Google Meet asli — minta user join meeting saat sampai di step itu.

---

### Task 1: Skeleton extension (manifest + service worker + panel placeholder)

**Files:**
- Create: `manifest.json`
- Create: `background/service-worker.js`
- Create: `panel/panel.html`

**Interfaces:**
- Consumes: —
- Produces: extension yang bisa di-load unpacked; klik icon toolbar membuka side panel. `content_scripts` BELUM didaftarkan (file-nya belum ada; Chrome menolak manifest yang menunjuk file hilang) — didaftarkan di Task 5.

- [ ] **Step 1: Tulis `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Meet Transcript",
  "version": "0.1.0",
  "description": "Transkrip Google Meet dari live caption + generate MoM via OpenAI",
  "permissions": ["sidePanel", "storage", "unlimitedStorage"],
  "host_permissions": ["https://meet.google.com/*", "https://api.openai.com/*"],
  "background": { "service_worker": "background/service-worker.js" },
  "side_panel": { "default_path": "panel/panel.html" },
  "action": { "default_title": "Meet Transcript" }
}
```

- [ ] **Step 2: Tulis `background/service-worker.js`**

```js
// background/service-worker.js
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
```

- [ ] **Step 3: Tulis `panel/panel.html` (placeholder, diganti total di Task 6)**

```html
<!doctype html>
<meta charset="utf-8">
<title>Meet Transcript</title>
<p>Meet Transcript — panel siap.</p>
```

- [ ] **Step 4: Verifikasi manual**

1. Buka `chrome://extensions`, nyalakan Developer mode.
2. "Load unpacked" → pilih folder proyek ini.
3. Expected: extension muncul tanpa error.
4. Klik icon "Meet Transcript" di toolbar (puzzle piece → pin dulu bila perlu).
5. Expected: side panel terbuka, menampilkan "Meet Transcript — panel siap."

- [ ] **Step 5: Commit**

```bash
git add manifest.json background/service-worker.js panel/panel.html
git commit -m "feat: skeleton MV3 extension with side panel"
```

---

### Task 2: `lib/merge.js` — logika pure (TDD)

**Files:**
- Create: `lib/merge.js`
- Test: `test/merge.test.mjs`

**Interfaces:**
- Consumes: —
- Produces: `globalThis.MeetMerge` dengan:
  - `upsertSegment(segments, seg)` — `seg = {id:number, speaker:string, text:string, t:number(ms)}`; update in-place segmen ber-`id` sama (caption Meet bermutasi di tempat), else append. Return `segments`.
  - `formatTranscript(segments) → string` — satu baris per segmen: `[HH:MM:SS] Speaker: text`.
  - `formatMarkdown(meeting) → string` — `meeting = {title, startedAt, segments, mom}`; markdown lengkap, MoM ikut bila ada.
  - `fillTemplate(template, transcript) → string` — ganti semua `{{transcript}}`.
  - `DEFAULT_MOM_TEMPLATE: string` — template default berisi `{{transcript}}`.

- [ ] **Step 1: Tulis failing test `test/merge.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/merge.js'); // classic script: side effect set globalThis.MeetMerge
const { upsertSegment, formatTranscript, formatMarkdown, fillTemplate, DEFAULT_MOM_TEMPLATE } =
  globalThis.MeetMerge;

test('upsertSegment appends segmen dengan id baru', () => {
  const segs = [];
  upsertSegment(segs, { id: 1, speaker: 'Ani', text: 'halo', t: 0 });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].text, 'halo');
});

test('upsertSegment update in-place untuk id yang sama, tidak duplikat', () => {
  const segs = [];
  upsertSegment(segs, { id: 1, speaker: 'Ani', text: 'halo', t: 0 });
  upsertSegment(segs, { id: 1, speaker: 'Ani', text: 'halo semua', t: 0 });
  upsertSegment(segs, { id: 2, speaker: 'Budi', text: 'hai', t: 1000 });
  upsertSegment(segs, { id: 1, speaker: 'Ani', text: 'halo semuanya', t: 0 });
  assert.equal(segs.length, 2);
  assert.equal(segs[0].text, 'halo semuanya');
  assert.equal(segs[1].text, 'hai');
});

test('formatTranscript satu baris per segmen', () => {
  const t = new Date(2026, 0, 1, 9, 5, 7).getTime();
  const out = formatTranscript([{ id: 1, speaker: 'Ani', text: 'halo', t }]);
  assert.equal(out, '[09:05:07] Ani: halo');
});

test('formatMarkdown berisi judul, segmen, dan MoM bila ada', () => {
  const t = new Date(2026, 0, 1, 9, 5, 7).getTime();
  const md = formatMarkdown({
    title: 'abc-defg-hij', startedAt: t, mom: 'ringkasan',
    segments: [{ id: 1, speaker: 'Ani', text: 'halo', t }],
  });
  assert.ok(md.startsWith('# abc-defg-hij'));
  assert.ok(md.includes('- **Ani** (09:05:07): halo'));
  assert.ok(md.includes('## MoM'));
  assert.ok(md.includes('ringkasan'));
});

test('formatMarkdown tanpa MoM tidak menulis heading MoM', () => {
  const md = formatMarkdown({ title: 'x', startedAt: 0, segments: [], mom: null });
  assert.ok(!md.includes('## MoM'));
});

test('fillTemplate mengganti semua placeholder', () => {
  assert.equal(fillTemplate('A {{transcript}} B {{transcript}}', 'X'), 'A X B X');
});

test('DEFAULT_MOM_TEMPLATE mengandung placeholder', () => {
  assert.ok(DEFAULT_MOM_TEMPLATE.includes('{{transcript}}'));
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `node --test test/merge.test.mjs`
Expected: FAIL — `Cannot find module '../lib/merge.js'`

- [ ] **Step 3: Tulis `lib/merge.js`**

```js
// lib/merge.js — logika pure: merge segmen caption + formatting.
// Classic script (bukan ES module): dipakai lewat globalThis oleh service worker
// (importScripts), panel (script tag), dan test (import side-effect).
(() => {
  // Caption Meet bermutasi di tempat (teks tumbuh/dikoreksi), jadi segmen
  // ber-id sama di-update, bukan di-append. Cari dari belakang: hanya
  // segmen terakhir yang masih bermutasi.
  function upsertSegment(segments, seg) {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i].id === seg.id) {
        segments[i].speaker = seg.speaker;
        segments[i].text = seg.text;
        return segments;
      }
    }
    segments.push({ ...seg });
    return segments;
  }

  const pad = (n) => String(n).padStart(2, '0');
  function timeOf(t) {
    const d = new Date(t);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function formatTranscript(segments) {
    return segments.map((s) => `[${timeOf(s.t)}] ${s.speaker}: ${s.text}`).join('\n');
  }

  function formatMarkdown(meeting) {
    const lines = [`# ${meeting.title}`, '', new Date(meeting.startedAt).toLocaleString(), ''];
    for (const s of meeting.segments) lines.push(`- **${s.speaker}** (${timeOf(s.t)}): ${s.text}`);
    if (meeting.mom) lines.push('', '---', '', '## MoM', '', meeting.mom);
    return lines.join('\n');
  }

  function fillTemplate(template, transcript) {
    return template.replaceAll('{{transcript}}', transcript);
  }

  const DEFAULT_MOM_TEMPLATE = `Buat Minutes of Meeting (MoM) dari transkrip meeting berikut.

Format:
## Ringkasan
## Poin Pembahasan
## Keputusan
## Action Items (siapa, apa, tenggat)

Transkrip:
{{transcript}}`;

  globalThis.MeetMerge = {
    upsertSegment, formatTranscript, formatMarkdown, fillTemplate, DEFAULT_MOM_TEMPLATE,
  };
})();
```

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `node --test test/merge.test.mjs`
Expected: PASS — `# pass 7`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add lib/merge.js test/merge.test.mjs
git commit -m "feat: segment merge + formatting logic with tests"
```

---

### Task 3: `content/selectors.js` — semua selector DOM Meet

**Files:**
- Create: `content/selectors.js`

**Interfaces:**
- Consumes: —
- Produces: `globalThis.MeetSelectors` dengan:
  - `captionsRegion() → Element|null` — container caption; `null` = caption mati/belum di call.
  - `captionBlocks(region) → Element[]` — satu element per giliran bicara.
  - `blockSpeaker(block) → string` — nama pembicara (fallback `'Unknown'`).
  - `blockText(block) → string` — teks caption block.
  - `ccButton() → Element|null` — tombol toggle CC.
  - `ccEnabled() → boolean` — CC sedang nyala.
  - `inCall() → boolean` — user sedang dalam call.
  - `meetingTitle() → string` — judul meeting dari `document.title`.

> **PENTING:** DOM Meet di-obfuscate dan berubah tiap beberapa bulan. Selector di bawah adalah tebakan terbaik per pengetahuan 2025 — Step 2 (verifikasi di Meet asli) WAJIB, dan selector disesuaikan bila meleset. Itulah alasan file ini ada sendiri.

- [ ] **Step 1: Tulis `content/selectors.js`**

```js
// content/selectors.js — SEMUA selector DOM Meet ada di file ini, tidak di tempat lain.
// DOM Meet di-obfuscate dan berubah tiap beberapa bulan. Kalau transkrip berhenti
// terisi, perbaiki selector di sini. Urutan selector: paling spesifik dulu,
// fallback berbasis aria/struktur di belakang.
(() => {
  const q = (sels, root = document) => {
    for (const s of sels) {
      try {
        const el = root.querySelector(s);
        if (el) return el;
      } catch { /* selector tidak valid di browser lama — lewati */ }
    }
    return null;
  };

  function captionsRegion() {
    return q([
      'div[jsname="dsyhDe"]',        // container caption (build 2024-2025)
      'div[aria-label="Captions"]',  // fallback aria (UI English)
      'div[aria-label="Teks"]',      // fallback aria (UI Indonesia)
      '.a4cQT',                      // class container lama
    ]);
  }

  function captionBlocks(region) {
    // div[jsname="tgaKEf"] = elemen teks caption; parent-nya = block satu
    // giliran bicara (avatar + nama + teks).
    const texts = region.querySelectorAll('div[jsname="tgaKEf"]');
    if (texts.length) return [...texts].map((t) => t.parentElement);
    // Fallback struktural: anak langsung region yang punya avatar <img>.
    return [...region.children].filter((c) => c.querySelector('img'));
  }

  function blockSpeaker(block) {
    const el = q(['.NWpY1d', '.zs7s8d'], block);
    if (el) return el.textContent.trim();
    // Fallback struktural: sibling setelah avatar = nama.
    const img = block.querySelector('img');
    const sib = img && img.nextElementSibling;
    return (sib && sib.textContent.trim()) || 'Unknown';
  }

  function blockText(block) {
    const el = q(['div[jsname="tgaKEf"]'], block);
    if (el) return el.textContent.trim();
    // Fallback: seluruh teks block minus nama pembicara.
    return block.textContent.replace(blockSpeaker(block), '').trim();
  }

  function ccButton() {
    return q([
      'button[jsname="r8qRAd"]',
      'button[aria-label*="caption" i]',
      'button[aria-label*="teks" i]',
    ]);
  }

  function ccEnabled() {
    const b = ccButton();
    return !!b && b.getAttribute('aria-pressed') === 'true';
  }

  function inCall() {
    return !!q([
      'button[jsname="CQylAd"]',
      'button[aria-label*="leave call" i]',
      'button[aria-label*="keluar dari panggilan" i]',
    ]);
  }

  function meetingTitle() {
    return document.title.replace(/^Meet\s*[-–]\s*/, '').trim() || location.pathname.slice(1);
  }

  globalThis.MeetSelectors = {
    captionsRegion, captionBlocks, blockSpeaker, blockText,
    ccButton, ccEnabled, inCall, meetingTitle,
  };
})();
```

- [ ] **Step 2: Verifikasi manual di Meet asli (PERLU MEET ASLI — minta user join meeting, nyalakan CC, dan bicara/putar audio)**

1. Join Google Meet, nyalakan CC (tombol "Turn on captions"), pastikan ada caption muncul.
2. Buka DevTools di tab Meet → Console.
3. Paste SELURUH isi `content/selectors.js` ke console (jalan di page world — cukup untuk verifikasi).
4. Jalankan dan cocokkan:

```js
const S = globalThis.MeetSelectors;
S.inCall()                      // expected: true
S.ccEnabled()                   // expected: true
const r = S.captionsRegion();   // expected: bukan null
S.captionBlocks(r).length       // expected: >= 1 saat caption tampil
S.blockSpeaker(S.captionBlocks(r)[0])  // expected: nama pembicara, bukan 'Unknown'
S.blockText(S.captionBlocks(r)[0])     // expected: teks caption
S.meetingTitle()                // expected: judul/kode meeting
```

5. Kalau ada yang meleset: inspect element caption (klik kanan → Inspect), perbaiki selector di `content/selectors.js`, ulangi sampai semua cocok. Catat selector baru di commit message.

- [ ] **Step 3: Commit**

```bash
git add content/selectors.js
git commit -m "feat: Meet DOM selectors, verified against live Meet"
```

---

### Task 4: Service worker — sesi meeting, port, storage

**Files:**
- Modify: `background/service-worker.js` (ganti seluruh isi)

**Interfaces:**
- Consumes: `globalThis.MeetMerge.upsertSegment` (Task 2).
- Produces (protokol messaging, dipakai Task 5–7):
  - Port name `'captions'`; pesan masuk:
    - `{type:'segments', meetingId, title, segs:[{id,speaker,text,t}]}` → simpan ke storage.
    - `{type:'status', meetingId, inCall:boolean, captionsOn:boolean}` → update status live.
  - Port disconnect → `endMeeting` (set `endedAt`).
  - `chrome.runtime.sendMessage`:
    - `{type:'get-active'}` → response `{id, inCall, captionsOn, lastSegmentAt, captionsOnAt}`.
  - Broadcast ke panel: `{type:'status', ...active}` dan `{type:'meeting-updated', id}`.
  - Storage: `meeting:<id> = {id, title, startedAt, endedAt, segments, mom}`, `meetings = [id terbaru dulu]`.

- [ ] **Step 1: Tulis ulang `background/service-worker.js`**

```js
// background/service-worker.js
importScripts('/lib/merge.js');

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Status meeting aktif. Hilang saat SW idle-restart — dipulihkan oleh pesan
// status content script (tiap 2 detik) begitu SW bangun lagi.
let active = { id: null, inCall: false, captionsOn: false, lastSegmentAt: 0, captionsOnAt: 0 };

function notifyPanel(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {}); // panel tertutup → abaikan
}

async function saveSegments({ meetingId, title, segs }) {
  const key = 'meeting:' + meetingId;
  const data = await chrome.storage.local.get([key, 'meetings']);
  const meeting = data[key] ?? {
    id: meetingId, title, startedAt: Date.now(), endedAt: null, segments: [], mom: null,
  };
  if (title) meeting.title = title;
  meeting.endedAt = null; // rejoin meeting lama → aktif lagi
  for (const seg of segs) globalThis.MeetMerge.upsertSegment(meeting.segments, seg);
  const meetings = data.meetings ?? [];
  if (!meetings.includes(meetingId)) meetings.unshift(meetingId);
  await chrome.storage.local.set({ [key]: meeting, meetings });
  active.lastSegmentAt = Date.now();
  notifyPanel({ type: 'meeting-updated', id: meetingId });
}

async function endMeeting(meetingId) {
  const key = 'meeting:' + meetingId;
  const data = await chrome.storage.local.get(key);
  if (!data[key]) return;
  data[key].endedAt = Date.now();
  await chrome.storage.local.set({ [key]: data[key] });
  if (active.id === meetingId) {
    active = { id: null, inCall: false, captionsOn: false, lastSegmentAt: 0, captionsOnAt: 0 };
    notifyPanel({ type: 'status', ...active });
  }
  notifyPanel({ type: 'meeting-updated', id: meetingId });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'captions') return;
  let meetingId = null;
  port.onMessage.addListener((msg) => {
    if (msg.type === 'segments') {
      meetingId = msg.meetingId;
      saveSegments(msg);
    } else if (msg.type === 'status') {
      meetingId = msg.meetingId;
      if (msg.captionsOn && !active.captionsOn) active.captionsOnAt = Date.now();
      active = { ...active, id: msg.meetingId, inCall: msg.inCall, captionsOn: msg.captionsOn };
      notifyPanel({ type: 'status', ...active });
    }
  });
  port.onDisconnect.addListener(() => {
    if (meetingId) endMeeting(meetingId);
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get-active') {
    sendResponse(active);
    return false;
  }
});
```

- [ ] **Step 2: Verifikasi manual dengan port palsu**

1. `chrome://extensions` → reload extension.
2. Buka side panel (klik icon extension), lalu klik kanan di dalam panel → **Inspect** → Console. (Panel = extension page; `chrome.runtime.connect` dari sini memicu `onConnect` di service worker.)
3. Paste:

```js
const p = chrome.runtime.connect({ name: 'captions' });
p.postMessage({ type: 'segments', meetingId: 'tes-ttes-tes', title: 'Meeting Tes',
  segs: [{ id: 1, speaker: 'Ani', text: 'halo semua', t: Date.now() }] });
```

4. Buka `chrome://extensions` → "Meet Transcript" → "service worker" (buka console SW) → jalankan:

```js
chrome.storage.local.get(console.log)
```

Expected: ada `meeting:tes-ttes-tes` dengan 1 segmen `halo semua`, dan `meetings: ['tes-ttes-tes']`.

5. Bersihkan data tes: `chrome.storage.local.clear()` di console SW.

- [ ] **Step 3: Commit**

```bash
git add background/service-worker.js
git commit -m "feat: service worker meeting session storage via port"
```

---

### Task 5: `content/captions.js` — observer + kirim segmen + auto-CC

**Files:**
- Create: `content/captions.js`
- Modify: `manifest.json` (tambah `content_scripts`)

**Interfaces:**
- Consumes: `globalThis.MeetSelectors` (Task 3); protokol port `'captions'` (Task 4).
- Produces: segmen caption mengalir ke storage saat meeting berjalan; status `inCall/captionsOn` terkirim tiap 2 detik; auto-klik CC maksimal 3 percobaan.

- [ ] **Step 1: Tulis `content/captions.js`**

```js
// content/captions.js — observe caption Meet, kirim segmen + status ke service worker.
(() => {
  const S = globalThis.MeetSelectors;
  const meetingId = location.pathname.slice(1);
  if (!/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(meetingId)) return; // bukan halaman call

  let port = null;
  function connect() {
    port = chrome.runtime.connect({ name: 'captions' });
    port.onDisconnect.addListener(() => { port = null; }); // SW restart → reconnect di post berikutnya
  }
  function post(msg) {
    if (!port) connect();
    try { port.postMessage(msg); } catch { port = null; }
  }

  const blockIds = new WeakMap(); // element block → id segmen
  const firstSeen = new Map();    // id → timestamp pertama terlihat
  let nextId = 1;
  const dirty = new Map();        // id → segmen yang berubah sejak flush terakhir
  let observer = null;
  let observedRegion = null;
  let ccAttempts = 0;

  function scan(region) {
    for (const block of S.captionBlocks(region)) {
      if (!block) continue;
      let id = blockIds.get(block);
      if (!id) { id = nextId++; blockIds.set(block, id); }
      const text = S.blockText(block);
      if (!text) continue;
      if (!firstSeen.has(id)) firstSeen.set(id, Date.now());
      dirty.set(id, { id, speaker: S.blockSpeaker(block), text, t: firstSeen.get(id) });
    }
  }

  // Tick 2 detik: pasang/lepas observer, auto-CC, lapor status.
  setInterval(() => {
    const region = S.captionsRegion();
    if (region && region !== observedRegion) {
      observer?.disconnect();
      observer = new MutationObserver(() => scan(region));
      observer.observe(region, { childList: true, subtree: true, characterData: true });
      observedRegion = region;
      scan(region);
    } else if (!region && observer) {
      observer.disconnect();
      observer = null;
      observedRegion = null;
    }
    if (!region && S.inCall() && !S.ccEnabled() && ccAttempts < 3) {
      S.ccButton()?.click(); // coba nyalakan CC otomatis
      ccAttempts++;
    }
    post({ type: 'status', meetingId, inCall: S.inCall(), captionsOn: !!region });
  }, 2000);

  // Flush 500ms: kirim hanya segmen yang berubah.
  setInterval(() => {
    if (!dirty.size) return;
    post({ type: 'segments', meetingId, title: S.meetingTitle(), segs: [...dirty.values()] });
    dirty.clear();
  }, 500);

  connect();
})();
```

- [ ] **Step 2: Daftarkan content scripts di `manifest.json`**

Tambahkan property ini (sejajar dengan `"background"`):

```json
"content_scripts": [
  {
    "matches": ["https://meet.google.com/*"],
    "js": ["content/selectors.js", "content/captions.js"],
    "run_at": "document_idle"
  }
]
```

- [ ] **Step 3: Verifikasi end-to-end (PERLU MEET ASLI — minta user join meeting dan bicara)**

1. Reload extension di `chrome://extensions`.
2. Join Google Meet (URL bentuk `meet.google.com/xxx-yyyy-zzz`). Biarkan CC mati dulu.
3. Expected: dalam ±6 detik CC menyala sendiri (auto-CC). Kalau tidak, nyalakan manual dan catat — periksa `ccButton()`/`ccEnabled()` di selectors.
4. Bicara / putar audio sampai caption muncul.
5. Console SW → `chrome.storage.local.get(console.log)`.
6. Expected: `meeting:<kode-meeting>` berisi `segments` yang bertambah, teks cocok dengan caption, `speaker` benar, TIDAK ada duplikat baris untuk kalimat yang sama (kalimat yang dikoreksi Meet ter-update, bukan dobel).
7. Tutup tab Meet → cek lagi: `endedAt` terisi.

- [ ] **Step 4: Commit**

```bash
git add content/captions.js manifest.json
git commit -m "feat: caption observer content script with auto-CC"
```

---

### Task 6: Side panel — live transcript, riwayat, settings, copy/download

**Files:**
- Modify: `panel/panel.html` (ganti seluruh isi)
- Create: `panel/panel.css`
- Create: `panel/panel.js`

**Interfaces:**
- Consumes: `globalThis.MeetMerge` (Task 2); messaging & storage keys (Task 4).
- Produces: UI 3 tab. Tombol "Generate MoM" BELUM ada (ditambah Task 7).

- [ ] **Step 1: Tulis ulang `panel/panel.html`**

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Meet Transcript</title>
  <link rel="stylesheet" href="panel.css">
</head>
<body>
  <nav>
    <button data-tab="live" class="active">Live</button>
    <button data-tab="history">Riwayat</button>
    <button data-tab="settings">Settings</button>
  </nav>
  <main id="view"></main>
  <script src="../lib/merge.js"></script>
  <script src="panel.js"></script>
</body>
</html>
```

- [ ] **Step 2: Tulis `panel/panel.css`**

```css
body { font: 13px/1.5 system-ui, sans-serif; margin: 0; color: #1a1a1a; }
nav { display: flex; border-bottom: 1px solid #ddd; position: sticky; top: 0; background: #fff; }
nav button { flex: 1; padding: 8px; border: 0; background: none; cursor: pointer; border-bottom: 2px solid transparent; }
nav button.active { font-weight: 600; border-bottom-color: #1a73e8; }
main { padding: 12px; overflow-y: auto; height: calc(100vh - 37px); box-sizing: border-box; }
h2 { font-size: 15px; margin: 8px 0 2px; }
h3 { font-size: 13px; margin: 12px 0 4px; }
.muted { color: #888; }
.seg { margin-bottom: 8px; }
.seg .who { font-weight: 600; }
.seg .time { color: #888; font-size: 11px; margin-left: 4px; }
.warn { background: #fef7e0; border: 1px solid #f9ab00; padding: 8px; border-radius: 6px; margin-bottom: 8px; }
.error { background: #fce8e6; border: 1px solid #d93025; padding: 8px; border-radius: 6px; margin-bottom: 8px; }
.actions { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
button { padding: 6px 10px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer; font: inherit; }
button:disabled { opacity: .5; }
.item { display: block; width: 100%; text-align: left; margin-bottom: 6px; padding: 8px; }
.mom { white-space: pre-wrap; background: #f6f8fa; padding: 8px; border-radius: 6px; }
label { display: block; font-weight: 600; margin-top: 8px; }
textarea, input { width: 100%; box-sizing: border-box; margin: 4px 0 4px; padding: 6px; border: 1px solid #ccc; border-radius: 6px; font: inherit; }
textarea { min-height: 160px; }
```

- [ ] **Step 3: Tulis `panel/panel.js`**

```js
// panel/panel.js — render live transcript, riwayat, settings dari storage.
const M = globalThis.MeetMerge;
const view = document.getElementById('view');
let tab = 'live';
let viewingId = null; // di tab Riwayat: meeting yang sedang dibuka
let status = { id: null, inCall: false, captionsOn: false, lastSegmentAt: 0, captionsOnAt: 0 };

// el(): SELALU textContent — teks caption/nama pembicara tidak dipercaya.
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

document.querySelectorAll('nav button').forEach((b) =>
  b.addEventListener('click', () => {
    tab = b.dataset.tab;
    viewingId = null;
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
    render();
  })
);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') {
    status = msg;
    if (tab === 'live') render();
  } else if (msg.type === 'meeting-updated') {
    if ((tab === 'live' && msg.id === status.id) || (tab === 'history' && msg.id === viewingId)) render();
  }
});

async function getMeeting(id) {
  return (await chrome.storage.local.get('meeting:' + id))['meeting:' + id] ?? null;
}

const safeName = (s) => s.replace(/[\/\\:*?"<>|]/g, '-');

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = safeName(name);
  a.click();
  URL.revokeObjectURL(a.href);
}

async function render() {
  if (tab === 'live') return renderMeeting(status.id, true);
  if (tab === 'history') return viewingId ? renderMeeting(viewingId, false) : renderHistory();
  return renderSettings();
}

async function renderMeeting(id, live) {
  const meeting = id ? await getMeeting(id) : null;
  const stickToBottom = live && view.scrollHeight - view.scrollTop - view.clientHeight < 40;
  view.replaceChildren();

  if (live && status.inCall && !status.captionsOn) {
    view.append(el('div', 'warn',
      'Caption mati. Nyalakan CC di toolbar Meet supaya transkrip terisi.'));
  }
  const quietSince = Math.max(status.lastSegmentAt || 0, status.captionsOnAt || 0);
  if (live && status.inCall && status.captionsOn && quietSince && Date.now() - quietSince > 30000) {
    view.append(el('div', 'warn',
      'Caption nyala tapi tidak ada teks masuk 30 detik terakhir. Kalau ada yang bicara, kemungkinan DOM Meet berubah — perbaiki content/selectors.js.'));
  }

  if (!meeting) {
    view.append(el('p', 'muted',
      live ? 'Tidak ada meeting aktif. Join Google Meet dulu.' : 'Meeting tidak ditemukan.'));
    return;
  }

  if (!live) {
    const back = el('button', null, '← Riwayat');
    back.addEventListener('click', () => { viewingId = null; render(); });
    view.append(back);
  }
  view.append(el('h2', null, meeting.title));
  view.append(el('p', 'muted', new Date(meeting.startedAt).toLocaleString()));

  const actions = el('div', 'actions');
  const btn = (label, fn) => {
    const b = el('button', null, label);
    b.addEventListener('click', fn);
    actions.append(b);
    return b;
  };
  btn('Copy', () => navigator.clipboard.writeText(M.formatTranscript(meeting.segments)));
  btn('Unduh .txt', () => download(`${meeting.title}.txt`, M.formatTranscript(meeting.segments)));
  btn('Unduh .md', () => download(`${meeting.title}.md`, M.formatMarkdown(meeting)));
  view.append(actions);

  const list = el('div');
  for (const s of meeting.segments) {
    const seg = el('div', 'seg');
    const head = el('div');
    head.append(el('span', 'who', s.speaker), el('span', 'time', new Date(s.t).toLocaleTimeString()));
    seg.append(head, el('div', null, s.text));
    list.append(seg);
  }
  if (!meeting.segments.length) list.append(el('p', 'muted', 'Belum ada caption masuk.'));
  view.append(list);

  if (meeting.mom) {
    view.append(el('h3', null, 'MoM'));
    view.append(el('div', 'mom', meeting.mom));
  }
  if (stickToBottom) view.scrollTop = view.scrollHeight;
}

async function renderHistory() {
  const { meetings = [] } = await chrome.storage.local.get('meetings');
  view.replaceChildren();
  if (!meetings.length) {
    view.append(el('p', 'muted', 'Belum ada riwayat.'));
    return;
  }
  for (const id of meetings) {
    const m = await getMeeting(id);
    if (!m) continue;
    const item = el('button', 'item');
    item.append(
      el('div', 'who', m.title),
      el('div', 'muted',
        `${new Date(m.startedAt).toLocaleString()} — ${m.segments.length} segmen${m.mom ? ' — MoM ✓' : ''}`)
    );
    item.addEventListener('click', () => { viewingId = id; render(); });
    view.append(item);
  }
}

async function renderSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  view.replaceChildren();
  view.append(el('h2', null, 'Settings'));

  const field = (label, input) => {
    view.append(el('label', null, label), input);
    return input;
  };
  const apiKey = field('OpenAI API key',
    Object.assign(document.createElement('input'), { type: 'password', value: settings.apiKey ?? '' }));
  const model = field('Model',
    Object.assign(document.createElement('input'), { value: settings.model ?? 'gpt-4o-mini' }));
  const template = field('Template MoM ({{transcript}} = transkrip)',
    Object.assign(document.createElement('textarea'), { value: settings.momTemplate ?? M.DEFAULT_MOM_TEMPLATE }));

  const save = el('button', null, 'Simpan');
  const note = el('span', 'muted', '');
  save.addEventListener('click', async () => {
    await chrome.storage.local.set({
      settings: {
        apiKey: apiKey.value.trim(),
        model: model.value.trim() || 'gpt-4o-mini',
        momTemplate: template.value,
      },
    });
    note.textContent = ' Tersimpan.';
  });
  view.append(save, note);
}

(async () => {
  const a = await chrome.runtime.sendMessage({ type: 'get-active' }).catch(() => null);
  if (a) status = a;
  render();
})();
```

- [ ] **Step 4: Verifikasi manual (PERLU MEET ASLI untuk bagian live)**

Tanpa meeting:
1. Reload extension, buka side panel.
2. Tab Live → expected: "Tidak ada meeting aktif. Join Google Meet dulu."
3. Tab Riwayat → expected: "Belum ada riwayat." (atau meeting dari Task 5).
4. Tab Settings → isi API key dummy `sk-test`, ubah template, klik Simpan → expected "Tersimpan."; tutup-buka panel → nilai tetap.

Dengan meeting (minta user join + bicara):
5. Tab Live → transcript muncul & bertambah live, auto-scroll saat di bawah.
6. Matikan CC manual di Meet → expected warning "Caption mati…" muncul ≤ 4 detik.
7. Klik Copy → paste di editor → format `[HH:MM:SS] Nama: teks`.
8. Unduh .txt dan .md → file terunduh, isi benar.
9. Tutup tab Meet → tab Riwayat → meeting ada di daftar, bisa dibuka, tombol ← kembali.

- [ ] **Step 5: Commit**

```bash
git add panel/panel.html panel/panel.css panel/panel.js
git commit -m "feat: side panel with live transcript, history, settings"
```

---

### Task 7: Generate MoM — `lib/openai.js` + service worker + tombol panel

**Files:**
- Create: `lib/openai.js`
- Modify: `background/service-worker.js` (importScripts + handler `generate-mom`)
- Modify: `panel/panel.js` (tombol Generate MoM di `renderMeeting`)

**Interfaces:**
- Consumes: `MeetMerge.formatTranscript/fillTemplate/DEFAULT_MOM_TEMPLATE` (Task 2); `settings` dari storage (Task 6).
- Produces:
  - `globalThis.MeetOpenAI.generateMoM({apiKey, model, prompt}) → Promise<string>` — throw `Error` dengan pesan jelas bila gagal.
  - Message `{type:'generate-mom', id}` → response `{ok:true, mom}` atau `{ok:false, error}`.

- [ ] **Step 1: Tulis `lib/openai.js`**

```js
// lib/openai.js — panggilan OpenAI chat completions. Classic script (globalThis).
(() => {
  async function generateMoM({ apiKey, model, prompt }) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message ?? `OpenAI error HTTP ${res.status}`);
    }
    const data = await res.json();
    const mom = data.choices?.[0]?.message?.content;
    if (!mom) throw new Error('Respons OpenAI kosong.');
    return mom;
  }
  globalThis.MeetOpenAI = { generateMoM };
})();
```

- [ ] **Step 2: Update `background/service-worker.js`**

Ganti baris pertama:

```js
importScripts('/lib/merge.js', '/lib/openai.js');
```

Tambahkan fungsi ini (setelah `endMeeting`):

```js
async function generateMom(id) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  if (!settings.apiKey) throw new Error('API key belum diisi di tab Settings.');
  const key = 'meeting:' + id;
  const data = await chrome.storage.local.get(key);
  const meeting = data[key];
  if (!meeting || !meeting.segments.length) throw new Error('Transkrip kosong.');
  const transcript = globalThis.MeetMerge.formatTranscript(meeting.segments);
  const prompt = globalThis.MeetMerge.fillTemplate(
    settings.momTemplate || globalThis.MeetMerge.DEFAULT_MOM_TEMPLATE, transcript);
  const mom = await globalThis.MeetOpenAI.generateMoM({
    apiKey: settings.apiKey, model: settings.model || 'gpt-4o-mini', prompt,
  });
  meeting.mom = mom;
  await chrome.storage.local.set({ [key]: meeting });
  return mom;
}
```

Ganti listener `onMessage` menjadi:

```js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get-active') {
    sendResponse(active);
    return false;
  }
  if (msg.type === 'generate-mom') {
    generateMom(msg.id).then(
      (mom) => sendResponse({ ok: true, mom }),
      (e) => sendResponse({ ok: false, error: e.message })
    );
    return true; // sendResponse async
  }
});
```

- [ ] **Step 3: Update `panel/panel.js`**

Di `renderMeeting`, tepat SETELAH baris `btn('Unduh .md', ...)` dan SEBELUM `view.append(actions);`, tambahkan:

```js
  const momBtn = btn(meeting.mom ? 'Regenerate MoM' : 'Generate MoM', async () => {
    momBtn.disabled = true;
    momBtn.textContent = 'Menghasilkan…';
    const res = await chrome.runtime.sendMessage({ type: 'generate-mom', id: meeting.id })
      .catch(() => null);
    if (res?.ok) return render();
    view.prepend(el('div', 'error', res?.error ?? 'Gagal menghubungi service worker.'));
    momBtn.disabled = false;
    momBtn.textContent = 'Generate MoM';
  });
```

- [ ] **Step 4: Verifikasi manual (PERLU API KEY ASLI — minta user isi API key OpenAI miliknya di tab Settings)**

1. Reload extension.
2. Tanpa API key (kosongkan di Settings) → buka meeting di Riwayat → klik Generate MoM → expected error merah: "API key belum diisi di tab Settings."
3. Isi API key asli di Settings → Simpan.
4. Buka meeting dengan transkrip (dari Task 5/6) → Generate MoM → tombol jadi "Menghasilkan…" → expected: MoM muncul di bawah transcript sesuai format template.
5. Unduh .md → expected: MoM ikut di bagian `## MoM`.
6. Isi API key salah (mis. `sk-salah`) → Generate MoM → expected pesan error dari OpenAI tampil merah, tombol aktif lagi.

- [ ] **Step 5: Commit**

```bash
git add lib/openai.js background/service-worker.js panel/panel.js
git commit -m "feat: generate MoM via OpenAI with configurable template"
```

---

### Task 8: README + checklist end-to-end

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: semua task sebelumnya.
- Produces: dokumentasi install/pakai/troubleshoot.

- [ ] **Step 1: Tulis `README.md`**

```markdown
# Meet Transcript

Chrome extension (Manifest V3): transkrip Google Meet dari live caption,
riwayat meeting, download .txt/.md, dan generate MoM via OpenAI.

## Install

1. Buka `chrome://extensions`, nyalakan **Developer mode**.
2. **Load unpacked** → pilih folder proyek ini.
3. Pin icon "Meet Transcript" di toolbar.

## Pakai

1. Join Google Meet. Extension mencoba menyalakan CC otomatis; kalau gagal,
   nyalakan manual (tombol CC di toolbar Meet).
2. Klik icon extension → side panel: tab **Live** menampilkan transkrip berjalan.
3. Tab **Settings**: isi OpenAI API key, model (default `gpt-4o-mini`), dan
   template MoM (`{{transcript}}` diganti isi transkrip).
4. Tombol **Generate MoM** membuat MoM dari transkrip; hasil ikut di unduhan .md.
5. Tab **Riwayat**: semua meeting tersimpan lokal (`chrome.storage.local`),
   bisa dibuka/di-download lagi.

## Batasan v1

- Transkrip bersumber dari caption Meet — caption harus nyala, akurasi ikut Google.
- Satu meeting aktif pada satu waktu.
- Meeting dianggap berakhir saat tab Meet ditutup/pindah halaman.

## Troubleshooting

**Transkrip berhenti terisi padahal caption jalan** → Google mengubah DOM Meet.
Semua selector ada di `content/selectors.js`; inspect element caption dan
sesuaikan. Panel menampilkan peringatan bila caption nyala tapi tidak ada teks
masuk 30 detik.

## Test

```bash
node --test test/merge.test.mjs
```
```

- [ ] **Step 2: Jalankan seluruh checklist end-to-end**

1. `node --test test/merge.test.mjs` → `# fail 0`.
2. Reload extension bersih: hapus + Load unpacked ulang.
3. Join Meet → CC auto-nyala → transcript live di panel → tutup tab → riwayat berisi → Generate MoM sukses → unduh .txt/.md benar.
4. Semua langkah verifikasi Task 6 Step 4 dan Task 7 Step 4 lulus.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README with install, usage, troubleshooting"
```

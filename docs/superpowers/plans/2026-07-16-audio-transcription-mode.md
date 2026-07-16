# Mode Transkrip Audio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menambah mode transkrip alternatif yang merekam audio tab Google Meet dan mentranskripnya via STT endpoint OpenAI-compatible, tanpa mengaktifkan caption Meet.

**Architecture:** Panel (mode audio) memanggil `chrome.tabCapture.getMediaStreamId` di konteks gesture user, mengirim streamId ke service worker; SW membuat offscreen document yang merekam audio (MediaRecorder), memutarnya balik ke speaker, memotong per 10 menit, lalu saat Stop mentranskrip tiap potong via `<baseUrl>/audio/transcriptions` dan mengirim teks hasil ke SW untuk disimpan ke meeting.

**Tech Stack:** Vanilla JS (classic scripts + `globalThis`), Manifest V3, `chrome.tabCapture` + `chrome.offscreen`, MediaRecorder/Web Audio, `node --test`.

**Spec:** `docs/superpowers/specs/2026-07-16-audio-transcription-mode-design.md`

## Global Constraints

- Manifest V3, vanilla JS, TANPA build step / npm / framework.
- Shared code = classic script yang meng-expose `globalThis.*` (offscreen & SW pakai lewat globalThis).
- Teks transkrip TIDAK DIPERCAYA — render selalu `textContent`, jangan `innerHTML`.
- Storage keys persis: `meeting:<id>`, `meetings`, `settings`.
- Endpoint STT persis: `POST <baseUrl>/audio/transcriptions`, multipart/form-data, header `Authorization: Bearer <apiKey>` (key opsional bila kosong).
- Default STT model `nvidia/parakeet-ctc-1.1b-asr`; durasi chunk 600000 ms (10 menit, hardcode di SW).
- Segmen mode audio: `speaker: ''` (tanpa nama), `t` = epoch ms absolut.
- Unit test: `node --test test/*.test.mjs` (Node 18+).
- Commit setelah tiap task.
- Task 4-7 butuh verifikasi manual di Google Meet asli + endpoint STT nyata — minta user saat sampai step itu.

### Kontrak pesan (dipakai lintas Task 3-6)

- Panel → SW: `{type:'start-recording', streamId, meetingId, tabId}`, `{type:'stop-recording'}`.
- SW → offscreen: `{target:'offscreen', op:'start', streamId, baseUrl, apiKey, sttModel, sttLanguage, chunkMs, baseTime}`, `{target:'offscreen', op:'stop'}`.
- Offscreen → SW: `{type:'audio-progress', meetingId, done, total}`, `{type:'audio-transcript', meetingId, segments}`, `{type:'audio-error', meetingId, error}`.
- SW → panel broadcast: `{type:'rec-state', recording:boolean, transcribing:boolean, done, total, error}`.
- `get-active` response memuat field baru `tabId` (dari `port.sender.tab.id`).

---

### Task 1: `lib/stt.js` — parse + merge hasil STT (logika pure, TDD)

**Files:**
- Create: `lib/stt.js`
- Test: `test/stt.test.mjs`

**Interfaces:**
- Consumes: —
- Produces: `globalThis.MeetStt` dengan:
  - `parseSttResponse(raw) → {segments:[{start:number, text:string}]}` — terima string JSON atau objek; dukung `verbose_json` (`{segments:[...]}`) dan fallback `{text}` (→ satu segmen `start:0`); tak terparse → `{segments:[]}`.
  - `mergeSttChunks(chunkResults, chunkDurationMs, baseTime) → [{t:number, speaker:'', text:string}]` — `chunkResults[i]` = hasil `parseSttResponse` atau `{error}`; offset chunk i = `baseTime + i*chunkDurationMs`; segmen `t = offset + round(start*1000)`; chunk error → satu segmen `text:'[transkrip gagal]'`; segmen teks kosong dilewati.

- [ ] **Step 1: Tulis failing test `test/stt.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/stt.js'); // classic script: set globalThis.MeetStt
const { parseSttResponse, mergeSttChunks } = globalThis.MeetStt;

test('parseSttResponse verbose_json', () => {
  const r = parseSttResponse('{"segments":[{"start":1.5,"text":"halo"},{"start":3,"text":"dunia"}]}');
  assert.deepEqual(r, { segments: [{ start: 1.5, text: 'halo' }, { start: 3, text: 'dunia' }] });
});

test('parseSttResponse fallback {text}', () => {
  assert.deepEqual(parseSttResponse('{"text":"halo dunia"}'), { segments: [{ start: 0, text: 'halo dunia' }] });
});

test('parseSttResponse objek langsung (bukan string)', () => {
  assert.deepEqual(parseSttResponse({ segments: [{ start: 0, text: 'a' }] }), { segments: [{ start: 0, text: 'a' }] });
});

test('parseSttResponse tak terparse → segments kosong', () => {
  assert.deepEqual(parseSttResponse('bukan json'), { segments: [] });
});

test('mergeSttChunks offset antar chunk + baseTime', () => {
  const base = 1000000;
  const chunks = [
    { segments: [{ start: 0, text: 'satu' }, { start: 2, text: 'dua' }] },
    { segments: [{ start: 1, text: 'tiga' }] },
  ];
  const out = mergeSttChunks(chunks, 600000, base);
  assert.deepEqual(out, [
    { t: base + 0, speaker: '', text: 'satu' },
    { t: base + 2000, speaker: '', text: 'dua' },
    { t: base + 600000 + 1000, speaker: '', text: 'tiga' },
  ]);
});

test('mergeSttChunks chunk error → penanda, segmen kosong dilewati', () => {
  const out = mergeSttChunks([{ error: 'gagal' }, { segments: [{ start: 0, text: '' }, { start: 1, text: 'ok' }] }], 600000, 0);
  assert.deepEqual(out, [
    { t: 0, speaker: '', text: '[transkrip gagal]' },
    { t: 601000, speaker: '', text: 'ok' },
  ]);
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `node --test test/stt.test.mjs`
Expected: FAIL — `Cannot find module '../lib/stt.js'`

- [ ] **Step 3: Tulis `lib/stt.js`**

```js
// lib/stt.js — parse & merge hasil speech-to-text. Classic script (globalThis).
// Dipakai offscreen document + di-unit-test via import side-effect.
(() => {
  function parseSttResponse(raw) {
    let d;
    try { d = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { return { segments: [] }; }
    if (d && Array.isArray(d.segments)) {
      return { segments: d.segments.map((s) => ({ start: s.start ?? 0, text: s.text ?? '' })) };
    }
    if (d && typeof d.text === 'string') return { segments: [{ start: 0, text: d.text }] };
    return { segments: [] };
  }

  // chunkResults[i] = hasil parseSttResponse ATAU {error}. Offset absolut chunk i
  // = baseTime + i*chunkDurationMs (chunk direkam berurutan @ durasi tetap).
  function mergeSttChunks(chunkResults, chunkDurationMs, baseTime) {
    const out = [];
    chunkResults.forEach((r, i) => {
      const offset = baseTime + i * chunkDurationMs;
      if (!r || r.error) {
        out.push({ t: offset, speaker: '', text: '[transkrip gagal]' });
        return;
      }
      for (const seg of r.segments ?? []) {
        const text = (seg.text ?? '').trim();
        if (!text) continue;
        out.push({ t: offset + Math.round((seg.start ?? 0) * 1000), speaker: '', text });
      }
    });
    return out;
  }

  globalThis.MeetStt = { parseSttResponse, mergeSttChunks };
})();
```

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `node --test test/stt.test.mjs`
Expected: PASS — `# pass 6`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add lib/stt.js test/stt.test.mjs
git commit -m "feat: STT response parse + chunk merge logic with tests"
```

---

### Task 2: `transcribeAudio` di `lib/openai.js` — panggilan STT multipart

**Files:**
- Modify: `lib/openai.js` (tambah fungsi + expose)

**Interfaces:**
- Consumes: `globalThis.MeetStt.parseSttResponse` (Task 1).
- Produces: `globalThis.MeetOpenAI.transcribeAudio({blob, baseUrl, apiKey, model, language}) → Promise<{segments:[{start,text}]}>` — POST multipart ke `<baseUrl>/audio/transcriptions` (fields: `file`=blob `audio.webm`, `model`, `response_format`=`verbose_json`, `language` bila diisi); sukses → `parseSttResponse(body)`; gagal → throw `Error` pesan jelas.

- [ ] **Step 1: Tambah `transcribeAudio` di `lib/openai.js`**

Sisipkan fungsi ini SEBELUM baris `globalThis.MeetOpenAI = {...}`:

```js
  async function transcribeAudio({ blob, baseUrl, apiKey, model, language }) {
    const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const form = new FormData();
    form.append('file', blob, 'audio.webm');
    form.append('model', model);
    form.append('response_format', 'verbose_json');
    if (language) form.append('language', language);
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    let res;
    try {
      res = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers, body: form });
    } catch {
      throw new Error(`Tidak bisa terhubung ke ${base} untuk transkrip audio.`);
    }
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      const detail = err?.error?.message ?? `HTTP ${res.status}`;
      const hint = res.status === 401 ? ' (API key salah?)'
        : res.status === 404 ? ' (endpoint/model STT tidak ditemukan?)'
        : (res.status === 400 || res.status === 415) ? ' (format audio tidak didukung model?)' : '';
      throw new Error(detail + hint);
    }
    return globalThis.MeetStt.parseSttResponse(await res.text());
  }
```

Ubah baris export menjadi:

```js
  globalThis.MeetOpenAI = { generateMoM, testConnection, transcribeAudio, extractContent, DEFAULT_BASE_URL };
```

- [ ] **Step 2: Verifikasi syntax**

Run: `node --check lib/openai.js`
Expected: exit 0 (tanpa output).

- [ ] **Step 3: Verifikasi test lain tak rusak**

Run: `node --test test/*.test.mjs`
Expected: `# fail 0` (semua test existing tetap lulus).

- [ ] **Step 4: Commit**

```bash
git add lib/openai.js
git commit -m "feat: transcribeAudio STT multipart client"
```

---

### Task 3: Settings — toggle sumber transkrip + model & bahasa STT

**Files:**
- Modify: `panel/panel.js` (fungsi `renderSettings`, sekitar baris 166-252)

**Interfaces:**
- Consumes: storage `settings` (existing).
- Produces: `settings` bertambah `transcriptSource:'caption'|'audio'` (default `'caption'`), `sttModel` (default `'nvidia/parakeet-ctc-1.1b-asr'`), `sttLanguage` (default `''`). Disimpan bersama field existing tanpa menghapusnya.

- [ ] **Step 1: Baca `renderSettings` saat ini untuk lokasi sisip**

Run: `sed -n '166,255p' panel/panel.js`
Expected: melihat pembuatan field `baseUrl/apiKey/model/template`, lalu blok `save`/`test`/`actions`.

- [ ] **Step 2: Tambah tiga field + sertakan saat menyimpan**

Di `renderSettings`, SETELAH baris pembuatan `template` (`const template = field(...)`) dan SEBELUM `const note = el('span', 'muted', '');`, sisipkan:

```js
  const source = field('Sumber transkrip',
    Object.assign(document.createElement('select'), { innerHTML: '' }));
  for (const [val, label] of [['caption', 'Caption Meet'], ['audio', 'Rekam audio']]) {
    source.append(Object.assign(document.createElement('option'), { value: val, textContent: label }));
  }
  source.value = settings.transcriptSource ?? 'caption';
  const sttModel = field('Model STT (mode audio)',
    Object.assign(document.createElement('input'), { value: settings.sttModel ?? 'nvidia/parakeet-ctc-1.1b-asr' }));
  const sttLanguage = field('Bahasa STT (mis. id, en — kosong = auto)',
    Object.assign(document.createElement('input'), { value: settings.sttLanguage ?? '' }));
```

> Catatan: `innerHTML: ''` di atas hanya mengosongkan `<select>` (bukan menyisipkan markup tak terpercaya); opsi ditambah via `createElement`/`textContent`. Aman.

Lalu di dalam handler `save.addEventListener('click', ...)`, pada objek `chrome.storage.local.set({ settings: {...} })`, tambahkan tiga field ini ke objek settings (pertahankan field existing `apiKey/baseUrl/model/momTemplate`):

```js
        transcriptSource: source.value,
        sttModel: sttModel.value.trim() || 'nvidia/parakeet-ctc-1.1b-asr',
        sttLanguage: sttLanguage.value.trim(),
```

- [ ] **Step 3: Verifikasi syntax**

Run: `node --check panel/panel.js`
Expected: exit 0.

- [ ] **Step 4: Verifikasi manual**

1. Reload extension, buka panel → Settings.
2. Expected: dropdown "Sumber transkrip" (Caption Meet / Rekam audio), field "Model STT", "Bahasa STT".
3. Set Sumber = Rekam audio, Bahasa = `id`, Simpan.
4. Console SW: `chrome.storage.local.get('settings', console.log)` → expected `transcriptSource:'audio'`, `sttModel:'nvidia/parakeet-ctc-1.1b-asr'`, `sttLanguage:'id'`, dan field lama (`apiKey/baseUrl/model/momTemplate`) tetap ada.

- [ ] **Step 5: Commit**

```bash
git add panel/panel.js
git commit -m "feat: settings for transcript source, STT model and language"
```

---

### Task 4: Offscreen document — capture, rekam, re-inject, chunk, transkrip

**Files:**
- Create: `offscreen/offscreen.html`
- Create: `offscreen/offscreen.js`
- Modify: `manifest.json` (permission `offscreen` + `tabCapture`)

**Interfaces:**
- Consumes: `globalThis.MeetStt.mergeSttChunks` (Task 1), `globalThis.MeetOpenAI.transcribeAudio` (Task 2); pesan `{target:'offscreen', op:'start'|'stop', ...}` (kontrak di Global Constraints).
- Produces: rekaman audio dari streamId; saat `stop` → transkrip tiap chunk → kirim `{type:'audio-transcript', meetingId, segments}` atau `{type:'audio-error', meetingId, error}` + `{type:'audio-progress', ...}` ke SW.

- [ ] **Step 1: Tambah permission di `manifest.json`**

Ubah baris `"permissions"` menjadi (tambah `tabCapture`, `offscreen`):

```json
  "permissions": ["sidePanel", "storage", "unlimitedStorage", "tabCapture", "offscreen"],
```

- [ ] **Step 2: Tulis `offscreen/offscreen.html`**

```html
<!doctype html>
<meta charset="utf-8">
<title>Meet Transcript offscreen</title>
<script src="../lib/stt.js"></script>
<script src="../lib/openai.js"></script>
<script src="offscreen.js"></script>
```

- [ ] **Step 3: Tulis `offscreen/offscreen.js`**

```js
// offscreen/offscreen.js — rekam audio tab (via streamId), putar balik ke
// speaker, potong per chunkMs, transkrip tiap chunk saat stop.
let audioCtx = null;
let stream = null;
let recorder = null;
let rotateTimer = null;
let chunkBlobs = [];   // Blob standalone per chunk
let chunkData = [];    // potongan dataavailable chunk berjalan
let cfg = null;        // {baseUrl, apiKey, sttModel, sttLanguage, chunkMs, baseTime, meetingId}
const MIME = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
  ? 'audio/webm;codecs=opus' : 'audio/webm';

function toSW(msg) { chrome.runtime.sendMessage(msg); }

function startChunkRecorder() {
  chunkData = [];
  recorder = new MediaRecorder(stream, { mimeType: MIME });
  recorder.ondataavailable = (e) => { if (e.data.size) chunkData.push(e.data); };
  recorder.onstop = () => { chunkBlobs.push(new Blob(chunkData, { type: MIME })); };
  recorder.start();
}

// Rotasi: stop recorder chunk ini (finalisasi Blob standalone) lalu mulai lagi.
function rotateChunk() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  startChunkRecorder();
}

async function start(msg) {
  cfg = msg;
  chunkBlobs = [];
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId } },
  });
  // Re-inject: tabCapture membisukan tab; putar balik ke speaker.
  audioCtx = new AudioContext();
  audioCtx.createMediaStreamSource(stream).connect(audioCtx.destination);
  startChunkRecorder();
  rotateTimer = setInterval(rotateChunk, msg.chunkMs);
}

async function stopAndTranscribe() {
  clearInterval(rotateTimer);
  rotateTimer = null;
  // Finalisasi chunk terakhir (tunggu onstop).
  await new Promise((resolve) => {
    if (!recorder || recorder.state === 'inactive') return resolve();
    recorder.addEventListener('stop', resolve, { once: true });
    recorder.stop();
  });
  stream?.getTracks().forEach((t) => t.stop());
  await audioCtx?.close().catch(() => {});
  audioCtx = null; stream = null; recorder = null;

  const results = [];
  for (let i = 0; i < chunkBlobs.length; i++) {
    toSW({ type: 'audio-progress', meetingId: cfg.meetingId, done: i, total: chunkBlobs.length });
    try {
      results.push(await globalThis.MeetOpenAI.transcribeAudio({
        blob: chunkBlobs[i], baseUrl: cfg.baseUrl, apiKey: cfg.apiKey,
        model: cfg.sttModel, language: cfg.sttLanguage,
      }));
    } catch (e) {
      results.push({ error: e.message });
    }
  }
  const segments = globalThis.MeetStt.mergeSttChunks(results, cfg.chunkMs, cfg.baseTime);
  chunkBlobs = [];
  toSW({ type: 'audio-transcript', meetingId: cfg.meetingId, segments });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  if (msg.op === 'start') {
    start(msg).catch((e) => toSW({ type: 'audio-error', meetingId: msg.meetingId, error: e.message }));
  } else if (msg.op === 'stop') {
    stopAndTranscribe().catch((e) => toSW({ type: 'audio-error', meetingId: cfg?.meetingId, error: e.message }));
  }
});
```

- [ ] **Step 4: Verifikasi syntax + JSON**

Run: `node --check offscreen/offscreen.js && python3 -m json.tool manifest.json > /dev/null && echo OK`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add offscreen/offscreen.html offscreen/offscreen.js manifest.json
git commit -m "feat: offscreen document records tab audio and transcribes chunks"
```

---

### Task 5: Service worker — orkestrasi rekam + simpan transkrip audio

**Files:**
- Modify: `background/service-worker.js`

**Interfaces:**
- Consumes: kontrak pesan (Global Constraints); `globalThis.MeetMerge.upsertSegment` (existing).
- Produces: handler `start-recording`/`stop-recording`; lifecycle offscreen; simpan `{type:'audio-transcript'}` ke `meeting.segments` (via writeChain) dengan `source:'audio'`; broadcast `rec-state`; `active.tabId` diisi dari `port.sender.tab.id`; badge REC menyala saat merekam audio.

- [ ] **Step 1: Simpan `tabId` dari port sender (hanya tab yang meng-klaim)**

Di `chrome.runtime.onConnect.addListener`, cabang `else if (msg.type === 'status') {`, tambahkan penyimpanan tabId SETELAH cek klaim supaya tab non-aktif tidak menimpa tabId. Cari baris `active = { ...active, id: msg.meetingId, inCall: msg.inCall, captionsOn: msg.captionsOn };` dan ubah menjadi:

```js
      active = { ...active, id: msg.meetingId, inCall: msg.inCall, captionsOn: msg.captionsOn,
        tabId: port.sender?.tab?.id ?? active.tabId };
```

(Baris ini hanya tercapai bila `canClaim` true — lihat `if (!canClaim) return;` di atasnya.)

- [ ] **Step 2: Tambah state rekam + helper offscreen (setelah blok `updateBadge`)**

```js
// Mode audio: state rekaman + lifecycle offscreen document.
let rec = { recording: false, transcribing: false, meetingId: null };

function broadcastRec(extra = {}) {
  notifyPanel({ type: 'rec-state', recording: rec.recording, transcribing: rec.transcribing, ...extra });
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Merekam audio tab Meet untuk transkrip.',
  });
}

async function startRecording({ streamId, meetingId }) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  await ensureOffscreen();
  rec = { recording: true, transcribing: false, meetingId };
  updateBadge();
  broadcastRec();
  chrome.runtime.sendMessage({
    target: 'offscreen', op: 'start', streamId, meetingId,
    baseUrl: settings.baseUrl, apiKey: settings.apiKey,
    sttModel: settings.sttModel || 'nvidia/parakeet-ctc-1.1b-asr',
    sttLanguage: settings.sttLanguage || '', chunkMs: 600000, baseTime: Date.now(),
  });
}

function stopRecording() {
  if (!rec.recording) return;
  rec.recording = false;
  rec.transcribing = true;
  updateBadge();
  broadcastRec();
  chrome.runtime.sendMessage({ target: 'offscreen', op: 'stop' });
}

async function saveAudioTranscript({ meetingId, segments }) {
  const key = 'meeting:' + meetingId;
  const data = await chrome.storage.local.get([key, 'meetings']);
  const meeting = data[key] ?? {
    id: meetingId, title: meetingId, startedAt: Date.now(), endedAt: null, segments: [], mom: null,
  };
  meeting.source = 'audio';
  for (const seg of segments) globalThis.MeetMerge.upsertSegment(meeting.segments,
    { ...seg, id: `audio:${seg.t}:${meeting.segments.length}` });
  const meetings = data.meetings ?? [];
  if (!meetings.includes(meetingId)) meetings.unshift(meetingId);
  await chrome.storage.local.set({ [key]: meeting, meetings });
  notifyPanel({ type: 'meeting-updated', id: meetingId });
}
```

> Catatan: `upsertSegment` butuh `id` unik; segmen STT tak punya, jadi diberi id sintetis `audio:<t>:<index>`.

- [ ] **Step 3: Badge menyala saat merekam audio**

Ubah fungsi `updateBadge` menjadi memperhitungkan rekaman audio:

```js
function updateBadge() {
  const recording = (active.inCall && active.captionsOn) || rec.recording;
  chrome.action.setBadgeText({ text: recording ? '●' : '' });
}
```

> `rec` dideklarasikan di Step 2 di ATAS `updateBadge`? Tidak — `updateBadge` sudah ada lebih awal. Karena deklarasi fungsi & `let rec` di-hoist/urut modul, pastikan `let rec = {...}` (Step 2) berada SEBELUM pemanggilan `updateBadge` pertama saat runtime. Aman: `updateBadge` hanya dipanggil dari handler (runtime), bukan saat load.

- [ ] **Step 4: Tambah handler pesan**

Di `chrome.runtime.onMessage.addListener`, tambahkan cabang berikut SEBELUM `return false;` default (setelah cabang `generate-mom`):

```js
  if (msg.type === 'start-recording') {
    startRecording(msg).catch((e) => broadcastRec({ error: e.message, recording: false }));
    return false;
  }
  if (msg.type === 'stop-recording') {
    stopRecording();
    return false;
  }
  if (msg.type === 'audio-progress') {
    broadcastRec({ done: msg.done, total: msg.total });
    return false;
  }
  if (msg.type === 'audio-transcript') {
    rec = { recording: false, transcribing: false, meetingId: null };
    updateBadge();
    enqueueWrite(() => saveAudioTranscript(msg));
    broadcastRec();
    chrome.offscreen.closeDocument?.().catch(() => {});
    return false;
  }
  if (msg.type === 'audio-error') {
    rec = { recording: false, transcribing: false, meetingId: null };
    updateBadge();
    broadcastRec({ error: msg.error });
    chrome.offscreen.closeDocument?.().catch(() => {});
    return false;
  }
```

- [ ] **Step 5: Sertakan `tabId` di respons `get-active`**

Handler `get-active` sudah `sendResponse(active)`; karena `active.tabId` kini diisi, tak perlu ubah. Verifikasi saja tak ada yang menimpa `active` tanpa `tabId` (endMeeting reset — itu benar, saat meeting berakhir tabId hilang).

- [ ] **Step 6: Verifikasi syntax**

Run: `node --check background/service-worker.js`
Expected: exit 0.

- [ ] **Step 7: Verifikasi test lain tak rusak**

Run: `node --test test/*.test.mjs`
Expected: `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add background/service-worker.js
git commit -m "feat: service worker orchestrates audio recording + transcript save"
```

---

### Task 6: Panel — UI rekam mode audio

**Files:**
- Modify: `panel/panel.js` (state atas + listener pesan + `renderMeeting`)

**Interfaces:**
- Consumes: `settings.transcriptSource`, `get-active` (`status.tabId`), broadcast `rec-state`.
- Produces: di tab Live saat `transcriptSource==='audio'`: tombol **Mulai rekam** / **Stop** + status transkrip; memanggil `chrome.tabCapture.getMediaStreamId` di gesture klik lalu kirim `start-recording`.

- [ ] **Step 1: Tambah state rekam + muat settings**

Di bagian atas `panel/panel.js`, setelah `let status = {...}` (baris 6), tambahkan:

```js
let recState = { recording: false, transcribing: false, done: 0, total: 0, error: null };
let settingsCache = {};
async function loadSettings() { settingsCache = (await chrome.storage.local.get('settings')).settings ?? {}; }
```

- [ ] **Step 2: Tangani broadcast `rec-state` + refresh settings**

Di `chrome.runtime.onMessage.addListener`, tambahkan cabang (di dalam listener yang sama):

```js
  else if (msg.type === 'rec-state') {
    recState = { recording: msg.recording, transcribing: msg.transcribing,
      done: msg.done ?? 0, total: msg.total ?? 0, error: msg.error ?? null };
    if (tab === 'live') render();
  }
```

Dan pada listener storage settings agar cache panel ikut terbarui — tambahkan di akhir file, sebelum IIFE init:

```js
chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && c.settings) { settingsCache = c.settings.newValue ?? {}; if (tab !== 'history') render(); }
});
```

- [ ] **Step 3: Panggil `loadSettings` saat init**

Ubah IIFE init di akhir file menjadi memuat settings dulu:

```js
(async () => {
  await loadSettings();
  const a = await chrome.runtime.sendMessage({ type: 'get-active' }).catch(() => null);
  if (a) status = a;
  render();
})();
```

- [ ] **Step 4: Render kontrol rekam di `renderMeeting` (mode audio)**

Di `renderMeeting`, tepat SETELAH `view.append(el('p', 'muted', new Date(meeting.startedAt).toLocaleString()));` (baris judul meeting) — TIDAK, kontrol harus muncul di Live walau belum ada meeting. Sebagai gantinya, di AWAL `renderMeeting` setelah guard epoch (`if (epoch !== renderEpoch) return;`) dan SEBELUM `if (!meeting)`, sisipkan blok mode-audio yang tampil saat `live`:

```js
  if (live && (settingsCache.transcriptSource === 'audio')) {
    const bar = el('div', 'actions');
    if (recState.transcribing) {
      bar.append(el('span', 'muted',
        recState.total ? `Mentranskrip… ${recState.done}/${recState.total}` : 'Mentranskrip…'));
    } else if (recState.recording) {
      const stop = el('button', null, 'Stop rekam');
      stop.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'stop-recording' }));
      bar.append(stop, el('span', 'muted', ' ● merekam'));
    } else {
      const startBtn = el('button', null, 'Mulai rekam');
      startBtn.addEventListener('click', () => startRecording(startBtn));
      bar.append(startBtn);
    }
    if (recState.error) bar.append(el('div', 'err', ' ' + recState.error));
    view.append(bar);
  }
```

- [ ] **Step 5: Fungsi `startRecording` (gesture → getMediaStreamId → SW)**

Tambahkan fungsi ini di `panel/panel.js` (mis. setelah `download()`):

```js
async function startRecording(btn) {
  btn.disabled = true;
  const tabId = status.tabId;
  if (!tabId) { recState = { ...recState, error: 'Tab Meet tidak terdeteksi. Join meeting dulu.' }; return render(); }
  try {
    // getMediaStreamId dipanggil di konteks gesture klik (wajib untuk tabCapture).
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await chrome.runtime.sendMessage({ type: 'start-recording', streamId, meetingId: status.id, tabId });
  } catch (e) {
    recState = { ...recState, error: 'Gagal mulai rekam: ' + e.message };
    render();
  }
}
```

- [ ] **Step 6: Verifikasi syntax**

Run: `node --check panel/panel.js`
Expected: exit 0.

- [ ] **Step 7: Verifikasi end-to-end (PERLU MEET ASLI + STT — minta user)**

1. Reload extension. Settings → Sumber transkrip = **Rekam audio**, Model STT & Bahasa terisi, Base URL + API key valid, Simpan.
2. Join Google Meet. Tab Live → expected tombol **Mulai rekam**.
3. Klik Mulai rekam → expected: badge ● menyala, status "● merekam", dan **kamu tetap mendengar audio meeting** (re-inject bekerja).
4. Bicara / putar audio ~30 detik. Klik **Stop rekam**.
5. Expected: status "Mentranskrip… k/N" → lalu transkrip muncul di panel (teks + waktu, tanpa nama pembicara).
6. Tab Riwayat → meeting tersimpan, `source:'audio'`; unduh .md berisi transkrip.
7. Bila STT gagal: pesan error jelas di panel; bila format audio ditolak → pesan "format audio tidak didukung" (lihat risiko #1 di spec — mungkin perlu ganti model STT).

- [ ] **Step 8: Commit**

```bash
git add panel/panel.js
git commit -m "feat: panel audio recording controls and status"
```

---

### Task 7: README + checklist mode audio

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: semua task sebelumnya.
- Produces: dokumentasi mode audio.

- [ ] **Step 1: Tambah bagian mode audio di `README.md`**

Sisipkan SEBELUM bagian `## Batasan v1`:

```markdown
## Mode transkrip audio (tanpa caption)

Alternatif bila tak ingin menyalakan caption Meet: rekam audio tab lalu
transkrip via STT.

1. Settings → **Sumber transkrip** = **Rekam audio**. Isi **Model STT**
   (mis. `nvidia/parakeet-ctc-1.1b-asr`) dan **Bahasa STT** (mis. `id`).
   Base URL & API key sama dengan MoM.
2. Join Meet → tab Live → **Mulai rekam** (audio meeting tetap terdengar).
3. **Stop rekam** → audio ditranskrip per potongan → transkrip muncul
   (teks + waktu, tanpa nama pembicara). Audio tidak disimpan.

Catatan: transkrip baru muncul setelah Stop (bukan live). Hanya audio tab
(peserta) yang direkam, mic sendiri tidak.
```

- [ ] **Step 2: Update bagian deskripsi batasan bila perlu**

Pastikan bagian `## Batasan v1` existing tidak bertentangan; mode audio adalah tambahan opsional, mode caption tetap default. Tak perlu ubah bila sudah konsisten.

- [ ] **Step 3: Jalankan seluruh unit test**

Run: `node --test test/*.test.mjs`
Expected: `# fail 0` (merge + openai + stt).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README audio transcription mode"
```
```

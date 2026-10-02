// Kabel pesan service worker: pemulihan state rekaman saat SW bangun lagi
// (recRestored) dan penerusan "nyalakan mikrofon" ke dokumen offscreen.
// Diuji lewat SW yang SUNGGUHAN dimuat di atas stub `chrome`, bukan tiruan
// logikanya: yang rusak di dua fitur ini justru kabelnya — get-active yang
// membalas sebelum pemulihan selesai, dan pesan yang nyasar ke dokumen yang
// tidak ada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../background/service-worker.js', import.meta.url), 'utf8');

// `offscreen` null = dokumen offscreen tidak ada (mati / belum pernah dibuat).
function loadSw({ offscreen, recordings = [] }) {
  const sent = [];
  let badge = null;
  const chrome = {
    action: {
      setBadgeBackgroundColor() {}, setBadgeTextColor() {},
      setBadgeText(o) { badge = o.text; },
    },
    runtime: {
      onMessage: { addListener: (f) => handlers.push(f) },
      onConnect: { addListener() {} },
      onInstalled: { addListener() {} },
      getContexts: async () => (offscreen ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []),
      async sendMessage(msg) {
        sent.push(msg);
        if (msg.target !== 'offscreen') return undefined; // panel tertutup
        if (!offscreen) throw new Error('Could not establish connection.');
        return msg.op === 'state' ? { ok: true, ...offscreen } : { ok: true };
      },
      getURL: (p) => p,
    },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    offscreen: { closeDocument: async () => {} },
  };
  const handlers = [];
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
  // Kirim pesan seperti Chrome: listener yang return true membalas async.
  const ask = (msg) => new Promise((resolve) => {
    for (const f of handlers) if (f(msg, {}, resolve) === true) return;
    resolve(undefined);
  });
  return { ask, sent, badge: () => badge };
}

// Handler yang tidak membalas mengerjakan sisanya di promise lepas — satu
// macrotask cukup untuk menguras microtask-nya.
const flush = () => new Promise((r) => setTimeout(r, 0));

test('get-active memulihkan rekaman yang masih jalan di offscreen', async () => {
  const sw = loadSw({ offscreen: { recording: true, transcribing: false, meetingId: 'discord-1-2' } });
  const a = await sw.ask({ type: 'get-active' });
  assert.deepEqual({ ...a.rec }, { recording: true, transcribing: false, meetingId: 'discord-1-2' });
  assert.equal(sw.badge(), '●');
  assert.ok(sw.sent.some((m) => m.target === 'offscreen' && m.op === 'state'));
});

test('transkrip yang masih jalan ikut dipulihkan', async () => {
  const sw = loadSw({ offscreen: { recording: false, transcribing: true, meetingId: 'abc-defg-hij' } });
  const a = await sw.ask({ type: 'get-active' });
  assert.deepEqual({ ...a.rec }, { recording: false, transcribing: true, meetingId: 'abc-defg-hij' });
});

test('tanpa dokumen offscreen, rec tetap kosong', async () => {
  const sw = loadSw({ offscreen: null });
  const a = await sw.ask({ type: 'get-active' });
  assert.deepEqual({ ...a.rec }, { recording: false, transcribing: false, meetingId: null });
  // Tidak ada dokumen → jangan kirim pesan ke offscreen sama sekali.
  assert.ok(!sw.sent.some((m) => m.target === 'offscreen'));
});

test('offscreen yang idle tidak memalsukan rekaman', async () => {
  const sw = loadSw({ offscreen: { recording: false, transcribing: false, meetingId: null } });
  const a = await sw.ask({ type: 'get-active' });
  assert.deepEqual({ ...a.rec }, { recording: false, transcribing: false, meetingId: null });
  assert.equal(sw.badge(), null); // badge tak disentuh
});

test('enable-mic diteruskan ke offscreen saat rekaman jalan', async () => {
  const sw = loadSw({ offscreen: { recording: true, transcribing: false, meetingId: 'discord-1-2' } });
  await sw.ask({ type: 'enable-mic' });
  await flush();
  assert.ok(sw.sent.some((m) => m.target === 'offscreen' && m.op === 'mic-enable'));
});

test('tanpa dokumen offscreen, enable-mic tidak dikirim ke mana pun', async () => {
  // settings.mic yang sudah ditulis popup sudah cukup: rekaman berikutnya
  // membacanya lewat sttConfig(). Mengirim pesan ke dokumen yang tak ada hanya
  // melahirkan unhandled rejection.
  const sw = loadSw({ offscreen: null });
  await sw.ask({ type: 'enable-mic' });
  await flush();
  assert.ok(!sw.sent.some((m) => m.op === 'mic-enable'));
});

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

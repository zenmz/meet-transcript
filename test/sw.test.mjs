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
function loadSw({ offscreen }) {
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
  vm.runInContext(SRC, vm.createContext({ chrome, console, URL }));
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

// Kabel pesan service worker: pemulihan state rekaman saat SW bangun lagi
// (recRestored), penerusan "nyalakan mikrofon" ke dokumen offscreen, dan
// pengenalan URL ruang meeting. Diuji lewat SW yang SUNGGUHAN dimuat di atas
// stub `chrome`, bukan tiruan logikanya: yang rusak di fitur-fitur ini justru
// kabelnya — get-active yang membalas sebelum pemulihan selesai, dan pesan yang
// nyasar ke dokumen yang tidak ada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../background/service-worker.js', import.meta.url), 'utf8');

// `offscreen` null = dokumen offscreen tidak ada (mati / belum pernah dibuat).
function loadSw({ offscreen, recordings = [], store = {} }) {
  const sent = [];
  let badge = null;
  const chrome = {
    action: {
      setBadgeBackgroundColor() {}, setBadgeTextColor() {},
      setBadgeText(o) { badge = o.text; },
    },
    runtime: {
      onMessage: { addListener: (f) => handlers.push(f) },
      onConnect: { addListener: (f) => connects.push(f) },
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
    // Storage di memori: endMeeting/ensureMeeting membaca-menulis record sungguhan.
    storage: { local: {
      get: async (keys) => {
        const out = {};
        for (const k of keys == null ? Object.keys(store) : [].concat(keys)) {
          if (k in store) out[k] = structuredClone(store[k]);
        }
        return out;
      },
      set: async (o) => { Object.assign(store, structuredClone(o)); },
      remove: async (k) => { for (const x of [].concat(k)) delete store[x]; },
    } },
    offscreen: { closeDocument: async () => {} },
  };
  const handlers = [];
  const connects = [];
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
  // meetingIdFromUrl ikut dibuka: deklarasi `function` di top-level sebuah
  // classic script menempel ke global konteks vm, beda dari `const` yang
  // tinggal di scope deklaratif script-nya.
  // Port caption tiruan dari tab `tabId`, seperti content/captions.js.
  const connect = (tabId) => {
    const port = { name: 'captions', sender: { tab: { id: tabId } }, msgFns: [], discFns: [],
      onMessage: { addListener: (f) => port.msgFns.push(f) },
      onDisconnect: { addListener: (f) => port.discFns.push(f) } };
    for (const f of connects) f(port);
    return { send: (m) => port.msgFns.forEach((f) => f(m)), disconnect: () => port.discFns.forEach((f) => f()) };
  };
  return { ask, sent, store, connect, badge: () => badge, meetingIdFromUrl: ctx.meetingIdFromUrl,
    autoTranscribe: ctx.autoTranscribe };
}

// GERBANG TUNGGAL seluruh fitur rekam: URL yang tak dikenalinya ditolak
// startFromTab, jadi pola yang salah membuat tombol Rekam tak pernah aktif
// tanpa petunjuk apa pun — kegagalan paling senyap yang bisa dimiliki fitur ini.
const idOf = loadSw({ offscreen: null }).meetingIdFromUrl;

// Handler yang tidak membalas mengerjakan sisanya di promise lepas — satu
// macrotask cukup untuk menguras microtask-nya.
const flush = () => new Promise((r) => setTimeout(r, 0));

test('get-active memulihkan rekaman yang masih jalan di offscreen', async () => {
  const sw = loadSw({ offscreen: { recording: true, transcribing: false, meetingId: 'discord-1-2',
    tabId: 42, autoStt: false } });
  const a = await sw.ask({ type: 'get-active' });
  // tabId ikut dipulihkan: tanpanya penutup sesi caption tak bisa membedakan
  // tab yang direkam dari tab lain di ruang yang sama.
  assert.deepEqual({ ...a.rec },
    { recording: true, transcribing: false, meetingId: 'discord-1-2', tabId: 42, autoStt: false });
  assert.equal(sw.badge(), '●');
  assert.ok(sw.sent.some((m) => m.target === 'offscreen' && m.op === 'state'));
});

test('transkrip yang masih jalan ikut dipulihkan', async () => {
  const sw = loadSw({ offscreen: { recording: false, transcribing: true, meetingId: 'abc-defg-hij',
    tabId: null, autoStt: true } });
  const a = await sw.ask({ type: 'get-active' });
  assert.deepEqual({ ...a.rec },
    { recording: false, transcribing: true, meetingId: 'abc-defg-hij', tabId: null, autoStt: true });
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

// STT otomatis hanya untuk Meet bermode audio. Selain itu rekaman adalah arsip:
// STT otomatis di sana cuma menambah baris "[transkrip gagal]" (endpoint tak
// disiapkan) — user menjalankan "Generate transkrip" sendiri dari Riwayat.
test('STT otomatis hanya untuk Meet bermode audio', () => {
  const { autoTranscribe } = loadSw({ offscreen: null });
  const meet = idOf('https://meet.google.com/abc-defg-hij');
  assert.equal(autoTranscribe(meet, 'caption'), false);
  assert.equal(autoTranscribe(meet, 'audio'), true);
  assert.equal(autoTranscribe(idOf('https://discord.com/channels/123/456'), 'audio'), false);
  assert.equal(autoTranscribe(idOf('https://zoom.us/wc/84787201766/join'), 'audio'), false);
});

// Stop memasang transcribing:true. Tanpa jawaban audio-saved, rekaman
// tanpa STT membuat status "Mentranskrip…" macet dan start berikutnya ditolak.
test('audio-saved melepas status transkrip', async () => {
  const sw = loadSw({ offscreen: { recording: false, transcribing: true, meetingId: 'abc-defg-hij' } });
  assert.equal((await sw.ask({ type: 'get-active' })).rec.transcribing, true);
  await sw.ask({ type: 'audio-saved', meetingId: 'abc-defg-hij' });
  const a = await sw.ask({ type: 'get-active' });
  assert.deepEqual({ ...a.rec }, { recording: false, transcribing: false, meetingId: null });
  assert.equal(sw.badge(), '');
});

// Peringatan siklus ini (potongan terakhir gagal, belum ada suara) adalah
// satu-satunya kabar bahwa arsip cacat — audio-saved tak boleh menghapusnya.
test('audio-saved tidak menghapus peringatan rekaman', async () => {
  const sw = loadSw({ offscreen: { recording: false, transcribing: true, meetingId: 'discord-1-2' } });
  await sw.ask({ type: 'get-active' });
  await sw.ask({ type: 'audio-saved', meetingId: 'discord-1-2' });
  const last = sw.sent.filter((m) => m.type === 'rec-state').at(-1);
  assert.equal(last.transcribing, false);
  assert.ok(!('error' in last));
});

// Platform tanpa content script tak pernah mendapat endedAt dari port caption;
// tanpa penanda ini sesi berikutnya di channel yang sama menumpuk ke record ini.
test('audio-saved menandai selesai record non-Meet, bukan Meet', async () => {
  const store = {
    'meeting:discord-1-2': { id: 'discord-1-2', startedAt: 1, endedAt: null, segments: [] },
    'meeting:abc-defg-hij': { id: 'abc-defg-hij', startedAt: 1, endedAt: null, segments: [] },
  };
  const sw = loadSw({ offscreen: null, store });
  await sw.ask({ type: 'audio-saved', meetingId: 'discord-1-2' });
  await sw.ask({ type: 'audio-saved', meetingId: 'abc-defg-hij' });
  await flush(); await flush();
  assert.equal(typeof sw.store['meeting:discord-1-2'].endedAt, 'number');
  // Meet ditutup oleh port caption saat user keluar — bukan saat Stop rekam.
  assert.equal(sw.store['meeting:abc-defg-hij'].endedAt, null);
});

// Tab B ikut join ruang yang sama lalu ditutup: rekaman di tab A jalan terus.
test('menutup tab lain di ruang yang sama tidak menghentikan rekaman', async () => {
  const sw = loadSw({ offscreen: { recording: true, transcribing: false, meetingId: 'abc-defg-hij', tabId: 1 } });
  await sw.ask({ type: 'get-active' });
  const b = sw.connect(2);
  b.send({ type: 'status', meetingId: 'abc-defg-hij', inCall: true, captionsOn: false });
  b.disconnect();
  await flush();
  assert.ok(!sw.sent.some((m) => m.op === 'stop'));
  const a = sw.connect(1);
  a.send({ type: 'status', meetingId: 'abc-defg-hij', inCall: true, captionsOn: false });
  a.disconnect();
  await flush();
  assert.ok(sw.sent.some((m) => m.op === 'stop'));
});

// Dua ruang in-call bersamaan: tab yang lebih dulu memegang status Live, tab
// lain tak menggusurnya tiap tick.
test('tab in-call kedua tidak merebut status meeting aktif', async () => {
  const sw = loadSw({ offscreen: null });
  const a = sw.connect(1);
  const b = sw.connect(2);
  a.send({ type: 'status', meetingId: 'aaa-aaaa-aaa', inCall: true, captionsOn: true });
  b.send({ type: 'status', meetingId: 'bbb-bbbb-bbb', inCall: true, captionsOn: false });
  a.send({ type: 'status', meetingId: 'aaa-aaaa-aaa', inCall: true, captionsOn: true });
  b.send({ type: 'status', meetingId: 'bbb-bbbb-bbb', inCall: true, captionsOn: false });
  assert.equal((await sw.ask({ type: 'get-active' })).id, 'aaa-aaaa-aaa');
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

test('Zoom web: tiga bentuk URL /wc/ yang dilayani Zoom', () => {
  // Bentuk sekarang, join dan start.
  assert.equal(idOf('https://zoom.us/wc/8412345678/join'), 'zoom-8412345678');
  assert.equal(idOf('https://zoom.us/wc/8412345678/start'), 'zoom-8412345678');
  // Bentuk lama, masih dilayani.
  assert.equal(idOf('https://zoom.us/wc/join/8412345678'), 'zoom-8412345678');
  // Querystring memuat nama tampilan & token sekali pakai — bukan bagian id.
  assert.equal(idOf('https://zoom.us/wc/8412345678/join?prefer=1&un=cmlvbg=='),
    'zoom-8412345678');
});

test('Zoom web: app.zoom.us dan subdomain vanity ikut dikenali', () => {
  assert.equal(idOf('https://app.zoom.us/wc/8412345678/start'), 'zoom-8412345678');
  assert.equal(idOf('https://dlabs.zoom.us/wc/join/8412345678'), 'zoom-8412345678');
});

test('Zoom: halaman non-meeting dan host lain ditolak', () => {
  // Tanpa /wc/ bukan web client — tombol Rekam tak boleh aktif di halaman harga.
  assert.equal(idOf('https://zoom.us/pricing'), null);
  assert.equal(idOf('https://zoom.us/j/8412345678'), null); // link launcher app
  assert.equal(idOf('https://zoom.us/wc/join/'), null);     // tanpa angka
  // Zoom for Government: host berbeda, sengaja di luar cakupan.
  assert.equal(idOf('https://zoomgov.com/wc/8412345678/join'), null);
  // Jangan tertipu domain yang sekadar BERAKHIRAN mirip.
  assert.equal(idOf('https://notzoom.us.evil.com/wc/8412345678/join'), null);
});

test('Meet & Discord tetap dikenali setelah cabang Zoom disisipkan', () => {
  // Proteksi regresi: cabang Zoom masuk di tengah fungsi yang sama.
  assert.equal(idOf('https://meet.google.com/abc-defg-hij'), 'abc-defg-hij');
  assert.equal(idOf('https://discord.com/channels/123/456'), 'discord-123-456');
  assert.equal(idOf('https://discord.com/channels/@me/456'), 'discord-dm-456');
  assert.equal(idOf('https://meet.google.com/landing'), null);
  assert.equal(idOf(undefined), null);
});

// Bentuk /meet/<kode> dilihat di browser tim — dulu ditolak, tombol Rekam mati.
// Id-nya harus kode saja: kalau beda dari /<kode>, caption & rekaman ruang yang
// sama pecah ke dua record.
test('Meet: /meet/<kode> dan /_meet/<kode> dikenali sebagai ruang yang sama', () => {
  assert.equal(idOf('https://meet.google.com/meet/rek-rore-iwm'), 'rek-rore-iwm');
  assert.equal(idOf('https://meet.google.com/meet/rek-rore-iwm?authuser=1'), 'rek-rore-iwm');
  assert.equal(idOf('https://meet.google.com/meet/'), null);
  assert.equal(idOf('https://meet.google.com/other/rek-rore-iwm'), null);
  // /_meet/<kode> dilayani Meet tanpa redirect (dicek 2026-10-22).
  assert.equal(idOf('https://meet.google.com/_meet/rek-rore-iwm'), 'rek-rore-iwm');
});

// Dulu cabang Meet adalah jatuhan untuk host APA PUN: halaman sembarang yang
// path-nya kebetulan berbentuk kode ruang ikut dianggap ruang Meet.
test('Meet: kode ruang di domain lain bukan Meet', () => {
  assert.equal(idOf('https://example.com/abc-defg-hij'), null);
  assert.equal(idOf('https://teams.microsoft.com/abc-defg-hij'), null);
});

const TOKEN = 'MWNmNTVhN2ItYTA1YS00YzI1LTg3MmItZjgxYTIyYjhhNGIw';

// Id thread yang sama harus keluar dari ketiga tempat Teams menaruhnya —
// hash web client, path undangan ter-encode, dan query launcher dua lapis.
test('Teams: id thread rapat dari hash, path undangan, dan launcher', () => {
  const want = `teams-${TOKEN}`;
  assert.equal(idOf(`https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19:meeting_${TOKEN}@thread.v2/0?context=%7b%7d&anon=true`), want);
  assert.equal(idOf(`https://teams.microsoft.com/l/meetup-join/19%3ameeting_${TOKEN}%40thread.v2/0?context=%7b%22Tid%22%7d`), want);
  assert.equal(idOf(`https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fl%2Fmeetup-join%2F19%3Ameeting_${TOKEN}%40thread.v2%2F0%3Fcontext%3D%257b%257d&type=meetup-join`), want);
  assert.equal(idOf(`https://teams.cloud.microsoft/v2/#/l/meetup-join/19:meeting_${TOKEN}@thread.v2/0`), want);
});

test('Teams: link pendek /meet/<angka> di domain kerja & pribadi', () => {
  assert.equal(idOf('https://teams.microsoft.com/meet/2345678901234?p=AbCdEf'), 'teams-2345678901234');
  assert.equal(idOf('https://teams.live.com/meet/9345678901234?p=XyZ'), 'teams-9345678901234');
});

test('Teams: halaman tanpa id rapat dan domain tiruan ditolak', () => {
  assert.equal(idOf('https://teams.microsoft.com/v2/'), null);
  assert.equal(idOf('https://teams.microsoft.com/v2/#/calendarv2'), null);
  assert.equal(idOf(`https://teams.microsoft.com.evil.com/v2/#/l/meetup-join/19:meeting_${TOKEN}@thread.v2/0`), null);
  // URI rusak tidak boleh melempar keluar dari meetingIdFromUrl.
  assert.equal(idOf('https://teams.microsoft.com/v2/#/%E0%A4%A'), null);
});

const HEX = 'cb176734e58f4e2aa88f39694dc3c9a3';
const MTID = 'db62852d3a1e984e0ce1f68e9f610562';

// MTID didahulukan: halaman joinservice membawa DUA hex (path + MTID), dan
// link undangan j.php hanya membawa MTID — keduanya harus berakhir di id sama.
test('Webex: MTID didahulukan, lalu hex di path', () => {
  assert.equal(idOf(`https://illinois.webex.com/wbxmjs/joinservice/sites/illinois/meeting/download/${HEX}?MTID=m${MTID}`), `webex-${MTID}`);
  assert.equal(idOf(`https://acme.webex.com/acme/j.php?MTID=m${MTID.toUpperCase()}`), `webex-${MTID}`);
  assert.equal(idOf(`https://acme.webex.com/wbxmjs/joinservice/sites/acme/meeting/download/${HEX}`), `webex-${HEX}`);
});

test('Webex: personal room per situs, halaman lain ditolak', () => {
  assert.equal(idOf('https://acme.webex.com/meet/John.Doe'), 'webex-acme-john.doe');
  assert.equal(idOf('https://acme.webex.com/join/jdoe'), 'webex-acme-jdoe');
  assert.equal(idOf('https://acme.webex.com/webappng/sites/acme/dashboard'), null);
  assert.equal(idOf(`https://webex.com.evil.com/meet/jdoe`), null);
});

// Jendela huddle dan tampilan channel menunjuk huddle yang sama → id sama.
test('Slack: huddle dan channel memberi id yang sama', () => {
  assert.equal(idOf('https://app.slack.com/huddle/T019QHUBYQ3/C034CBLMQ9G'), 'slack-T019QHUBYQ3-C034CBLMQ9G');
  assert.equal(idOf('https://app.slack.com/client/T019QHUBYQ3/C034CBLMQ9G'), 'slack-T019QHUBYQ3-C034CBLMQ9G');
  assert.equal(idOf('https://app.slack.com/client/T019QHUBYQ3/C034CBLMQ9G/thread/C034CBLMQ9G-1712345678.000100'),
    'slack-T019QHUBYQ3-C034CBLMQ9G');
  assert.equal(idOf('https://app.slack.com/client/E030G10V24F/D04ABCDEF12'), 'slack-E030G10V24F-D04ABCDEF12');
});

test('Slack: halaman tanpa channel ditolak', () => {
  assert.equal(idOf('https://app.slack.com/client/T019QHUBYQ3/unreads'), null);
  assert.equal(idOf('https://app.slack.com/client/E030G10V24F/dms'), null);
  assert.equal(idOf('https://slack.com/huddle/T019QHUBYQ3/C034CBLMQ9G'), null);
});

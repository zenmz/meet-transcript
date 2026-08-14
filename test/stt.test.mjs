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

const { sttMode, sttEndpoint, WHISPER_DEFAULT, DEFAULT_LANGUAGE } = globalThis.MeetStt;

test('sttMode: settings kosong (instalasi baru) → whisper-local', () => {
  assert.equal(sttMode({}), 'whisper-local');
  assert.equal(sttMode(), 'whisper-local');
});

test('sttMode: sttMode tersimpan menang atas tebakan apa pun', () => {
  assert.equal(sttMode({ sttMode: 'api', apiKey: '' }), 'api');
});

// Mode 'browser' sudah dihapus. Settings lama yang masih menyimpannya harus
// jatuh ke aturan penurunan, bukan bocor keluar sebagai mode yang tak dikenal
// offscreen (transkrip diam-diam dikirim entah ke mana / gagal tanpa pesan).
test('sttMode migrasi: sttMode browser tersimpan → diturunkan ulang', () => {
  assert.equal(sttMode({ sttMode: 'browser' }), 'whisper-local');
  assert.equal(sttMode({ sttMode: 'browser', sttBaseUrl: 'http://localhost:8080/v1' }), 'whisper-local');
  assert.equal(sttMode({ sttMode: 'browser', sttBaseUrl: 'https://api.openai.com/v1' }), 'api');
  assert.equal(sttMode({ sttMode: 'browser', apiKey: 'k' }), 'api');
});

test('sttEndpoint: settings browser lama → mode http, bukan browser', () => {
  const r = sttEndpoint({ sttMode: 'browser', sttBrowserModel: 'Xenova/whisper-small' });
  assert.equal(r.mode, 'http');
  assert.equal(r.baseUrl, WHISPER_DEFAULT);
});

test('sttMode migrasi: sttBaseUrl lokal → whisper-local (port apa pun)', () => {
  assert.equal(sttMode({ sttBaseUrl: 'http://localhost:8080/v1' }), 'whisper-local');
  assert.equal(sttMode({ sttBaseUrl: 'http://127.0.0.1:9000/v1' }), 'whisper-local');
});

test('sttMode migrasi: sttBaseUrl remote / rusak → api', () => {
  assert.equal(sttMode({ sttBaseUrl: 'https://api.openai.com/v1' }), 'api');
  assert.equal(sttMode({ sttBaseUrl: 'bukan url' }), 'api');
});

test('sttMode migrasi: mode chat lama (endpoint chat terisi) → api, bukan whisper', () => {
  // Settings lama tanpa sttBaseUrl memakai endpoint chat. 'api' punya fallback
  // yang sama, jadi user lama tidak tiba-tiba diarahkan ke localhost.
  assert.equal(sttMode({ apiKey: 'k' }), 'api');
  assert.equal(sttMode({ baseUrl: 'https://x/v1' }), 'api');
});

test('sttEndpoint whisper-local: URL kosong → default localhost, apiKey chat TIDAK ikut', () => {
  assert.deepEqual(
    sttEndpoint({ sttMode: 'whisper-local', baseUrl: 'https://x/v1', apiKey: 'k' }),
    { mode: 'http', baseUrl: WHISPER_DEFAULT, apiKey: '', model: 'whisper-1', language: DEFAULT_LANGUAGE });
});

test('sttEndpoint api: sttBaseUrl terisi → apiKey utama TIDAK ikut', () => {
  const r = sttEndpoint({ sttMode: 'api', baseUrl: 'https://x/v1', apiKey: 'k', sttBaseUrl: 'http://localhost:20128/v1' });
  assert.equal(r.baseUrl, 'http://localhost:20128/v1');
  assert.equal(r.apiKey, '');
});

test('sttEndpoint api: sttBaseUrl + sttApiKey terisi → dua-duanya dipakai', () => {
  const r = sttEndpoint({ sttMode: 'api', baseUrl: 'https://x/v1', apiKey: 'k', sttBaseUrl: 'http://localhost:20128/v1', sttApiKey: 's' });
  assert.equal(r.baseUrl, 'http://localhost:20128/v1');
  assert.equal(r.apiKey, 's');
});

test('sttEndpoint api: STT fields kosong → jatuh ke endpoint chat (perilaku lama)', () => {
  const r = sttEndpoint({ sttMode: 'api', baseUrl: 'https://x/v1', apiKey: 'k' });
  assert.equal(r.baseUrl, 'https://x/v1');
  assert.equal(r.apiKey, 'k');
});

test('sttEndpoint: bahasa default Indonesia, tapi string kosong tersimpan = auto', () => {
  assert.equal(sttEndpoint({ sttMode: 'api' }).language, 'id');
  // ?? bukan ||: user yang sengaja mengosongkan field minta auto-detect.
  assert.equal(sttEndpoint({ sttMode: 'api', sttLanguage: '' }).language, '');
  assert.equal(sttEndpoint({ sttMode: 'api', sttLanguage: 'en' }).language, 'en');
});

// Sebagian server mengirim {text:"…",segments:[]}. Mendahulukan array kosong
// membuang teks yang sebenarnya ada, dan potongan itu jadi lubang senyap.
test('parseSttResponse: segments kosong jatuh ke {text}, bukan dibuang', () => {
  assert.deepEqual(parseSttResponse('{"text":"halo dunia","segments":[]}'),
    { segments: [{ start: 0, text: 'halo dunia' }] });
});

// Sebagian proxy OpenAI-compatible membalas HTTP 200 dengan body error.
test('parseSttResponse: body {error} jadi penanda gagal, bukan segmen kosong', () => {
  assert.deepEqual(parseSttResponse('{"error":{"message":"model tidak ada"}}'),
    { error: 'model tidak ada' });
  const merged = mergeSttChunks([parseSttResponse('{"error":{"message":"x"}}')], 1000, 0);
  assert.deepEqual(merged.map((s) => s.text), ['[transkrip gagal]']);
});

// Potongan yang gagal tersimpan meninggalkan nomor bolong. Tanpa indeks asli,
// semua potongan sesudahnya ditimestamp satu slot (10 menit) terlalu awal.
test('mergeSttChunks memakai indeks asli potongan saat ada yang bolong', () => {
  const r = [{ segments: [{ start: 0, text: 'satu' }] }, { segments: [{ start: 0, text: 'tiga' }] }];
  assert.deepEqual(mergeSttChunks(r, 600000, 0, [0, 2]).map((s) => s.t), [0, 1200000]);
  // tanpa indices, perilaku lama (berurutan) dipertahankan
  assert.deepEqual(mergeSttChunks(r, 600000, 0).map((s) => s.t), [0, 600000]);
});

// {text:""} bukan hasil — kalau ia menang atas body error, potongan yang gagal
// jadi lubang senyap alih-alih penanda "[transkrip gagal]".
test('parseSttResponse: text kosong tidak menang atas body error', () => {
  assert.deepEqual(parseSttResponse('{"text":"   ","error":{"message":"model mati"}}'),
    { error: 'model mati' });
  assert.deepEqual(parseSttResponse('{"text":""}'), { segments: [] });
});

// Segmen yang sah menang atas field error/warning yang menempel di body yang sama.
test('parseSttResponse: segmen sah menang atas field error yang menempel', () => {
  assert.deepEqual(parseSttResponse('{"segments":[{"start":0,"text":"halo"}],"error":{"message":"warn"}}'),
    { segments: [{ start: 0, text: 'halo' }] });
});

// Bentuk error tanpa `message` tidak boleh jadi "[object Object]".
test('parseSttResponse: error tanpa message tetap terbaca', () => {
  assert.deepEqual(parseSttResponse('{"error":{"code":500}}'), { error: '{"code":500}' });
});

// indices yang panjangnya tidak sama = pemanggil salah pasang. Memakainya
// per-elemen menabrakkan dua potongan ke timestamp yang sama, diam-diam.
test('mergeSttChunks mengabaikan indices yang panjangnya tidak sepadan', () => {
  const r = [{ segments: [{ start: 0, text: 'a' }] }, { segments: [{ start: 0, text: 'b' }] },
    { segments: [{ start: 0, text: 'c' }] }];
  assert.deepEqual(mergeSttChunks(r, 600000, 0, [0, 2]).map((s) => s.t), [0, 600000, 1200000]);
});

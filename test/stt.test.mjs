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

test('sttMode: kosong/undefined → chat', () => {
  assert.equal(globalThis.MeetStt.sttMode(''), 'chat');
  assert.equal(globalThis.MeetStt.sttMode(undefined), 'chat');
  assert.equal(globalThis.MeetStt.sttMode('   '), 'chat');
});

test('sttMode: host lokal → whisper (port apa pun)', () => {
  assert.equal(globalThis.MeetStt.sttMode('http://localhost:8080/v1'), 'whisper');
  assert.equal(globalThis.MeetStt.sttMode('http://127.0.0.1:9000/v1'), 'whisper');
  assert.equal(globalThis.MeetStt.sttMode(globalThis.MeetStt.WHISPER_DEFAULT), 'whisper');
});

test('sttMode: host remote / URL rusak → api', () => {
  assert.equal(globalThis.MeetStt.sttMode('https://api.openai.com/v1'), 'api');
  assert.equal(globalThis.MeetStt.sttMode('bukan url'), 'api');
});

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

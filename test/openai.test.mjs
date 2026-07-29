import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/openai.js'); // classic script: set globalThis.MeetOpenAI
const { extractContent, errorFromBody, generateMoM } = globalThis.MeetOpenAI;

test('JSON tunggal biasa', () => {
  const raw = JSON.stringify({ choices: [{ message: { content: 'halo' } }] });
  assert.equal(extractContent(raw), 'halo');
});

test('JSON diikuti terminator SSE "data: [DONE]" (format 9Router)', () => {
  const raw = JSON.stringify({ choices: [{ message: { content: 'halo' } }] }) + 'data: [DONE]';
  assert.equal(extractContent(raw), 'halo');
});

test('JSON + "\\ndata: [DONE]" dengan whitespace', () => {
  const raw = JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) + '\n\ndata: [DONE]\n';
  assert.equal(extractContent(raw), 'ok');
});

test('SSE stream: gabungkan delta antar baris', () => {
  const raw = [
    'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ha' } }] }),
    'data: ' + JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
    'data: [DONE]',
  ].join('\n');
  assert.equal(extractContent(raw), 'halo');
});

test('SSE dengan baris tak lengkap dilewati, tidak throw', () => {
  const raw = [
    'data: ' + JSON.stringify({ choices: [{ delta: { content: 'a' } }] }),
    'data: {rusak',
    'data: ' + JSON.stringify({ choices: [{ delta: { content: 'b' } }] }),
    'data: [DONE]',
  ].join('\n');
  assert.equal(extractContent(raw), 'ab');
});

// Sebagian proxy membalas HTTP 200 dengan body error. Tanpa ini pesan server
// yang sebenarnya dibuang dan yang tersisa cuma "Respons kosong dari server."
test('errorFromBody mengambil pesan error dari body 200', () => {
  assert.equal(errorFromBody('{"error":{"message":"model tidak ada"}}'), 'model tidak ada');
  assert.equal(errorFromBody('{"error":"kuota habis"}'), 'kuota habis');
  assert.equal(errorFromBody('{"choices":[]}'), null);
  assert.equal(errorFromBody('bukan json'), null);
  assert.equal(errorFromBody(''), null);
});

// Menguji PENYAMBUNGANNYA, bukan cuma errorFromBody: bug-nya ada di chat(),
// yang membuang pesan server dan melaporkan "Respons kosong dari server."
async function denganFetch(balasan, fn) {
  const asli = globalThis.fetch;
  globalThis.fetch = async () => balasan();
  try { return await fn(); } finally { globalThis.fetch = asli; }
}

test('chat: body error di HTTP 200 melaporkan pesan server, bukan "Respons kosong"', async () => {
  await denganFetch(
    () => new Response('{"error":{"message":"model tidak ada"}}', { status: 200 }),
    () => assert.rejects(
      () => generateMoM({ apiKey: 'k', model: 'm', prompt: 'p', baseUrl: 'https://x.test/v1' }),
      /model tidak ada/));
});

test('chat: body 200 tanpa content dan tanpa error tetap "Respons kosong"', async () => {
  await denganFetch(
    () => new Response('{"choices":[]}', { status: 200 }),
    () => assert.rejects(
      () => generateMoM({ apiKey: 'k', model: 'm', prompt: 'p', baseUrl: 'https://x.test/v1' }),
      /Respons kosong/));
});

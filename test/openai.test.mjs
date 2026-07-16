import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/openai.js'); // classic script: set globalThis.MeetOpenAI
const { extractContent } = globalThis.MeetOpenAI;

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

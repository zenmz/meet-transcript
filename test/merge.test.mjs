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

test('fillTemplate tidak menafsirkan pola $ di transkrip', () => {
  assert.equal(fillTemplate('X {{transcript}} Y', 'a$&b'), 'X a$&b Y');
});

test('DEFAULT_MOM_TEMPLATE mengandung placeholder', () => {
  assert.ok(DEFAULT_MOM_TEMPLATE.includes('{{transcript}}'));
});

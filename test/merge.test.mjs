import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/merge.js'); // classic script: side effect set globalThis.MeetMerge
const { upsertSegment, replaceAudioSegments, formatTranscript, formatMarkdown, fillTemplate,
  DEFAULT_MOM_TEMPLATE } = globalThis.MeetMerge;

const audio = (t, text) => ({ t, text, speaker: '' });

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

test('replaceAudioSegments mengisi meeting kosong dan memberi id bercap baseTime', () => {
  const out = replaceAudioSegments([], [audio(0, 'halo'), audio(1000, 'hai')], { baseTime: 100 });
  assert.deepEqual(out.map((s) => s.id), ['audio:100:0', 'audio:100:1']);
  assert.deepEqual(out.map((s) => s.text), ['halo', 'hai']);
});

test('transkrip ulang (replace) MENGGANTI grup rekaman yang sama, bukan menumpuk', () => {
  const opt = { baseTime: 100, replace: true };
  const first = replaceAudioSegments([], [audio(0, '[transkrip gagal]'), audio(1000, '[transkrip gagal]')], opt);
  const second = replaceAudioSegments(first, [audio(0, 'halo'), audio(1000, 'hai')], opt);
  assert.equal(second.length, 2);
  assert.deepEqual(second.map((s) => s.text), ['halo', 'hai']);
});

// Bug yang paling mahal: rekaman KEDUA di ruang Meet yang sama dulu menghapus
// transkrip rekaman pertama, dan audionya sudah ikut hilang (beginAudio clear).
test('rekaman BARU di ruang yang sama menambah, tidak menghapus rekaman sebelumnya', () => {
  const first = replaceAudioSegments([], [audio(0, 'sesi satu')], { baseTime: 100 });
  const second = replaceAudioSegments(first, [audio(9000, 'sesi dua')], { baseTime: 9000 });
  assert.deepEqual(second.map((s) => s.text), ['sesi satu', 'sesi dua']);
  assert.deepEqual(second.map((s) => s.id), ['audio:100:0', 'audio:9000:0']);
});

// Id lama tanpa cap baseTime hanya boleh dibuang kalau audio yang sedang
// ditranskrip ulang MEMANG rekaman legacy itu sendiri (loadAudio yang tahu).
test('id lama tanpa cap dibuang hanya saat transkrip ulang rekaman legacy', () => {
  const lama = [{ id: 'audio:0', speaker: '', text: 'lama', t: 0 }];
  const tambah = replaceAudioSegments(lama, [audio(1000, 'baru')], { baseTime: 500 });
  assert.deepEqual(tambah.map((s) => s.text), ['lama', 'baru'], 'rekaman baru menambah');
  const ulangLegacy = replaceAudioSegments(lama, [audio(1000, 'baru')],
    { baseTime: 500, replace: true, legacy: true });
  assert.deepEqual(ulangLegacy.map((s) => s.text), ['baru'], 'transkrip ulang legacy mengganti');
});

// Regresi mahal: rekam sebelum upgrade (id lama) → upgrade → rekam lagi di ruang
// sama → transkrip ulang rekaman KEDUA tidak boleh menyentuh rekaman pertama,
// yang audionya sudah lama dibuang beginAudio dan tak bisa dipulihkan.
test('transkrip ulang rekaman bercap TIDAK menghapus rekaman legacy milik lain', () => {
  const lama = [{ id: 'audio:0', speaker: '', text: 'rekaman lama', t: 0 }];
  const dua = replaceAudioSegments(lama, [audio(9000, 'rekaman baru')], { baseTime: 9000 });
  const ulang = replaceAudioSegments(dua, [audio(9000, 'baru diperbaiki')],
    { baseTime: 9000, replace: true, legacy: false });
  assert.deepEqual(ulang.map((s) => s.text), ['rekaman lama', 'baru diperbaiki']);
});

test('replaceAudioSegments mempertahankan segmen dari caption', () => {
  const withCaption = [{ id: 'cap-1', speaker: 'Ani', text: 'halo', t: 0 }];
  const opt = { baseTime: 1, replace: true };
  const out = replaceAudioSegments(replaceAudioSegments(withCaption, [audio(5, 'a')], opt), [audio(5, 'b')], opt);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'cap-1');
  assert.equal(out[1].text, 'b');
});

// Caption disimpan lebih dulu di array, baris audio di-concat di belakangnya —
// tanpa urut ulang, transkrip gabungan melompat mundur di tengah.
test('replaceAudioSegments mengurutkan gabungan caption+audio per waktu', () => {
  const caption = [
    { id: 'cap-1', speaker: 'Ani', text: 'pembuka', t: 1000 },
    { id: 'cap-2', speaker: 'Budi', text: 'penutup', t: 9000 },
  ];
  const out = replaceAudioSegments(caption, [audio(3000, 'tengah'), audio(12000, 'setelah')], { baseTime: 7 });
  assert.deepEqual(out.map((s) => s.text), ['pembuka', 'tengah', 'penutup', 'setelah']);
  assert.deepEqual(out.map((s) => s.t), [1000, 3000, 9000, 12000]);
  // id audio tetap berurut sesuai hasil STT, bukan sesuai posisi akhir.
  assert.deepEqual(out.filter((s) => s.id.startsWith('audio:')).map((s) => s.id), ['audio:7:0', 'audio:7:1']);
});

// Transkrip ulang dengan model STT yang balas 200 + teks kosong menghasilkan
// nol segmen; transkrip lama yang sudah bagus tidak boleh ikut hilang.
test('replaceAudioSegments dengan hasil kosong TIDAK menghapus transkrip lama', () => {
  const opt = { baseTime: 100, replace: true };
  const first = replaceAudioSegments([{ id: 'cap-1', text: 'x', speaker: 'Ani', t: 0 }],
    [audio(0, 'halo'), audio(1000, 'hai')], opt);
  const out = replaceAudioSegments(first, [], opt);
  assert.deepEqual(out.map((s) => s.id), ['cap-1', 'audio:100:0', 'audio:100:1']);
  assert.deepEqual(out.map((s) => s.text), ['x', 'halo', 'hai']);
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

test('formatTranscript tanpa speaker (mode audio)', () => {
  const t = new Date(2026, 0, 1, 9, 5, 7).getTime();
  assert.equal(formatTranscript([{ id: 1, speaker: '', text: 'halo', t }]), '[09:05:07] halo');
});

test('formatMarkdown tanpa speaker tidak menulis ****', () => {
  const t = new Date(2026, 0, 1, 9, 5, 7).getTime();
  const md = formatMarkdown({ title: 'x', startedAt: t, mom: null, segments: [{ id: 1, speaker: '', text: 'halo', t }] });
  assert.ok(md.includes('- (09:05:07): halo'));
  assert.ok(!md.includes('****'));
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

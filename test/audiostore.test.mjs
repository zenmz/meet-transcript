// Dua helper murni di lib/audiostore.js: parsing bentuk key, dan pemilihan
// rekaman yang dipangkas. Sisa file itu I/O IndexedDB yang tak ada di Node,
// dan repo ini nol dependency — jadi yang diuji adalah bagian murninya, yang
// juga satu-satunya tempat bentuk key diparse.
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/audiostore.js'); // classic script: set globalThis.MeetAudioStore
const { groupRecordings, pruneTargets, KEEP_RECORDINGS } = globalThis.MeetAudioStore;

const metaOf = (over = {}) => ({ meetingId: 'abc-defg-hij', chunkMs: 600000,
  baseTime: 1000, count: 0, videoCount: 0, ...over });

test('layout baru: chunk & vchunk dikelompokkan ke rekamannya', () => {
  const metas = new Map([
    ['meta:1000', metaOf({ baseTime: 1000, count: 2, videoCount: 1 })],
    ['meta:2000', metaOf({ baseTime: 2000, meetingId: 'discord-1-2', count: 1 })],
  ]);
  const keys = ['meta:1000', 'chunk:1000:0', 'chunk:1000:1', 'vchunk:1000:0',
    'meta:2000', 'chunk:2000:0'];
  const recs = groupRecordings(keys, metas);
  assert.deepEqual(recs.map((r) => r.recId), [2000, 1000]); // terbaru dulu
  assert.equal(recs[1].meetingId, 'abc-defg-hij');
  assert.deepEqual(recs[1].chunkKeys.map((c) => c.key), ['chunk:1000:0', 'chunk:1000:1']);
  assert.deepEqual(recs[1].videoKeys.map((c) => c.key), ['vchunk:1000:0']);
  assert.equal(recs[1].legacy, false);
  assert.equal(recs[1].oldKeys, false);
  assert.deepEqual([...recs[1].keys].sort(),
    ['chunk:1000:0', 'chunk:1000:1', 'meta:1000', 'vchunk:1000:0']);
});

test('urutan numerik, bukan leksikografis', () => {
  // Timestamp transkrip ulang dihitung dari indeks potongan. Kalau 'chunk:10'
  // jatuh sebelum 'chunk:2', seluruh transkrip bergeser 10 menit per slot.
  const metas = new Map([['meta:1000', metaOf({ count: 11 })]]);
  const keys = ['meta:1000', ...Array.from({ length: 11 }, (_, i) => `chunk:1000:${i}`)];
  const recs = groupRecordings(keys.slice().reverse(), metas);
  assert.deepEqual(recs[0].chunkKeys.map((c) => c.index),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('indeks bolong tetap mengembalikan indeks ASLI', () => {
  // Potongan yang gagal ditulis melewati indeksnya. Penomoran ulang rapat
  // membuat potongan sesudahnya ditimestamp 10 menit terlalu awal.
  const metas = new Map([['meta:1000', metaOf({ count: 4 })]]);
  const recs = groupRecordings(
    ['meta:1000', 'chunk:1000:0', 'chunk:1000:2', 'chunk:1000:3'], metas);
  assert.deepEqual(recs[0].chunkKeys.map((c) => c.index), [0, 2, 3]);
});

test('bentuk key lama dibaca sebagai SATU rekaman, flag oldKeys', () => {
  const metas = new Map([['meta', metaOf({ baseTime: 1500, count: 2 })]]);
  const recs = groupRecordings(
    ['meta', 'chunk:0', 'chunk:1', 'vchunk:0'], metas);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].recId, 1500); // dari meta.baseTime
  assert.equal(recs[0].oldKeys, true);
  assert.equal(recs[0].legacy, false); // 'blobs' tidak ada → bukan layout ≤0.3
  assert.deepEqual(recs[0].chunkKeys.map((c) => c.index), [0, 1]);
  assert.deepEqual(recs[0].videoKeys.map((c) => c.index), [0]);
});

test("layout 'blobs' ≤0.3 menyalakan legacy, bukan oldKeys saja", () => {
  // legacy dibawa sampai replaceAudioSegments: hanya rekaman inilah yang boleh
  // menghapus baris transkrip ber-id tanpa cap baseTime.
  const metas = new Map([['meta', metaOf({ baseTime: 900 })]]);
  const recs = groupRecordings(['meta', 'blobs'], metas);
  assert.equal(recs[0].legacy, true);
  assert.equal(recs[0].oldKeys, true);
  assert.deepEqual([...recs[0].keys].sort(), ['blobs', 'meta']);
});

test('meta legacy tanpa baseTime → recId 0, bukan NaN', () => {
  // Layout ≤0.3 bisa tak punya baseTime. NaN membuat rekaman ini hilang dari
  // semua daftar DAN tak pernah terpangkas — bocor selamanya.
  const metas = new Map([['meta', { meetingId: 'abc-defg-hij', count: 1 }]]);
  const recs = groupRecordings(['meta', 'chunk:0'], metas);
  assert.equal(recs[0].recId, 0);
  assert.deepEqual(recs[0].chunkKeys.map((c) => c.key), ['chunk:0']);
});

test('chunk tanpa meta diabaikan, tidak jadi rekaman hantu', () => {
  // Meta terpangkas tapi delete chunk-nya gagal. Rekaman hantu ber-meetingId
  // undefined akan muncul di menu panel sebagai baris yang selalu gagal.
  const metas = new Map([['meta:2000', metaOf({ baseTime: 2000 })]]);
  const recs = groupRecordings(['meta:2000', 'chunk:2000:0', 'chunk:1000:0'], metas);
  assert.deepEqual(recs.map((r) => r.recId), [2000]);
});

test('recId legacy yang bertabrakan dengan meta: baru tidak menimpanya', () => {
  const metas = new Map([
    ['meta:1000', metaOf({ baseTime: 1000, meetingId: 'baru' })],
    ['meta', metaOf({ baseTime: 1000, meetingId: 'lama' })],
  ]);
  const recs = groupRecordings(['meta:1000', 'meta'], metas);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].meetingId, 'baru');
  assert.equal(recs[0].oldKeys, false);
});

test('store kosong → daftar kosong', () => {
  assert.deepEqual(groupRecordings([], new Map()), []);
});

test('pruneTargets: tepat KEEP tidak memangkas apa pun', () => {
  assert.equal(KEEP_RECORDINGS, 5);
  const recs = Array.from({ length: 5 }, (_, i) => ({ recId: i, keys: [`meta:${i}`] }));
  assert.deepEqual(pruneTargets(recs), []);
});

test('pruneTargets: lebih dari KEEP memangkas yang TERTUA beserta chunk-nya', () => {
  const recs = Array.from({ length: 6 }, (_, i) => ({
    recId: i * 1000,
    keys: [`meta:${i * 1000}`, `chunk:${i * 1000}:0`, `vchunk:${i * 1000}:0`],
  }));
  assert.deepEqual(pruneTargets(recs), ['meta:0', 'chunk:0:0', 'vchunk:0:0']);
});

test('pruneTargets tidak bergantung urutan masukan', () => {
  const recs = [{ recId: 1, keys: ['meta:1'] }, { recId: 9, keys: ['meta:9'] }];
  assert.deepEqual(pruneTargets(recs, 1), ['meta:1']);
});

test('pruneTargets: slot legacy terpangkas sebagai satu unit', () => {
  const legacy = { recId: 0, keys: ['meta', 'chunk:0', 'vchunk:0', 'blobs'] };
  const recs = [legacy, ...Array.from({ length: 5 },
    (_, i) => ({ recId: (i + 1) * 1000, keys: [`meta:${(i + 1) * 1000}`] }))];
  assert.deepEqual(pruneTargets(recs), ['meta', 'chunk:0', 'vchunk:0', 'blobs']);
});

test('pruneTargets: daftar kosong → kosong', () => {
  assert.deepEqual(pruneTargets([]), []);
});

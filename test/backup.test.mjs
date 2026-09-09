import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/backup.js'); // classic script: set globalThis.MeetBackup
const { makeZip, readZip } = globalThis.MeetBackup;

test('zip round-trip: nama & isi utuh, termasuk blob biner', async () => {
  const bin = new Uint8Array(70000).map((_, i) => i % 251); // > 1 blok, byte non-ASCII
  const entries = [
    { name: 'backup.json', data: '{"version":1}' },
    { name: 'audio/chunk-3.webm', data: new Blob([bin]) },
  ];
  const zip = await makeZip(entries);
  const out = await readZip(zip);
  assert.deepEqual(out.map((e) => e.name), ['backup.json', 'audio/chunk-3.webm']);
  assert.equal(await out[0].blob.text(), '{"version":1}');
  assert.deepEqual(new Uint8Array(await out[1].blob.arrayBuffer()), bin);
});

test('zip kosong tetap terbaca (EOCD saja)', async () => {
  assert.deepEqual(await readZip(await makeZip([])), []);
});

test('bukan zip → error jelas, bukan hasil kosong', async () => {
  await assert.rejects(readZip(new Blob(['bukan zip sama sekali'])), /ZIP/);
});

// importBackup MENGHAPUS seluruh data sebagai langkah pertama. Yang diuji di
// bawah bukan "error dilempar" melainkan "clear() TIDAK pernah dipanggil" —
// backup rusak yang lolos guard menghapus riwayat user lalu gagal saat set().
const { importBackup } = globalThis.MeetBackup;

function stubEnv() {
  const calls = { cleared: 0, set: null, imported: null };
  globalThis.chrome = { storage: { local: {
    clear: async () => { calls.cleared++; },
    set: async (v) => { calls.set = v; },
  } } };
  globalThis.MeetAudioStore = {
    importAudio: async (meta, chunks) => { calls.imported = { meta, chunks }; },
  };
  return calls;
}
const zipOf = (json, extra = []) =>
  makeZip([{ name: 'backup.json', data: JSON.stringify(json) }, ...extra]);

test('zip tanpa backup.json ditolak SEBELUM storage.clear()', async () => {
  const calls = stubEnv();
  // Zip sah tapi bukan backup (mis. user salah pilih file) — data existing
  // tidak boleh tersentuh sama sekali.
  const zip = await makeZip([{ name: 'catatan.txt', data: 'bukan backup' }]);
  await assert.rejects(importBackup(zip), /backup\.json tidak ada/);
  assert.equal(calls.cleared, 0);
});

test('backup.json bukan JSON ditolak SEBELUM storage.clear()', async () => {
  const calls = stubEnv();
  const zip = await makeZip([{ name: 'backup.json', data: '{rusak' }]);
  await assert.rejects(importBackup(zip), /bukan JSON/);
  assert.equal(calls.cleared, 0);
});

test('backup.json cacat ditolak SEBELUM storage.clear()', async () => {
  for (const bad of [
    { version: 1, storage: 'x' },          // string
    { version: 1, storage: [1, 2] },       // array
    { version: 1 },                        // storage hilang
    { version: 2, storage: {} },           // versi tak dikenal
    { version: 1, storage: {}, audioMeta: 'x' },
  ]) {
    const calls = stubEnv();
    await assert.rejects(importBackup(await zipOf(bad)), /rusak|tidak dikenal/);
    assert.equal(calls.cleared, 0, `clear() jalan untuk backup cacat: ${JSON.stringify(bad)}`);
  }
});

test('import sehat: chunk & vchunk mendarat di key IndexedDB yang benar', async () => {
  const calls = stubEnv();
  const zip = await zipOf(
    { version: 1, storage: { meetings: ['abc'] }, audioMeta: { meetingId: 'abc', count: 1 } },
    [{ name: 'audio/chunk-7.webm', data: new Blob(['a']) },
      { name: 'audio/video-0.webm', data: new Blob(['v']) }]);
  const r = await importBackup(zip);
  assert.equal(calls.cleared, 1);
  assert.deepEqual(calls.set, { meetings: ['abc'] });
  assert.deepEqual(calls.imported.chunks.map((c) => c.key), ['chunk:7', 'vchunk:0']);
  assert.deepEqual(r, { meetings: 1, chunks: 2, audioError: null });
});

// Import MENGGANTI seluruh data, termasuk rekaman: backup tanpa rekaman harus
// mengosongkan store, bukan membiarkan rekaman lama nempel ke meeting impor
// (kode ruang recurring sama → "Transkrip ulang" menimpa transkrip impor
// dengan audio sesi lain). Chunk tanpa meta tidak ditulis dan tidak dihitung.
test('audioMeta null → store rekaman dikosongkan, chunk tak ditulis', async () => {
  const calls = stubEnv();
  const r = await importBackup(await zipOf(
    { version: 1, storage: { meetings: ['a'] }, audioMeta: null },
    [{ name: 'audio/chunk-0.webm', data: new Blob(['x']) }]));
  assert.deepEqual(calls.imported, { meta: null, chunks: [] });
  assert.equal(r.chunks, 0);
});

// Storage sudah tergantikan saat tahap ini gagal — melempar akan membuat panel
// melaporkan "import gagal" untuk import yang sebenarnya sudah menimpa data.
test('restore rekaman gagal → hasil parsial, bukan throw', async () => {
  stubEnv();
  globalThis.MeetAudioStore.importAudio = async () => { throw new Error('kuota habis'); };
  const r = await importBackup(await zipOf(
    { version: 1, storage: { meetings: ['a'] }, audioMeta: { meetingId: 'a' } },
    [{ name: 'audio/chunk-0.webm', data: new Blob(['x']) }]));
  assert.equal(r.audioError, 'kuota habis');
  assert.equal(r.meetings, 1);
  assert.equal(r.chunks, 0);
});

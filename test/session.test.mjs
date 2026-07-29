import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../content/session.js'); // classic script: set globalThis.MeetSession
const { step, meetingIdFrom, INITIAL } = globalThis.MeetSession;

const A = 'abc-defg-hij';
const B = 'xyz-mnop-qrs';

// Jalankan beberapa tick berurutan, kumpulkan aksinya.
function run(ticks, state = INITIAL) {
  const acts = [];
  let s = state;
  for (const t of ticks) {
    s = step(s, t);
    acts.push({ open: s.open, close: s.close, report: s.report, curId: s.curId });
  }
  return { state: s, acts };
}
const inCall = (id) => ({ id, inCall: true });
const out = (id) => ({ id, inCall: false });

test('meetingIdFrom hanya menerima pola kode Meet', () => {
  assert.equal(meetingIdFrom('/abc-defg-hij'), A);
  assert.equal(meetingIdFrom('/landing'), null);
  assert.equal(meetingIdFrom('/'), null);
  assert.equal(meetingIdFrom(undefined), null);
});

test('masuk ruang dari halaman landing membuka sesi (SPA, tanpa reload)', () => {
  const { acts } = run([out(null), out(A)]);
  assert.deepEqual(acts[0], { open: false, close: false, report: false, curId: null });
  assert.deepEqual(acts[1], { open: true, close: false, report: true, curId: A });
});

test('pindah ruang menutup sesi lama dan membuka yang baru di tick yang sama', () => {
  const { acts } = run([inCall(A), inCall(B)]);
  assert.deepEqual(acts[1], { open: true, close: true, report: true, curId: B });
});

// Properti terpenting: setelah pindah, tak ada satu pun tick yang masih
// melaporkan ruang lama — itulah jalur yang dulu menulis caption ruang baru ke
// record ruang lama.
test('setelah pindah ruang, tak ada tick yang melapor dengan id ruang lama', () => {
  const { acts } = run([inCall(A), inCall(B), inCall(B), out(B)]);
  const dilapor = acts.filter((a) => a.report).map((a) => a.curId);
  assert.deepEqual(dilapor, [A, B, B, B]);
  assert.equal(acts.filter((a) => a.close).length, 1);
  assert.equal(acts.filter((a) => a.open).length, 2); // A lalu B
});

test('keluar call menutup sesi setelah dua tick, bukan satu', () => {
  const { acts } = run([inCall(A), out(A), out(A)]);
  assert.equal(acts[1].close, false, 'satu tick tanpa tombol keluar belum boleh menutup');
  assert.equal(acts[1].report, true);
  assert.deepEqual(acts[2], { open: false, close: true, report: false, curId: A });
});

test('kedipan satu tick tidak menghentikan sesi yang masih berjalan', () => {
  const { acts } = run([inCall(A), out(A), inCall(A), out(A), out(A)]);
  assert.equal(acts[2].close, false);
  assert.equal(acts[3].close, false, 'counter harus ter-reset saat in-call kembali');
  assert.equal(acts[4].close, true);
});

// Meet sempat melewati pathname lain saat transisi SPA. Menutup di tick pertama
// akan menghentikan rekaman audio yang sebenarnya masih berjalan.
test('pathname bukan kode ruang selama satu tick tidak menutup sesi', () => {
  const { acts } = run([inCall(A), out(null), inCall(A)]);
  assert.equal(acts[1].close, false);
  assert.equal(acts[2].close, false);
  assert.equal(acts[2].curId, A);
});

test('pathname bukan kode ruang dua tick berturut menutup sesi dan mereset', () => {
  const { state, acts } = run([inCall(A), out(null), out(null)]);
  assert.deepEqual(acts[2], { open: false, close: true, report: false, curId: null });
  assert.deepEqual(
    { curId: state.curId, reporting: state.reporting, sawInCall: state.sawInCall, goneTicks: state.goneTicks },
    INITIAL);
});

// Lobby: belum pernah in-call, jadi tak ada yang "ditinggalkan" — sesinya harus
// tetap melapor supaya panel tahu tab ini ada di ruang tersebut.
test('duduk di lobby tanpa pernah join tidak menutup sesi', () => {
  const { acts } = run([out(A), out(A), out(A), out(A)]);
  assert.equal(acts.every((a) => !a.close && a.report), true);
  assert.equal(acts.filter((a) => a.open).length, 1);
});

test('sesi yang sudah ditutup tidak hidup lagi selama URL sama & belum rejoin', () => {
  const { acts } = run([inCall(A), out(A), out(A), out(A), out(A)]);
  assert.equal(acts[2].close, true);
  assert.deepEqual(acts.slice(3).map((a) => [a.open, a.close, a.report]),
    [[false, false, false], [false, false, false]]);
});

test('rejoin di URL yang sama membuka sesi baru', () => {
  const { acts } = run([inCall(A), out(A), out(A), inCall(A)]);
  assert.deepEqual(acts[3], { open: true, close: false, report: true, curId: A });
});

test('selector inCall() rusak (tak pernah true) → sesi tidak pernah ditutup sendiri', () => {
  const { acts } = run(Array.from({ length: 5 }, () => out(A)));
  assert.equal(acts.every((a) => !a.close && a.report), true);
});

// Masuk ruang B dari ruang A membawa state lama; kalau sawInCall/goneTicks tidak
// ikut di-reset, sesi B ditutup ~4 detik setelah tiba padahal user baru sampai
// di lobby-nya. Dua mutasi itu lolos seluruh test sebelumnya.
test('sesi ruang baru mulai dari nol, tidak mewarisi hitungan ruang sebelumnya', () => {
  const { acts } = run([inCall(A), out(A), inCall(B), out(B), out(B), out(B)]);
  assert.equal(acts[2].open, true);
  assert.equal(acts.slice(3).every((a) => a.curId === B), true);
  assert.equal(acts[3].close, false);
  assert.equal(acts[4].close, true, 'B ditutup karena keluar call B, bukan warisan A');
});

// Tiba di lobby ruang B setelah sempat in-call di ruang A. Kalau sawInCall
// terbawa, B dianggap "sudah ditinggalkan" dan sesinya ditutup ~4 detik setelah
// tiba — rekaman audio ikut dihentikan padahal user belum join.
test('pindah ruang saat tidak in-call tidak mewarisi sawInCall ruang lama', () => {
  const { acts } = run([inCall(A), out(B), out(B), out(B)]);
  assert.equal(acts[1].close, true, 'ruang A memang ditutup');
  assert.equal(acts.slice(2).every((a) => !a.close && a.report && a.curId === B), true);
});

// goneTicks ruang lama yang terbawa membuat debounce ruang baru cuma satu tick.
test('hitungan keluar ruang lama tidak terbawa ke ruang baru', () => {
  const { acts } = run([inCall(A), out(A), out(B), out(null)]);
  assert.equal(acts[3].close, false, 'satu tick di luar ruang B belum boleh menutup');
});

// Tanpa pernah join sekalipun, meninggalkan halaman ruang tetap mengakhiri sesi
// — kalau tidak, tab yang balik ke landing terus melapor ruang yang ditinggalkan.
test('meninggalkan halaman ruang dari lobby menutup sesi setelah dua tick', () => {
  const { acts } = run([out(A), out(null), out(null)]);
  assert.equal(acts[1].close, false);
  assert.deepEqual(acts[2], { open: false, close: true, report: false, curId: null });
});

test('pindah ruang saat masih di lobby ruang lama tidak menutup apa pun dua kali', () => {
  const { acts } = run([out(A), out(B), out(B), out(B)]);
  assert.equal(acts[1].close, true);
  assert.equal(acts[1].open, true);
  assert.equal(acts.slice(2).every((a) => !a.close && a.report), true);
});

// Invarian struktural: tiap close harus punya open yang mendahuluinya, dan
// report benar persis saat sesi terbuka. Di-brute-force, bukan dieja satu-satu.
test('open/close berpasangan dan report konsisten di semua sekuens', () => {
  const pilihan = [null, A, B].flatMap((id) => [{ id, inCall: false }, { id, inCall: true }]);
  const rec = (s, terbuka, sisa) => {
    if (!sisa) return;
    for (const t of pilihan) {
      const n = step(s, t);
      assert.equal(n.close && !terbuka, false, 'close tanpa sesi terbuka');
      const kini = n.open ? true : (n.close ? false : terbuka);
      assert.equal(n.report, kini, 'report harus true persis saat sesi terbuka');
      assert.ok(n.goneTicks <= 2, 'goneTicks tak boleh lewat batas');
      rec(n, kini, sisa - 1);
    }
  };
  rec(INITIAL, false, 5); // 6^5 = 7776 sekuens
});

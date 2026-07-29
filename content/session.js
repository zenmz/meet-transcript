// content/session.js — kapan satu "sesi meeting" dibuka & ditutup.
// Dipisah dari captions.js dan dibuat pure supaya bisa diuji di node: cabang di
// sini yang memutuskan rekaman audio dihentikan (audio disimpan & ditranskrip)
// atau tidak, dan salah satu arah kegagalannya tidak terlihat di UI mana pun.
// Classic script (globalThis), sama seperti selectors.js.
(() => {
  const MEET_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
  // Dua tick (≈4 detik) sebelum sesi ditutup. Menutup di tick pertama
  // menghentikan rekaman yang masih berjalan, dan dua hal yang normal bisa
  // memicunya sesaat: tombol "keluar dari panggilan" berkedip saat Meet menukar
  // layout, dan pathname sempat melewati halaman lain saat transisi SPA.
  const LEAVE_TICKS = 2;

  function meetingIdFrom(pathname) {
    const p = String(pathname ?? '').slice(1);
    return MEET_RE.test(p) ? p : null;
  }

  const INITIAL = { curId: null, reporting: false, sawInCall: false, goneTicks: 0 };

  // Satu langkah tick: state lama + apa yang terlihat di halaman → state baru
  // + aksi. `open`/`close` efek yang dijalankan pemanggil (reset state caption,
  // buka/tutup port). `report` = boleh mengirim status/segmen ronde ini.
  function step(s, { id, inCall }) {
    let { curId, reporting, sawInCall, goneTicks } = s;
    let open = false;
    let close = false;

    // Pindah ke ruang LAIN: ruangnya sudah pasti ganti, tak ada yang perlu
    // ditunggu. Tutup sesi lama dan buka yang baru di tick yang sama. Hitungan
    // ruang lama WAJIB ikut nol: kalau sawInCall/goneTicks terbawa, sesi ruang
    // baru ditutup ~4 detik setelah tiba padahal user baru sampai di lobbynya.
    if (id && id !== curId) {
      close = reporting;
      curId = id;
      reporting = true; sawInCall = false; goneTicks = 0;
      open = true;
    }

    // Belum pernah di ruang mana pun, dan sekarang pun tidak.
    if (!curId) return { ...INITIAL, open, close, report: false };

    if (inCall) {
      if (!reporting) { open = true; reporting = true; goneTicks = 0; } // rejoin di ruang yang sama
      sawInCall = true;
      goneTicks = 0;
      return { curId, reporting, sawInCall, goneTicks, open, close, report: true };
    }

    // Tidak in-call. Dua sinyal "sudah selesai di ruang ini", di-debounce sama:
    // pathname bukan kode ruang lagi, atau tombol keluar hilang setelah sempat
    // masuk call. Lobby yang belum pernah join tidak termasuk — di sana tombol
    // keluar memang belum ada, dan sesinya harus tetap melapor.
    // Syarat sawInCall juga menjaga degradasi: kalau selector inCall() rusak dan
    // tak pernah true, sesi tidak pernah ditutup sendiri (perilaku lama).
    const leaving = !id || sawInCall;
    if (reporting && leaving && ++goneTicks >= LEAVE_TICKS) {
      // curId ikut dinolkan hanya kalau memang sudah tidak di halaman ruang;
      // kalau masih di URL yang sama, id itu tetap dipegang supaya rejoin
      // dikenali sebagai ruang yang sama, bukan ruang baru.
      return { curId: id ?? null, reporting: false, sawInCall: false, goneTicks: 0,
        open, close: true, report: false };
    }
    return { curId, reporting, sawInCall, goneTicks, open, close, report: reporting };
  }

  globalThis.MeetSession = { step, meetingIdFrom, INITIAL };
})();

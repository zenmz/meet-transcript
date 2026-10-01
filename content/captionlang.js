// content/captionlang.js — setel bahasa caption Meet dari `settings.captionLang`
// (popup). Perlu ada karena combobox bahasanya hidup DI DALAM region caption
// yang disembunyikan captionhide.js: begitu caption disembunyikan, pemilihnya
// ikut hilang dari layar. display:none tidak menghalangi .click() programatik,
// jadi pilihannya tetap bisa diterapkan dari sini.
(() => {
  const S = globalThis.MeetSelectors;

  let want = 'id'; // settings kosong (instalasi baru) → Indonesia
  let changed = false;
  let applied = false;
  let attempts = 0;
  let busy = false;
  let wasInCall = false;

  function reset() { applied = false; attempts = 0; }

  // Listener dulu, snapshot belakangan — pola yang sama dengan captions.js &
  // captionhide.js: snapshot get() bisa lebih tua dari onChanged yang mendarat
  // selagi get berjalan.
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== 'local' || !c.settings) return;
    changed = true;
    want = c.settings.newValue?.captionLang ?? 'id';
    reset(); // pilihan baru harus diterapkan walau yang lama sudah sukses
  });
  chrome.storage.local.get('settings').then((d) => {
    if (!changed) want = d.settings?.captionLang ?? 'id';
  }).catch(() => {});

  function apply() {
    const combo = S.langCombobox();
    if (!combo) return;
    const re = S.LANG_PATTERN[want];
    if (!re) return;
    // Sudah benar — termasuk sesudah klik di tick sebelumnya. Keberhasilan
    // HANYA diputuskan di sini, dari label combobox, bukan dari "klik sudah
    // dikirim": opsi yang meleset akan terus dicoba sampai batas attempts.
    if (re.test(combo.textContent.trim())) { applied = true; return; }
    attempts++;
    busy = true;
    combo.click(); // buka daftar; opsinya memang sudah ada di DOM sejak awal
    setTimeout(() => {
      const opt = S.langOption(re);
      if (opt) opt.click();
      // Gagal menemukan opsi: tutup lagi daftarnya. Tanpa ini menu Meet
      // tertinggal terbuka di layar user tanpa ada yang membukanya.
      else combo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      busy = false;
    }, 300);
  }

  // Sekali per call, bukan terus-menerus: ini menyetel DEFAULT, bukan mengunci.
  // Tanpa `applied`, pergantian bahasa yang user lakukan sendiri di UI Meet
  // akan dibalik lagi dalam 2 detik.
  const timer = setInterval(() => {
    if (!chrome.runtime?.id) { clearInterval(timer); return; } // script yatim
    if (!S.inCall()) { wasInCall = false; reset(); return; }
    if (!wasInCall) { wasInCall = true; reset(); } // call baru → terapkan lagi
    if (applied || busy || attempts >= 3) return;
    apply();
  }, 2000);
})();

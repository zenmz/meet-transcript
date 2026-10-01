// content/captionhide.js — sembunyikan caption Meet dari layar (bawaan ON;
// checkbox Settings `hideCaptions` mematikannya) TANPA mematikan CC: container
// caption diberi `display: none`, DOM-nya tetap hidup dan terus bermutasi
// (rendering tidak memengaruhi MutationObserver), jadi observer di captions.js
// tetap mengisi transkrip. display:none, BUKAN visibility:hidden: Meet mengukur
// tinggi container caption untuk menata tile video — visibility:hidden
// menyisakan ruang kosong seukuran caption, display:none membuat tingginya 0
// sehingga tata letaknya sama seperti CC mati (diverifikasi user 2026-09-09).
(() => {
  const S = globalThis.MeetSelectors;
  const style = document.createElement('style');
  style.textContent = S.CAPTION_REGION.join(', ') + ' { display: none !important; }';
  let on = true; // undefined / settings lama → bawaan sembunyikan

  // Style hanya terpasang saat DALAM call. Di landing/lobby tak ada caption,
  // dan CAPTION_REGION ditulis untuk q() (cocok pertama menang) — sebagai CSS
  // keempat selector berlaku sekaligus, jadi fallback aria/class lama tak
  // perlu diberi kesempatan salah sasaran di halaman yang tak relevan.
  const sync = () => {
    if (on && S.inCall()) { if (!style.isConnected) document.documentElement.append(style); }
    else style.remove();
  };

  // Listener dulu, snapshot belakangan. Snapshot get() bisa lebih tua dari
  // onChanged yang mendarat selagi get berjalan (user menekan Simpan saat
  // halaman dimuat) — kalau sudah ada perubahan, snapshot itu basi, abaikan.
  let changed = false;
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== 'local' || !c.settings) return;
    changed = true;
    on = c.settings.newValue?.hideCaptions !== false;
    sync();
  });
  chrome.storage.local.get('settings').then((d) => {
    if (!changed) on = d.settings?.hideCaptions !== false;
    sync();
  }).catch(() => sync());

  // Tiap 2 detik: ikuti inCall, dan script YATIM (extension di-reload/update
  // saat call berjalan) melepas style-nya sendiri — listener di atas sudah
  // mati bersama context-nya, dan tanpa ini caption terkunci tersembunyi
  // sampai tab di-reload, tak terjangkau checkbox Settings mana pun.
  const timer = setInterval(() => {
    if (!chrome.runtime?.id) { clearInterval(timer); style.remove(); return; }
    sync();
  }, 2000);
})();

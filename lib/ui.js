// lib/ui.js — helper DOM yang dipakai side panel DAN popup. Classic script
// (globalThis), sama seperti lib/* lainnya.
(() => {
  // el(): SELALU textContent — teks caption/nama pembicara tidak dipercaya.
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const mkBtn = (label, fn, box) => {
    const b = el('button', null, label);
    b.addEventListener('click', fn);
    box.append(b);
    return b;
  };

  // Key dropdown yang terbuka. Per-dokumen (popup dan panel memuat script ini
  // masing-masing), dan dibutuhkan karena tab Live merender ulang tiap 2 detik:
  // tanpa mengingat ini, menu yang baru dibuka tertutup sendiri.
  let openMenu = null;

  // Dropdown <details> native (tanpa JS buka-tutup). Menu menutup begitu item
  // diklik, jadi umpan balik aksi ditulis ke label summary (`head`) — tombol
  // di dalam menu yang berubah label tak akan terlihat siapa pun.
  // opts.cls menambah kelas (popup memakai 'inline': menu membuka di bawah
  // barisnya, bukan melayang seperti di sidebar). opts.caret '' = glyph-nya
  // diserahkan ke CSS, supaya bisa ditaruh di tepi kanan baris lewat ::after
  // + space-between, dan berubah saat menu terbuka.
  const mkDropdown = (container, key, label, opts = {}) => {
    const caret = opts.caret ?? ' ▾';
    const menu = el('details', 'menu' + (opts.cls ? ' ' + opts.cls : ''));
    const head = el('summary', null, label + caret);
    const list = el('div', 'menu-list');
    menu.append(head, list);
    menu.open = openMenu === key;
    menu.addEventListener('toggle', () => {
      if (menu.open) openMenu = key; else if (openMenu === key) openMenu = null;
    });
    container.append(menu);
    const item = (text, fn) => mkBtn(text, () => { menu.open = false; fn(); }, list);
    return { head, list, item, label: label + caret };
  };

  // Dropdown menutup saat klik di luar — <details> tidak punya light-dismiss.
  // Satu listener global; `open = false` memicu toggle → openMenu ikut null.
  document.addEventListener('click', (e) => {
    document.querySelectorAll('details.menu[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
  });

  globalThis.MeetUi = { el, mkBtn, mkDropdown };
})();

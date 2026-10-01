// popup/popup.js — satu-satunya tempat tombol "Rekam" benar-benar bisa jalan.
// Klik ikon toolbar ADALAH invocation action, dan hanya invocation (action,
// context menu, shortcut, omnibox) yang memberi izin activeTab untuk tab
// aktif — syarat tabCapture.getMediaStreamId. Tombol di side panel tidak
// pernah dapat: Chrome menolaknya dengan "Extension has not been invoked for
// the current page". Itu sebabnya start ada di sini dan Stop di dua tempat.
const { el, mkBtn, mkDropdown } = globalThis.MeetUi;
const view = document.getElementById('view');

let rec = { recording: false, transcribing: false, error: null };
// Dibaca saat load, bukan di dalam handler klik: sidePanel.open() butuh user
// gesture, dan menunggu tabs.query di tengah handler sudah menghabiskannya.
let tabId = null;

const SVG_NS = 'http://www.w3.org/2000/svg';
// Ikon digambar inline, bukan <img>: file ikon terpisah berarti satu request
// per baris dan warnanya tak bisa ikut teks.
function icon(paths, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  if (cls) svg.setAttribute('class', cls);
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
// Bahasa caption Meet. Indonesia duluan = default: settings.captionLang yang
// kosong (instalasi baru) dibaca sebagai 'id'.
const BAHASA = [['id', 'Indonesia'], ['en', 'English']];
let captionLang = 'id';

const ICON = {
  // Titik rekam — satu-satunya ikon berisi warna, sewarna badge merekam.
  rekam: () => icon(['M12 6a6 6 0 110 12 6 6 0 010-12z'], 'solid'),
  stop: () => icon(['M7.5 7.5h9v9h-9z'], 'solid'),
  detail: () => icon(['M4 5h16v14H4z', 'M14 5v14']),
  riwayat: () => icon(['M3.5 12a8.5 8.5 0 1 0 17 0 8.5 8.5 0 1 0-17 0', 'M12 7.5V12l3 2']),
  bahasa: () => icon([
    'M3.5 12a8.5 8.5 0 1 0 17 0 8.5 8.5 0 1 0-17 0',
    'M3.5 12h17',
    'M12 3.5c2.1 2.3 3.2 5.2 3.2 8.5s-1.1 6.2-3.2 8.5c-2.1-2.3-3.2-5.2-3.2-8.5S9.9 5.8 12 3.5z',
  ]),
};

// Digabung ke settings TERSIMPAN, bukan ke salinan di memori: panel bisa sedang
// membuka Settings dengan editan yang belum disimpan, dan menulis ulang seluruh
// objek dari popup akan membuangnya.
async function setCaptionLang(code) {
  captionLang = code;
  render(); // centang pindah sekarang, tak menunggu storage
  const cur = (await chrome.storage.local.get('settings')).settings ?? {};
  await chrome.storage.local.set({ settings: { ...cur, captionLang: code } });
}

// Panel dibuka dari gesture klik ini. Tujuannya dititipkan ke service worker
// lebih dulu — panel membacanya lewat get-active sebelum render pertama.
function openPanel(panelTab, meetingId) {
  if (panelTab) {
    chrome.runtime.sendMessage({ type: 'open-panel-tab', tab: panelTab, id: meetingId }).catch(() => {});
  }
  if (tabId != null) chrome.sidePanel?.open({ tabId }).catch(() => {});
  window.close();
}

// Judul meeting terbaru di dropdown Riwayat. 8, bukan semua: satu record berisi
// SELURUH segmen transkripnya, jadi membaca daftar panjang berarti menarik
// berpuluh MB ke popup yang cuma butuh judulnya. Sisanya lewat "Lihat semua".
const RIWAYAT_MAX = 8;

// Dimuat hanya saat dropdown-nya dibuka, bukan saat popup terbuka: mayoritas
// popup dibuka untuk menekan Rekam, dan pembacaan itu tak gratis.
async function fillRiwayat(d) {
  const { meetings: ids = [] } = await chrome.storage.local.get('meetings');
  if (!ids.length) {
    d.list.replaceChildren(el('div', 'muted', 'Belum ada riwayat.'));
    return;
  }
  const top = ids.slice(0, RIWAYAT_MAX);
  const data = await chrome.storage.local.get(top.map((id) => 'meeting:' + id));
  d.list.replaceChildren();
  for (const id of top) {
    const m = data['meeting:' + id];
    if (!m) continue; // record terhapus tapi masih tercatat di daftar
    d.item(m.title || id, () => openPanel('history', id));
  }
  if (ids.length > top.length) d.item(`Lihat semua (${ids.length})`, () => openPanel('history'));
}

function row(label, iconEl, fn) {
  const b = mkBtn(label, fn, view);
  b.prepend(iconEl);
  return b;
}

function render() {
  view.replaceChildren();
  if (rec.transcribing) {
    view.append(el('div', 'muted state', 'Mentranskrip…'));
  } else if (rec.recording) {
    row('Stop rekam', ICON.stop(), () => chrome.runtime.sendMessage({ type: 'stop-recording' }));
    view.append(el('div', 'muted state', '● Merekam tab ini'));
  } else {
    // caret '' → glyph datang dari CSS (› tertutup, ⌄ terbuka), menempel di
    // tepi kanan baris.
    const d = mkDropdown(view, 'rec', 'Rekam', { cls: 'inline', caret: '' });
    d.head.prepend(ICON.rekam());
    const start = (video) => chrome.runtime.sendMessage({ type: 'start-active-tab-recording', video });
    d.item('Audio saja', () => start(false));
    d.item('Audio + video', () => start(true));
  }
  const l = mkDropdown(view, 'bahasa', 'Bahasa caption', { cls: 'inline', caret: '' });
  l.head.prepend(ICON.bahasa());
  for (const [code, label] of BAHASA) {
    // Centang di label, bukan ikon terpisah: baris menu ini sudah punya
    // indentasi tetap, dan ikon kedua membuat dua kolom kosong untuk yang lain.
    l.item(code === captionLang ? label + '  ✓' : label, () => setCaptionLang(code));
  }
  row('Tampilkan detail', ICON.detail(), () => openPanel());
  // Popup TIDAK ditutup setelah start: pesan gagal (tab bukan Meet/Discord,
  // rekaman lain masih jalan) harus punya tempat untuk muncul.
  if (rec.error) view.append(el('div', 'err', rec.error));
  view.append(el('div', 'sep'));
  const h = mkDropdown(view, 'riwayat', 'Riwayat meet', { cls: 'inline', caret: '' });
  h.head.prepend(ICON.riwayat());
  h.list.append(el('div', 'muted', 'Memuat…'));
  // Render ulang (mis. rekaman berhenti) membangun dropdown baru; `openMenu` di
  // lib/ui.js membuatnya terbuka lagi, jadi isinya harus diisi ulang juga —
  // karena itu pengisian digantung ke state `open`, bukan ke sekali toggle.
  const menu = h.head.parentElement;
  // `filled` mencegah pembacaan ganda: menyetel .open di mkDropdown MEMICU
  // toggle, dan panggilan sinkron di bawah menangani kasus menu yang memang
  // sudah terbuka — tanpa penjaga ini keduanya membaca storage masing-masing.
  let filled = false;
  const fill = () => {
    if (!menu.open || filled) return;
    filled = true;
    fillRiwayat(h);
  };
  menu.addEventListener('toggle', fill);
  fill();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'rec-state') return;
  // 'error' in msg, bukan msg.error ?? null: broadcast progres tidak membawa
  // field error sama sekali, dan menganggapnya null menghapus pesan yang baru
  // terbit.
  rec = { recording: msg.recording, transcribing: msg.transcribing,
    error: 'error' in msg ? msg.error : rec.error };
  render();
});

render(); // gambar dulu, status menyusul — popup tak boleh kosong sekejap
chrome.tabs.query({ active: true, currentWindow: true })
  .then(([t]) => { tabId = t?.id ?? null; })
  .catch(() => {});
chrome.storage.local.get('settings').then((d) => {
  captionLang = d.settings?.captionLang ?? 'id';
  render();
}).catch(() => {});
chrome.runtime.sendMessage({ type: 'get-active' }).then((d) => {
  if (!d?.rec) return;
  rec = { ...rec, recording: d.rec.recording, transcribing: d.rec.transcribing };
  render();
}).catch(() => {}); // service worker baru bangun & belum punya listener

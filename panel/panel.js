// panel/panel.js — render live transcript, riwayat, settings dari storage.
const M = globalThis.MeetMerge;
const view = document.getElementById('view');
let tab = 'live';
let viewingId = null; // di tab Riwayat: meeting yang sedang dibuka
let status = { id: null, inCall: false, captionsOn: false, lastSegmentAt: 0, captionsOnAt: 0 };
let recState = { recording: false, transcribing: false, done: 0, total: 0, error: null };
// Firefox tidak punya tabCapture — rekam audio mustahil di sana, jadi seluruh
// UI-nya (bar rekam di tab Live, sumber "Rekam audio" + blok STT di Settings)
// disembunyikan. Tombol audio di Riwayat TIDAK perlu digate: syaratnya
// audioMeta milik meeting itu, dan di Firefox tak pernah ada audio tersimpan.
const HAS_AUDIO = !!chrome.tabCapture;
let settingsCache = {};
async function loadSettings() { settingsCache = (await chrome.storage.local.get('settings')).settings ?? {}; }

// el(): SELALU textContent — teks caption/nama pembicara tidak dipercaya.
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// Side panel tidak punya console yang dilihat user, dan halaman Errors di
// chrome://extensions cuma menampilkan stack minified milik vendor TANPA baris
// pesannya — persis bagian yang dibutuhkan untuk tahu apa yang salah. Jadi
// pesan + stack ditempelkan ke panel sendiri, bisa disorot dan disalin.
function reportError(what, e) {
  let box = document.getElementById('crash');
  if (!box) {
    box = el('div', 'error');
    box.id = 'crash';
    document.body.prepend(box);
  }
  box.textContent = `${what}: ${e?.message || e}\n${e?.stack ?? ''}`;
}
// Rejection tanpa handler adalah justru yang paling tidak terlihat: tidak ada
// jejaknya di UI sama sekali, cuma di halaman Errors.
addEventListener('unhandledrejection', (ev) => reportError('Promise gagal', ev.reason));
addEventListener('error', (ev) => reportError('Error', ev.error ?? ev.message));

document.querySelectorAll('nav button').forEach((b) =>
  b.addEventListener('click', () => {
    // Hanya Settings yang dilindungi: menggambar ulang di sana membuang semua
    // editan yang belum disimpan (Template MoM, API key) tanpa peringatan.
    // Tab lain HARUS boleh digambar ulang — daftar Riwayat tidak punya jalur
    // refresh lain, jadi memblokirnya membuat meeting baru tak pernah muncul
    // sampai user memantul ke tab lain dan kembali.
    if (b.dataset.tab === tab && tab === 'settings') return;
    tab = b.dataset.tab;
    viewingId = null;
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
    render();
  })
);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') {
    // Ganti meeting = keluhan rekaman meeting sebelumnya tidak berlaku lagi.
    // recState.error satu slot global tanpa pemilik, jadi tanpa ini error dari
    // ruang A tercat di atas tab Live ruang B — dan pesan seperti "Bukan halaman
    // meeting aktif" menempel sampai sesi panel berakhir.
    if (msg.id !== status.id) recState.error = null;
    status = msg;
    if (tab === 'live') render();
  } else if (msg.type === 'meeting-updated') {
    if ((tab === 'live' && msg.id === status.id) || (tab === 'history' && msg.id === viewingId)) render();
  } else if (msg.type === 'rec-state') {
    // Cache audio-meta dibuang hanya saat siklus rekam/transkrip BERGANTI
    // status. Dibuang tiap pesan berarti tiap audio-progress (satu per chunk,
    // plus tiap kabar unduh model) memaksa satu indexedDB.open lagi.
    const wasActive = recState.recording || recState.transcribing;
    if (wasActive !== (msg.recording || msg.transcribing)) audioMetaKey = null;
    recState = { recording: msg.recording, transcribing: msg.transcribing,
      done: msg.done ?? 0, total: msg.total ?? 0,
      // 'error' in msg, bukan msg.error ?? null: broadcast progress tidak
      // membawa field error sama sekali, dan menganggapnya null menghapus
      // peringatan yang baru saja terbit (mis. "belum ada suara masuk") begitu
      // chunk pertama mulai ditranskrip. Yang menghapus hanya rekaman baru,
      // yang memang mengirim error: null secara eksplisit.
      error: 'error' in msg ? msg.error : recState.error };
    // View meeting di tab Riwayat ikut dirender ulang: "Transkrip ulang"
    // dijalankan dari SANA, dan progres/error-nya cuma datang lewat pesan ini.
    // Tanpa ini tombolnya duduk disabled "Mentranskrip…" tanpa kabar apa pun,
    // dan kalau offscreen error, errornya tak pernah tampil sama sekali.
    // Daftar riwayat sengaja tidak ikut — rerender-nya melempar scroll ke atas.
    if (tab === 'live' || (tab === 'history' && viewingId)) render();
  }
});

async function getMeeting(id) {
  return (await chrome.storage.local.get('meeting:' + id))['meeting:' + id] ?? null;
}

const safeName = (s) => s.replace(/[\/\\:*?"<>|]/g, '-');

// Mode STT "Whisper di browser" (WASM in-extension) sudah dihapus. sttMode()
// menurunkan ulang settings lama secara diam-diam, dan diam itu masalahnya:
// user yang dulu full-offline (tanpa server STT, tanpa izin origin localhost)
// baru menemukan modenya hilang lewat rekaman pertama yang gagal transkrip.
// Peringatan ini hilang sendiri begitu user menekan Simpan di Settings —
// doSave menulis mode hasil resolusi, jadi tak perlu state "sudah dibaca".
const sttModeRemoved = () => settingsCache.sttMode === 'browser';
const STT_REMOVED_NOTE = 'Mode "Whisper di browser" sudah dihapus di versi ini. '
  + 'Setelan STT-mu dipindah otomatis ke server/API — buka Settings, cek Mode STT '
  + 'dan STT Base URL, lalu Simpan sebelum merekam.';

// Prompt MoM lengkap (template + transkrip) untuk paste ke AI web tanpa API key.
const promptText = (meeting) => M.fillTemplate(
  settingsCache.momTemplate || M.DEFAULT_MOM_TEMPLATE,
  M.formatTranscript(meeting.segments));

function download(name, data) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: 'text/plain' }));
  a.download = safeName(name);
  a.click();
  // Revoke ditunda: dialog "Save as" baru membaca blob setelah click() kembali.
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// Tiap chunk adalah file webm berdiri sendiri (satu MediaRecorder per chunk),
// jadi tidak digabung: menyambung dua webm menghasilkan file berheader ganda
// yang di kebanyakan player cuma terbaca potongan pertamanya. Diunduh terpisah
// dan dinomori supaya urutannya jelas.
async function downloadAudio(meeting) {
  const saved = await globalThis.MeetAudioStore.loadAudio();
  if (!saved?.blobs?.length) return 0;
  // Kepemilikan dicek ULANG di sini, bukan cuma lewat gate tombolnya: gate itu
  // membaca audioMeta yang di-cache, dan view meeting di tab Riwayat tidak
  // dirender ulang saat rekaman BARU mengganti isi store. Tanpa cek ini, buka
  // meeting lama A → rekam ruang B → klik "Unduh audio" di A menghasilkan blob
  // milik B, tersimpan dengan nama A.
  if (saved.meetingId !== meeting.id) return 0;
  // Dinomori dengan indeks ASLI potongan, bukan posisi di array: kalau ada
  // potongan yang gagal tersimpan, penomoran berurutan membuat file-file itu
  // tidak lagi cocok dengan slot 10 menit di transkrip.
  saved.blobs.forEach((blob, i) => download(
    saved.blobs.length > 1
      ? `${meeting.title}-${String((saved.indices?.[i] ?? i) + 1).padStart(2, '0')}.webm`
      : `${meeting.title}.webm`,
    blob));
  return saved.blobs.length;
}

// Kebalikan audio: part video BUKAN file berdiri sendiri — gabungan berurutan
// seluruh part = satu file webm valid, jadi diunduh sebagai SATU file.
// "-video" di nama: hindari tabrakan dengan unduhan audio satu-file.
async function downloadVideo(meeting) {
  const saved = await globalThis.MeetAudioStore.loadVideo();
  if (!saved?.blobs?.length) return false;
  // Cek kepemilikan ulang — alasan sama dengan downloadAudio di atas.
  if (saved.meetingId !== meeting.id) return false;
  download(`${meeting.title}-video.webm`, new Blob(saved.blobs, { type: 'video/webm' }));
  return true;
}

// Epoch guard: render async saling balapan (klik tab vs broadcast SW);
// pass yang kalah cepat tidak boleh menimpa DOM pass yang lebih baru.
let renderEpoch = 0;
let lastRenderedKey = null; // view terakhir yang digambar renderMeeting (id|live)
let audioMeta = null;       // hasil audio-meta terakhir
let audioMetaKey = null;    // view key yang menghasilkannya (null = wajib tanya lagi)
const momErrors = new Map(); // meetingId → pesan error MoM terakhir
let moreOpen = false;        // <details> "Lainnya" terbuka? bertahan antar render

async function render() {
  const epoch = ++renderEpoch;
  if (tab === 'live') return renderMeeting(status.id, true, epoch);
  if (tab === 'history') return viewingId ? renderMeeting(viewingId, false, epoch) : renderHistory(epoch);
  return renderSettings(epoch);
}

async function renderMeeting(id, live, epoch) {
  const meeting = id ? await getMeeting(id) : null;
  const viewKey = `${id}|${live}`;
  // Audio meta menentukan tombol "Unduh audio" & "Transkrip ulang" (hanya
  // rekaman TERAKHIR yang disimpan). Diambil SEBELUM replaceChildren supaya
  // rerender 2-detikan tidak membuat action bar + daftar segmen berkedip, dan
  // di-cache per view karena tiap panggilan = satu indexedDB.open.
  // undefined = pembacaan GAGAL (jangan di-cache, tombolnya harus bisa muncul
  // di render berikutnya), null = memang tak ada audio (aman di-cache).
  let meta = audioMeta;
  let metaKey = audioMetaKey;
  if (meeting?.source !== 'audio') { meta = null; metaKey = null; }
  else if (audioMetaKey !== viewKey) {
    const res = await globalThis.MeetAudioStore.loadAudioMeta().catch(() => undefined);
    meta = res ?? null;
    metaKey = res === undefined ? null : viewKey;
  }
  if (epoch !== renderEpoch) return; // pass lebih baru sudah jalan
  // Cache baru ditulis SETELAH epoch dicek: pass yang kalah balapan tidak boleh
  // menimpa hasil pass yang lebih baru, walau ia sudah terlanjur membacanya.
  audioMeta = meta;
  audioMetaKey = metaKey;
  const sameView = viewKey === lastRenderedKey;
  lastRenderedKey = viewKey;
  // Navigasi ke view lain: mulai dari bawah (live) / atas (riwayat).
  // Rerender view yang sama: pertahankan posisi baca.
  const stickToBottom = live && (!sameView || view.scrollHeight - view.scrollTop - view.clientHeight < 40);
  const prevTop = sameView ? view.scrollTop : 0;
  view.replaceChildren();

  // Tidak digate "Sumber transkrip": rekam audio boleh dipakai di mode caption
  // juga (caption jalan live, audio jadi cadangan/pelengkap yang ditranskrip
  // saat stop). Tanpa bar ini di mode caption, rekaman yang dimulai dari klik
  // kanan tidak punya tombol Stop, progres, maupun tempat errornya muncul.
  if (live && HAS_AUDIO) {
    const bar = el('div', 'actions');
    if (recState.transcribing) {
      bar.append(el('span', 'muted',
        recState.total ? `Mentranskrip… ${recState.done}/${recState.total}` : 'Mentranskrip…'));
    } else if (recState.recording) {
      const stop = el('button', null, 'Stop rekam');
      stop.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'stop-recording' }));
      bar.append(stop, el('span', 'muted', ' ● merekam'));
    } else {
      // tabCapture butuh invocation activeTab yang tidak diberikan tombol side
      // panel (batasan Chrome) — start dipicu dari context menu halaman Meet.
      bar.append(el('span', 'muted', 'Untuk mulai: klik kanan di halaman Meet → "Rekam audio meeting" (atau "Rekam audio + video meeting").'));
    }
    if (recState.error) bar.append(el('div', 'err', ' ' + recState.error));
    if (sttModeRemoved()) bar.append(el('div', 'warn', STT_REMOVED_NOTE));
    view.append(bar);
  }

  if (settingsCache.transcriptSource !== 'audio' && live && status.inCall && !status.captionsOn) {
    view.append(el('div', 'warn',
      'Caption mati. Nyalakan CC di toolbar Meet supaya transkrip terisi.'));
  }
  const quietSince = Math.max(status.lastSegmentAt || 0, status.captionsOnAt || 0);
  if (settingsCache.transcriptSource !== 'audio' && live && status.inCall && status.captionsOn && quietSince && Date.now() - quietSince > 30000) {
    view.append(el('div', 'warn',
      'Caption nyala tapi tidak ada teks masuk 30 detik terakhir. Kalau ada yang bicara, kemungkinan DOM Meet berubah — perbaiki content/selectors.js.'));
  }

  if (!meeting) {
    view.append(el('p', 'muted',
      live ? 'Tidak ada meeting aktif. Join Google Meet dulu.' : 'Meeting tidak ditemukan.'));
    return;
  }

  if (!live) {
    const back = el('button', null, '← Riwayat');
    back.addEventListener('click', () => { viewingId = null; render(); });
    view.append(back);
  }
  view.append(el('h2', null, meeting.title));
  view.append(el('p', 'muted', new Date(meeting.startedAt).toLocaleString()));

  if (momErrors.has(meeting.id)) view.append(el('div', 'error', momErrors.get(meeting.id)));

  // Error rekam/transkrip di atas hanya dicat di bar tab Live. Dicat juga di
  // sini supaya error (mis. "Transkrip kosong") ketemu tombol "Transkrip ulang"
  // di view meeting tersimpan. Digate ke meeting pemilik audio: recState.error
  // satu slot global, tanpa gate ini error rekaman meeting A ikut tercat di
  // meeting caption lama B yang tak punya tombolnya — persis kebingungan yang
  // mau dihilangkan.
  if (!live && recState.error && audioMeta?.meetingId === meeting.id) {
    view.append(el('div', 'err', recState.error));
  }

  // Dua baris tombol: yang dipakai tiap kali di atas, sisanya di balik
  // <details>. Panel cuma ~350px — tujuh tombol sejajar jadi empat baris dan
  // yang penting tenggelam di antaranya.
  const actions = el('div', 'actions');
  const more = el('div', 'actions');
  const btn = (label, fn, box = actions) => {
    const b = el('button', null, label);
    b.addEventListener('click', fn);
    box.append(b);
    return b;
  };
  // Label balik sendiri: tab Live menggambar ulang tiap 2 detik sehingga
  // tombolnya ter-reset, tapi view meeting di Riwayat tidak — di sana "Disalin ✓"
  // menetap selamanya dan klik berikutnya tak memberi umpan balik apa pun.
  const flash = (b, label, ms = 2000) => {
    const asli = b.dataset.label ?? (b.dataset.label = b.textContent);
    b.textContent = label;
    clearTimeout(Number(b.dataset.timer));
    b.dataset.timer = String(setTimeout(() => { b.textContent = asli; }, ms));
  };
  const copyBtn = btn('Copy', async () => {
    try {
      await navigator.clipboard.writeText(M.formatTranscript(meeting.segments));
      flash(copyBtn, 'Disalin ✓');
    } catch {
      flash(copyBtn, 'Gagal menyalin');
    }
  });
  // Prompt kosong tak berguna (Copy menyalin blank, Gemini auto-submit blank
  // message) — tombol ini hanya muncul kalau ada transkrip untuk diisi.
  if (meeting.segments.length) {
    const copyPromptBtn = btn('Copy Prompt+Transkrip', async () => {
      try {
        await navigator.clipboard.writeText(promptText(meeting));
        flash(copyPromptBtn, 'Disalin ✓');
      } catch {
        flash(copyPromptBtn, 'Gagal menyalin');
      }
    }, more);
    const gemBtn = btn('Kirim ke Gemini', async () => {
      gemBtn.disabled = true; // cegah klik ganda buka beberapa tab/percakapan Gemini
      gemBtn.textContent = 'Membuka Gemini…';
      const prompt = promptText(meeting);
      // Clipboard dulu: asuransi kalau injeksi gagal (DOM Gemini berubah).
      await navigator.clipboard.writeText(prompt).catch(() => {});
      chrome.runtime.sendMessage({ type: 'send-to-gemini', text: prompt });
      // Tab Live rerender ~2 detik sekali lewat broadcast status (tombol ini
      // ikut dibuat ulang, otomatis enable) — tab Riwayat tidak rerender
      // sendiri, jadi tanpa ini tombol tetap disabled selamanya kalau injeksi
      // gagal dan user harus pindah tab lalu balik untuk coba lagi.
      setTimeout(() => { gemBtn.disabled = false; gemBtn.textContent = 'Kirim ke Gemini'; }, 3000);
    }, more);
  }
  btn('Unduh .txt', () => download(`${meeting.title}.txt`, M.formatTranscript(meeting.segments)), more);
  btn('Unduh .md', () => download(`${meeting.title}.md`, M.formatMarkdown(meeting)), more);
  const momBtn = btn(meeting.mom ? 'Regenerate MoM' : 'Generate MoM', async () => {
    momBtn.disabled = true;
    momBtn.textContent = 'Menghasilkan…';
    momErrors.delete(meeting.id);
    const res = await chrome.runtime.sendMessage({ type: 'generate-mom', id: meeting.id })
      .catch(() => null);
    if (!res?.ok) momErrors.set(meeting.id, res?.error ?? 'Gagal menghubungi service worker.');
    render(); // state persisten + render(): epoch-safe, error tetap tampil setelah rerender
  });
  // Disembunyikan saat rekam/transkrip jalan: audio tersimpan masih milik
  // rekaman SEBELUMNYA, jadi menawarkannya di samping "Stop rekam" cuma
  // membingungkan — SW menolak kliknya juga.
  // Tombol audio disembunyikan selama rekam/transkrip (SW menolak kliknya), tapi
  // di tab Riwayat tidak ada bar progres seperti di Live — tanpa baris ini,
  // "Transkrip ulang" yang diklik dari sini membuat seluruh blok tombol LENYAP
  // tanpa kabar apa pun sampai selesai.
  if (!live && recState.transcribing && audioMeta?.meetingId === meeting.id) {
    actions.append(el('span', 'muted',
      recState.total ? `Mentranskrip… ${recState.done}/${recState.total}` : 'Mentranskrip…'));
  }
  // Gate audio (count) dan video (videoCount) DIPISAH: part video mendarat
  // tiap 60 detik, chunk audio baru tiap rotasi 10 menit — rekaman yang mati
  // di menit 5 punya video tersimpan tapi count audio masih 0, dan gate
  // gabungan menyembunyikan video yang sebenarnya bisa diselamatkan.
  if (audioMeta?.meetingId === meeting.id && (audioMeta.count > 0 || audioMeta.videoCount > 0)
    && !recState.recording && !recState.transcribing) {
    // count 0 = beginAudio sudah menulis meta tapi belum ada satu potongan pun
    // (rekaman mati sebelum rotasi pertama). Menawarkan Unduh/Transkrip ulang
    // di situ hanya berujung "Audio rekaman tidak tersimpan lagi".
    if (audioMeta.count > 0) {
      // Chunk disimpan sambil merekam, jadi tombol ini juga jalur penyelamat
      // kalau rekaman mati di tengah (browser ditutup) atau STT gagal total:
      // audionya tetap utuh sampai potongan terakhir yang sempat ditulis.
      const dlBtn = btn(`Unduh audio${audioMeta.count > 1 ? ` (${audioMeta.count} file)` : ''}`, async () => {
        dlBtn.disabled = true;
        const n = await downloadAudio(meeting).catch(() => 0);
        dlBtn.textContent = n ? `Diunduh ✓${n > 1 ? ` (${n} file)` : ''}` : 'Audio tidak ditemukan';
        dlBtn.disabled = false;
      }, more);
      // Chrome memblok unduhan beruntun sampai user mengizinkan sekali — tanpa
      // keterangan ini, file ke-2 dst tampak hilang begitu saja. Ikut ke dalam
      // <details>, bukan ke baris utama: keterangannya tak ada gunanya kalau
      // tombol yang dijelaskan sedang tersembunyi.
      if (audioMeta.count > 1) more.append(el('span', 'muted',
        'Beberapa file: izinkan "Download multiple files" kalau Chrome bertanya.'));
    }
    if (audioMeta.videoCount > 0) {
      const vBtn = btn('Unduh video', async () => {
        vBtn.disabled = true;
        const ok = await downloadVideo(meeting).catch(() => false);
        vBtn.textContent = ok ? 'Diunduh ✓' : 'Video tidak ditemukan';
        vBtn.disabled = false;
      }, more);
    }
    if (audioMeta.count > 0) {
      const reBtn = btn('Transkrip ulang', async () => {
        reBtn.disabled = true;
        reBtn.textContent = 'Mentranskrip…';
        momErrors.delete(meeting.id);
        const res = await chrome.runtime.sendMessage(
          { type: 'regenerate-transcript', id: meeting.id }).catch(() => null);
        if (!res?.ok) {
          momErrors.set(meeting.id, res?.error ?? 'Gagal menghubungi service worker.');
          render();
        }
        // Sukses: hasil datang lewat broadcast meeting-updated, panel rerender sendiri.
      });
    }
  }
  view.append(actions);
  // <details> native: disclosure yang benar tanpa satu baris JS pun untuk
  // buka-tutupnya. Yang perlu ditulis sendiri cuma mengingat posisinya —
  // tab Live merender ulang tiap 2 detik, dan tanpa ini menu yang baru dibuka
  // menutup sendiri di depan mata user.
  if (more.children.length) {
    const box = el('details', 'more');
    box.open = moreOpen;
    box.addEventListener('toggle', () => { moreOpen = box.open; });
    box.append(el('summary', null, 'Lainnya'), more);
    view.append(box);
  }

  const list = el('div');
  for (const s of meeting.segments) {
    const seg = el('div', 'seg');
    const head = el('div');
    head.append(el('span', 'who', s.speaker), el('span', 'time', new Date(s.t).toLocaleTimeString()));
    seg.append(head, el('div', null, s.text));
    list.append(seg);
  }
  if (!meeting.segments.length) list.append(el('p', 'muted', 'Belum ada caption masuk.'));
  view.append(list);

  if (meeting.mom) {
    view.append(el('h3', null, 'MoM'));
    view.append(el('div', 'mom', meeting.mom));
  }
  view.scrollTop = stickToBottom ? view.scrollHeight : prevTop;
}

async function renderHistory(epoch) {
  const { meetings = [] } = await chrome.storage.local.get('meetings');
  const items = (await Promise.all(meetings.map(getMeeting))).filter(Boolean);
  if (epoch !== renderEpoch) return;
  lastRenderedKey = null;
  view.replaceChildren();
  if (!items.length) {
    view.append(el('p', 'muted', 'Belum ada riwayat.'));
    return;
  }
  for (const m of items) {
    const item = el('button', 'item');
    item.append(
      el('div', 'who', m.title),
      el('div', 'muted',
        `${new Date(m.startedAt).toLocaleString()} — ${m.segments.length} segmen${m.mom ? ' — MoM ✓' : ''}`)
    );
    item.addEventListener('click', () => { viewingId = m.id; render(); });
    view.append(item);
  }
}

async function renderSettings(epoch) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  if (epoch !== renderEpoch) return;
  lastRenderedKey = null;
  view.replaceChildren();
  view.append(el('h2', null, 'Settings'));

  // Tiap field dibungkus satu div supaya barisnya (label + input) bisa
  // disembunyikan utuh: field STT yang tidak relevan dengan mode terpilih
  // hanya bikin bingung, dan label yatim lebih buruk lagi.
  const rowOf = new WeakMap();
  const field = (label, input) => {
    const row = el('div');
    row.append(el('label', null, label), input);
    view.append(row);
    rowOf.set(input, row);
    return input;
  };
  const show = (input, on) => { rowOf.get(input).hidden = !on; };
  const DEFAULT_BASE = globalThis.MeetOpenAI.DEFAULT_BASE_URL;
  const baseUrl = field('Base URL (OpenAI-compatible)',
    Object.assign(document.createElement('input'), { value: settings.baseUrl ?? DEFAULT_BASE }));
  const apiKey = field('API key',
    Object.assign(document.createElement('input'), { type: 'password', value: settings.apiKey ?? '' }));
  const model = field('Model',
    Object.assign(document.createElement('input'), { value: settings.model ?? 'gpt-4o-mini' }));
  const template = field('Template MoM ({{transcript}} = transkrip)',
    Object.assign(document.createElement('textarea'), { value: settings.momTemplate ?? M.DEFAULT_MOM_TEMPLATE }));

  const source = field('Sumber transkrip',
    Object.assign(document.createElement('select'), { innerHTML: '' }));
  for (const [val, label] of [['caption', 'Caption Meet'], ['audio', 'Rekam audio']]) {
    source.append(Object.assign(document.createElement('option'), { value: val, textContent: label }));
  }
  source.value = settings.transcriptSource ?? 'caption';

  // Seluruh blok STT hanya berarti kalau transkrip datang dari audio. Sumber
  // caption tidak menyentuh STT sama sekali — menampilkan mode, info, dan
  // empat field-nya cuma menyuruh user mengonfigurasi sesuatu yang tak dipakai.
  const audioMode = () => source.value === 'audio';

  const ST = globalThis.MeetStt;
  const sttModeSel = field('Mode STT',
    Object.assign(document.createElement('select'), { innerHTML: '' }));
  for (const [val, label] of [
    ['whisper-local', 'Whisper lokal (server sendiri)'],
    ['api', '9Router / STT API'],
  ]) {
    sttModeSel.append(Object.assign(document.createElement('option'), { value: val, textContent: label }));
  }
  sttModeSel.value = ST.sttMode(settings);

  // Info per mode, langsung di bawah dropdown. Mode API tidak punya baris ini:
  // field-nya (URL, key, model, bahasa) sudah menerangkan dirinya sendiri.
  const INFO = {
    'whisper-local': 'Audio dikirim ke server whisper OpenAI-compatible milikmu sendiri '
      + '(whisper.cpp, faster-whisper, dll) di URL di bawah. Audio tidak keluar dari '
      + 'jaringanmu, tapi servernya harus sudah jalan sebelum mulai merekam — kalau mati, '
      + 'transkrip gagal dan audionya tersimpan untuk diulang.',
  };
  const sttInfo = el('div', 'info');
  view.append(sttInfo);
  // Dicat di sini juga, bukan cuma di tab Live: Settings adalah tempat
  // memperbaikinya, dan dropdown di atas sudah terlanjur menampilkan mode
  // hasil resolusi seolah-olah itu memang pilihan user selama ini. Dibaca
  // dari `settings` (storage segar), bukan settingsCache — view ini tidak
  // ikut dirender ulang oleh onChanged.
  const sttRemovedNote = settings.sttMode === 'browser' ? el('div', 'warn', STT_REMOVED_NOTE) : null;
  if (sttRemovedNote) view.append(sttRemovedNote);

  // Kosong TIDAK ditampilkan apa adanya untuk whisper-local: sttEndpoint
  // memakai WHISPER_DEFAULT kalau URL-nya kosong, jadi field kosong berarti UI
  // menyembunyikan URL yang sebenarnya dipakai — terlihat seperti setelan yang
  // hilang padahal request-nya tetap jalan ke localhost:8080.
  const savedMode = ST.sttMode(settings);
  const initialUrl = settings.sttBaseUrl || (savedMode === 'api' ? '' : ST.WHISPER_DEFAULT);
  const sttBaseUrl = field('STT Base URL',
    Object.assign(document.createElement('input'), { value: initialUrl }));
  const sttApiKey = field('STT API key (kosong = tanpa auth)',
    Object.assign(document.createElement('input'), { type: 'password', value: settings.sttApiKey ?? '' }));
  const sttModel = field('Model STT',
    Object.assign(document.createElement('input'), { value: settings.sttModel ?? ST.DEFAULT_API_MODEL }));
  const sttLanguage = field('Bahasa STT (mis. id, en — kosong = auto)',
    Object.assign(document.createElement('input'), { value: settings.sttLanguage ?? ST.DEFAULT_LANGUAGE }));

  // Mode menentukan field mana yang relevan. URL/key/model/bahasa tetap
  // tersimpan walau tersembunyi supaya pindah mode bolak-balik tidak
  // menghapus konfigurasi yang sudah benar.
  function applyMode() {
    const audio = HAS_AUDIO && audioMode();
    const m = sttModeSel.value;
    // Field tetap DIBUAT (doSave membaca value-nya, jadi setelan STT yang
    // tersimpan tidak hangus saat Simpan di Firefox) — cuma barisnya yang hilang.
    show(source, HAS_AUDIO);
    show(sttModeSel, audio);
    show(sttBaseUrl, audio);
    show(sttApiKey, audio && m === 'api');
    show(sttModel, audio && m === 'api');
    // whisper-local IKUT mengirim language ke servernya (sttEndpoint), jadi
    // menyembunyikan field-nya berarti nilainya dipakai tapi tak bisa diubah.
    show(sttLanguage, audio);
    const info = audio && INFO[m];
    sttInfo.textContent = info ? 'ⓘ ' + INFO[m] : '';
    sttInfo.hidden = !info;
  }
  // Pindah sumber transkrip menyembunyikan/memunculkan seluruh blok STT.
  source.addEventListener('change', applyMode);
  // Satu field dipakai dua mode yang bentuk URL-nya sama sekali berbeda
  // (localhost whisper vs endpoint STT publik), jadi isinya diingat PER MODE.
  // Sebelumnya berpindah mode menimpa/mengosongkan field begitu saja: URL yang
  // sudah diketik lenyap dalam sekali klik, dan kalau lalu ditekan Simpan yang
  // tersimpan adalah kosong — persis seperti "STT Base URL tidak disimpan".
  const urlByMode = { 'whisper-local': ST.WHISPER_DEFAULT, api: '' };
  let urlMode = savedMode === 'api' ? 'api' : 'whisper-local';
  urlByMode[urlMode] = initialUrl;
  sttModeSel.addEventListener('change', () => {
    urlByMode[urlMode] = sttBaseUrl.value.trim(); // simpan yang sedang tampil
    urlMode = sttModeSel.value;
    sttBaseUrl.value = urlByMode[urlMode];
    applyMode();
  });
  applyMode();

  const note = el('span', 'muted', '');
  const setNote = (cls, text) => { note.className = cls; note.textContent = ' ' + text; };

  const normalizedBase = () => (baseUrl.value.trim() || DEFAULT_BASE).replace(/\/+$/, '');
  const sttBaseValue = () => sttBaseUrl.value.trim().replace(/\/+$/, '');
  // Yang DIPAKAI untuk jaringan: sumber caption tidak menyentuh STT sama sekali —
  // tak boleh memunculkan dialog izin host untuk server yang tidak akan dihubungi.
  const sttBaseForNetwork = () => (audioMode() ? sttBaseValue() : '');

  // Minta izin chat + STT sekaligus: dua request permintaan berurutan di
  // satu klik kehilangan user activation di antara dialog (throw "must be
  // called during a user gesture") — satu dialog gabungan menghindari itu.
  // Dipakai baik oleh Simpan maupun Tes koneksi.
  // invalidUrl ditandai di objek error, bukan dicocokkan dari teks pesannya:
  // pemanggil harus bisa membedakan "URL-nya salah, jangan simpan" dari "izin
  // ditolak, tetap simpan" — dan pencocokan awalan teks diam-diam gagal begitu
  // ada pesan baru yang tidak memakai awalan itu.
  const badUrl = (m) => Object.assign(new Error(m), { invalidUrl: true });
  async function ensureOrigins(bases) {
    const patterns = [];
    for (const b of bases) {
      // new URL() saja terlalu longgar: "localhost:8080/v1" (skema lupa diketik)
      // ikut parse jadi protocol "localhost:" + hostname kosong, lolos ke
      // permissions.request sebagai pattern rusak. Wajib http/https + hostname.
      let u;
      try { u = new URL(b); } catch { u = null; }
      if (!u || !/^https?:$/.test(u.protocol) || !u.hostname) throw badUrl(`URL tidak valid: ${b}`);
      // Match pattern Chrome tidak mengenal literal IPv6 sama sekali — pattern
      // "http://[::1]/*" ditolak permissions.request, dan penolakan itu tampil
      // sebagai "izin ditolak" yang menyesatkan. Katakan sebabnya.
      if (u.hostname.startsWith('[')) {
        throw badUrl(`Alamat IPv6 tidak didukung Chrome: ${b}. Pakai 127.0.0.1 atau nama host.`);
      }
      // Match pattern Chrome tidak boleh berisi port — pakai hostname saja
      // (pattern tanpa port otomatis mencakup semua port, mis. localhost:20128).
      const p = `${u.protocol}//${u.hostname}/*`;
      if (p !== 'https://api.openai.com/*') patterns.push(p);
    }
    if (!patterns.length) return;
    if (!await chrome.permissions.request({ origins: [...new Set(patterns)] }).catch(() => false)) {
      throw new Error(`Izin akses ${patterns.join(', ')} ditolak.`);
    }
  }

  // GET /models saja: cukup deteksi typo URL / API key kosong-salah tanpa
  // butuh file audio sungguhan. 404/405/501 tetap dianggap OK (warning) —
  // sebagian server tidak menyediakan /models sama sekali.
  async function probeStt(base, key) {
    const host = new URL(base).hostname;
    let res;
    try {
      res = await fetch(`${base}/models`, key ? { headers: { Authorization: `Bearer ${key}` } } : {});
    } catch {
      throw new Error(`Tidak bisa terhubung ke STT ${host}.`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`STT ${host}: HTTP ${res.status} (STT API key salah/kosong?)`);
    }
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      // Sebagian server whisper tidak melayani GET /models sama sekali —
      // 405/501 sama artinya dengan 404 di sini, bukan kegagalan.
      return ` (STT ${host}: endpoint /models tak didukung server — HTTP ${res.status}, cek manual.)`;
    }
    if (!res.ok) throw new Error(`STT ${host}: HTTP ${res.status}`);
    return '';
  }

  const test = el('button', null, 'Tes koneksi');
  test.addEventListener('click', async () => {
    test.disabled = true;
    setNote('muted', 'Menguji…');
    try {
      const base = normalizedBase();
      const sttBase = sttBaseForNetwork();
      // Kedua origin diminta sekaligus di sini, sebelum testConnection (yang
      // bisa >5 detik) — request izin kedua setelah round-trip jaringan sudah
      // lewat batas user activation dan gagal ("must be called during a user
      // gesture"), yang salah dilaporkan sebagai izin ditolak.
      await ensureOrigins(sttBase ? [base, sttBase] : [base]);
      await globalThis.MeetOpenAI.testConnection({
        apiKey: apiKey.value.trim(),
        model: model.value.trim() || 'gpt-4o-mini',
        baseUrl: base,
      });
      const sttNote = sttBase ? await probeStt(sttBase, sttApiKey.value.trim()) : '';
      setNote('ok', `✓ Koneksi OK${sttBase ? ' (chat + STT)' : ''} — URL, API key, dan model valid.${sttNote}`);
    } catch (e) {
      setNote('err', '✗ Gagal: ' + (e?.message ?? e));
    } finally {
      // finally, bukan setelah catch: apa pun yang dilempar di dalam catch
      // meninggalkan tombol ini disabled selamanya.
      test.disabled = false;
    }
  });

  const save = el('button', null, 'Simpan');
  save.addEventListener('click', async () => {
    // Klik ganda memunculkan dua dialog izin dan dua penulisan settings.
    if (save.disabled) return;
    save.disabled = true;
    try {
      await doSave();
    } finally {
      save.disabled = false;
    }
  });

  async function doSave() {
    const base = normalizedBase();
    const sttBase = sttBaseForNetwork();
    let warning = null;
    try {
      await ensureOrigins(sttBase ? [base, sttBase] : [base]);
    } catch (e) {
      // URL rusak → jangan simpan. Editan lain tetap utuh di form (tidak ada
      // rerender), jadi tinggal perbaiki URL-nya lalu Simpan lagi.
      if (e.invalidUrl) return setNote('err', e.message);
      warning = e.message; // izin ditolak → tetap simpan, tapi beri tahu
    }
    await chrome.storage.local.set({
      settings: {
        apiKey: apiKey.value.trim(),
        baseUrl: base,
        model: model.value.trim() || 'gpt-4o-mini',
        momTemplate: template.value,
        transcriptSource: source.value,
        sttMode: sttModeSel.value,
        sttModel: sttModel.value.trim() || ST.DEFAULT_API_MODEL,
        sttLanguage: sttLanguage.value.trim(),
        sttBaseUrl: sttBaseValue(),
        sttApiKey: sttApiKey.value.trim(),
      },
    });
    // Simpan menulis mode hasil resolusi, jadi peringatan "mode browser
    // dihapus" tidak berlaku lagi. View ini tidak dirender ulang setelah
    // Simpan — tanpa baris ini peringatannya menetap padahal user sudah
    // melakukan persis yang disuruh.
    if (sttRemovedNote) sttRemovedNote.hidden = true;
    if (warning) setNote('err', `Tersimpan, tapi ${warning} Request bisa gagal.`);
    else setNote('ok', 'Tersimpan.');
  }

  const actions = el('div', 'actions');
  actions.append(test, save, note);
  view.append(actions);

  // Backup seluruh data (riwayat+MoM+settings+rekaman terakhir) ke satu zip,
  // dan import-nya. Satu-satunya jalur selamat data melewati uninstall.
  view.append(el('h3', null, 'Backup'));
  const bnote = el('span', 'muted', '');
  const setBnote = (cls, text) => { bnote.className = cls; bnote.textContent = ' ' + text; };
  const exportBtn = el('button', null, 'Export backup (.zip)');
  exportBtn.addEventListener('click', async () => {
    // Digate sama seperti import: rekaman yang sedang jalan baru menulis
    // potongan tiap rotasi, jadi zip yang dibuat sekarang memuat rekaman
    // separuh jadi — dan cacatnya baru ketahuan saat file itu di-restore.
    if (recState.recording || recState.transcribing) {
      return setBnote('err', '✗ Rekaman/transkrip sedang berjalan — backup akan memuat rekaman separuh. Stop dulu.');
    }
    exportBtn.disabled = true;
    setBnote('muted', 'Menyusun zip…'); // rekaman video besar — bisa beberapa detik
    try {
      const zip = await globalThis.MeetBackup.exportBackup();
      download(`meet-transcript-backup-${new Date().toISOString().slice(0, 10)}.zip`, zip);
      setBnote('ok', `✓ Backup siap (${(zip.size / 1048576).toFixed(1)} MB).`);
    } catch (e) {
      setBnote('err', '✗ Export gagal: ' + (e?.message ?? e));
    } finally {
      exportBtn.disabled = false;
    }
  });
  const importInput = Object.assign(document.createElement('input'),
    { type: 'file', accept: '.zip,application/zip', hidden: true });
  const importBtn = el('button', null, 'Import backup');
  importBtn.addEventListener('click', () => { importInput.value = ''; importInput.click(); });
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    // Import men-clear storage — rekaman/transkrip yang sedang berjalan akan
    // menulis ke record yang barusan dihapus/diganti. Tolak, jangan menunggu.
    if (recState.recording || recState.transcribing) {
      return setBnote('err', '✗ Rekaman/transkrip sedang berjalan — stop dulu sebelum import.');
    }
    if (!confirm('Import MENGGANTI seluruh data sekarang (riwayat, settings, rekaman tersimpan). Lanjut?')) return;
    importBtn.disabled = true;
    setBnote('muted', 'Mengimpor…');
    try {
      const r = await globalThis.MeetBackup.importBackup(file);
      await loadSettings();
      audioMetaKey = null; // cache meta lama tidak berlaku lagi
      // Rekaman gagal di-restore TIDAK dilaporkan sebagai "import gagal":
      // transkrip & settings sudah masuk, dan menyebutnya gagal membuat user
      // mengira data lamanya masih utuh — padahal sudah tertimpa.
      alert(r.audioError
        ? `Import selesai SEBAGIAN: ${r.meetings} meeting masuk, tapi rekaman audio/video gagal di-restore (${r.audioError}). Data lama sudah tergantikan.`
        : `Import selesai: ${r.meetings} meeting, ${r.chunks} potongan rekaman.`);
      // Render ulang WAJIB: form masih berisi nilai pra-import, dan "Simpan"
      // dari form basi itu menimpa settings yang barusan di-import.
      render();
    } catch (e) {
      setBnote('err', '✗ Import gagal: ' + (e?.message ?? e));
    } finally {
      importBtn.disabled = false;
    }
  });
  const backupRow = el('div', 'actions');
  backupRow.append(exportBtn, importBtn, importInput, bnote);
  view.append(backupRow);
}

chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && c.settings) { settingsCache = c.settings.newValue ?? {}; if (tab === 'live') render(); }
});

(async () => {
  await loadSettings();
  const a = await chrome.runtime.sendMessage({ type: 'get-active' }).catch(() => null);
  if (a) status = a;
  if (a?.rec) recState = { ...recState, recording: a.rec.recording, transcribing: a.rec.transcribing };
  render();
})();

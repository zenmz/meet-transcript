// background/service-worker.js
// Firefox: bukan service worker — script lain dimuat lewat background.scripts
// di manifest.firefox.json (urutannya harus sama dengan daftar ini).
if (typeof importScripts === 'function') {
  importScripts('/lib/merge.js', '/lib/openai.js', '/lib/stt.js', '/lib/audiostore.js');
}

chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true });
// Firefox: tidak ada sidePanel — klik ikon toolbar men-toggle sidebar. toggle()
// wajib dipanggil sinkron di dalam handler (butuh user gesture). Di Chrome
// listener ini tidak didaftarkan; klik ikon sudah ditangani setPanelBehavior.
if (chrome.sidebarAction) {
  chrome.action.onClicked.addListener(() => chrome.sidebarAction.toggle());
}

// Status meeting aktif. Hilang saat SW idle-restart — dipulihkan oleh pesan
// status content script (tiap 2 detik) begitu SW bangun lagi.
let active = { id: null, inCall: false, captionsOn: false, lastSegmentAt: 0, captionsOnAt: 0 };

function notifyPanel(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {}); // panel tertutup → abaikan
}

// Titik merekam di ikon toolbar: indikator saat panel ditutup.
chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
chrome.action.setBadgeTextColor?.({ color: '#ffffff' }); // titik putih di badge merah
function updateBadge() {
  const recording = (active.inCall && active.captionsOn) || rec.recording;
  chrome.action.setBadgeText({ text: recording ? '●' : '' });
}

// Mode audio: state rekaman + lifecycle offscreen document.
let rec = { recording: false, transcribing: false, meetingId: null };

// Judul tab Meet: Chrome menaruh "Meet" di DEPAN (`Meet – abc-defg-hij`), tapi
// bentuk trailing " - Google Meet" juga muncul di sebagian versi/locale.
// Sisa yang kosong atau cuma meeting id bukan judul yang berguna.
function titleFromTab(tabTitle, meetingId) {
  const t = String(tabTitle ?? '')
    .replace(/^Meet\s*[-—–]\s*/, '')
    .replace(/\s*[-—–]\s*Google Meet\s*$/, '')
    .trim();
  return !t || t === meetingId ? meetingId : t;
}

function broadcastRec(extra = {}) {
  notifyPanel({ type: 'rec-state', recording: rec.recording, transcribing: rec.transcribing, ...extra });
}

// getContexts butuh Chrome 116 — itulah lantai versi ekstensi ini, bukan 114
// (sidePanel). Fallback chrome.offscreen.hasDocument sengaja TIDAK dipakai:
// API itu baru ada di Chrome 150+, jadi cabangnya tak pernah tereksekusi di
// Chrome mana pun, sementara diam-diam mengembalikan false di 114–115 justru
// membuat stopRecording menyerah tanpa memfinalisasi rekaman.
async function hasOffscreen() {
  // Firefox tidak punya getContexts MAUPUN offscreen. Guard di sini, bukan di
  // pemanggil: stopRecording tetap dipanggil dari finish() tiap meeting usai,
  // dan tanpa guard ini tiap penutupan meeting melempar unhandled rejection.
  if (!chrome.runtime.getContexts) return false;
  const c = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).catch(() => []);
  return c.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Merekam audio tab Meet untuk transkrip.',
  });
}

// Start rekam dipicu dari context menu halaman Meet: klik context menu memberi
// invocation activeTab yang dibutuhkan tabCapture.getMediaStreamId — tombol
// side panel tidak (batasan Chrome).
const MEET_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
function meetingIdFromUrl(url) {
  try {
    const p = new URL(url).pathname.slice(1);
    return MEET_RE.test(p) ? p : null;
  } catch {
    return null;
  }
}

// Rekam audio butuh tabCapture — tidak ada di Firefox, jadi menu klik-kanan
// dan seluruh jalur start-nya tidak didaftarkan sama sekali di sana.
if (chrome.tabCapture) {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: 'rec-start', title: 'Rekam audio meeting',
        contexts: ['page'], documentUrlPatterns: ['https://meet.google.com/*'] });
      chrome.contextMenus.create({ id: 'rec-stop', title: 'Stop rekam audio',
        contexts: ['page'], documentUrlPatterns: ['https://meet.google.com/*'] });
    });
  });

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'rec-start') {
      // Cek sebelum getMediaStreamId: klik saat sudah merekam tak boleh masuk
      // catch (yang akan reset state palsu padahal rekaman jalan terus).
      if (rec.recording || rec.transcribing || await hasOffscreen()) {
        broadcastRec({ error: 'Rekaman masih berjalan.' });
        return;
      }
      // HANYA dari URL tab yang diklik — tanpa fallback ke active.id. tabCapture
      // merekam TAB INI; kalau ini bukan halaman ruang, yang terekam adalah
      // halaman landing yang sunyi, sementara meeting sungguhan di tab lain yang
      // kena akibatnya: source-nya dibalik jadi audio, endedAt dihapus, dan
      // audio tersimpannya dibuang oleh beginAudio.
      const meetingId = meetingIdFromUrl(tab?.url);
      if (!meetingId) {
        broadcastRec({ error: 'Buka halaman ruang Meet-nya dulu — rekaman mengambil audio tab ini.' });
        return;
      }
      try {
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        await startRecording({ streamId, meetingId, title: titleFromTab(tab?.title, meetingId) });
      } catch (e) {
        // TIDAK mereset rec di sini: klik kedua yang ditolak karena rekaman
        // pertama sedang jalan juga mendarat di sini, dan resetnya akan mematikan
        // status rekaman yang sehat (badge padam, tombol Stop hilang, dan saat
        // meeting selesai onDisconnect melihat recording:false sehingga rekaman
        // tak pernah difinalisasi). startRecording yang mereset miliknya sendiri.
        broadcastRec({ error: e.message });
      }
    } else if (info.menuItemId === 'rec-stop') {
      stopRecording();
    }
  });
}

// Konfigurasi STT untuk pesan ke offscreen. Satu tempat: start & retranscribe
// harus memakai aturan endpoint/model/bahasa yang persis sama.
async function sttConfig() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const stt = globalThis.MeetStt.sttEndpoint(settings);
  return {
    sttMode: stt.mode, baseUrl: stt.baseUrl, apiKey: stt.apiKey,
    sttModel: stt.model, sttLanguage: stt.language, sttBrowserModel: stt.sttBrowserModel,
  };
}

// Start yang sedang berjalan. stopRecording menunggunya: tanpa itu, klik Stop
// (atau tab Meet yang ditutup) di detik-detik startup membuat SW mereset rec
// jadi idle, lalu start selesai dan offscreen merekam sungguhan — rekaman jalan
// tanpa badge, tanpa tombol Stop, dan semua start berikutnya ditolak.
let startPromise = null;

async function startRecording({ streamId, meetingId, title }) {
  // Guard + klaim SINKRON, sebelum await mana pun: dua klik context menu
  // beruntun sama-sama lolos pre-check di pemanggil (yang punya await sendiri),
  // dan tanpa klaim di sini keduanya masuk dan yang kedua merusak state yang
  // pertama.
  if (rec.recording || rec.transcribing) throw new Error('Rekaman masih berjalan.');
  const baseTime = Date.now();
  rec = { recording: true, transcribing: false, meetingId };
  updateBadge();
  startPromise = (async () => {
    if (await hasOffscreen()) throw new Error('Rekaman masih berjalan.');
    await startRecordingInner({ streamId, meetingId, title, baseTime });
  })();
  try {
    await startPromise;
  } catch (e) {
    rec = { recording: false, transcribing: false, meetingId: null };
    updateBadge();
    // Dokumen offscreen bisa sudah TERLANJUR dibuat sebelum kegagalan. Kalau
    // dibiarkan, hasOffscreen() true selamanya dan tiap start berikutnya
    // ditolak "Rekaman masih berjalan." sampai browser di-restart.
    chrome.offscreen?.closeDocument?.().catch(() => {});
    broadcastRec();
    throw e;
  } finally {
    startPromise = null;
  }
}

async function startRecordingInner({ streamId, meetingId, title, baseTime }) {
  const stt = await sttConfig();
  await ensureOffscreen();
  // error: null eksplisit — panel mempertahankan error/peringatan terakhir
  // sampai ada yang menghapusnya, dan rekaman BARU adalah satu-satunya
  // peristiwa yang boleh menghapus keluhan rekaman sebelumnya.
  broadcastRec({ error: null });
  // Dicatat begitu rekam mulai, tidak menunggu transkrip: tombol "Unduh audio"
  // & "Transkrip ulang" cuma hidup di dalam entri Riwayat, jadi tanpa ini
  // rekaman yang STT-nya gagal total tak terjangkau layar mana pun. Judul ikut
  // dicatat sekarang — saat transkrip selesai, tab-nya bisa sudah ditutup.
  // Balasan diperiksa, bukan cuma "tidak reject": side panel yang terbuka juga
  // sebuah receiving end, jadi sendMessage tetap resolve walau dokumen offscreen
  // tidak ada — dan panel terbuka adalah keadaan NORMAL (di situ tombol Stop-nya).
  // Tanpa cek ini rec macet recording:true: badge menyala, start & regenerate
  // berikutnya ditolak selamanya padahal tidak ada yang merekam.
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen', op: 'start', streamId, meetingId, ...stt,
    chunkMs: 600000, baseTime,
  }).catch((e) => ({ ok: false, error: e.message }));
  if (!res?.ok) throw new Error('Offscreen tidak merespons — rekaman tidak dimulai.');
  // Dicatat SETELAH start dikonfirmasi: start yang gagal tidak boleh membalik
  // meeting caption yang sudah ada jadi source:'audio' dan menghapus endedAt-nya,
  // atau meninggalkan entri Riwayat kosong untuk rekaman yang tak pernah terjadi.
  enqueueWrite(() => ensureMeeting({ meetingId, title, startedAt: baseTime }));
}

// Transkrip ulang dari audio tersimpan: offscreen yang mengerjakan (bukan SW —
// SW MV3 bisa dimatikan di tengah loop upload yang panjang).
async function regenerateTranscript(meetingId) {
  if (rec.recording || rec.transcribing) throw new Error('Rekaman/transkrip masih berjalan.');
  // rec di-set SEBELUM await pertama: ini satu-satunya penyerialisasi transkrip.
  // Kalau dipasang setelah await (mis. setelah loadAudioMeta), dua panggilan
  // regenerate-transcript beruntun (klik ganda dari panel) sama-sama lolos
  // guard di atas sebelum salah satu sempat menandai transcribing — dua loop
  // transkrip jalan bersamaan dan meeting yang sama dapat dua audio-transcript.
  rec = { recording: false, transcribing: true, meetingId };
  updateBadge();
  broadcastRec({ error: null }); // percobaan baru → keluhan percobaan lama dihapus
  try {
    // Tidak ada cek hasOffscreen() di sini: dokumen offscreen ditutup secara
    // fire-and-forget setelah transkrip selesai, jadi klik di sela penutupan itu
    // akan salah ditolak — dan kalau closeDocument gagal (rejection-nya ditelan),
    // transkrip ulang terblokir selamanya. Penjaganya ada di offscreen sendiri
    // (busy || recorder), yang justru selamat dari restart SW dan membalas
    // {ok:false}; balasan itu diperiksa di bawah.
    const meta = await globalThis.MeetAudioStore.loadAudioMeta();
    if (!meta) throw new Error('Tidak ada audio tersimpan.');
    if (meta.meetingId !== meetingId) {
      throw new Error('Audio tersimpan milik meeting lain — hanya rekaman terakhir yang disimpan.');
    }
    const stt = await sttConfig();
    await ensureOffscreen();
    // Balasan diperiksa, bukan cuma "tidak reject": side panel yang terbuka
    // juga sebuah receiving end, jadi sendMessage tetap resolve walau offscreen
    // sudah tertutup — dan rec.transcribing macet true tanpa ada yang bekerja.
    // Panel tidak pernah membalas pesan ini, jadi balasan offscreen yang menang.
    const res = await chrome.runtime.sendMessage({
      target: 'offscreen', op: 'retranscribe', meetingId, ...stt,
    });
    if (!res?.ok) throw new Error(res?.error || 'Offscreen tidak merespons — transkrip ulang tidak dimulai.');
  } catch (e) {
    // Gagal sebelum offscreen mulai kerja → rec harus balik, jangan macet di
    // transcribing (memblok start/stop rekam & regenerate berikutnya selamanya).
    rec = { recording: false, transcribing: false, meetingId: null };
    updateBadge();
    broadcastRec();
    throw e;
  }
}

async function stopRecording() {
  // Start yang masih jalan ditunggu dulu — lihat komentar di startPromise.
  if (startPromise) await startPromise.catch(() => {});
  // rec.transcribing → stop kedua (double-click) diblok: cegah transkrip dobel.
  if (rec.transcribing || (!rec.recording && !(await hasOffscreen()))) return;
  rec.recording = false;
  rec.transcribing = true;
  updateBadge();
  broadcastRec();
  // Balasan diperiksa, bukan cuma "tidak reject" — lihat alasannya di
  // startRecordingInner. Tanpa ini, klik Stop yang mendarat di sela penutupan
  // dokumen offscreen membuat transcribing macet true SELAMANYA: tak ada
  // audio-transcript yang akan datang, dan start/stop/regenerate ditolak terus.
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', op: 'stop' })
    .catch(() => null);
  if (res?.ok) return;                 // offscreen mengerjakannya, tunggu audio-transcript
  if (res?.busy) {                     // transkrip memang jalan — transcribing tetap true
    broadcastRec({ error: res.error });
    return;
  }
  rec = { recording: false, transcribing: false, meetingId: null };
  updateBadge();
  broadcastRec({ error: res?.error ?? 'Offscreen tidak merespons — rekaman dihentikan tanpa transkrip.' });
}

// Kode ruang Meet permanen per link, jadi occurrence baru meeting recurring
// datang dengan meetingId yang SAMA. Record lama yang sudah stale (lihat
// isStaleMeeting) diarsip ke id `kode@timestamp` dan key kode ruang diserahkan
// ke record segar — tanpa ini transkrip standup hari ini menyambung ke record
// kemarin. Memutasi `data` milik pemanggil (data[key] dihapus, data.meetings
// diganti id arsip) lalu pemanggil membuat record segar seperti biasa. Wajib
// dipanggil dari dalam enqueueWrite, seperti pemanggilnya.
async function archiveIfStale(meetingId, data) {
  const key = 'meeting:' + meetingId;
  const old = data[key];
  if (!old || !globalThis.MeetMerge.isStaleMeeting(old, Date.now())) return;
  const lastActivity = globalThis.MeetMerge.lastActivityAt(old);
  const archiveId = `${meetingId}@${lastActivity}`;
  const meetings = data.meetings ?? [];
  const i = meetings.indexOf(meetingId);
  if (i !== -1) meetings[i] = archiveId; else meetings.unshift(archiveId);
  data.meetings = meetings;
  // endedAt diisi kalau kosong (sesi crash): record arsip sudah pasti selesai.
  await chrome.storage.local.set({
    ['meeting:' + archiveId]: { ...old, id: archiveId, endedAt: old.endedAt ?? lastActivity },
  });
  await chrome.storage.local.remove(key);
  delete data[key];
  // Audio tersimpan milik sesi lama ikut pindah ke id arsip — "Unduh audio" &
  // "Transkrip ulang" tinggal di view record, jadi tanpa retag ini audionya
  // yatim. Gagal retag ditelan: akibat terburuknya persis perilaku lama.
  await globalThis.MeetAudioStore.retagAudioMeta(meetingId, archiveId, lastActivity).catch(() => {});
  notifyPanel({ type: 'meeting-updated', id: archiveId });
}

// Catat meeting tanpa menyentuh segmen: dipakai saat rekaman MULAI, sebelum
// ada satu pun hasil transkrip.
async function ensureMeeting({ meetingId, title, startedAt }) {
  const key = 'meeting:' + meetingId;
  const data = await chrome.storage.local.get([key, 'meetings']);
  await archiveIfStale(meetingId, data);
  const meeting = data[key] ?? {
    id: meetingId, title: title || meetingId, startedAt, endedAt: null, segments: [], mom: null,
  };
  meeting.source = 'audio';
  meeting.endedAt = null; // rekam ulang di ruang Meet yang sama → aktif lagi
  if (title) meeting.title = title;
  const meetings = data.meetings ?? [];
  if (!meetings.includes(meetingId)) meetings.unshift(meetingId);
  await chrome.storage.local.set({ [key]: meeting, meetings });
  notifyPanel({ type: 'meeting-updated', id: meetingId });
}

// Sengaja TANPA archiveIfStale: transkrip ini milik sesi yang BARU berakhir,
// dan transkrip ulang dari arsip datang dengan id arsipnya sendiri (audio meta
// ikut di-retag saat pengarsipan). Kasus sebaliknya ditangani redirect di
// bawah: STT browser bisa menggiling >30 menit, dan selama itu ruangnya bisa
// keburu diarsip lalu dipakai occurrence baru — tanpa redirect, transkrip
// sesi LAMA mendarat di record sesi baru (persis bug yang commit ini perbaiki,
// lewat pintu samping).
async function saveAudioTranscript({ meetingId, segments, baseTime, replace, legacy }) {
  let key = 'meeting:' + meetingId;
  const data = await chrome.storage.local.get([key, 'meetings']);
  // Record di key kode ruang mulai SETELAH rekaman ini? Berarti bukan lagi
  // miliknya — cari record arsip pemilik rekaman (startedAt <= baseTime).
  // Tidak ketemu → jatuh ke perilaku lama (tulis ke record yang ada).
  if (data[key] && baseTime && data[key].startedAt > baseTime) {
    const ids = (data.meetings ?? []).filter((m) => String(m).startsWith(meetingId + '@'));
    const recs = await chrome.storage.local.get(ids.map((id) => 'meeting:' + id));
    const owner = globalThis.MeetMerge.ownerOfRecording(
      ids.map((id) => recs['meeting:' + id]), baseTime);
    if (owner) {
      meetingId = owner.id;
      key = 'meeting:' + meetingId;
      data[key] = owner;
    }
  }
  const meeting = data[key] ?? {
    // startedAt = waktu MULAI rekam, bukan waktu simpan: kalau dipakai waktu
    // simpan, segmen ber-timestamp lebih awal dari "mulai" meeting-nya.
    id: meetingId, title: meetingId, startedAt: baseTime ?? Date.now(),
    endedAt: null, segments: [], mom: null,
  };
  meeting.source = 'audio';
  meeting.segments = globalThis.MeetMerge.replaceAudioSegments(
    meeting.segments, segments, { baseTime: baseTime ?? 0, replace: !!replace, legacy: !!legacy });
  const meetings = data.meetings ?? [];
  if (!meetings.includes(meetingId)) meetings.unshift(meetingId);
  await chrome.storage.local.set({ [key]: meeting, meetings });
  notifyPanel({ type: 'meeting-updated', id: meetingId });
}

async function saveSegments({ meetingId, title, segs }) {
  const key = 'meeting:' + meetingId;
  const data = await chrome.storage.local.get([key, 'meetings']);
  await archiveIfStale(meetingId, data);
  const meeting = data[key] ?? {
    // title bisa string kosong (content script tak tahu judulnya) — record baru
    // tetap butuh sesuatu yang bisa ditampilkan.
    id: meetingId, title: title || meetingId, startedAt: Date.now(), endedAt: null, segments: [], mom: null,
  };
  if (title) meeting.title = title;
  meeting.endedAt = null; // rejoin (dalam ambang gap) di meeting yang sama → aktif lagi
  for (const seg of segs) globalThis.MeetMerge.upsertSegment(meeting.segments, seg);
  const meetings = data.meetings ?? [];
  if (!meetings.includes(meetingId)) meetings.unshift(meetingId);
  await chrome.storage.local.set({ [key]: meeting, meetings });
  if (!active.id || active.id === meetingId) active.lastSegmentAt = Date.now();
  notifyPanel({ type: 'meeting-updated', id: meetingId });
}

async function endMeeting(meetingId) {
  // Reset `active` DULUAN, sebelum early-return di bawah: meeting yang tak
  // pernah punya record (tak ada satu pun caption masuk) membuat fungsi ini
  // keluar lebih awal dan meninggalkan active.id + active.inCall nyangkut
  // selamanya — badge menyala terus, Live menunjuk ruang yang sudah ditinggal.
  if (active.id === meetingId) {
    active = { id: null, inCall: false, captionsOn: false, lastSegmentAt: 0, captionsOnAt: 0 };
    updateBadge();
    notifyPanel({ type: 'status', ...active });
  }
  const key = 'meeting:' + meetingId;
  const data = await chrome.storage.local.get(key);
  if (!data[key]) return;
  data[key].endedAt = Date.now();
  await chrome.storage.local.set({ [key]: data[key] });
  notifyPanel({ type: 'meeting-updated', id: meetingId });
}

async function generateMom(id) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  if (!settings.apiKey) throw new Error('API key belum diisi di tab Settings.');
  const key = 'meeting:' + id;
  const data = await chrome.storage.local.get(key);
  const meeting = data[key];
  if (!meeting || !meeting.segments.length) throw new Error('Transkrip kosong.');
  const transcript = globalThis.MeetMerge.formatTranscript(meeting.segments);
  const prompt = globalThis.MeetMerge.fillTemplate(
    settings.momTemplate || globalThis.MeetMerge.DEFAULT_MOM_TEMPLATE, transcript);
  const mom = await globalThis.MeetOpenAI.generateMoM({
    apiKey: settings.apiKey, model: settings.model || 'gpt-4o-mini', prompt,
    baseUrl: settings.baseUrl,
  });
  // Persist lewat writeChain + re-read: segmen yang masuk selama request
  // OpenAI tidak boleh tertimpa objek meeting yang stale.
  await new Promise((resolve, reject) => {
    enqueueWrite(async () => {
      try {
        const fresh = (await chrome.storage.local.get(key))[key];
        if (!fresh) throw new Error('Meeting tidak ditemukan.');
        fresh.mom = mom;
        await chrome.storage.local.set({ [key]: fresh });
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
  return mom;
}

// Single-flight: klik ganda / panel ganda tidak boleh memicu dua request
// OpenAI paralel untuk meeting yang sama.
const momInFlight = new Map();
function generateMomOnce(id) {
  let p = momInFlight.get(id);
  if (!p) {
    p = generateMom(id).finally(() => momInFlight.delete(id));
    momInFlight.set(id, p);
  }
  return p;
}

// Storage writes diserialisasi: get→set yang tumpang tindih bisa saling
// menimpa (segmen hilang), jadi semua write antre di satu chain.
let writeChain = Promise.resolve();
const enqueueWrite = (fn) => {
  writeChain = writeChain.then(fn).catch((e) => console.error('storage write', e));
  return writeChain;
};

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'captions') return;
  let meetingId = null;
  // Port ini pernah benar-benar berada DI DALAM call? Tab yang cuma membuka
  // halaman ruang (lobby, link kalender yang diklik dua kali) juga melapor tiap
  // 2 detik dengan meetingId yang sama — tanpa penanda ini, menutup tab itu
  // menghentikan rekaman dan menutup meeting milik tab lain yang masih rapat.
  let joined = false;
  let ended = false;
  // Satu tempat penutup meeting, dipakai jalur pesan 'ended' MAUPUN onDisconnect.
  const finish = () => {
    if (ended || !joined || !meetingId) return;
    ended = true;
    // rec.meetingId null = state rekaman hilang karena SW restart, padahal
    // dokumen offscreen bisa jadi masih merekam. stopRecording punya penjaga
    // hasOffscreen() sendiri, jadi biarkan ia yang memutuskan.
    if (!rec.meetingId || rec.meetingId === meetingId) stopRecording();
    enqueueWrite(() => endMeeting(meetingId));
  };
  port.onMessage.addListener((msg) => {
    if (msg.type === 'segments') {
      meetingId = msg.meetingId;
      enqueueWrite(() => saveSegments(msg));
    } else if (msg.type === 'ended') {
      meetingId = msg.meetingId;
      if (msg.joined) joined = true;
      finish();
    } else if (msg.type === 'status') {
      meetingId = msg.meetingId;
      if (msg.inCall) joined = true;
      // Multi-tab: tab yang benar-benar in-call menang. Tab lobby TIDAK boleh
      // menimpa status meeting yang sedang berjalan — termasuk saat id-nya sama
      // (dulu `active.id === msg.meetingId` mengizinkannya, dan akibatnya
      // inCall/captionsOn berkedip tiap 2 detik antara dua tab, yang ikut
      // mereset captionsOnAt sehingga peringatan "caption nyala tapi tak ada
      // teks 30 detik" tidak pernah bisa muncul).
      const canClaim = msg.inCall || !active.inCall || !active.id;
      if (!canClaim) return;
      if (msg.captionsOn && !active.captionsOn) active.captionsOnAt = Date.now();
      active = { ...active, id: msg.meetingId, inCall: msg.inCall, captionsOn: msg.captionsOn };
      updateBadge();
      notifyPanel({ type: 'status', ...active });
    }
  });
  // Tab ditutup / di-reload tanpa sempat mengirim 'ended'. finish() idempotent.
  port.onDisconnect.addListener(finish);
});

// Berjalan DI HALAMAN Gemini via executeScript — harus mandiri (di-serialize,
// tak bisa akses scope SW). Poll: Gemini SPA, editor muncul belakangan.
// Selector dipusatkan di SEL — titik perbaikan kalau DOM Gemini berubah.
function injectGeminiPrompt(text) {
  const SEL = {
    editor: 'div.ql-editor',
    send: 'button[aria-label*="Send" i], button[aria-label*="Kirim" i], button.send-button',
  };
  const deadline = Date.now() + 20000;
  const timer = setInterval(() => {
    const editor = document.querySelector(SEL.editor);
    if (!editor) {
      if (Date.now() > deadline) clearInterval(timer); // timeout → user paste manual (clipboard)
      return;
    }
    clearInterval(timer);
    editor.focus();
    editor.replaceChildren();
    // Quill: satu <p> per baris; InputEvent supaya framework Gemini deteksi isi.
    for (const line of text.split('\n')) {
      const p = document.createElement('p');
      p.textContent = line;
      editor.append(p);
    }
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    // Tombol kirim baru enable setelah framework proses input event.
    setTimeout(() => document.querySelector(SEL.send)?.click(), 500);
  }, 500);
}

function sendToGemini(text) {
  chrome.tabs.create({ url: 'https://gemini.google.com/app' }).then((tab) => {
    // Satu fungsi pelepas untuk kedua listener: injeksi yang BERHASIL juga harus
    // melepas onRemoved, kalau tidak tiap kiriman meninggalkan satu closure hidup
    // sampai tab Gemini-nya ditutup.
    const done = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(gone);
    };
    const onUpdated = (id, info, t) => {
      if (id !== tab.id || info.status !== 'complete') return;
      // Belum sign-in → redirect ke accounts.google.com juga 'complete': tunggu Gemini asli.
      if (!t.url?.startsWith('https://gemini.google.com/')) return;
      done();
      // Gagal inject (SW restart, DOM berubah) → diam: teks sudah di clipboard.
      chrome.scripting.executeScript({ target: { tabId: tab.id }, func: injectGeminiPrompt, args: [text] })
        .catch(() => {});
    };
    function gone(id) { if (id === tab.id) done(); }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(gone);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get-active') {
    sendResponse({ ...active, rec });
    return false;
  }
  if (msg.type === 'generate-mom') {
    generateMomOnce(msg.id).then(
      (mom) => sendResponse({ ok: true, mom }),
      (e) => sendResponse({ ok: false, error: e.message })
    );
    return true; // sendResponse async
  }
  if (msg.type === 'stop-recording') {
    stopRecording();
    return false;
  }
  if (msg.type === 'regenerate-transcript') {
    regenerateTranscript(msg.id).then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: e.message })
    );
    return true;
  }
  if (msg.type === 'audio-progress') {
    // Pesan ini BUKTI offscreen sedang mentranskrip. Kalau rec bilang idle,
    // yang salah adalah rec: service worker MV3 mati saat jeda antar potongan
    // (10 menit audio bisa lewat 30 detik tanpa pesan) lalu dibangunkan lagi
    // oleh pesan ini dengan state kosong. Tanpa pemulihan ini panel menghapus
    // "Mentranskrip…" dan menawarkan "Transkrip ulang" yang pasti ditolak.
    if (!rec.transcribing) {
      rec = { recording: false, transcribing: true, meetingId: msg.meetingId ?? rec.meetingId };
      updateBadge();
    }
    broadcastRec({ done: msg.done, total: msg.total, note: msg.note });
    return false;
  }
  if (msg.type === 'audio-transcript') {
    rec = { recording: false, transcribing: false, meetingId: null };
    updateBadge();
    if (!msg.segments.length) {
      // Kosong = STT tidak menghasilkan teks; tanpa pesan ini user melihat
      // meeting kosong yang tampak seperti berhasil. Sengaja tidak menyebut
      // "Transkrip ulang": tombolnya cuma ada kalau audionya memang tersimpan.
      broadcastRec({ error: 'Transkrip kosong — STT tidak menghasilkan teks. Cek endpoint/model STT di Settings.' });
    } else {
      // Eksplisit null: panel kini mempertahankan error terakhir sampai ada
      // yang menghapusnya, dan transkrip yang berhasil adalah kabar baik yang
      // membatalkan peringatan siklus ini.
      broadcastRec({ error: null });
    }
    // Meeting TETAP disimpan walau kosong: tombol "Transkrip ulang" hanya ada
    // di dalam view meeting tersimpan, jadi tanpa record ini pesan di atas
    // menyuruh klik tombol yang tidak akan pernah muncul dan audio yang sudah
    // tersimpan jadi tak terjangkau selamanya.
    enqueueWrite(() => saveAudioTranscript(msg));
    chrome.offscreen?.closeDocument?.().catch(() => {});
    return false;
  }
  if (msg.type === 'audio-error') {
    rec = { recording: false, transcribing: false, meetingId: null };
    updateBadge();
    broadcastRec({ error: msg.error });
    chrome.offscreen?.closeDocument?.().catch(() => {});
    return false;
  }
  if (msg.type === 'audio-warn') {
    broadcastRec({ error: msg.error });
    return false;
  }
  if (msg.type === 'send-to-gemini') {
    sendToGemini(msg.text);
    return false;
  }
  return false;
});

// background/service-worker.js
importScripts('/lib/merge.js', '/lib/openai.js', '/lib/stt.js', '/lib/audiostore.js');

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

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
let recTitle = null; // judul tab saat mulai rekam — mode audio tak punya sumber judul lain

function broadcastRec(extra = {}) {
  notifyPanel({ type: 'rec-state', recording: rec.recording, transcribing: rec.transcribing, ...extra });
}

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const c = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).catch(() => []);
    return c.length > 0;
  }
  return chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument().catch(() => false) : false;
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
    const meetingId = meetingIdFromUrl(tab?.url) || active.id;
    if (!meetingId) { broadcastRec({ error: 'Bukan halaman meeting aktif.' }); return; }
    recTitle = tab?.title?.replace(/\s*[-—–]\s*Google Meet\s*$/, '').trim() || null;
    try {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      await startRecording({ streamId, meetingId });
    } catch (e) {
      rec = { recording: false, transcribing: false, meetingId: null };
      updateBadge();
      broadcastRec({ error: e.message });
    }
  } else if (info.menuItemId === 'rec-stop') {
    stopRecording();
  }
});

async function startRecording({ streamId, meetingId }) {
  if (rec.recording || rec.transcribing || await hasOffscreen()) {
    throw new Error('Rekaman masih berjalan.');
  }
  const { settings = {} } = await chrome.storage.local.get('settings');
  const stt = globalThis.MeetStt.sttEndpoint(settings);
  await ensureOffscreen();
  rec = { recording: true, transcribing: false, meetingId };
  updateBadge();
  broadcastRec();
  chrome.runtime.sendMessage({
    target: 'offscreen', op: 'start', streamId, meetingId,
    baseUrl: stt.baseUrl, apiKey: stt.apiKey,
    sttModel: settings.sttModel || 'nvidia/parakeet-ctc-1.1b-asr',
    sttLanguage: settings.sttLanguage || '', chunkMs: 600000, baseTime: Date.now(),
  });
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
  broadcastRec();
  try {
    const meta = await globalThis.MeetAudioStore.loadAudioMeta();
    if (!meta) throw new Error('Tidak ada audio tersimpan.');
    if (meta.meetingId !== meetingId) {
      throw new Error('Audio tersimpan milik meeting lain — hanya rekaman terakhir yang disimpan.');
    }
    const { settings = {} } = await chrome.storage.local.get('settings');
    const stt = globalThis.MeetStt.sttEndpoint(settings);
    await ensureOffscreen();
    // await: kalau tak ada receiving end (offscreen sempat tertutup di antara
    // ensureOffscreen dan send), promise reject dan harus lewat catch di
    // bawah — kalau tidak, rec.transcribing macet true selamanya.
    await chrome.runtime.sendMessage({
      target: 'offscreen', op: 'retranscribe', meetingId,
      baseUrl: stt.baseUrl, apiKey: stt.apiKey,
      sttModel: settings.sttModel || 'nvidia/parakeet-ctc-1.1b-asr',
      sttLanguage: settings.sttLanguage || '',
    });
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
  // rec.transcribing → stop kedua (double-click) diblok: cegah transkrip dobel.
  if (rec.transcribing || (!rec.recording && !(await hasOffscreen()))) return;
  rec.recording = false;
  rec.transcribing = true;
  updateBadge();
  broadcastRec();
  chrome.runtime.sendMessage({ target: 'offscreen', op: 'stop' });
}

async function saveAudioTranscript({ meetingId, segments, baseTime }) {
  const key = 'meeting:' + meetingId;
  const data = await chrome.storage.local.get([key, 'meetings']);
  const meeting = data[key] ?? {
    // startedAt = waktu MULAI rekam, bukan waktu simpan: kalau dipakai waktu
    // simpan, segmen ber-timestamp lebih awal dari "mulai" meeting-nya.
    id: meetingId, title: recTitle || meetingId, startedAt: baseTime ?? Date.now(),
    endedAt: null, segments: [], mom: null,
  };
  meeting.source = 'audio';
  for (const seg of segments) globalThis.MeetMerge.upsertSegment(meeting.segments,
    { ...seg, id: `audio:${seg.t}:${meeting.segments.length}` });
  const meetings = data.meetings ?? [];
  if (!meetings.includes(meetingId)) meetings.unshift(meetingId);
  await chrome.storage.local.set({ [key]: meeting, meetings });
  notifyPanel({ type: 'meeting-updated', id: meetingId });
}

async function saveSegments({ meetingId, title, segs }) {
  const key = 'meeting:' + meetingId;
  const data = await chrome.storage.local.get([key, 'meetings']);
  const meeting = data[key] ?? {
    id: meetingId, title, startedAt: Date.now(), endedAt: null, segments: [], mom: null,
  };
  if (title) meeting.title = title;
  meeting.endedAt = null; // rejoin meeting lama → aktif lagi
  for (const seg of segs) globalThis.MeetMerge.upsertSegment(meeting.segments, seg);
  const meetings = data.meetings ?? [];
  if (!meetings.includes(meetingId)) meetings.unshift(meetingId);
  await chrome.storage.local.set({ [key]: meeting, meetings });
  if (!active.id || active.id === meetingId) active.lastSegmentAt = Date.now();
  notifyPanel({ type: 'meeting-updated', id: meetingId });
}

async function endMeeting(meetingId) {
  const key = 'meeting:' + meetingId;
  const data = await chrome.storage.local.get(key);
  if (!data[key]) return;
  data[key].endedAt = Date.now();
  await chrome.storage.local.set({ [key]: data[key] });
  if (active.id === meetingId) {
    active = { id: null, inCall: false, captionsOn: false, lastSegmentAt: 0, captionsOnAt: 0 };
    updateBadge();
    notifyPanel({ type: 'status', ...active });
  }
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
  port.onMessage.addListener((msg) => {
    if (msg.type === 'segments') {
      meetingId = msg.meetingId;
      enqueueWrite(() => saveSegments(msg));
    } else if (msg.type === 'status') {
      meetingId = msg.meetingId;
      // Multi-tab: tab yang benar-benar in-call menang; tab lain (lobby/stale)
      // tidak boleh menimpa status meeting yang sedang berjalan.
      const canClaim = msg.inCall || active.id === msg.meetingId || !active.inCall || !active.id;
      if (!canClaim) return;
      if (msg.captionsOn && !active.captionsOn) active.captionsOnAt = Date.now();
      active = { ...active, id: msg.meetingId, inCall: msg.inCall, captionsOn: msg.captionsOn,
        tabId: port.sender?.tab?.id ?? active.tabId };
      updateBadge();
      notifyPanel({ type: 'status', ...active });
    }
  });
  port.onDisconnect.addListener(() => {
    if (rec.recording && rec.meetingId === meetingId) stopRecording();
    if (meetingId) enqueueWrite(() => endMeeting(meetingId));
  });
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
    const onUpdated = (id, info, t) => {
      if (id !== tab.id || info.status !== 'complete') return;
      // Belum sign-in → redirect ke accounts.google.com juga 'complete': tunggu Gemini asli.
      if (!t.url?.startsWith('https://gemini.google.com/')) return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      // Gagal inject (SW restart, DOM berubah) → diam: teks sudah di clipboard.
      chrome.scripting.executeScript({ target: { tabId: tab.id }, func: injectGeminiPrompt, args: [text] })
        .catch(() => {});
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    // Tab ditutup sebelum Gemini sempat load → lepas listener, jangan tinggalkan closure mati.
    chrome.tabs.onRemoved.addListener(function gone(id) {
      if (id !== tab.id) return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(gone);
    });
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
  if (msg.type === 'audio-meta') {
    globalThis.MeetAudioStore.loadAudioMeta()
      .then((m) => sendResponse(m), () => sendResponse(null));
    return true; // sendResponse async
  }
  if (msg.type === 'regenerate-transcript') {
    regenerateTranscript(msg.id).then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: e.message })
    );
    return true;
  }
  if (msg.type === 'audio-progress') {
    broadcastRec({ done: msg.done, total: msg.total });
    return false;
  }
  if (msg.type === 'audio-transcript') {
    rec = { recording: false, transcribing: false, meetingId: null };
    updateBadge();
    if (!msg.segments.length) {
      // Kosong = STT tidak menghasilkan teks. Tanpa pesan ini user melihat
      // meeting kosong yang tampak seperti berhasil.
      broadcastRec({ error: 'Transkrip kosong — STT tidak menghasilkan teks. Cek endpoint/model STT di Settings, lalu coba "Transkrip ulang".' });
    } else {
      enqueueWrite(() => saveAudioTranscript(msg));
      broadcastRec();
    }
    chrome.offscreen.closeDocument?.().catch(() => {});
    return false;
  }
  if (msg.type === 'audio-error') {
    rec = { recording: false, transcribing: false, meetingId: null };
    updateBadge();
    broadcastRec({ error: msg.error });
    chrome.offscreen.closeDocument?.().catch(() => {});
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

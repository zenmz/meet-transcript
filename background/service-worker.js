// background/service-worker.js
importScripts('/lib/merge.js', '/lib/openai.js');

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
    const meetingId = meetingIdFromUrl(tab?.url) || active.id;
    if (!meetingId) { broadcastRec({ error: 'Bukan halaman meeting aktif.' }); return; }
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
  await ensureOffscreen();
  rec = { recording: true, transcribing: false, meetingId };
  updateBadge();
  broadcastRec();
  chrome.runtime.sendMessage({
    target: 'offscreen', op: 'start', streamId, meetingId,
    baseUrl: settings.baseUrl, apiKey: settings.apiKey,
    sttModel: settings.sttModel || 'nvidia/parakeet-ctc-1.1b-asr',
    sttLanguage: settings.sttLanguage || '', chunkMs: 600000, baseTime: Date.now(),
  });
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

async function saveAudioTranscript({ meetingId, segments }) {
  const key = 'meeting:' + meetingId;
  const data = await chrome.storage.local.get([key, 'meetings']);
  const meeting = data[key] ?? {
    id: meetingId, title: meetingId, startedAt: Date.now(), endedAt: null, segments: [], mom: null,
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
  if (msg.type === 'start-recording') {
    startRecording(msg).catch((e) => {
      // Gagal setelah rec di-set → reset state + badge, jangan tinggalkan stuck.
      rec = { recording: false, transcribing: false, meetingId: null };
      updateBadge();
      broadcastRec({ error: e.message });
    });
    return false;
  }
  if (msg.type === 'stop-recording') {
    stopRecording();
    return false;
  }
  if (msg.type === 'audio-progress') {
    broadcastRec({ done: msg.done, total: msg.total });
    return false;
  }
  if (msg.type === 'audio-transcript') {
    rec = { recording: false, transcribing: false, meetingId: null };
    updateBadge();
    enqueueWrite(() => saveAudioTranscript(msg));
    broadcastRec();
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
  return false;
});

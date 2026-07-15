// background/service-worker.js
importScripts('/lib/merge.js', '/lib/openai.js');

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Status meeting aktif. Hilang saat SW idle-restart — dipulihkan oleh pesan
// status content script (tiap 2 detik) begitu SW bangun lagi.
let active = { id: null, inCall: false, captionsOn: false, lastSegmentAt: 0, captionsOnAt: 0 };

function notifyPanel(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {}); // panel tertutup → abaikan
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
      active = { ...active, id: msg.meetingId, inCall: msg.inCall, captionsOn: msg.captionsOn };
      notifyPanel({ type: 'status', ...active });
    }
  });
  port.onDisconnect.addListener(() => {
    if (meetingId) enqueueWrite(() => endMeeting(meetingId));
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get-active') {
    sendResponse(active);
    return false;
  }
  if (msg.type === 'generate-mom') {
    generateMomOnce(msg.id).then(
      (mom) => sendResponse({ ok: true, mom }),
      (e) => sendResponse({ ok: false, error: e.message })
    );
    return true; // sendResponse async
  }
});

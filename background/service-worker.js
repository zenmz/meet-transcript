// background/service-worker.js
importScripts('/lib/merge.js');

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
  active.lastSegmentAt = Date.now();
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

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'captions') return;
  let meetingId = null;
  port.onMessage.addListener((msg) => {
    if (msg.type === 'segments') {
      meetingId = msg.meetingId;
      saveSegments(msg);
    } else if (msg.type === 'status') {
      meetingId = msg.meetingId;
      if (msg.captionsOn && !active.captionsOn) active.captionsOnAt = Date.now();
      active = { ...active, id: msg.meetingId, inCall: msg.inCall, captionsOn: msg.captionsOn };
      notifyPanel({ type: 'status', ...active });
    }
  });
  port.onDisconnect.addListener(() => {
    if (meetingId) endMeeting(meetingId);
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get-active') {
    sendResponse(active);
    return false;
  }
});

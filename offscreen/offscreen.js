// offscreen/offscreen.js — rekam audio tab (via streamId), putar balik ke
// speaker, potong per chunkMs, transkrip tiap chunk saat stop.
let audioCtx = null;
let stream = null;
let recorder = null;
let rotateTimer = null;
let chunkBlobs = [];   // Blob standalone per chunk
let cfg = null;        // {baseUrl, apiKey, sttModel, sttLanguage, chunkMs, baseTime, meetingId}
const MIME = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
  ? 'audio/webm;codecs=opus' : 'audio/webm';

function toSW(msg) { chrome.runtime.sendMessage(msg); }

function startChunkRecorder() {
  const data = []; // per-recorder: rotasi tak boleh menabrak data recorder lain
  recorder = new MediaRecorder(stream, { mimeType: MIME });
  recorder.ondataavailable = (e) => { if (e.data.size) data.push(e.data); };
  recorder.onstop = () => { chunkBlobs.push(new Blob(data, { type: MIME })); };
  recorder.start();
}

// Rotasi: stop recorder chunk ini (finalisasi Blob standalone) lalu mulai lagi.
function rotateChunk() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  startChunkRecorder();
}

async function start(msg) {
  if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  stream?.getTracks().forEach((t) => t.stop());
  await audioCtx?.close().catch(() => {});
  cfg = msg;
  chunkBlobs = [];
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId } },
  });
  // Re-inject: tabCapture membisukan tab; putar balik ke speaker.
  audioCtx = new AudioContext();
  audioCtx.createMediaStreamSource(stream).connect(audioCtx.destination);
  if (audioCtx.state === 'suspended') await audioCtx.resume(); // tanpa ini tab bisa senyap
  startChunkRecorder();
  rotateTimer = setInterval(rotateChunk, msg.chunkMs);
}

async function stopAndTranscribe() {
  clearInterval(rotateTimer);
  rotateTimer = null;
  // Finalisasi chunk terakhir (tunggu onstop).
  await new Promise((resolve) => {
    if (!recorder || recorder.state === 'inactive') return resolve();
    recorder.addEventListener('stop', resolve, { once: true });
    recorder.stop();
  });
  stream?.getTracks().forEach((t) => t.stop());
  await audioCtx?.close().catch(() => {});
  audioCtx = null; stream = null; recorder = null;

  const results = [];
  for (let i = 0; i < chunkBlobs.length; i++) {
    toSW({ type: 'audio-progress', meetingId: cfg.meetingId, done: i, total: chunkBlobs.length });
    try {
      results.push(await globalThis.MeetOpenAI.transcribeAudio({
        blob: chunkBlobs[i], baseUrl: cfg.baseUrl, apiKey: cfg.apiKey,
        model: cfg.sttModel, language: cfg.sttLanguage,
      }));
    } catch (e) {
      results.push({ error: e.message });
    }
  }
  const segments = globalThis.MeetStt.mergeSttChunks(results, cfg.chunkMs, cfg.baseTime);
  chunkBlobs = [];
  toSW({ type: 'audio-transcript', meetingId: cfg.meetingId, segments });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  if (msg.op === 'start') {
    start(msg).catch((e) => toSW({ type: 'audio-error', meetingId: msg.meetingId, error: e.message }));
  } else if (msg.op === 'stop') {
    stopAndTranscribe().catch((e) => toSW({ type: 'audio-error', meetingId: cfg?.meetingId, error: e.message }));
  }
});

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
  if (recorder && recorder.state !== 'inactive') { recorder.onstop = null; recorder.stop(); }
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

// Dipakai dua jalur: setelah rekam selesai, dan tombol "Transkrip ulang".
async function transcribeChunks(blobs, c) {
  const results = [];
  for (let i = 0; i < blobs.length; i++) {
    toSW({ type: 'audio-progress', meetingId: c.meetingId, done: i, total: blobs.length });
    try {
      results.push(await globalThis.MeetOpenAI.transcribeAudio({
        blob: blobs[i], baseUrl: c.baseUrl, apiKey: c.apiKey,
        model: c.sttModel, language: c.sttLanguage,
      }));
    } catch (e) {
      results.push({ error: e.message });
    }
  }
  const segments = globalThis.MeetStt.mergeSttChunks(results, c.chunkMs, c.baseTime);
  toSW({ type: 'audio-transcript', meetingId: c.meetingId, segments, baseTime: c.baseTime });
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

  // Simpan dulu, transkrip belakangan: endpoint STT salah tidak boleh
  // menghanguskan rekaman — audio tetap bisa ditranskrip ulang.
  await globalThis.MeetAudioStore.saveAudio({
    meetingId: cfg.meetingId, chunkMs: cfg.chunkMs, baseTime: cfg.baseTime, blobs: chunkBlobs,
  }).catch((e) => toSW({ type: 'audio-warn', meetingId: cfg.meetingId,
    error: 'Audio gagal disimpan untuk transkrip ulang: ' + e.message }));
  const blobs = chunkBlobs;
  chunkBlobs = [];
  await transcribeChunks(blobs, cfg);
}

async function retranscribe(msg) {
  const saved = await globalThis.MeetAudioStore.loadAudio();
  if (!saved) throw new Error('Audio rekaman tidak tersimpan lagi.');
  if (saved.meetingId !== msg.meetingId) {
    throw new Error('Audio tersimpan milik meeting lain — hanya rekaman terakhir yang disimpan.');
  }
  // chunkMs/baseTime dari rekaman asli supaya timestamp segmen tetap sama;
  // endpoint & model diambil dari settings TERBARU lewat msg.
  await transcribeChunks(saved.blobs, { ...msg, chunkMs: saved.chunkMs, baseTime: saved.baseTime });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  if (msg.op === 'start') {
    start(msg).catch((e) => toSW({ type: 'audio-error', meetingId: msg.meetingId, error: e.message }));
  } else if (msg.op === 'stop') {
    stopAndTranscribe().catch((e) => toSW({ type: 'audio-error', meetingId: cfg?.meetingId, error: e.message }));
  } else if (msg.op === 'retranscribe') {
    retranscribe(msg).catch((e) =>
      toSW({ type: 'audio-error', meetingId: msg.meetingId, error: e.message }));
  }
});

// offscreen/offscreen.js — rekam audio tab (via streamId), putar balik ke
// speaker, potong per chunkMs, transkrip tiap chunk saat stop.
let audioCtx = null;
let stream = null;
let recorder = null;
let rotateTimer = null;
let silenceTimer = null;
let chunkBlobs = [];   // Blob standalone per chunk
let pendingSaves = []; // appendChunk yang belum selesai (ditunggu sebelum stop)
let cfg = null;        // {baseUrl, apiKey, sttMode, sttModel, sttLanguage, chunkMs, baseTime, meetingId}
// Offscreen menyerialisasi dirinya sendiri: guard rec.transcribing di SW cuma
// bertahan selama SW hidup, padahal SW MV3 bisa mati di tengah upload yang
// panjang sementara dokumen ini terus bekerja. Tanpa flag ini, perintah stop
// kedua menimpa audio tersimpan dengan array kosong dan membunuh transkrip
// yang sedang jalan.
let busy = false;
const MIME = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
  ? 'audio/webm;codecs=opus' : 'audio/webm';

// catch: SW sedang teardown & panel tertutup → tak ada penerima, dan rejection
// tanpa handler jadi unhandled rejection di offscreen document.
function toSW(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }

function startChunkRecorder() {
  const data = []; // per-recorder: rotasi tak boleh menabrak data recorder lain
  recorder = new MediaRecorder(stream, { mimeType: MIME });
  recorder.ondataavailable = (e) => { if (e.data.size) data.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(data, { type: MIME });
    chunkBlobs.push(blob);
    // Disimpan begitu chunk selesai, bukan menunggu stop: rekaman satu jam
    // yang browsernya ditutup di menit ke-50 menyisakan 5 chunk yang bisa
    // ditranskrip ulang & diunduh, bukan nol. Kegagalan simpan tidak
    // membatalkan transkrip — chunkBlobs (memori) tetap sumber transkrip.
    pendingSaves.push(globalThis.MeetAudioStore.appendChunk(blob).catch((e) =>
      toSW({ type: 'audio-warn', meetingId: cfg?.meetingId,
        error: 'Satu potongan audio gagal disimpan untuk transkrip ulang: ' + e.message })));
  };
  recorder.start();
}

function stopSilenceWatch() {
  if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
}

// Tab yang sunyi menghasilkan rekaman kosong dan transkrip kosong, dan itu baru
// ketahuan setelah Stop — bisa satu jam kemudian. Penyebab paling sering bukan
// bug: tabCapture merekam KELUARAN tab (suara peserta lain), sedangkan mic
// sendiri tidak lewat situ, jadi meeting yang cuma diisi suara kita sendiri
// sunyi total dari sisi tab. Diberitahukan di 15 detik pertama, bukan di akhir.
function watchSilence(source) {
  const an = audioCtx.createAnalyser();
  an.fftSize = 2048;
  source.connect(an); // paralel dengan destination, tidak mengubah playback
  const buf = new Float32Array(an.fftSize);
  let quiet = 0;
  silenceTimer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const a = Math.abs(buf[i]);
      if (a > peak) peak = a;
    }
    // ~-40 dBFS: di bawah bisikan pun masih lolos, tapi tidak tertipu noise
    // floor kanal digital yang praktis nol.
    if (peak > 0.01) return stopSilenceWatch(); // ada suara → berhenti mengawasi
    if (++quiet < 15) return;
    stopSilenceWatch();
    toSW({ type: 'audio-warn', meetingId: cfg?.meetingId,
      error: 'Belum ada suara masuk 15 detik. Yang direkam hanya audio tab (peserta lain) — '
        + 'suara mikrofonmu sendiri TIDAK ikut terekam. Kalau tak ada peserta lain yang '
        + 'bersuara, rekaman akan kosong dan transkripnya juga.' });
  }, 1000);
}

// Rotasi: stop recorder chunk ini (finalisasi Blob standalone) lalu mulai lagi.
function rotateChunk() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  startChunkRecorder();
}

async function start(msg) {
  if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
  stopSilenceWatch();
  if (recorder && recorder.state !== 'inactive') { recorder.onstop = null; recorder.stop(); }
  stream?.getTracks().forEach((t) => t.stop());
  await audioCtx?.close().catch(() => {});
  cfg = msg;
  chunkBlobs = [];
  pendingSaves = [];
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId } },
  });
  // Meta ditulis sebelum chunk pertama: meetingId + waktu mulai sudah
  // tersimpan walau rekaman nanti mati di tengah.
  await globalThis.MeetAudioStore.beginAudio(
    { meetingId: msg.meetingId, chunkMs: msg.chunkMs, baseTime: msg.baseTime });
  // Re-inject: tabCapture membisukan tab; putar balik ke speaker.
  audioCtx = new AudioContext();
  const src = audioCtx.createMediaStreamSource(stream);
  src.connect(audioCtx.destination);
  if (audioCtx.state === 'suspended') await audioCtx.resume(); // tanpa ini tab bisa senyap
  watchSilence(src);
  startChunkRecorder();
  rotateTimer = setInterval(rotateChunk, msg.chunkMs);
}

// Satu chunk → {segments}. Mode browser jalan lokal di CPU (transformers.js +
// WASM), mode lain upload ke endpoint OpenAI-compatible.
async function transcribeOne(blob, c, i, total) {
  if (c.sttMode === 'browser') {
    // Dynamic import: whisper-browser.js ES module dan bundle-nya besar —
    // jangan dibaca sama sekali kalau mode STT bukan browser.
    const m = await import(chrome.runtime.getURL('lib/whisper-browser.js'));
    return m.transcribe(blob, {
      language: c.sttLanguage,
      model: c.sttBrowserModel,
      // Unduhan model pertama kali ratusan MB tanpa tanda apa pun di UI —
      // tanpa ini user melihat "Mentranskrip…" diam bermenit-menit.
      onProgress: (note) => toSW({ type: 'audio-progress', meetingId: c.meetingId, done: i, total, note }),
    });
  }
  return globalThis.MeetOpenAI.transcribeAudio({
    blob, baseUrl: c.baseUrl, apiKey: c.apiKey,
    model: c.sttModel, language: c.sttLanguage,
  });
}

// Dipakai dua jalur: setelah rekam selesai (replace=false, hasilnya grup baru),
// dan tombol "Transkrip ulang" (replace=true, menggantikan grup yang sama).
async function transcribeChunks(blobs, c, replace) {
  const results = [];
  for (let i = 0; i < blobs.length; i++) {
    toSW({ type: 'audio-progress', meetingId: c.meetingId, done: i, total: blobs.length });
    try {
      results.push(await transcribeOne(blobs[i], c, i, blobs.length));
    } catch (e) {
      results.push({ error: e.message });
    }
  }
  // Transkrip ulang yang GAGAL TOTAL tidak boleh menulis apa pun: hasilnya
  // adalah baris "[transkrip gagal]" per potongan — tidak kosong, jadi ia lolos
  // semua penjaga di hilir dan menimpa transkrip lama yang justru masih bagus.
  // Rekaman baru tidak kena aturan ini: di sana tak ada yang bisa hilang, dan
  // penanda gagal itu justru memberi tahu di menit mana audionya ada.
  // Syaratnya ADA TEKS, bukan sekadar "ada potongan yang tidak error": potongan
  // sunyi menghasilkan {segments:[]} yang bukan error, jadi kombinasi
  // sunyi + endpoint mati tetap lolos dan menimpa transkrip lama dengan baris
  // "[transkrip gagal]" saja.
  if (replace && !results.some((r) => r && !r.error && r.segments?.length)) {
    throw new Error('Transkrip ulang tidak menghasilkan teks — transkrip lama dipertahankan. Cek endpoint/model STT.');
  }
  const segments = globalThis.MeetStt.mergeSttChunks(results, c.chunkMs, c.baseTime, c.indices);
  toSW({ type: 'audio-transcript', meetingId: c.meetingId, segments, baseTime: c.baseTime,
    replace: !!replace, legacy: !!c.legacy });
}

async function stopAndTranscribe() {
  // cfg null = dokumen ini belum pernah merekam (mis. baru dibuat untuk
  // retranscribe, lalu kena 'stop' dari SW yang rec-nya ter-reset restart).
  // Tanpa guard ini cfg.meetingId di bawah melempar TypeError.
  if (!cfg) return;
  busy = true;
  try {
    clearInterval(rotateTimer);
    rotateTimer = null;
    stopSilenceWatch();
    // Finalisasi chunk terakhir (tunggu onstop), tapi jangan tanpa batas:
    // kalau tab dibongkar di saat yang salah, event 'stop' bisa tak pernah
    // datang — promise menggantung, finally tak jalan, dan busy macet true:
    // stop & transkrip ulang ditolak selamanya sampai browser di-restart.
    const pending = recorder;
    const finalized = await Promise.race([
      new Promise((resolve) => {
        if (!recorder || recorder.state === 'inactive') return resolve(true);
        recorder.addEventListener('stop', () => resolve(true), { once: true });
        recorder.stop();
      }),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)), // 5s cukup untuk finalisasi satu chunk
    ]);
    // Timeout: chunk terakhir (sampai chunkMs = 10 menit audio) tidak masuk
    // chunkBlobs. Jangan diam — user harus tahu ujung rekaman hilang.
    if (!finalized) {
      // onstop dilepas: kalau ia datang belakangan, handler-nya mendorong
      // potongan ke chunkBlobs yang sudah ditukar dan menulis ke IndexedDB
      // setelah pendingSaves selesai ditunggu — transkrip ulang nanti jadi
      // lebih panjang dari transkrip aslinya, tanpa penjelasan apa pun.
      if (pending) pending.onstop = null;
      toSW({ type: 'audio-warn', meetingId: cfg?.meetingId,
        error: 'Potongan terakhir gagal difinalisasi — bagian akhir rekaman mungkin hilang.' });
    }
    // Chunk sudah disimpan sambil jalan (onstop), tinggal tunggu tulisan
    // terakhir mendarat supaya "Transkrip ulang" & "Unduh audio" melihat
    // rekaman yang utuh, bukan kurang satu chunk.
    await Promise.all(pendingSaves);
    pendingSaves = [];
    stream?.getTracks().forEach((t) => t.stop());
    await audioCtx?.close().catch(() => {});
    audioCtx = null; stream = null; recorder = null;

    const blobs = chunkBlobs;
    chunkBlobs = [];
    await transcribeChunks(blobs, cfg, false);
  } finally {
    busy = false;
  }
}

async function retranscribe(msg) {
  busy = true;
  try {
    const saved = await globalThis.MeetAudioStore.loadAudio();
    if (!saved) throw new Error('Audio rekaman tidak tersimpan lagi.');
    if (saved.meetingId !== msg.meetingId) {
      throw new Error('Audio tersimpan milik meeting lain — hanya rekaman terakhir yang disimpan.');
    }
    // chunkMs/baseTime/indices dari rekaman asli supaya timestamp segmen tetap
    // sama; endpoint & model diambil dari settings TERBARU lewat msg.
    await transcribeChunks(
      saved.blobs,
      { ...msg, chunkMs: saved.chunkMs, baseTime: saved.baseTime, indices: saved.indices, legacy: saved.legacy },
      true);
  } finally {
    busy = false;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;
  // Semua op MEMBALAS. Side panel yang terbuka juga sebuah receiving end, jadi
  // sendMessage di service worker tetap resolve walau dokumen ini tidak ada —
  // hanya balasan dari sini yang membuktikan ada yang benar-benar mengerjakan.
  // Panel tak pernah membalas pesan bertarget offscreen, jadi balasan ini menang.
  if (msg.op === 'start') {
    sendResponse({ ok: true });
    start(msg).catch((e) => toSW({ type: 'audio-error', meetingId: msg.meetingId, error: e.message }));
  } else if (msg.op === 'stop') {
    // Dua guard, bukan satu. busy: transkrip sedang jalan. !recorder: siklus
    // rekam SUDAH selesai — cfg masih terisi dan SW menutup dokumen ini secara
    // fire-and-forget, jadi klik "Stop rekam" di sela penutupan itu lolos guard
    // SW dan sampai ke sini. Tanpa cek recorder ia jalan sampai transcribeChunks
    // dengan chunkBlobs kosong dan menyiarkan transkrip kosong yang menimpa
    // hasil yang baru saja benar.
    // `busy` dibedakan dari `!recorder` di balasan: busy berarti transkrip MEMANG
    // jalan (SW harus tetap menunggu), !recorder berarti tak ada apa pun yang
    // jalan (SW harus mereset, kalau tidak ia macet "Mentranskrip…" selamanya).
    if (busy || !recorder) {
      sendResponse({ ok: false, busy,
        error: busy ? 'Transkrip masih berjalan — perintah stop diabaikan.'
          : 'Tidak ada rekaman aktif — perintah stop diabaikan.' });
      return false;
    }
    sendResponse({ ok: true });
    stopAndTranscribe().catch((e) => toSW({ type: 'audio-error', meetingId: cfg?.meetingId, error: e.message }));
  } else if (msg.op === 'retranscribe') {
    // Balasan wajib: side panel yang terbuka juga receiving end, jadi hanya
    // balasan dari sini yang membuktikan offscreen benar-benar mengerjakannya.
    // recorder != null → rekaman masih jalan, transkrip ulang akan membuang
    // chunk-nya lewat closeDocument() di akhir.
    if (busy || recorder) {
      sendResponse({ ok: false, error: 'Rekaman/transkrip masih berjalan.' });
      return false;
    }
    sendResponse({ ok: true });
    retranscribe(msg).catch((e) =>
      toSW({ type: 'audio-error', meetingId: msg.meetingId, error: e.message }));
  }
  return false;
});

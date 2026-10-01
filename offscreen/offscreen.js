// offscreen/offscreen.js — rekam audio tab (via streamId), putar balik ke
// speaker, potong per chunkMs, transkrip tiap chunk saat stop.
let audioCtx = null;
let stream = null;
let micStream = null;  // mic opsional (settings.mic): dicampur ke rekaman, bukan ke speaker
let micJoining = false;
let mixNode = null;    // GainNode: tab (+ mic) → recStream & pengawas sunyi
let recStream = null;  // audio campuran, sumber SEMUA recorder
let recorder = null;
let videoRecorder = null;
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
const VIDEO_MIME = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
  ? 'video/webm;codecs=vp9,opus' : 'video/webm';

// catch: SW sedang teardown & panel tertutup → tak ada penerima, dan rejection
// tanpa handler jadi unhandled rejection di offscreen document.
function toSW(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }

function startChunkRecorder() {
  const data = []; // per-recorder: rotasi tak boleh menabrak data recorder lain
  // recStream = campuran tab + mic dari Web Audio, audio-only — saat mode
  // video, track video ada di `stream`, tidak di sini (MIME audio menolaknya).
  recorder = new MediaRecorder(recStream, { mimeType: MIME });
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
      error: 'Belum ada suara masuk 15 detik. ' + (micStream
        ? 'Tab dan mikrofon sama-sama sunyi — cek mic dan apakah ada yang bicara.'
        : 'Yang direkam hanya audio tab (peserta lain) — suara mikrofonmu sendiri TIDAK '
          + 'ikut terekam (centang "Rekam mikrofon" di Settings). Kalau tak ada peserta '
          + 'lain yang bersuara, rekaman akan kosong dan transkripnya juga.') });
  }, 1000);
}

// Mic dicampur ke mixNode. Prompt izin TIDAK bisa muncul dari dokumen ini
// (getUserMedia gagal "Permission dismissed"), jadi gagal di sini normal:
// SW yang memunculkan jendela izin (panel/mic.html), lalu mengirim op
// 'mic-join' kalau user mengizinkan — mic bergabung ke rekaman yang sedang
// jalan tanpa menyentuh recorder, karena semua recorder membaca campuran.
async function joinMic() {
  if (micStream || micJoining || !audioCtx) return;
  micJoining = true;
  let s;
  try {
    s = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    // name ikut: SW cuma memunculkan jendela izin untuk NotAllowedError —
    // mic tak ada / dipakai aplikasi lain bukan soal izin.
    toSW({ type: 'mic-denied', meetingId: cfg?.meetingId, name: e.name, error: e.message });
    return;
  } finally {
    micJoining = false;
  }
  // Rekaman bisa keburu berhenti (atau diganti) selama prompt menunggu:
  // context ditutup / mixNode null → sambungan gagal → lepas mic lagi.
  try {
    audioCtx.createMediaStreamSource(s).connect(mixNode);
    micStream = s;
  } catch {
    s.getTracks().forEach((t) => t.stop());
  }
}

// Rotasi: stop recorder chunk ini (finalisasi Blob standalone) lalu mulai lagi.
function rotateChunk() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  startChunkRecorder();
}

// SATU recorder jalan terus (bukan rotasi seperti audio): part hasil timeslice
// bukan file berdiri sendiri — hanya gabungan berurutan yang valid, jadi
// memutus recorder berarti memutus file. Timeslice 60 detik: crash di tengah
// meeting kehilangan maksimal 1 menit video terakhir, bukan seluruh file.
function startVideoRecorder() {
  // Video dari tab, audio dari campuran: pakai `stream` mentah berarti file
  // video tanpa suara mic padahal rekaman audionya memuatnya.
  videoRecorder = new MediaRecorder(
    new MediaStream([...stream.getVideoTracks(), ...recStream.getAudioTracks()]), {
    mimeType: VIDEO_MIME,
    videoBitsPerSecond: 500_000, // preset seimbang: 720p 10fps ±250 MB/jam
    audioBitsPerSecond: 48_000,
  });
  videoRecorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    pendingSaves.push(globalThis.MeetAudioStore.appendVideoPart(e.data).catch((err) =>
      toSW({ type: 'audio-warn', meetingId: cfg?.meetingId,
        error: 'Satu potongan video gagal disimpan — file video bisa rusak mulai menit itu: ' + err.message })));
  };
  videoRecorder.start(60000);
}

async function start(msg) {
  if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
  stopSilenceWatch();
  if (recorder && recorder.state !== 'inactive') { recorder.onstop = null; recorder.stop(); }
  if (videoRecorder && videoRecorder.state !== 'inactive') {
    videoRecorder.ondataavailable = null;
    videoRecorder.stop();
  }
  videoRecorder = null;
  stream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null; mixNode = null; recStream = null;
  await audioCtx?.close().catch(() => {});
  cfg = msg;
  chunkBlobs = [];
  pendingSaves = [];
  const constraints = {
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId } },
  };
  if (msg.video) {
    // Preset seimbang: cukup untuk grid muka + slide, ±250 MB/jam dengan
    // bitrate di startVideoRecorder. contentHint 'detail' di bawah menjaga
    // teks slide tetap tajam di bitrate rendah.
    constraints.video = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId,
      maxWidth: 1280, maxHeight: 720, maxFrameRate: 10 } };
  }
  stream = await navigator.mediaDevices.getUserMedia(constraints);
  const vTrack = stream.getVideoTracks()[0];
  if (vTrack) vTrack.contentHint = 'detail';
  // Picker memunculkan bar "Stop sharing" milik Chrome, dan tab yang ditutup
  // mengakhiri track dengan cara yang sama. Tanpa ini recorder terus jalan di
  // track mati: chunk kosong, transkrip kosong, dan baru ketahuan di akhir.
  // track.stop() milik kita sendiri TIDAK memicu 'ended', jadi stop normal
  // tidak lewat sini.
  stream.getAudioTracks()[0]?.addEventListener('ended', () => toSW({ type: 'stop-recording' }));
  // Meta ditulis sebelum chunk pertama: meetingId + waktu mulai sudah
  // tersimpan walau rekaman nanti mati di tengah.
  await globalThis.MeetAudioStore.beginAudio(
    { meetingId: msg.meetingId, chunkMs: msg.chunkMs, baseTime: msg.baseTime });
  audioCtx = new AudioContext();
  const src = audioCtx.createMediaStreamSource(stream);
  // Re-inject: tabCapture membisukan tab; putar balik ke speaker.
  src.connect(audioCtx.destination);
  // Semua recorder merekam SATU campuran (tab + mic opsional), bukan track tab
  // mentah: mic bisa bergabung belakangan (izin diberikan di tengah rekaman)
  // tanpa menyentuh recorder yang sudah jalan. Mic sengaja TIDAK ke
  // destination — itu berarti mendengar suara sendiri.
  mixNode = audioCtx.createGain();
  src.connect(mixNode);
  const dest = audioCtx.createMediaStreamDestination();
  mixNode.connect(dest);
  recStream = dest.stream;
  if (audioCtx.state === 'suspended') await audioCtx.resume(); // tanpa ini tab bisa senyap
  watchSilence(mixNode);
  // Tidak di-await: getUserMedia yang menunggu prompt tak boleh menahan
  // start() (SW menunggu balasannya) — mic masuk begitu tersedia.
  if (msg.mic) joinMic();
  startChunkRecorder();
  // Video itu lapisan opsional: konstruktor MediaRecorder bisa menolak
  // kombinasi mimeType/bitrate di mesin tertentu (NotSupportedError), dan
  // tanpa guard ini exception-nya menjalar keluar start() → SW mereset state
  // dan menutup offscreen, jadi rekaman AUDIO yang sebenarnya sehat ikut mati
  // dan seluruh transkrip meeting hilang gara-gara lapisan tambahan.
  if (msg.video) {
    try {
      startVideoRecorder();
    } catch (e) {
      videoRecorder = null;
      toSW({ type: 'audio-warn', meetingId: msg.meetingId,
        error: 'Rekaman video gagal dimulai (' + e.message + ') — rekaman audio & transkrip jalan terus.' });
    }
  }
  rotateTimer = setInterval(rotateChunk, msg.chunkMs);
}

// Satu chunk → {segments}, upload ke endpoint OpenAI-compatible.
function transcribeOne(blob, c) {
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
      results.push(await transcribeOne(blobs[i], c));
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
    // Finalisasi chunk terakhir (tunggu event 'stop'), tapi jangan tanpa batas:
    // kalau tab dibongkar di saat yang salah, event itu bisa tak pernah datang
    // — promise menggantung, finally tak jalan, dan busy macet true: stop &
    // transkrip ulang ditolak selamanya sampai browser di-restart.
    // Timeout → false; handler recorder-nya WAJIB dilepas pemanggil: event yang
    // datang belakangan menulis ke chunkBlobs/IndexedDB yang sudah ditukar atau
    // sudah selesai ditunggu — hasilnya transkrip/file yang diam-diam tanggung.
    const stopAndWait = (rec) => Promise.race([
      new Promise((resolve) => {
        if (!rec || rec.state === 'inactive') return resolve(true);
        rec.addEventListener('stop', () => resolve(true), { once: true });
        rec.stop();
      }),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)), // 5s cukup untuk finalisasi satu potongan
    ]);
    const pending = recorder;
    if (!await stopAndWait(pending)) {
      if (pending) pending.onstop = null;
      toSW({ type: 'audio-warn', meetingId: cfg?.meetingId,
        error: 'Potongan terakhir gagal difinalisasi — bagian akhir rekaman mungkin hilang.' });
    }
    const vPending = videoRecorder;
    if (!await stopAndWait(vPending)) {
      vPending.ondataavailable = null;
      toSW({ type: 'audio-warn', meetingId: cfg?.meetingId,
        error: 'Potongan video terakhir gagal difinalisasi — ujung video mungkin hilang.' });
    }
    // Chunk sudah disimpan sambil jalan (onstop), tinggal tunggu tulisan
    // terakhir mendarat supaya "Transkrip ulang" & "Unduh audio" melihat
    // rekaman yang utuh, bukan kurang satu chunk.
    await Promise.all(pendingSaves);
    pendingSaves = [];
    stream?.getTracks().forEach((t) => t.stop());
    micStream?.getTracks().forEach((t) => t.stop());
    // Dinolkan SEBELUM await close(): joinMic yang baru resolve di sela await
    // itu menemukan mixNode null → connect gagal → track mic-nya dilepas.
    // Kalau dinolkan sesudahnya, mic tersambung ke context yang sedang ditutup
    // (Chrome cuma warning) lalu track-nya hidup terus tanpa pernah di-stop.
    micStream = null; mixNode = null; recStream = null;
    await audioCtx?.close().catch(() => {});
    audioCtx = null; stream = null; recorder = null; videoRecorder = null;

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
    // Balasan menunggu start() SELESAI, bukan dikirim lebih dulu: SW mencatat
    // meeting (source audio, endedAt null, entri Riwayat) begitu ok datang —
    // ok yang mendahului getUserMedia/beginAudio membuat start yang gagal
    // tetap memutasi record, padahal SW menunda pencatatan justru untuk itu.
    // Gagal dilaporkan lewat balasan; SW yang mereset rec & menutup dokumen.
    start(msg).then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: e.message }));
    return true;
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
  } else if (msg.op === 'mic-join') {
    // Izin mic baru diberikan lewat jendela izin SW di tengah rekaman. Digate
    // cfg.mic: tombol "Izinkan mikrofon" di Settings bisa diklik saat rekaman
    // tab-only berjalan — izin boleh tersimpan, tapi mic tak boleh ikut masuk.
    sendResponse({ ok: true });
    if (cfg?.mic) joinMic();
  }
  return false;
});

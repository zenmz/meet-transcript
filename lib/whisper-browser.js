// lib/whisper-browser.js — Whisper yang jalan DI DALAM browser (transformers.js
// + onnxruntime-web), tanpa server dan tanpa API key.
// ES module (transformers.min.js hanya punya build ESM), dimuat lewat dynamic
// import() dari offscreen.js supaya bundle 900 KB ini tak terbaca di mode lain.
// Keluarannya {segments:[{start,text}]} — sama persis dengan
// MeetStt.parseSttResponse — jadi mergeSttChunks tak perlu tahu asal chunk.
import { pipeline, env } from './vendor/transformers.min.js';

// WAJIB. Default ORT adalah direktori cdn.jsdelivr.net dan dari situ ia
// meng-import() file .mjs remote — diblok CSP MV3 (script-src 'self'), model tak
// pernah jalan. Bentuk OBJEK, bukan string direktori: dengan {wasm} saja ORT
// memakai glue JS yang sudah ter-bundle dan tidak dynamic-import apa pun, jadi
// cuma satu file vendor yang perlu dibawa.
env.backends.onnx.wasm.wasmPaths = {
  wasm: chrome.runtime.getURL('lib/vendor/ort-wasm-simd-threaded.jsep.wasm'),
};
// Halaman extension tidak cross-origin isolated → tak ada SharedArrayBuffer,
// jadi multi-thread mustahil (ORT sendiri akan memaksanya ke 1). Disetel
// eksplisit supaya tidak ada percobaan spawn worker + warning.
env.backends.onnx.wasm.numThreads = 1;
// Tidak ada bobot model di dalam ZIP extension (ratusan MB): diunduh dari
// huggingface.co saat transkrip pertama, lalu di-cache browser. Tanpa flag ini
// transformers.js mencari /models/... di origin extension dulu dan selalu 404.
env.allowLocalModels = false;

const DEFAULT_MODEL = 'Xenova/whisper-base';
// Whisper TIDAK auto-detect kalau language dikosongkan: transformers.js diam-diam
// memakai 'en' dan hasilnya jadi terjemahan Inggris yang kacau untuk audio
// Indonesia. Jadi mode browser selalu punya bahasa eksplisit.
const DEFAULT_LANGUAGE = 'id';

let pipePromise = null;
let pipeModel = null;

// Progress transformers.js menyala puluhan kali per detik saat unduh; tanpa
// throttle tiap event jadi satu sendMessage ke SW lalu satu render panel.
function throttle(fn, ms) {
  let last = 0;
  return (...a) => {
    const now = Date.now();
    if (now - last < ms) return;
    last = now;
    fn?.(...a);
  };
}

function describe(p) {
  if (p.status === 'progress' && p.loaded != null) {
    const mb = (n) => (n / 1e6).toFixed(1);
    // huggingface.co tidak selalu mengirim Content-Length. Kalau tak ada,
    // transformers.js memakai jumlah byte yang SUDAH masuk sebagai total, jadi
    // p.progress selalu 100 — angka persen yang bohong dan bikin user mengira
    // unduhan macet di 100%. Tampilkan byte saja saat totalnya tak dipercaya.
    const size = p.total > p.loaded
      ? `${mb(p.loaded)}/${mb(p.total)} MB (${Math.round(p.progress)}%)`
      : `${mb(p.loaded)} MB`;
    return `unduh model ${p.file ?? ''} ${size}`;
  }
  if (p.status === 'done') return `siap: ${p.file ?? ''}`;
  return p.status ?? 'memuat model';
}

// Pipeline di-cache antar chunk: memuat ulang model tiap chunk berarti membaca
// ratusan MB dari cache dan menginisialisasi ORT berulang kali.
function getPipe(model, onProgress) {
  if (pipeModel !== model) {
    // Pipeline lama dilepas eksplisit: ia memegang heap WASM ORT (ratusan MB
    // untuk small), dan membuang referensinya saja tidak mengembalikannya —
    // ganti-ganti ukuran model di Settings menumpuknya sampai halaman ditutup.
    pipePromise?.then((p) => p?.dispose?.()).catch(() => {});
    pipeModel = model;
    pipePromise = null;
  }
  pipePromise ??= build(model, onProgress).catch((e) => {
    // Hanya nolkan kalau model ini MASIH yang terpilih: kalau user sudah pindah
    // model selagi unduhan ini gagal, promise milik model baru yang kebuang.
    if (pipeModel === model) pipePromise = null; // boleh dicoba lagi
    throw e;
  });
  return pipePromise;
}

// WASM q8, satu jalur tanpa cabang. WebGPU lebih cepat tapi bobotnya (encoder
// fp32 + decoder q4) 206 MB lawan 77 MB, dan encoder q8 di WebGPU dikenal
// menghasilkan teks kacau — ukuran itu tak bisa ditekan.
// ponytail: kalau WASM terbukti terlalu lambat, tambahkan WebGPU sebagai
// pilihan yang user nyalakan sendiri — jangan diam-diam, unduhannya 3x lipat.
async function build(model, onProgress) {
  const progress_callback = throttle((p) => onProgress?.(describe(p)), 1000);
  return pipeline('automatic-speech-recognition', model, {
    device: 'wasm', dtype: 'q8', progress_callback,
  });
}

// Whisper minta PCM mono 16 kHz float; decodeAudioData me-resample ke sampleRate
// context-nya, jadi tak perlu resampler sendiri. OfflineAudioContext, bukan
// AudioContext: Chrome membatasi ~6 AudioContext hidup per halaman dan dokumen
// ini sudah memakai satu untuk playback — satu per chunk menabrak batas itu di
// rekaman panjang, dan errornya muncul sebagai "[transkrip gagal]".
async function decodeMono16k(blob) {
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  if (buf.numberOfChannels === 1) return buf.getChannelData(0);
  // Downmix rata-rata, bukan ambil kanal kiri: audio tab bisa menaruh peserta
  // yang berbeda di kanal yang berbeda.
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / buf.numberOfChannels;
  }
  return out;
}

// Unduh + inisialisasi model tanpa mentranskrip apa pun, untuk tombol "Unduh
// model" di Settings. Membangun pipeline PENUH, bukan sekadar fetch file: itu
// sekalian membuktikan runtime WASM-nya bisa jalan di mesin ini.
export function preload(model, onProgress) {
  return getPipe(model || DEFAULT_MODEL, onProgress).then(() => true);
}

export async function transcribe(blob, { language, model, onProgress } = {}) {
  const pipe = await getPipe(model || DEFAULT_MODEL, onProgress);
  const audio = await decodeMono16k(blob);
  // "Transkrip kosong" bisa berarti dua hal yang sangat berbeda: audio yang
  // masuk ke model memang sunyi/salah decode, atau modelnya yang tak
  // menghasilkan apa-apa dari audio yang baik. Di panel keduanya terlihat
  // identik. Dua angka ini memisahkannya tanpa perlu DevTools.
  let peak = 0;
  for (let i = 0; i < audio.length; i++) {
    const a = Math.abs(audio[i]);
    if (a > peak) peak = a;
  }
  const stat = `${Math.round(audio.length / 16000)}s, puncak ${peak.toFixed(3)}`;
  onProgress?.(`audio ${stat} — menjalankan model…`);
  const out = await pipe(audio, {
    // Kode ISO ('id') maupun nama penuh ('indonesian') diterima, huruf kecil.
    language: String(language || DEFAULT_LANGUAGE).toLowerCase(),
    task: 'transcribe',
    // Whisper hanya menerima 30 detik sekali jalan; chunk rekaman kita 10 menit,
    // jadi pipeline yang memotong. stride = tumpang tindih supaya kalimat yang
    // terbelah di batas potongan tidak hilang.
    chunk_length_s: 30,
    stride_length_s: 5,
    // Timestamp dibutuhkan mergeSttChunks untuk menempatkan tiap baris di
    // menit yang benar; tanpa ini semua baris menumpuk di detik 0.
    return_timestamps: true,
  });
  // Cek `segments.length`, bukan `chunks.length`: model bisa mengembalikan
  // potongan bertimestamp yang teksnya kosong semua, dan mengembalikannya apa
  // adanya melewatkan diagnostik di bawah — potongan itu jadi lubang senyap di
  // transkrip padahal durasi & puncak audionya sudah terhitung.
  const segments = (out?.chunks ?? [])
    .map((c) => ({ start: c.timestamp?.[0] ?? 0, text: (c.text ?? '').trim() }))
    .filter((s) => s.text);
  if (segments.length) return { segments };
  // return_timestamps tidak didukung model → masih ada out.text utuh.
  const text = (out?.text ?? '').trim();
  if (!text) onProgress?.(`model tak menghasilkan teks — audio ${stat}`);
  return { segments: text ? [{ start: 0, text }] : [] };
}

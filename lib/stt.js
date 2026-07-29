// lib/stt.js — parse & merge hasil speech-to-text. Classic script (globalThis).
// Dipakai offscreen document + di-unit-test via import side-effect.
(() => {
  // Bentuk error beda-beda antar server: string, {message}, atau {code}. String(obj)
  // menghasilkan "[object Object]" yang tak memberi tahu apa pun.
  function errorText(e) {
    if (typeof e === 'string') return e;
    return e?.message ? String(e.message) : JSON.stringify(e);
  }

  function parseSttResponse(raw) {
    let d;
    try { d = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { return { segments: [] }; }
    // Hasil yang BERGUNA didahulukan. Sebagian server melampirkan `error` (atau
    // `warning`) di samping transkrip yang sah; mengeceknya lebih dulu membuang
    // teks yang sebenarnya ada dan menggantinya dengan penanda gagal.
    // segments KOSONG juga bukan jawaban: sebagian server mengirim
    // {text:"…",segments:[]}, dan mendahulukan array kosong membuang teksnya.
    if (d && Array.isArray(d.segments) && d.segments.length) {
      return { segments: d.segments.map((s) => ({ start: s.start ?? 0, text: s.text ?? '' })) };
    }
    if (d && typeof d.text === 'string' && d.text.trim()) {
      return { segments: [{ start: 0, text: d.text }] };
    }
    // Tak ada teks sama sekali; barulah body error dibaca. Sebagian proxy
    // OpenAI-compatible membalas HTTP 200 dengan body {error:{…}} — tanpa
    // cabang ini potongan itu jadi lubang senyap, bukan penanda gagal.
    if (d && d.error) return { error: errorText(d.error) };
    return { segments: [] };
  }

  // chunkResults[i] = hasil parseSttResponse ATAU {error}. Offset absolut potongan
  // = baseTime + indeks_rekaman × chunkDurationMs (direkam berurutan @ durasi tetap).
  // `indices` = indeks asli tiap potongan, dipakai saat ada potongan yang gagal
  // tersimpan: tanpa itu semua potongan sesudahnya bergeser maju satu slot
  // (10 menit) tanpa tanda apa pun.
  function mergeSttChunks(chunkResults, chunkDurationMs, baseTime, indices) {
    const out = [];
    // Semua-atau-tidak: indices yang panjangnya tidak sama dengan hasil berarti
    // pemanggilnya salah pasang, dan fallback per-elemen akan diam-diam menabrakkan
    // dua potongan ke timestamp yang sama alih-alih gagal terang-terangan.
    const idx = indices?.length === chunkResults.length ? indices : null;
    chunkResults.forEach((r, i) => {
      const offset = baseTime + (idx ? idx[i] : i) * chunkDurationMs;
      if (!r || r.error) {
        out.push({ t: offset, speaker: '', text: '[transkrip gagal]' });
        return;
      }
      for (const seg of r.segments ?? []) {
        const text = (seg.text ?? '').trim();
        if (!text) continue;
        out.push({ t: offset + Math.round((seg.start ?? 0) * 1000), speaker: '', text });
      }
    });
    return out;
  }

  const WHISPER_DEFAULT = 'http://localhost:8080/v1';
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
  const DEFAULT_LANGUAGE = 'id';
  const DEFAULT_BROWSER_MODEL = 'Xenova/whisper-base';
  // Pilihan model untuk mode browser. Ukuran ≈ jumlah parameter × 1 byte karena
  // bobotnya q8 — perkiraan, tapi terbukti: base (74 M parameter) memang terukur
  // ~80 MB saat diunduh. Ini SATU-SATUNYA tuas kualitas yang dimiliki mode
  // browser: whisper kecil dilatih dominan bahasa Inggris, dan untuk Indonesia
  // tiny/base sering menghasilkan teks yang salah dengar — bukan kosong, tapi
  // tidak sesuai. small adalah titik di mana hasilnya mulai bisa dipakai.
  const BROWSER_MODELS = [
    ['Xenova/whisper-tiny', 'Tiny — ±40 MB, tercepat, paling tidak akurat'],
    ['Xenova/whisper-base', 'Base — ±80 MB, cepat, sering salah dengar di bahasa Indonesia'],
    ['Xenova/whisper-small', 'Small — ±250 MB, jauh lebih akurat, jauh lebih lambat'],
  ];
  const DEFAULT_WHISPER_MODEL = 'whisper-1';
  const DEFAULT_API_MODEL = 'nvidia/parakeet-ctc-1.1b-asr';

  const isLocalUrl = (v) => {
    try { return LOCAL_HOSTS.has(new URL(String(v).trim()).hostname); } catch { return false; }
  };

  // Mode STT disimpan eksplisit di settings.sttMode. Dulu diturunkan dari
  // sttBaseUrl, tapi mode 'browser' tidak punya URL sama sekali — tak ada yang
  // bisa diturunkan. Nilai: 'whisper-local' | 'browser' | 'api'.
  function sttMode(s = {}) {
    if (s.sttMode) return s.sttMode;
    // Migrasi settings lama (mode diturunkan dari sttBaseUrl).
    const b = (s.sttBaseUrl || '').trim();
    if (b) return isLocalUrl(b) ? 'whisper-local' : 'api';
    // sttBaseUrl kosong = mode 'chat' yang lama (ikut endpoint chat). 'api'
    // punya fallback yang persis sama, jadi settings lama tetap jalan. Kalau
    // endpoint chat pun belum pernah diisi, ini instalasi baru → whisper lokal.
    return (s.apiKey || s.baseUrl) ? 'api' : 'whisper-local';
  }

  // Pilih endpoint + model + bahasa STT dari settings, satu tempat, supaya
  // service worker tidak menduplikasi aturan fallback-nya.
  // language pakai ?? bukan ||: string kosong yang DISIMPAN user berarti
  // "auto-detect", jadi tidak boleh diam-diam diganti default.
  function sttEndpoint(s = {}) {
    const mode = sttMode(s);
    const sttBase = (s.sttBaseUrl || '').trim();
    const sttKey = (s.sttApiKey || '').trim();
    const language = s.sttLanguage ?? DEFAULT_LANGUAGE;
    if (mode === 'browser') {
      return { mode: 'browser', language, sttBrowserModel: s.sttBrowserModel || DEFAULT_BROWSER_MODEL };
    }
    if (mode === 'whisper-local') {
      // Server whisper lokal tak butuh auth: apiKey chat tak boleh ikut ke sana.
      return { mode: 'http', baseUrl: sttBase || WHISPER_DEFAULT, apiKey: sttKey,
        model: s.sttModel || DEFAULT_WHISPER_MODEL, language };
    }
    // api: sttBaseUrl terisi → apiKey utama TIDAK ikut (key chat tak boleh
    // bocor ke host lain). Kosong → jatuh ke endpoint chat (perilaku lama).
    const model = s.sttModel || DEFAULT_API_MODEL;
    if (sttBase) return { mode: 'http', baseUrl: sttBase, apiKey: sttKey, model, language };
    return { mode: 'http', baseUrl: s.baseUrl, apiKey: sttKey || s.apiKey, model, language };
  }

  globalThis.MeetStt = {
    parseSttResponse, mergeSttChunks, sttEndpoint, sttMode, isLocalUrl,
    WHISPER_DEFAULT, DEFAULT_LANGUAGE, DEFAULT_BROWSER_MODEL, DEFAULT_API_MODEL, BROWSER_MODELS,
  };
})();

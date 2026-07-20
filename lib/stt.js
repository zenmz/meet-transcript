// lib/stt.js — parse & merge hasil speech-to-text. Classic script (globalThis).
// Dipakai offscreen document + di-unit-test via import side-effect.
(() => {
  function parseSttResponse(raw) {
    let d;
    try { d = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { return { segments: [] }; }
    if (d && Array.isArray(d.segments)) {
      return { segments: d.segments.map((s) => ({ start: s.start ?? 0, text: s.text ?? '' })) };
    }
    if (d && typeof d.text === 'string') return { segments: [{ start: 0, text: d.text }] };
    return { segments: [] };
  }

  // chunkResults[i] = hasil parseSttResponse ATAU {error}. Offset absolut chunk i
  // = baseTime + i*chunkDurationMs (chunk direkam berurutan @ durasi tetap).
  function mergeSttChunks(chunkResults, chunkDurationMs, baseTime) {
    const out = [];
    chunkResults.forEach((r, i) => {
      const offset = baseTime + i * chunkDurationMs;
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

  // Pilih endpoint STT dari settings. sttBaseUrl terisi → apiKey utama TIDAK
  // ikut (server whisper lokal tak butuh auth; key chat tak boleh bocor ke
  // host lain). Kosong dua-duanya → endpoint chat (perilaku lama).
  function sttEndpoint(s = {}) {
    const sttBase = (s.sttBaseUrl || '').trim();
    const sttKey = (s.sttApiKey || '').trim();
    if (sttBase) return { baseUrl: sttBase, apiKey: sttKey };
    return { baseUrl: s.baseUrl, apiKey: sttKey || s.apiKey };
  }

  globalThis.MeetStt = { parseSttResponse, mergeSttChunks, sttEndpoint };
})();

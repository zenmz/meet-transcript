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

  const WHISPER_DEFAULT = 'http://localhost:8080/v1';
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

  // Mode STT diturunkan dari sttBaseUrl, tidak disimpan sendiri: satu sumber
  // kebenaran, jadi dropdown tak pernah desync dari URL yang benar-benar dipakai.
  function sttMode(sttBaseUrl) {
    const b = (sttBaseUrl || '').trim();
    if (!b) return 'chat';
    let u;
    try { u = new URL(b); } catch { return 'api'; }
    return LOCAL_HOSTS.has(u.hostname) ? 'whisper' : 'api';
  }

  globalThis.MeetStt = { parseSttResponse, mergeSttChunks, sttEndpoint, sttMode, WHISPER_DEFAULT };
})();

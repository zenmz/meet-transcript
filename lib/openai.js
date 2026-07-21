// lib/openai.js — panggilan chat completions ke endpoint OpenAI-compatible
// (base URL bisa diganti di Settings). Classic script (globalThis).
(() => {
  const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
  // Batas transkrip per chunk. Tanpa ini, endpoint STT yang menerima koneksi
  // tapi tak pernah menjawab menggantung fetch selamanya → offscreen busy=true
  // permanen, stop & transkrip ulang ditolak sampai extension di-reload. 20
  // menit: longgar untuk chunk 10 menit di whisper lokal yang lambat, tapi yang
  // menggantung tetap dibatalkan. ponytail: jadikan setting kalau ada transkrip
  // sah yang > 20 menit.
  const STT_TIMEOUT_MS = 1200000;

  async function chat({ apiKey, model, baseUrl, messages }) {
    const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    let res;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, stream: false }),
      });
    } catch {
      throw new Error(
        `Tidak bisa terhubung ke ${base} — URL salah, server mati, atau izin host belum diberikan.`);
    }
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      const detail = err?.error?.message ?? `HTTP ${res.status}`;
      const hint = res.status === 401 ? ' (API key salah?)'
        : res.status === 404 ? ' (endpoint atau model tidak ditemukan?)' : '';
      throw new Error(detail + hint);
    }
    const content = extractContent(await res.text());
    if (!content) throw new Error('Respons kosong dari server.');
    return content;
  }

  // Sebagian proxy (mis. 9Router) membalas objek JSON lalu menempelkan
  // terminator SSE "data: [DONE]", atau membalas stream SSE penuh —
  // res.json() gagal di keduanya. Parser ini menangani JSON tunggal maupun SSE.
  function extractContent(raw) {
    raw = raw.trim();
    const single = raw.replace(/\s*data:\s*\[DONE\]\s*$/, '').trim();
    if (single.startsWith('{')) {
      try {
        const c = JSON.parse(single).choices?.[0]?.message?.content;
        if (c != null) return c;
      } catch { /* mungkin SSE bertingkat — jatuh ke parser baris di bawah */ }
    }
    // SSE stream: gabungkan delta dari tiap baris "data: {...}".
    let out = '';
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*data:\s*(.+)$/);
      if (!m || m[1].trim() === '[DONE]') continue;
      try {
        const ch = JSON.parse(m[1]).choices?.[0];
        out += ch?.delta?.content ?? ch?.message?.content ?? '';
      } catch { /* baris tak lengkap — lewati */ }
    }
    return out;
  }

  function generateMoM({ apiKey, model, prompt, baseUrl }) {
    return chat({ apiKey, model, baseUrl, messages: [{ role: 'user', content: prompt }] });
  }

  // Validasi URL + API key + model sekaligus dengan satu request mini.
  async function testConnection({ apiKey, model, baseUrl }) {
    await chat({ apiKey, model, baseUrl, messages: [{ role: 'user', content: 'Balas singkat: ok' }] });
    return true;
  }

  async function transcribeAudio({ blob, baseUrl, apiKey, model, language, timeoutMs }) {
    const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const form = new FormData();
    form.append('file', blob, 'audio.webm');
    form.append('model', model);
    form.append('response_format', 'verbose_json');
    if (language) form.append('language', language);
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const limit = timeoutMs || STT_TIMEOUT_MS;
    let res;
    try {
      res = await fetch(`${base}/audio/transcriptions`,
        { method: 'POST', headers, body: form, signal: AbortSignal.timeout(limit) });
    } catch (e) {
      if (e?.name === 'TimeoutError') {
        throw new Error(
          `Transkrip audio timeout setelah ${Math.round(limit / 1000)} detik — endpoint STT ${base} tidak merespons.`);
      }
      throw new Error(`Tidak bisa terhubung ke ${base} untuk transkrip audio.`);
    }
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      const detail = err?.error?.message ?? `HTTP ${res.status}`;
      const hint = res.status === 401 ? ' (API key salah?)'
        : res.status === 404 ? ' (endpoint/model STT tidak ditemukan?)'
        : (res.status === 400 || res.status === 415) ? ' (format audio tidak didukung model?)' : '';
      throw new Error(detail + hint);
    }
    return globalThis.MeetStt.parseSttResponse(await res.text());
  }

  globalThis.MeetOpenAI = { generateMoM, testConnection, transcribeAudio, extractContent, DEFAULT_BASE_URL };
})();

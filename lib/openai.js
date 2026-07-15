// lib/openai.js — panggilan chat completions ke endpoint OpenAI-compatible
// (base URL bisa diganti di Settings). Classic script (globalThis).
(() => {
  const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

  async function chat({ apiKey, model, baseUrl, messages }) {
    const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    let res;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages }),
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
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Respons kosong dari server.');
    return content;
  }

  function generateMoM({ apiKey, model, prompt, baseUrl }) {
    return chat({ apiKey, model, baseUrl, messages: [{ role: 'user', content: prompt }] });
  }

  // Validasi URL + API key + model sekaligus dengan satu request mini.
  async function testConnection({ apiKey, model, baseUrl }) {
    await chat({ apiKey, model, baseUrl, messages: [{ role: 'user', content: 'Balas singkat: ok' }] });
    return true;
  }

  globalThis.MeetOpenAI = { generateMoM, testConnection, DEFAULT_BASE_URL };
})();

// lib/openai.js — panggilan chat completions (OpenAI-compatible: OpenAI,
// OpenRouter, dll — base URL bisa diganti di Settings). Classic script (globalThis).
(() => {
  const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

  async function generateMoM({ apiKey, model, prompt, baseUrl }) {
    const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message ?? `OpenAI error HTTP ${res.status}`);
    }
    const data = await res.json();
    const mom = data.choices?.[0]?.message?.content;
    if (!mom) throw new Error('Respons OpenAI kosong.');
    return mom;
  }
  globalThis.MeetOpenAI = { generateMoM, DEFAULT_BASE_URL };
})();

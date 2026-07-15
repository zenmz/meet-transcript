// lib/openai.js — panggilan OpenAI chat completions. Classic script (globalThis).
(() => {
  async function generateMoM({ apiKey, model, prompt }) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
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
  globalThis.MeetOpenAI = { generateMoM };
})();

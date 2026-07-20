// panel/panel.js — render live transcript, riwayat, settings dari storage.
const M = globalThis.MeetMerge;
const view = document.getElementById('view');
let tab = 'live';
let viewingId = null; // di tab Riwayat: meeting yang sedang dibuka
let status = { id: null, inCall: false, captionsOn: false, lastSegmentAt: 0, captionsOnAt: 0 };
let recState = { recording: false, transcribing: false, done: 0, total: 0, error: null };
let settingsCache = {};
async function loadSettings() { settingsCache = (await chrome.storage.local.get('settings')).settings ?? {}; }

// el(): SELALU textContent — teks caption/nama pembicara tidak dipercaya.
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

document.querySelectorAll('nav button').forEach((b) =>
  b.addEventListener('click', () => {
    tab = b.dataset.tab;
    viewingId = null;
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
    render();
  })
);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') {
    status = msg;
    if (tab === 'live') render();
  } else if (msg.type === 'meeting-updated') {
    if ((tab === 'live' && msg.id === status.id) || (tab === 'history' && msg.id === viewingId)) render();
  } else if (msg.type === 'rec-state') {
    recState = { recording: msg.recording, transcribing: msg.transcribing,
      done: msg.done ?? 0, total: msg.total ?? 0, error: msg.error ?? null };
    if (tab === 'live') render();
  }
});

async function getMeeting(id) {
  return (await chrome.storage.local.get('meeting:' + id))['meeting:' + id] ?? null;
}

const safeName = (s) => s.replace(/[\/\\:*?"<>|]/g, '-');

// Prompt MoM lengkap (template + transkrip) untuk paste ke AI web tanpa API key.
const promptText = (meeting) => M.fillTemplate(
  settingsCache.momTemplate || M.DEFAULT_MOM_TEMPLATE,
  M.formatTranscript(meeting.segments));

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = safeName(name);
  a.click();
  // Revoke ditunda: dialog "Save as" baru membaca blob setelah click() kembali.
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// Epoch guard: render async saling balapan (klik tab vs broadcast SW);
// pass yang kalah cepat tidak boleh menimpa DOM pass yang lebih baru.
let renderEpoch = 0;
let lastRenderedKey = null; // view terakhir yang digambar renderMeeting (id|live)
const momErrors = new Map(); // meetingId → pesan error MoM terakhir

async function render() {
  const epoch = ++renderEpoch;
  if (tab === 'live') return renderMeeting(status.id, true, epoch);
  if (tab === 'history') return viewingId ? renderMeeting(viewingId, false, epoch) : renderHistory(epoch);
  return renderSettings(epoch);
}

async function renderMeeting(id, live, epoch) {
  const meeting = id ? await getMeeting(id) : null;
  if (epoch !== renderEpoch) return; // pass lebih baru sudah jalan
  const sameView = `${id}|${live}` === lastRenderedKey;
  lastRenderedKey = `${id}|${live}`;
  // Navigasi ke view lain: mulai dari bawah (live) / atas (riwayat).
  // Rerender view yang sama: pertahankan posisi baca.
  const stickToBottom = live && (!sameView || view.scrollHeight - view.scrollTop - view.clientHeight < 40);
  const prevTop = sameView ? view.scrollTop : 0;
  view.replaceChildren();

  if (live && (settingsCache.transcriptSource === 'audio')) {
    const bar = el('div', 'actions');
    if (recState.transcribing) {
      bar.append(el('span', 'muted',
        recState.total ? `Mentranskrip… ${recState.done}/${recState.total}` : 'Mentranskrip…'));
    } else if (recState.recording) {
      const stop = el('button', null, 'Stop rekam');
      stop.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'stop-recording' }));
      bar.append(stop, el('span', 'muted', ' ● merekam'));
    } else {
      // tabCapture butuh invocation activeTab yang tidak diberikan tombol side
      // panel (batasan Chrome) — start dipicu dari context menu halaman Meet.
      bar.append(el('span', 'muted', 'Untuk mulai: klik kanan di halaman Meet → "Rekam audio meeting".'));
    }
    if (recState.error) bar.append(el('div', 'err', ' ' + recState.error));
    view.append(bar);
  }

  if (settingsCache.transcriptSource !== 'audio' && live && status.inCall && !status.captionsOn) {
    view.append(el('div', 'warn',
      'Caption mati. Nyalakan CC di toolbar Meet supaya transkrip terisi.'));
  }
  const quietSince = Math.max(status.lastSegmentAt || 0, status.captionsOnAt || 0);
  if (settingsCache.transcriptSource !== 'audio' && live && status.inCall && status.captionsOn && quietSince && Date.now() - quietSince > 30000) {
    view.append(el('div', 'warn',
      'Caption nyala tapi tidak ada teks masuk 30 detik terakhir. Kalau ada yang bicara, kemungkinan DOM Meet berubah — perbaiki content/selectors.js.'));
  }

  if (!meeting) {
    view.append(el('p', 'muted',
      live ? 'Tidak ada meeting aktif. Join Google Meet dulu.' : 'Meeting tidak ditemukan.'));
    return;
  }

  if (!live) {
    const back = el('button', null, '← Riwayat');
    back.addEventListener('click', () => { viewingId = null; render(); });
    view.append(back);
  }
  view.append(el('h2', null, meeting.title));
  view.append(el('p', 'muted', new Date(meeting.startedAt).toLocaleString()));

  if (momErrors.has(meeting.id)) view.append(el('div', 'error', momErrors.get(meeting.id)));
  const actions = el('div', 'actions');
  const btn = (label, fn) => {
    const b = el('button', null, label);
    b.addEventListener('click', fn);
    actions.append(b);
    return b;
  };
  const copyBtn = btn('Copy', async () => {
    try {
      await navigator.clipboard.writeText(M.formatTranscript(meeting.segments));
      copyBtn.textContent = 'Disalin ✓';
    } catch {
      copyBtn.textContent = 'Gagal menyalin';
    }
  });
  // Prompt kosong tak berguna (Copy menyalin blank, Gemini auto-submit blank
  // message) — tombol ini hanya muncul kalau ada transkrip untuk diisi.
  if (meeting.segments.length) {
    const copyPromptBtn = btn('Copy Prompt+Transkrip', async () => {
      try {
        await navigator.clipboard.writeText(promptText(meeting));
        copyPromptBtn.textContent = 'Disalin ✓';
      } catch {
        copyPromptBtn.textContent = 'Gagal menyalin';
      }
    });
    const gemBtn = btn('Kirim ke Gemini', async () => {
      gemBtn.disabled = true; // cegah klik ganda buka beberapa tab/percakapan Gemini
      gemBtn.textContent = 'Membuka Gemini…';
      const prompt = promptText(meeting);
      // Clipboard dulu: asuransi kalau injeksi gagal (DOM Gemini berubah).
      await navigator.clipboard.writeText(prompt).catch(() => {});
      chrome.runtime.sendMessage({ type: 'send-to-gemini', text: prompt });
      // Tab Live rerender ~2 detik sekali lewat broadcast status (tombol ini
      // ikut dibuat ulang, otomatis enable) — tab Riwayat tidak rerender
      // sendiri, jadi tanpa ini tombol tetap disabled selamanya kalau injeksi
      // gagal dan user harus pindah tab lalu balik untuk coba lagi.
      setTimeout(() => { gemBtn.disabled = false; gemBtn.textContent = 'Kirim ke Gemini'; }, 3000);
    });
  }
  btn('Unduh .txt', () => download(`${meeting.title}.txt`, M.formatTranscript(meeting.segments)));
  btn('Unduh .md', () => download(`${meeting.title}.md`, M.formatMarkdown(meeting)));
  const momBtn = btn(meeting.mom ? 'Regenerate MoM' : 'Generate MoM', async () => {
    momBtn.disabled = true;
    momBtn.textContent = 'Menghasilkan…';
    momErrors.delete(meeting.id);
    const res = await chrome.runtime.sendMessage({ type: 'generate-mom', id: meeting.id })
      .catch(() => null);
    if (!res?.ok) momErrors.set(meeting.id, res?.error ?? 'Gagal menghubungi service worker.');
    render(); // state persisten + render(): epoch-safe, error tetap tampil setelah rerender
  });
  view.append(actions);

  const list = el('div');
  for (const s of meeting.segments) {
    const seg = el('div', 'seg');
    const head = el('div');
    head.append(el('span', 'who', s.speaker), el('span', 'time', new Date(s.t).toLocaleTimeString()));
    seg.append(head, el('div', null, s.text));
    list.append(seg);
  }
  if (!meeting.segments.length) list.append(el('p', 'muted', 'Belum ada caption masuk.'));
  view.append(list);

  if (meeting.mom) {
    view.append(el('h3', null, 'MoM'));
    view.append(el('div', 'mom', meeting.mom));
  }
  view.scrollTop = stickToBottom ? view.scrollHeight : prevTop;
}

async function renderHistory(epoch) {
  const { meetings = [] } = await chrome.storage.local.get('meetings');
  const items = (await Promise.all(meetings.map(getMeeting))).filter(Boolean);
  if (epoch !== renderEpoch) return;
  lastRenderedKey = null;
  view.replaceChildren();
  if (!items.length) {
    view.append(el('p', 'muted', 'Belum ada riwayat.'));
    return;
  }
  for (const m of items) {
    const item = el('button', 'item');
    item.append(
      el('div', 'who', m.title),
      el('div', 'muted',
        `${new Date(m.startedAt).toLocaleString()} — ${m.segments.length} segmen${m.mom ? ' — MoM ✓' : ''}`)
    );
    item.addEventListener('click', () => { viewingId = m.id; render(); });
    view.append(item);
  }
}

async function renderSettings(epoch) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  if (epoch !== renderEpoch) return;
  lastRenderedKey = null;
  view.replaceChildren();
  view.append(el('h2', null, 'Settings'));

  const field = (label, input) => {
    view.append(el('label', null, label), input);
    return input;
  };
  const DEFAULT_BASE = globalThis.MeetOpenAI.DEFAULT_BASE_URL;
  const baseUrl = field('Base URL (OpenAI-compatible)',
    Object.assign(document.createElement('input'), { value: settings.baseUrl ?? DEFAULT_BASE }));
  const apiKey = field('API key',
    Object.assign(document.createElement('input'), { type: 'password', value: settings.apiKey ?? '' }));
  const model = field('Model',
    Object.assign(document.createElement('input'), { value: settings.model ?? 'gpt-4o-mini' }));
  const template = field('Template MoM ({{transcript}} = transkrip)',
    Object.assign(document.createElement('textarea'), { value: settings.momTemplate ?? M.DEFAULT_MOM_TEMPLATE }));

  const source = field('Sumber transkrip',
    Object.assign(document.createElement('select'), { innerHTML: '' }));
  for (const [val, label] of [['caption', 'Caption Meet'], ['audio', 'Rekam audio']]) {
    source.append(Object.assign(document.createElement('option'), { value: val, textContent: label }));
  }
  source.value = settings.transcriptSource ?? 'caption';
  const sttModel = field('Model STT (mode audio)',
    Object.assign(document.createElement('input'), { value: settings.sttModel ?? 'nvidia/parakeet-ctc-1.1b-asr' }));
  const sttLanguage = field('Bahasa STT (mis. id, en — kosong = auto)',
    Object.assign(document.createElement('input'), { value: settings.sttLanguage ?? '' }));
  const sttModeSel = field('Mode STT (mode audio)',
    Object.assign(document.createElement('select'), { innerHTML: '' }));
  for (const [val, label] of [
    ['chat', 'Ikut endpoint chat di atas'],
    ['whisper', 'Whisper lokal'],
    ['api', 'STT API terpisah (9Router / OpenAI)'],
  ]) {
    sttModeSel.append(Object.assign(document.createElement('option'), { value: val, textContent: label }));
  }
  sttModeSel.value = globalThis.MeetStt.sttMode(settings.sttBaseUrl);
  const sttBaseUrl = field('STT Base URL',
    Object.assign(document.createElement('input'), { value: settings.sttBaseUrl ?? '' }));
  const sttApiKey = field('STT API key (kosong = tanpa auth)',
    Object.assign(document.createElement('input'), { type: 'password', value: settings.sttApiKey ?? '' }));

  // Dropdown hanya prefill dua field di atas — yang disimpan & dipakai tetap
  // sttBaseUrl, jadi user bebas mengedit URL tanpa mode ikut berubah.
  sttModeSel.addEventListener('change', () => {
    if (sttModeSel.value === 'chat') { sttBaseUrl.value = ''; sttApiKey.value = ''; }
    else if (sttModeSel.value === 'whisper') sttBaseUrl.value = globalThis.MeetStt.WHISPER_DEFAULT;
    else if (globalThis.MeetStt.sttMode(sttBaseUrl.value) !== 'api') sttBaseUrl.value = '';
  });

  const note = el('span', 'muted', '');
  const setNote = (cls, text) => { note.className = cls; note.textContent = ' ' + text; };

  const normalizedBase = () => (baseUrl.value.trim() || DEFAULT_BASE).replace(/\/+$/, '');

  // Minta izin chat + STT sekaligus: dua request permintaan berurutan di
  // satu klik kehilangan user activation di antara dialog (throw "must be
  // called during a user gesture") — satu dialog gabungan menghindari itu.
  // Dipakai baik oleh Simpan maupun Tes koneksi.
  async function ensureOrigins(bases) {
    const patterns = [];
    for (const b of bases) {
      // new URL() saja terlalu longgar: "localhost:8080/v1" (skema lupa diketik)
      // ikut parse jadi protocol "localhost:" + hostname kosong, lolos ke
      // permissions.request sebagai pattern rusak. Wajib http/https + hostname.
      let u;
      try { u = new URL(b); } catch { u = null; }
      if (!u || !/^https?:$/.test(u.protocol) || !u.hostname) throw new Error(`URL tidak valid: ${b}`);
      // Match pattern Chrome tidak boleh berisi port — pakai hostname saja
      // (pattern tanpa port otomatis mencakup semua port, mis. localhost:20128).
      const p = `${u.protocol}//${u.hostname}/*`;
      if (p !== 'https://api.openai.com/*') patterns.push(p);
    }
    if (!patterns.length) return;
    if (!await chrome.permissions.request({ origins: [...new Set(patterns)] }).catch(() => false)) {
      throw new Error(`Izin akses ${patterns.join(', ')} ditolak.`);
    }
  }

  // GET /models saja: cukup deteksi typo URL / API key kosong-salah tanpa
  // butuh file audio sungguhan. 404/405/501 tetap dianggap OK (warning) —
  // sebagian server tidak menyediakan /models sama sekali.
  async function probeStt(base, key) {
    const host = new URL(base).hostname;
    let res;
    try {
      res = await fetch(`${base}/models`, key ? { headers: { Authorization: `Bearer ${key}` } } : {});
    } catch {
      throw new Error(`Tidak bisa terhubung ke STT ${host}.`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`STT ${host}: HTTP ${res.status} (STT API key salah/kosong?)`);
    }
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      // Sebagian server whisper tidak melayani GET /models sama sekali —
      // 405/501 sama artinya dengan 404 di sini, bukan kegagalan.
      return ` (STT ${host}: endpoint /models tak didukung server — HTTP ${res.status}, cek manual.)`;
    }
    if (!res.ok) throw new Error(`STT ${host}: HTTP ${res.status}`);
    return '';
  }

  const test = el('button', null, 'Tes koneksi');
  test.addEventListener('click', async () => {
    test.disabled = true;
    setNote('muted', 'Menguji…');
    try {
      const base = normalizedBase();
      const sttBase = sttBaseUrl.value.trim().replace(/\/+$/, '');
      // Kedua origin diminta sekaligus di sini, sebelum testConnection (yang
      // bisa >5 detik) — request izin kedua setelah round-trip jaringan sudah
      // lewat batas user activation dan gagal ("must be called during a user
      // gesture"), yang salah dilaporkan sebagai izin ditolak.
      await ensureOrigins(sttBase ? [base, sttBase] : [base]);
      await globalThis.MeetOpenAI.testConnection({
        apiKey: apiKey.value.trim(),
        model: model.value.trim() || 'gpt-4o-mini',
        baseUrl: base,
      });
      const sttNote = sttBase ? await probeStt(sttBase, sttApiKey.value.trim()) : '';
      setNote('ok', `✓ Koneksi OK${sttBase ? ' (chat + STT)' : ''} — URL, API key, dan model valid.${sttNote}`);
    } catch (e) {
      setNote('err', '✗ Gagal: ' + e.message);
    }
    test.disabled = false;
  });

  const save = el('button', null, 'Simpan');
  save.addEventListener('click', async () => {
    const base = normalizedBase();
    const sttBase = sttBaseUrl.value.trim().replace(/\/+$/, '');
    let warning = null;
    try {
      await ensureOrigins(sttBase ? [base, sttBase] : [base]);
    } catch (e) {
      if (e.message.startsWith('URL tidak valid:')) return setNote('err', e.message);
      warning = e.message; // izin ditolak → tetap simpan, tapi beri tahu
    }
    await chrome.storage.local.set({
      settings: {
        apiKey: apiKey.value.trim(),
        baseUrl: base,
        model: model.value.trim() || 'gpt-4o-mini',
        momTemplate: template.value,
        transcriptSource: source.value,
        sttModel: sttModel.value.trim() || 'nvidia/parakeet-ctc-1.1b-asr',
        sttLanguage: sttLanguage.value.trim(),
        sttBaseUrl: sttBase,
        sttApiKey: sttApiKey.value.trim(),
      },
    });
    if (warning) setNote('err', `Tersimpan, tapi ${warning} Request bisa gagal.`);
    else setNote('ok', 'Tersimpan.');
  });

  const actions = el('div', 'actions');
  actions.append(test, save, note);
  view.append(actions);
}

chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && c.settings) { settingsCache = c.settings.newValue ?? {}; if (tab === 'live') render(); }
});

(async () => {
  await loadSettings();
  const a = await chrome.runtime.sendMessage({ type: 'get-active' }).catch(() => null);
  if (a) status = a;
  if (a?.rec) recState = { ...recState, recording: a.rec.recording, transcribing: a.rec.transcribing };
  render();
})();

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

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = safeName(name);
  a.click();
  // Revoke ditunda: dialog "Save as" baru membaca blob setelah click() kembali.
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

async function startRecording(btn) {
  btn.disabled = true;
  const tabId = status.tabId;
  if (!tabId) { recState = { ...recState, error: 'Tab Meet tidak terdeteksi. Join meeting dulu.' }; return render(); }
  try {
    // getMediaStreamId dipanggil di konteks gesture klik (wajib untuk tabCapture).
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await chrome.runtime.sendMessage({ type: 'start-recording', streamId, meetingId: status.id, tabId });
  } catch (e) {
    recState = { ...recState, error: 'Gagal mulai rekam: ' + e.message };
    render();
  }
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
      const startBtn = el('button', null, 'Mulai rekam');
      startBtn.addEventListener('click', () => startRecording(startBtn));
      bar.append(startBtn);
    }
    if (recState.error) bar.append(el('div', 'err', ' ' + recState.error));
    view.append(bar);
  }

  if (live && status.inCall && !status.captionsOn) {
    view.append(el('div', 'warn',
      'Caption mati. Nyalakan CC di toolbar Meet supaya transkrip terisi.'));
  }
  const quietSince = Math.max(status.lastSegmentAt || 0, status.captionsOnAt || 0);
  if (live && status.inCall && status.captionsOn && quietSince && Date.now() - quietSince > 30000) {
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

  const note = el('span', 'muted', '');
  const setNote = (cls, text) => { note.className = cls; note.textContent = ' ' + text; };

  const normalizedBase = () => (baseUrl.value.trim() || DEFAULT_BASE).replace(/\/+$/, '');

  // Host selain default butuh izin runtime (manifest hanya mengizinkan
  // api.openai.com). Diminta di sini karena perlu user gesture.
  async function ensureOrigin(base) {
    let u;
    try {
      u = new URL(base);
    } catch {
      throw new Error('Base URL tidak valid.');
    }
    // Match pattern Chrome tidak boleh berisi port — pakai hostname saja
    // (pattern tanpa port otomatis mencakup semua port, mis. localhost:20128).
    const pattern = `${u.protocol}//${u.hostname}/*`;
    if (pattern === 'https://api.openai.com/*') return;
    const ok = await chrome.permissions.request({ origins: [pattern] }).catch(() => false);
    if (!ok) throw new Error(`Izin akses ${u.hostname} ditolak.`);
  }

  const test = el('button', null, 'Tes koneksi');
  test.addEventListener('click', async () => {
    test.disabled = true;
    setNote('muted', 'Menguji…');
    try {
      const base = normalizedBase();
      await ensureOrigin(base);
      await globalThis.MeetOpenAI.testConnection({
        apiKey: apiKey.value.trim(),
        model: model.value.trim() || 'gpt-4o-mini',
        baseUrl: base,
      });
      setNote('ok', '✓ Koneksi OK — URL, API key, dan model valid.');
    } catch (e) {
      setNote('err', '✗ Gagal: ' + e.message);
    }
    test.disabled = false;
  });

  const save = el('button', null, 'Simpan');
  save.addEventListener('click', async () => {
    const base = normalizedBase();
    let warning = null;
    try {
      await ensureOrigin(base);
    } catch (e) {
      if (e.message === 'Base URL tidak valid.') return setNote('err', e.message);
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
  if (area === 'local' && c.settings) { settingsCache = c.settings.newValue ?? {}; if (tab !== 'history') render(); }
});

(async () => {
  await loadSettings();
  const a = await chrome.runtime.sendMessage({ type: 'get-active' }).catch(() => null);
  if (a) status = a;
  render();
})();

// panel/panel.js — render live transcript, riwayat, settings dari storage.
const M = globalThis.MeetMerge;
const view = document.getElementById('view');
let tab = 'live';
let viewingId = null; // di tab Riwayat: meeting yang sedang dibuka
let status = { id: null, inCall: false, captionsOn: false, lastSegmentAt: 0, captionsOnAt: 0 };

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
  const apiKey = field('API key',
    Object.assign(document.createElement('input'), { type: 'password', value: settings.apiKey ?? '' }));
  const baseUrl = field('Base URL (OpenAI-compatible; OpenRouter: https://openrouter.ai/api/v1)',
    Object.assign(document.createElement('input'), { value: settings.baseUrl ?? DEFAULT_BASE }));
  const model = field('Model',
    Object.assign(document.createElement('input'), { value: settings.model ?? 'gpt-4o-mini' }));
  const template = field('Template MoM ({{transcript}} = transkrip)',
    Object.assign(document.createElement('textarea'), { value: settings.momTemplate ?? M.DEFAULT_MOM_TEMPLATE }));

  const save = el('button', null, 'Simpan');
  const note = el('span', 'muted', '');
  save.addEventListener('click', async () => {
    const base = (baseUrl.value.trim() || DEFAULT_BASE).replace(/\/+$/, '');
    let origin;
    try {
      origin = new URL(base).origin;
    } catch {
      note.textContent = ' Base URL tidak valid.';
      return;
    }
    // Host selain default butuh izin runtime (manifest hanya mengizinkan
    // api.openai.com). Diminta di sini karena perlu user gesture.
    let denied = false;
    if (origin !== 'https://api.openai.com') {
      denied = !(await chrome.permissions.request({ origins: [origin + '/*'] }).catch(() => false));
    }
    await chrome.storage.local.set({
      settings: {
        apiKey: apiKey.value.trim(),
        baseUrl: base,
        model: model.value.trim() || 'gpt-4o-mini',
        momTemplate: template.value,
      },
    });
    note.textContent = denied
      ? ` Tersimpan, tapi izin akses ${origin} ditolak — request bisa gagal.`
      : ' Tersimpan.';
  });
  view.append(save, note);
}

(async () => {
  const a = await chrome.runtime.sendMessage({ type: 'get-active' }).catch(() => null);
  if (a) status = a;
  render();
})();

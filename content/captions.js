// content/captions.js — observe caption Meet, kirim segmen + status ke service worker.
(() => {
  const S = globalThis.MeetSelectors;
  const SESS = globalThis.MeetSession;

  let sourceMode = 'caption';
  // Snapshot get() bisa lebih tua dari onChanged yang mendarat selagi get
  // berjalan — kalau sudah ada perubahan, snapshot itu basi, abaikan.
  let sourceChanged = false;
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== 'local' || !c.settings) return;
    sourceChanged = true;
    sourceMode = c.settings.newValue?.transcriptSource ?? 'caption';
  });
  chrome.storage.local.get('settings').then((d) => {
    if (!sourceChanged) sourceMode = d.settings?.transcriptSource ?? 'caption';
  }).catch(() => {});

  let port = null;
  let statusTimer = null;
  let flushTimer = null;

  function connect() {
    const p = chrome.runtime.connect({ name: 'captions' });
    // Identitas dicek: kalau postMessage sempat melempar (port mati) dan `port`
    // sudah diganti yang baru, handler port LAMA yang datang belakangan tidak
    // boleh menihilkan port yang sedang hidup — kalau itu terjadi, post
    // berikutnya membuka port ketiga dan service worker melihat dua port hidup
    // yang masing-masing melacak meetingId sendiri.
    p.onDisconnect.addListener(() => { if (port === p) port = null; });
    port = p;
  }

  function stopAll() {
    // Extension di-reload/di-update → content script ini yatim dan tidak akan
    // pernah bisa reconnect. Matikan semua supaya tidak spam error tiap tick.
    clearInterval(statusTimer);
    clearInterval(flushTimer);
    observer?.disconnect();
    observer = null;
  }

  function post(msg) {
    if (!chrome.runtime?.id) { // context invalidated (extension reload)
      stopAll();
      return false;
    }
    try {
      if (!port) connect();
      port.postMessage(msg);
      return true;
    } catch {
      port = null; // SW restart → reconnect & retry di tick berikutnya
      return false;
    }
  }

  let blockIds = new WeakMap();   // element block → id segmen
  const firstSeen = new Map();    // id → timestamp pertama terlihat
  // Tag unik per sesi script: reload tab me-reset counter; tanpa tag,
  // id baru menabrak id lama di storage dan menimpa awal transkrip.
  // Sengaja TIDAK di-reset saat pindah ruang: counter yang jalan terus justru
  // menjaga id tetap unik di satu dokumen yang melewati beberapa meeting.
  const sessionTag = crypto.randomUUID().slice(0, 8);
  let nextId = 1;
  const dirty = new Map();        // id → segmen yang berubah sejak flush terakhir
  let observer = null;
  let observedRegion = null;
  let ccAttempts = 0;

  let sess = { ...SESS.INITIAL };

  function openSession() {
    ccAttempts = 0;
    // Semua state per-meeting dibuang bersama. blockIds ikut: element caption
    // yang selamat melewati pergantian ruang akan mempertahankan id lamanya
    // sementara firstSeen-nya sudah hilang, jadi segmen itu dapat timestamp
    // baru dan — lebih buruk — terkirim dengan meetingId ruang yang baru.
    blockIds = new WeakMap();
    dirty.clear();
    firstSeen.clear();
    observer?.disconnect();
    observer = null;
    observedRegion = null;
  }

  // Menutup port ADALAH sinyal "meeting selesai" ke service worker: di sana
  // port.onDisconnect yang menghentikan rekaman audio (chunk terakhir
  // difinalisasi, audio tersimpan, transkrip jalan) lalu menandai endedAt.
  // Tidak ada pesan khusus — jalur yang sama dipakai saat tab ditutup.
  function closeSession(endedId, hadJoined) {
    // Flush terakhir SEBELUM port ditutup. Tick 2 detik vs flush 500ms berarti
    // selalu ada caption ekor yang belum terkirim, dan batch yang gagal kirim
    // sengaja ditahan di `dirty` untuk retry — keduanya hilang permanen kalau
    // port ditutup lebih dulu. Pakai id yang BARU BERAKHIR, bukan sess.curId:
    // saat pindah ruang, sess sudah menunjuk ruang berikutnya.
    if (dirty.size && endedId) {
      post({ type: 'segments', meetingId: endedId, title: S.meetingTitle(), segs: [...dirty.values()] });
    }
    // Dikosongkan tanpa memeriksa hasil post. Kalau post gagal (SW
    // mati tepat di tick penutup) segmen ekor itu memang hilang — sesi sudah
    // ditutup, flush timer digate sess.report, tak ada lagi yang mengirimnya.
    // Menahannya hanya menunda pembuangan sampai openSession berikutnya.
    dirty.clear();
    // Observer ikut dilepas: tanpa ini ia terus memindai meeting yang sudah
    // berakhir ke dalam dirty sampai sesi berikutnya membersihkannya.
    observer?.disconnect();
    observer = null;
    observedRegion = null;
    // Sinyal selesai EKSPLISIT, tidak menggantungkan diri pada port.onDisconnect
    // saja: kalau port sempat mati (SW restart) lalu post di atas membukanya
    // kembali, port BARU itu tak punya riwayat "pernah in-call" di service
    // worker — disconnect-nya diabaikan, rekaman tak pernah difinalisasi, dan
    // meeting tak pernah ditutup. hadJoined dibawa supaya SW tak perlu menebak.
    if (endedId) post({ type: 'ended', meetingId: endedId, joined: !!hadJoined });
    port?.disconnect(); // disconnect() tidak memicu onDisconnect di sisi pemanggil
    port = null;
  }

  function scan(region) {
    for (const block of S.captionBlocks(region)) {
      if (!block) continue;
      let id = blockIds.get(block);
      if (!id) { id = `${sessionTag}:${nextId++}`; blockIds.set(block, id); }
      const text = S.blockText(block);
      if (!text) continue;
      if (!firstSeen.has(id)) firstSeen.set(id, Date.now());
      dirty.set(id, { id, speaker: S.blockSpeaker(block), text, t: firstSeen.get(id) });
    }
  }

  // Tick 2 detik: lacak ruang aktif, pasang/lepas observer, auto-CC, lapor status.
  function tick() {
    // Dicek di sini, bukan cuma di post(): kedua pemanggil post() digate
    // sess.report, jadi tab yang di-reload lalu berhenti di halaman landing
    // tidak akan pernah sampai ke pengecekan itu dan kedua timer-nya berdetak
    // selamanya di script yang sudah yatim.
    if (!chrome.runtime?.id) { stopAll(); return; }

    const inCall = S.inCall();
    const prevId = sess.curId;
    const prevJoined = sess.sawInCall;
    // URL dibaca tiap tick, bukan sekali saat load: Meet adalah SPA — landing →
    // lobby → in-call → ruang lain semuanya lewat History API di satu dokumen,
    // jadi content script tidak pernah di-inject ulang. Id yang beku membuat
    // caption ruang baru tertulis ke record ruang lama.
    sess = SESS.step(sess, { id: SESS.meetingIdFrom(location.pathname), inCall });
    if (sess.close) closeSession(prevId, prevJoined);
    if (sess.open) openSession();
    if (!sess.report) return;

    const region = S.captionsRegion();
    if (region && region !== observedRegion) {
      observer?.disconnect();
      observer = new MutationObserver(() => scan(region));
      observer.observe(region, { childList: true, subtree: true, characterData: true });
      observedRegion = region;
      scan(region);
    } else if (!region && observer) {
      observer.disconnect();
      observer = null;
      observedRegion = null;
    }
    // Mode audio tidak memaksa CC menyala. Konsekuensinya: kalau selector
    // inCall() rusak, auto-CC juga tak pernah jalan — jadi transkrip caption
    // hanya "tetap jalan" kalau user menyalakan CC sendiri.
    if (sourceMode !== 'audio' && !region && inCall && !S.ccEnabled() && ccAttempts < 3) {
      S.ccButton()?.click(); // coba nyalakan CC otomatis
      ccAttempts++;
    }
    post({ type: 'status', meetingId: sess.curId, inCall, captionsOn: !!region });
  }

  // Flush 500ms: kirim hanya segmen yang berubah; batch gagal di-retry tick
  // berikutnya. TIDAK digate "Sumber transkrip": caption dan rekam audio boleh
  // jalan bersama di satu meeting — replaceAudioSegments mempertahankan baris
  // caption dan mengurutkan gabungannya per timestamp.
  flushTimer = setInterval(() => {
    if (!sess.report || !dirty.size) return;
    const sent = post({ type: 'segments', meetingId: sess.curId, title: S.meetingTitle(), segs: [...dirty.values()] });
    if (sent) dirty.clear();
  }, 500);

  // Interval dipasang SEBELUM tick pertama: tick itu bisa memanggil stopAll(),
  // dan clearInterval(null) untuk timer yang belum terisi tidak menghentikan
  // apa pun — script yatim tetap berdetak.
  statusTimer = setInterval(tick, 2000);
  tick(); // tab yang di-load langsung di dalam call tak perlu menunggu 2 detik
})();

// content/captions.js — observe caption Meet, kirim segmen + status ke service worker.
(() => {
  const S = globalThis.MeetSelectors;
  const meetingId = location.pathname.slice(1);
  if (!/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(meetingId)) return; // bukan halaman call

  let port = null;
  function connect() {
    port = chrome.runtime.connect({ name: 'captions' });
    port.onDisconnect.addListener(() => { port = null; }); // SW restart → reconnect di post berikutnya
  }
  function post(msg) {
    if (!port) connect();
    try {
      port.postMessage(msg);
      return true;
    } catch {
      port = null; // SW restart → reconnect & retry di tick berikutnya
      return false;
    }
  }

  const blockIds = new WeakMap(); // element block → id segmen
  const firstSeen = new Map();    // id → timestamp pertama terlihat
  let nextId = 1;
  const dirty = new Map();        // id → segmen yang berubah sejak flush terakhir
  let observer = null;
  let observedRegion = null;
  let ccAttempts = 0;

  function scan(region) {
    for (const block of S.captionBlocks(region)) {
      if (!block) continue;
      let id = blockIds.get(block);
      if (!id) { id = nextId++; blockIds.set(block, id); }
      const text = S.blockText(block);
      if (!text) continue;
      if (!firstSeen.has(id)) firstSeen.set(id, Date.now());
      dirty.set(id, { id, speaker: S.blockSpeaker(block), text, t: firstSeen.get(id) });
    }
  }

  // Tick 2 detik: pasang/lepas observer, auto-CC, lapor status.
  setInterval(() => {
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
    if (!region && S.inCall() && !S.ccEnabled() && ccAttempts < 3) {
      S.ccButton()?.click(); // coba nyalakan CC otomatis
      ccAttempts++;
    }
    post({ type: 'status', meetingId, inCall: S.inCall(), captionsOn: !!region });
  }, 2000);

  // Flush 500ms: kirim hanya segmen yang berubah; batch gagal di-retry tick berikutnya.
  setInterval(() => {
    if (!dirty.size) return;
    const sent = post({ type: 'segments', meetingId, title: S.meetingTitle(), segs: [...dirty.values()] });
    if (sent) dirty.clear();
  }, 500);

  connect();
})();

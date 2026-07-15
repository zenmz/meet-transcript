// content/selectors.js — SEMUA selector DOM Meet ada di file ini, tidak di tempat lain.
// DOM Meet di-obfuscate dan berubah tiap beberapa bulan. Kalau transkrip berhenti
// terisi, perbaiki selector di sini. Urutan selector: paling spesifik dulu,
// fallback berbasis aria/struktur di belakang.
(() => {
  const q = (sels, root = document) => {
    for (const s of sels) {
      try {
        const el = root.querySelector(s);
        if (el) return el;
      } catch { /* selector tidak valid di browser lama — lewati */ }
    }
    return null;
  };

  function captionsRegion() {
    return q([
      'div[jsname="dsyhDe"]',        // container caption (build 2024-2025)
      'div[aria-label="Captions"]',  // fallback aria (UI English)
      'div[aria-label="Teks"]',      // fallback aria (UI Indonesia)
      '.a4cQT',                      // class container lama
    ]);
  }

  function captionBlocks(region) {
    // div[jsname="tgaKEf"] = elemen teks caption; parent-nya = block satu
    // giliran bicara (avatar + nama + teks).
    const texts = region.querySelectorAll('div[jsname="tgaKEf"]');
    if (texts.length) return [...texts].map((t) => t.parentElement);
    // Fallback struktural: anak langsung region yang punya avatar <img>.
    return [...region.children].filter((c) => c.querySelector('img'));
  }

  function blockSpeaker(block) {
    const el = q(['.NWpY1d', '.zs7s8d'], block);
    if (el) return el.textContent.trim();
    // Fallback struktural: sibling setelah avatar = nama.
    const img = block.querySelector('img');
    const sib = img && img.nextElementSibling;
    return (sib && sib.textContent.trim()) || 'Unknown';
  }

  function blockText(block) {
    const el = q(['div[jsname="tgaKEf"]'], block);
    if (el) return el.textContent.trim();
    // Fallback: seluruh teks block minus nama pembicara.
    return block.textContent.replace(blockSpeaker(block), '').trim();
  }

  function ccButton() {
    return q([
      'button[jsname="r8qRAd"]',
      'button[aria-label*="caption" i]',
      'button[aria-label*="teks" i]',
    ]);
  }

  function ccEnabled() {
    const b = ccButton();
    return !!b && b.getAttribute('aria-pressed') === 'true';
  }

  function inCall() {
    return !!q([
      'button[jsname="CQylAd"]',
      'button[aria-label*="leave call" i]',
      'button[aria-label*="keluar dari panggilan" i]',
    ]);
  }

  function meetingTitle() {
    return document.title.replace(/^Meet\s*[-–]\s*/, '').trim() || location.pathname.slice(1);
  }

  globalThis.MeetSelectors = {
    captionsRegion, captionBlocks, blockSpeaker, blockText,
    ccButton, ccEnabled, inCall, meetingTitle,
  };
})();

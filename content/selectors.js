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

  // Diekspor juga: captionhide.js memakainya sebagai selector CSS untuk
  // menyembunyikan container yang sama.
  const CAPTION_REGION = [
    'div[jsname="dsyhDe"]',        // container caption (build 2024-2025)
    'div[aria-label="Captions"]',  // fallback aria (UI English)
    'div[aria-label="Teks"]',      // fallback aria (UI Indonesia)
    '.a4cQT',                      // class container lama
  ];
  function captionsRegion() {
    return q(CAPTION_REGION);
  }

  function captionBlocks(region) {
    // Struktur per 2026-07 (diverifikasi di Meet asli):
    //   div.nMcdL           = block satu giliran bicara
    //     div.adE6rb        = header: img avatar + span.NWpY1d nama
    //     div.ygicle        = teks caption
    // Tombol "Jump to bottom" (div.IMKgW) ada di luar block → tak ikut ke-scrape.
    const blocks = region.querySelectorAll('div.nMcdL');
    if (blocks.length) return [...blocks];
    // Build lama: div[jsname="tgaKEf"] = elemen teks; parent = block.
    const texts = region.querySelectorAll('div[jsname="tgaKEf"]');
    if (texts.length) return [...texts].map((t) => t.parentElement);
    // Fallback struktural terakhir (lemah): anak langsung region yang punya avatar.
    return [...region.children].filter((c) => c.querySelector('img'));
  }

  function blockSpeaker(block) {
    const el = q(['.NWpY1d', '.KcIKyf', '.zs7s8d'], block);
    if (el) return el.textContent.trim();
    // Fallback struktural: sibling setelah avatar = nama.
    const img = block.querySelector('img');
    const sib = img && img.nextElementSibling;
    return (sib && sib.textContent.trim()) || 'Unknown';
  }

  function blockText(block) {
    const el = q(['.ygicle', 'div[jsname="tgaKEf"]'], block);
    if (el) return el.textContent.trim();
    // Fallback: teks block minus header (avatar+nama) & elemen UI (tombol/ikon).
    const clone = block.cloneNode(true);
    clone.querySelectorAll('img, button, i').forEach((n) => n.remove());
    return clone.textContent.replace(blockSpeaker(block), '').trim();
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

  // String KOSONG = "tidak tahu, jangan ubah judul yang sudah tersimpan".
  // Jangan pernah mengarang judul dari location.pathname: script ini jalan di
  // seluruh meet.google.com, dan saat pindah ruang / keluar call pathname sudah
  // menunjuk ruang BERIKUTNYA (atau /landing) sementara flush terakhir masih
  // milik ruang sebelumnya — saveSegments akan menimpa judul aslinya dengan
  // kode ruang lain. Trailing " - Google Meet" ikut dibuang supaya cocok dengan
  // titleFromTab di service worker (dua jalur, satu bentuk judul).
  function meetingTitle() {
    const t = document.title
      .replace(/^Meet\s*[-–—]\s*/, '')
      .replace(/\s*[-–—]\s*Google Meet\s*$/, '')
      .trim();
    return t && t !== 'Meet' ? t : '';
  }

  globalThis.MeetSelectors = {
    captionsRegion, captionBlocks, blockSpeaker, blockText,
    ccButton, ccEnabled, inCall, meetingTitle, CAPTION_REGION,
  };
})();

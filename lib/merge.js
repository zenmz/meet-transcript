// lib/merge.js — logika pure: merge segmen caption + formatting.
// Classic script (bukan ES module): dipakai lewat globalThis oleh service worker
// (importScripts), panel (script tag), dan test (import side-effect).
(() => {
  // Caption Meet bermutasi di tempat (teks tumbuh/dikoreksi), jadi segmen
  // ber-id sama di-update, bukan di-append. Cari dari belakang: hanya
  // segmen terakhir yang masih bermutasi.
  function upsertSegment(segments, seg) {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i].id === seg.id) {
        segments[i].speaker = seg.speaker;
        segments[i].text = seg.text;
        return segments;
      }
    }
    segments.push({ ...seg });
    return segments;
  }

  // Baris audio milik SATU rekaman diganti seluruhnya, bukan di-upsert: satu
  // transkrip ulang menghasilkan set baris utuh yang baru, dan upsert dengan id
  // bergeser membuat hasil lama menumpuk di hasil baru.
  //
  // Id dicap baseTime rekamannya (`audio:<baseTime>:<i>`), jadi satu rekaman =
  // satu grup. Tanpa cap ini rekaman KEDUA di ruang Meet yang sama menghapus
  // transkrip rekaman pertama — keduanya menomori ulang dari audio:0, dan
  // audionya pun sudah hilang (beginAudio meng-clear store), jadi hilangnya
  // permanen dan senyap.
  //
  // `replace` hanya true di jalur "Transkrip ulang", satu-satunya jalur yang
  // memang menggantikan hasil sebelumnya.
  //
  // `legacy` (id tanpa cap, dari versi sebelum cap ada) HANYA ikut dibuang kalau
  // audio yang sedang ditranskrip ulang memang rekaman legacy itu sendiri.
  // Membuangnya tiap kali replace=true adalah bug yang persis sama dengan yang
  // fungsi ini perbaiki: rekam sebelum upgrade (id lama) → upgrade → rekam lagi
  // di ruang sama (id bercap) → transkrip ulang rekaman kedua akan menghapus
  // transkrip rekaman pertama, yang audionya sudah lama dibuang beginAudio.
  //
  // Baris caption dipertahankan — caption dan rekam audio boleh jalan bersama
  // di satu meeting — lalu gabungannya diurutkan per timestamp, karena baris
  // caption ada lebih dulu di array.
  // Hasil kosong TIDAK menghapus apa pun: transkrip lama yang bagus tidak boleh
  // hangus karena satu percobaan yang tak menghasilkan teks.
  function replaceAudioSegments(segments, audioSegs, { baseTime = 0, replace = false, legacy = false } = {}) {
    if (!audioSegs.length) return segments;
    const tag = `audio:${baseTime}:`;
    const UNTAGGED = /^audio:\d+$/; // id sebelum cap baseTime ada
    const drop = (id) => {
      const s = String(id ?? '');
      return s.startsWith(tag) || (replace && legacy && UNTAGGED.test(s));
    };
    return segments
      .filter((s) => !drop(s.id))
      .concat(audioSegs.map((seg, i) => ({ ...seg, id: `${tag}${i}` })))
      .sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  }

  const pad = (n) => String(n).padStart(2, '0');
  function timeOf(t) {
    const d = new Date(t);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function formatTranscript(segments) {
    return segments.map((s) => s.speaker
      ? `[${timeOf(s.t)}] ${s.speaker}: ${s.text}`
      : `[${timeOf(s.t)}] ${s.text}`).join('\n');
  }

  function formatMarkdown(meeting) {
    const lines = [`# ${meeting.title}`, '', new Date(meeting.startedAt).toLocaleString(), ''];
    for (const s of meeting.segments) lines.push(s.speaker
      ? `- **${s.speaker}** (${timeOf(s.t)}): ${s.text}`
      : `- (${timeOf(s.t)}): ${s.text}`);
    if (meeting.mom) lines.push('', '---', '', '## MoM', '', meeting.mom);
    return lines.join('\n');
  }

  // Kode ruang Meet permanen per link — meeting recurring memakai kode yang
  // sama tiap kali. Dua helper ini yang memutuskan "segmen yang datang untuk
  // record lama ini masih sesi yang sama, atau occurrence baru yang harus
  // dipisah" (service worker mengarsipkan record lama kalau stale).
  //
  // Kapan sesi record ini terakhir hidup: endedAt kalau sempat tercatat;
  // sesi yang mati tanpa penutupan (browser crash — endedAt null) jatuh ke
  // timestamp segmen terakhir, lalu startedAt untuk record tanpa segmen.
  function lastActivityAt(meeting) {
    if (meeting.endedAt) return meeting.endedAt;
    let last = meeting.startedAt ?? 0;
    for (const s of meeting.segments ?? []) if ((s.t ?? 0) > last) last = s.t;
    return last;
  }

  const SESSION_GAP_MS = 30 * 60 * 1000;
  // Ambang terpisah untuk record TANPA endedAt: meeting live yang hening lama
  // (tak ada yang bicara) juga tak punya endedAt, dan memisahnya di ambang 30
  // menit membelah meeting yang masih berjalan. 6 jam cukup langka untuk
  // hening sungguhan, cukup pendek untuk tetap memisah standup besoknya
  // setelah crash.
  const CRASH_GAP_MS = 6 * 60 * 60 * 1000;

  function isStaleMeeting(meeting, now) {
    const gap = meeting.endedAt ? SESSION_GAP_MS : CRASH_GAP_MS;
    return now - lastActivityAt(meeting) > gap;
  }

  // Record mana yang memiliki rekaman ber-baseTime ini: yang mulai sebelum
  // (atau tepat saat) rekaman itu dimulai — ambil yang paling muda. Dipakai
  // saat transkrip lambat selesai SETELAH ruangnya diarsip dan dipakai
  // occurrence baru: hasilnya harus mendarat di record arsip pemiliknya.
  function ownerOfRecording(records, baseTime) {
    let best = null;
    for (const r of records) {
      if (r && r.startedAt <= baseTime && (!best || r.startedAt > best.startedAt)) best = r;
    }
    return best;
  }

  function fillTemplate(template, transcript) {
    // split/join: replaceAll menafsirkan pola $ di string pengganti
    return template.split('{{transcript}}').join(transcript);
  }

  const DEFAULT_MOM_TEMPLATE = `Buat Minutes of Meeting (MoM) dari transkrip meeting berikut.

Format:
## Date:
## Related Project:
## Participants
## Context
## Discussion
## Action Items (siapa, apa)

Transkrip:
{{transcript}}`;

  globalThis.MeetMerge = {
    upsertSegment, replaceAudioSegments, formatTranscript, formatMarkdown, fillTemplate,
    lastActivityAt, isStaleMeeting, ownerOfRecording, SESSION_GAP_MS, CRASH_GAP_MS,
    DEFAULT_MOM_TEMPLATE,
  };
})();

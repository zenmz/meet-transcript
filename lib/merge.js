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

  const pad = (n) => String(n).padStart(2, '0');
  function timeOf(t) {
    const d = new Date(t);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function formatTranscript(segments) {
    return segments.map((s) => `[${timeOf(s.t)}] ${s.speaker}: ${s.text}`).join('\n');
  }

  function formatMarkdown(meeting) {
    const lines = [`# ${meeting.title}`, '', new Date(meeting.startedAt).toLocaleString(), ''];
    for (const s of meeting.segments) lines.push(`- **${s.speaker}** (${timeOf(s.t)}): ${s.text}`);
    if (meeting.mom) lines.push('', '---', '', '## MoM', '', meeting.mom);
    return lines.join('\n');
  }

  function fillTemplate(template, transcript) {
    return template.replaceAll('{{transcript}}', transcript);
  }

  const DEFAULT_MOM_TEMPLATE = `Buat Minutes of Meeting (MoM) dari transkrip meeting berikut.

Format:
## Ringkasan
## Poin Pembahasan
## Keputusan
## Action Items (siapa, apa, tenggat)

Transkrip:
{{transcript}}`;

  globalThis.MeetMerge = {
    upsertSegment, formatTranscript, formatMarkdown, fillTemplate, DEFAULT_MOM_TEMPLATE,
  };
})();

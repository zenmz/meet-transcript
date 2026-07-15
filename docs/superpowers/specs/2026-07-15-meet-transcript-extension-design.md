# Meet Transcript Extension — Design (v1)

Tanggal: 2026-07-15
Status: Disetujui user

## Tujuan

Chrome extension (Manifest V3) yang membuat transkrip dari Google Meet dengan
men-scrape live caption bawaan Meet, menampilkannya live di Chrome Side Panel,
menyimpan riwayat per meeting, mendukung copy/download (.txt/.md), dan
men-generate Minutes of Meeting (MoM) via OpenAI API dengan template prompt
yang bisa diatur user.

## Scope

**v1 (masuk):**
- Scrape caption Meet dari DOM (bukan audio capture).
- Live transcript di Chrome Side Panel.
- Auto-save per meeting + riwayat yang bisa dibuka lagi.
- Copy ke clipboard, download .txt/.md.
- Generate MoM via OpenAI API (API key milik user), format via template prompt
  di settings.

**v2 (ditunda, eksplisit di luar scope):**
- Integrasi eksternal: Notion, Google Docs, webhook.
- Audio capture + Speech-to-Text.

## Keputusan teknis

| Keputusan | Pilihan | Alasan |
|---|---|---|
| Sumber transkrip | Scrape caption DOM | Gratis, tanpa API, nama pembicara tersedia |
| UI | Chrome Side Panel | Tetap terbuka selama meeting, tidak ganggu layar Meet |
| Stack | Vanilla JS, tanpa build step | Zero tooling, cukup untuk scope ini |
| Settings | Tab di dalam side panel | Tanpa halaman options terpisah |
| Download | Blob + `<a download>` | Tanpa permission `downloads` |

## Arsitektur

```
[Content script @ meet.google.com]
  MutationObserver pada area caption
  → segmen {speaker, text, timestamp}
  → chrome.runtime message
[Service worker]
  → simpan sesi aktif ke chrome.storage.local
  → fetch OpenAI saat generate MoM
[Side panel]
  → live transcript, riwayat, copy/download, tombol MoM, tab Settings
```

- Meeting ID dari URL: `meet.google.com/xxx-yyyy-zzz`.
- Meeting dianggap selesai saat content script unload / user keluar dari call.

## Caption scraping (bagian paling rapuh)

- Class name DOM Meet di-obfuscate dan sering berubah. Selector ditargetkan
  via atribut stabil (aria/role) dengan fallback, dan **semua selector
  diisolasi di `content/selectors.js`** supaya mudah diperbaiki saat Meet
  mengubah DOM-nya.
- Caption Meet bermutasi di tempat (teks tumbuh/dikoreksi). Logika merge:
  update segmen terakhir per pembicara, bukan append duplikat. Segmen
  difinalisasi saat node caption hilang atau pembicara berganti.
- Caption harus menyala. Extension mencoba auto-klik tombol CC saat join;
  jika gagal, panel menampilkan peringatan + instruksi manual.

## Data model & storage

```js
// chrome.storage.local
"meeting:<id>" = {
  id, title, startedAt, endedAt,
  segments: [{ t, speaker, text }],
  mom: null | string,
}
"meetings" = [id, ...]                       // index riwayat, terbaru dulu
"settings" = { apiKey, model, momTemplate }  // model default: gpt-4o-mini
```

- Permission `unlimitedStorage` disertakan (transkrip panjang).
- API key disimpan di `storage.local`, bukan `storage.sync` — secret tidak
  di-sync antar device.

## Generate MoM

- Settings: API key OpenAI, pilihan model (default `gpt-4o-mini`), template
  prompt (textarea) dengan placeholder `{{transcript}}`. Format MoM
  sepenuhnya dikendalikan template.
- Tombol "Generate MoM" di panel → service worker → POST
  `https://api.openai.com/v1/chat/completions` → hasil disimpan di
  `meeting.mom`, ditampilkan di panel, bisa di-copy/download.

## Struktur file

```
manifest.json
content/selectors.js       # semua selector DOM Meet di sini
content/captions.js        # observer + kirim segmen
background/service-worker.js
panel/panel.html|js|css    # transcript, riwayat, settings tab
lib/merge.js               # logika merge segmen (pure, di-unit-test)
lib/openai.js
test/merge.test.mjs        # node --test, tanpa framework
```

## Permissions

- `sidePanel`, `storage`, `unlimitedStorage`
- Host: `https://meet.google.com/*`, `https://api.openai.com/*`

## Error handling

- Caption mati → warning di panel + instruksi menyalakan CC.
- API error (key salah, quota habis, network) → pesan jelas di panel.
- Meet mengubah DOM → tidak ada segmen masuk padahal sedang di call → panel
  menampilkan peringatan "transcript tidak terisi".

## Testing

- `lib/merge.js` (logika paling rawan) di-unit-test dengan `node --test`.
- Sisanya diverifikasi manual di Google Meet asli.

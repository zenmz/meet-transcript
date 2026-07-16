# Mode Transkrip Audio (tanpa caption) — Design

Tanggal: 2026-07-16
Status: Disetujui user (menunggu review spec)
Extension: Meet Transcript (Chrome MV3, vanilla JS)

## Tujuan

Alternatif menghasilkan transkrip Google Meet **tanpa mengaktifkan caption
bawaan Meet**: rekam audio tab Meet, lalu transkrip via speech-to-text (STT)
endpoint OpenAI-compatible (mis. 9Router `nvidia/parakeet-ctc-1.1b-asr`).
Mode dipilih di Settings; mode caption existing tetap ada.

## Keputusan (dari brainstorm)

| Aspek | Pilihan |
|---|---|
| Sumber audio | `chrome.tabCapture` — audio tab Meet (suara peserta) |
| Waktu STT | Rekam penuh, transkrip di akhir (saat Stop) |
| Relasi mode caption | Toggle di Settings: `caption` / `audio`, satu aktif |
| Endpoint STT | Base URL yang sama, `POST <baseUrl>/audio/transcriptions` |
| Model STT | Field di Settings (default `nvidia/parakeet-ctc-1.1b-asr`) |
| Bahasa STT | Field di Settings (mis. `id`), dikirim param `language` |
| Kontrol rekam | Tombol **Mulai rekam** / **Stop** manual di panel |
| Nama pembicara | Tidak ada — segmen = teks + timestamp, `speaker` kosong |
| Durasi chunk | 10 menit (hardcode) |

## Kendala MV3 (membentuk arsitektur)

- Service worker tidak punya DOM → **tidak bisa** MediaRecorder/tabCapture.
  Rekaman berjalan di **offscreen document** (`chrome.offscreen`, permission
  `offscreen`, reason `USER_MEDIA`).
- `tabCapture` butuh **user gesture** → mode audio wajib tombol start manual.
- tabCapture membuat tab **bisu** untuk user → offscreen harus **re-inject**
  stream ke speaker via Web Audio (`AudioContext` → `destination`).

## Arsitektur & alur

```
[Panel] mode audio, tombol "Mulai rekam"
  → chrome.runtime message {type:'start-recording', tabId}
[Service worker]
  → chrome.tabCapture.getMediaStreamId({targetTabId}) (perlu gesture dari panel)
  → pastikan offscreen document ada (chrome.offscreen.createDocument)
  → kirim streamId ke offscreen
[Offscreen document]
  → getUserMedia({audio:{mandatory:{chromeMediaSource:'tab',
       chromeMediaSourceId: streamId}}})
  → AudioContext: sambungkan source → destination (re-inject, tab tak bisu)
  → MediaRecorder(stream), timeslice → kumpulkan Blob chunk per ~10 menit
[Panel] tombol "Stop"
  → {type:'stop-recording'} → offscreen: recorder.stop(), tutup AudioContext
  → offscreen transkrip tiap chunk berurutan:
       POST <baseUrl>/audio/transcriptions (multipart: file, model, language,
       response_format=verbose_json) dengan Authorization Bearer <key>
  → gabung segmen antar chunk dengan offset timestamp berjalan
  → kirim hasil ke SW → simpan ke meeting.segments (speaker:''), source:'audio'
  → buang audio (tidak disimpan)
```

- Offscreen ⇄ SW komunikasi via `chrome.runtime.sendMessage` (offscreen adalah
  extension page). Audio Blob tetap di offscreen; hanya teks yang menyeberang.

## Data model

Reuse struktur meeting existing. Tambah penanda:

```js
"meeting:<id>" = {
  id, title, startedAt, endedAt,
  source: 'caption' | 'audio',        // BARU
  segments: [{ t, speaker, text }],   // mode audio: speaker = ''
  mom,
}
"settings" = {
  apiKey, baseUrl, model, momTemplate, // existing
  transcriptSource: 'caption'|'audio', // BARU, default 'caption'
  sttModel,                            // BARU, default 'nvidia/parakeet-ctc-1.1b-asr'
  sttLanguage,                         // BARU, default '' (auto)
}
```

- Panel & formatting sudah render `textContent` apa adanya; `speaker` kosong
  tampil tanpa nama. `formatTranscript`/`formatMarkdown` tetap dipakai.

## STT: pemotongan & penggabungan (logika pure, di-unit-test)

- Rekaman dipotong per 10 menit → daftar Blob. Tiap Blob ditranskrip terpisah
  (batasi ukuran upload).
- Response `verbose_json` = `{segments:[{start, text}, ...]}` (detik relatif
  chunk). Penggabungan: `t_absolut = chunkStartMs + start*1000`.
- Fungsi pure `mergeSttChunks(chunks, chunkDurationMs) → [{t, speaker:'', text}]`
  di `lib/stt.js`, di-unit-test dengan fixture verbose_json.

## UI (panel, mode audio)

- Tab Live saat `transcriptSource==='audio'` & tidak ada rekaman: tombol
  **Mulai rekam**. Saat merekam: **Stop** + indikator durasi berjalan.
- Saat Stop → status "Mentranskrip… (chunk k/N)" → transkrip muncul.
- Settings tab dapat: dropdown **Sumber transkrip**, field **Model STT**,
  field **Bahasa STT**.
- Badge titik REC menyala juga saat mode audio merekam.

## Error handling

- Gesture ditolak / tab tak bisa di-capture / offscreen gagal → pesan jelas
  di panel, tombol kembali ke "Mulai rekam".
- STT gagal per chunk → tandai chunk itu `[transkrip gagal]`, lanjut sisanya,
  transkrip parsial tetap tersimpan.
- Format audio ditolak STT (mis. 415/400) → pesan + saran ganti model.
- Meeting ditutup saat merekam → Stop otomatis lalu transkrip (best-effort).

## Risiko diverifikasi saat implementasi (bukan blocker desain)

1. Format webm/opus diterima `parakeet`/endpoint? Kalau tidak → perlu encode
   wav di offscreen (berat). Verifikasi dengan 1 chunk asli sebelum lanjut.
2. Batas ukuran upload 9Router untuk 10 menit opus. Kalau kebesaran → perkecil
   durasi chunk.
3. `verbose_json` didukung endpoint? Kalau tidak → fallback `json` (teks polos,
   timestamp per-chunk saja, bukan per-segmen).

## Batasan v1 (disengaja)

- Hanya audio tab (peserta) — mic sendiri tidak dicampur.
- Tanpa nama pembicara.
- Tidak live: transkrip muncul setelah Stop.
- Audio tidak disimpan (hanya teks).

## Testing

- `lib/stt.js` `mergeSttChunks` (logika rawan: offset timestamp antar chunk)
  di-unit-test `node --test test/stt.test.mjs`.
- tabCapture, offscreen, re-inject audio, panggilan STT nyata diverifikasi
  manual di Google Meet asli (butuh user).

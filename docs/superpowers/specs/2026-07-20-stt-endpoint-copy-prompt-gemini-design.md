# Desain: Endpoint STT Terpisah, Copy Prompt+Transkrip, Kirim ke Gemini

Tanggal: 2026-07-20

## Latar

Tiga fitur untuk pengguna tanpa API key berbayar:

1. **STT endpoint terpisah** — mode rekam audio sekarang memakai `baseUrl`/`apiKey` yang sama dengan chat/MoM. Pengguna ingin STT diarahkan ke server Whisper lokal (whisper.cpp / faster-whisper, OpenAI-compatible) atau ke 9Router, terpisah dari endpoint chat.
2. **Copy Prompt+Transkrip** — tombol yang menyalin prompt MoM lengkap (template + transkrip) supaya bisa di-paste manual ke AI web (ChatGPT/Gemini/dll) tanpa API key.
3. **Kirim ke Gemini** — tombol yang membuka gemini.google.com, mengisi prompt otomatis, dan langsung submit. Memanfaatkan login Google yang sudah ada; tanpa API key.

## Keputusan desain (hasil klarifikasi)

- Whisper lokal = server eksternal OpenAI-compatible di localhost, BUKAN whisper in-browser.
- Gemini = auto-paste via skrip injeksi + **auto-submit** (pilihan user, sadar risiko terkirim langsung).
- Prompt = template MoM yang sudah ada (`settings.momTemplate` / `DEFAULT_MOM_TEMPLATE`) diisi `fillTemplate()`.

## 1. STT endpoint terpisah

**Settings baru** (di `renderSettings`, `panel/panel.js`):

- `sttBaseUrl` (input teks) — kosong = ikut Base URL utama. Placeholder/hint: `http://localhost:8080/v1` (whisper lokal) atau URL 9Router.
- `sttApiKey` (input password) — kosong = tanpa header Authorization (server whisper lokal umumnya tanpa auth).

**Fallback**: fungsi pure kecil `sttEndpoint(settings)` di `lib/stt.js` mengembalikan `{ baseUrl, apiKey }`:

- `baseUrl` = `sttBaseUrl` jika terisi, selain itu `baseUrl` utama.
- `apiKey` = `sttApiKey` jika terisi; jika `sttBaseUrl` terisi tapi `sttApiKey` kosong → tanpa key (JANGAN jatuh ke apiKey utama — server lokal tak butuh, dan key utama tidak boleh bocor ke endpoint lain).
- Kedua STT field kosong → pakai `baseUrl`+`apiKey` utama (perilaku sekarang).

**Aliran**: service worker membaca settings saat start rekaman → kirim hasil `sttEndpoint()` ke offscreen (field `baseUrl`/`apiKey` di pesan start, seperti sekarang). `offscreen.js` tidak berubah.

**Izin host**: `ensureOrigin` (sudah ada di panel) juga dipanggil untuk `sttBaseUrl` saat Simpan. Pattern tanpa port (batasan Chrome) — sudah ditangani.

## 2. Tombol Copy Prompt+Transkrip

Di bar actions `renderMeeting` (live & riwayat), tombol baru **"Copy Prompt+Transkrip"**:

```js
clipboard = M.fillTemplate(settings.momTemplate ?? M.DEFAULT_MOM_TEMPLATE,
                           M.formatTranscript(meeting.segments))
```

Feedback sama dengan tombol Copy sekarang ("Disalin ✓" / "Gagal menyalin").

## 3. Kirim ke Gemini

Tombol **"Kirim ke Gemini"** di bar actions yang sama.

**Alur**:

1. Panel: salin prompt ke clipboard dulu (asuransi — kalau injeksi gagal, user tinggal paste manual).
2. Panel → SW: `{ type: 'send-to-gemini', text }`.
3. SW: `chrome.tabs.create({ url: 'https://gemini.google.com/app' })` → tunggu tab `status: 'complete'` → `chrome.scripting.executeScript` injeksi fungsi one-shot dengan `text` sebagai arg.
4. Skrip injeksi: poll (interval 500 ms, timeout 20 detik) sampai editor muncul → isi teks → klik tombol kirim.

**Selector Gemini** (dipusatkan di satu objek di atas fungsi injeksi supaya gampang diperbaiki saat DOM Gemini berubah — pola sama dengan `content/selectors.js`):

- Editor: `div.ql-editor` (Quill rich-text). Isi via `el.textContent = text` + dispatch `InputEvent` supaya framework Gemini mendeteksi perubahan.
- Tombol kirim: `button[aria-label*="Send" i], button[aria-label*="Kirim" i]` — klik setelah teks masuk (beri jeda 1 frame/`requestAnimationFrame` agar tombol enable).

**Gagal** (timeout / selector tak ketemu): tidak ada aksi lanjutan — teks sudah di clipboard, user paste manual. SW tidak perlu lapor balik ke panel (panel mungkin sudah tutup); cukup best-effort.

**Manifest**: tambah permission `"scripting"`, tambah host `"https://gemini.google.com/*"` ke `host_permissions`. Tanpa content script permanen di Gemini.

## Error handling

- STT: error transkrip sudah ditangani per-chunk (`[transkrip gagal]`) — tidak berubah.
- Clipboard gagal → tombol tampil "Gagal menyalin", tombol Gemini tetap buka tab (teks tetap dikirim via executeScript, hanya asuransi clipboard yang hilang).
- Injeksi Gemini gagal → diam; fallback = clipboard.

## Testing

- Unit test `sttEndpoint()` di `test/stt.test.mjs`: 4 kasus (dua-duanya kosong, hanya sttBaseUrl, dua-duanya terisi, sttApiKey tanpa sttBaseUrl).
- Injeksi Gemini & tombol panel: verifikasi manual (DOM eksternal, tidak di-unit-test).

## Di luar cakupan

- Whisper in-browser (transformers.js).
- Template prompt terpisah untuk paste-ke-AI (pakai template MoM yang sama).
- Auto-retrieve jawaban Gemini kembali ke extension.

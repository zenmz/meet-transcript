# Meet Transcript

Chrome extension (Manifest V3): transkrip Google Meet dari live caption,
riwayat meeting, download .txt/.md, dan generate MoM via OpenAI.

## Install

1. Buka `chrome://extensions`, nyalakan **Developer mode**.
2. **Load unpacked** → pilih folder proyek ini.
3. Pin icon "Meet Transcript" di toolbar.

## Pakai

1. Join Google Meet. Extension mencoba menyalakan CC otomatis; kalau gagal,
   nyalakan manual (tombol CC di toolbar Meet).
2. Klik icon extension → side panel: tab **Live** menampilkan transkrip berjalan.
3. Tab **Settings**: isi OpenAI API key, model (default `gpt-4o-mini`), dan
   template MoM (`{{transcript}}` diganti isi transkrip).
4. Tombol **Generate MoM** membuat MoM dari transkrip; hasil ikut di unduhan .md.
5. Tab **Riwayat**: semua meeting tersimpan lokal (`chrome.storage.local`),
   bisa dibuka/di-download lagi.

## Mode transkrip audio (tanpa caption)

Alternatif bila tak ingin menyalakan caption Meet: rekam audio tab lalu
transkrip via STT.

1. Settings → **Sumber transkrip** = **Rekam audio**. Isi **Model STT**
   (mis. `nvidia/parakeet-ctc-1.1b-asr`) dan **Bahasa STT** (mis. `id`).
   Base URL & API key sama dengan MoM.
2. Join Meet → tab Live → **Mulai rekam** (audio meeting tetap terdengar).
3. **Stop rekam** → audio ditranskrip per potongan → transkrip muncul
   (teks + waktu, tanpa nama pembicara). Audio tidak disimpan.

Catatan: transkrip baru muncul setelah Stop (bukan live). Hanya audio tab
(peserta) yang direkam, mic sendiri tidak.

**STT Base URL terpisah**: di Settings, field **STT Base URL** kosong = ikut
Base URL (OpenAI-compatible) di atas. Isi kalau STT dan chat butuh endpoint
beda, mis. whisper lokal (`http://localhost:8080/v1`) atau proxy semacam
9Router.

## Tanpa API key: copy prompt atau kirim ke Gemini

Alternatif kalau tak mau isi API key OpenAI, dari tab Riwayat/Live:

- **Copy Prompt+Transkrip**: salin prompt MoM lengkap (template + transkrip)
  ke clipboard — paste ke ChatGPT/Gemini/AI web lain manual.
- **Kirim ke Gemini**: buka tab gemini.google.com, isi kotak chat dengan
  prompt, lalu kirim otomatis (butuh sudah login Google). Prompt tetap
  disalin ke clipboard duluan sebagai fallback — kalau auto-isi gagal (mis.
  DOM Gemini berubah), tinggal paste manual di kotak chat yang sudah terbuka.

## Batasan v1

- Transkrip bersumber dari caption Meet — caption harus nyala, akurasi ikut Google.
- Satu meeting aktif pada satu waktu.
- Meeting dianggap berakhir saat tab Meet ditutup/pindah halaman.

## Troubleshooting

**Transkrip berhenti terisi padahal caption jalan** → Google mengubah DOM Meet.
Semua selector ada di `content/selectors.js`; inspect element caption dan
sesuaikan. Panel menampilkan peringatan bila caption nyala tapi tidak ada teks
masuk 30 detik.

## Test

```bash
node --test test/*.test.mjs
```

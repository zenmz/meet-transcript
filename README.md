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

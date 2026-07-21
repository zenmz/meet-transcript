# Meet Transcript

Chrome extension (Manifest V3): transkrip Google Meet dari live caption,
riwayat meeting, download .txt/.md, dan generate MoM via OpenAI.

## Install (untuk tim — tak perlu Chrome Web Store)

Ekstensi ini dipasang lewat **Load unpacked**. Auto-update TIDAK ada di jalur
ini — ambil versi baru lalu klik reload. Dua cara mendapatkan filenya:

**Cara 1 — ZIP rilis (paling gampang, tanpa git)**

1. Buka tab **[Releases](../../releases)** repo → ambil rilis terbaru →
   download aset **`meet-transcript-vX.Y.Z.zip`** (di bagian *Assets*). Ini
   paket bersih — cuma file ekstensi, tanpa docs/test.
2. Extract ZIP-nya ke folder tetap (jangan di dalam Downloads yang sering
   dibersihkan — kalau foldernya hilang, ekstensinya mati).
3. `chrome://extensions` → nyalakan **Developer mode** (kanan atas) →
   **Load unpacked** → pilih folder hasil extract (yang berisi `manifest.json`).
4. Pin ikon **Meet Transcript** di toolbar.
5. Update: download ZIP rilis baru, replace folder, lalu `chrome://extensions`
   → klik **reload** (↻) di kartu ekstensi.

**Cara 2 — git clone (kalau mau `git pull` untuk update)**

1. `git clone <url-repo>` ke folder tetap.
2. `chrome://extensions` → **Developer mode** → **Load unpacked** → pilih
   folder hasil clone.
3. Update: `git pull` di folder itu, lalu klik **reload** (↻) di kartu ekstensi.

> Peringatan "Developer mode extensions" muncul tiap Chrome start — normal untuk
> ekstensi yang tidak dari Web Store, aman diabaikan (jangan klik "Remove").

**Privasi:** ekstensi merekam/menyalin isi meeting dan mengirim transkrip
(dan audio, di mode rekam) ke endpoint STT/LLM yang kamu set di Settings
(OpenAI / 9Router / Gemini). Isi meeting keluar ke layanan itu — pastikan tim
sadar dan endpoint-nya sesuai kebijakan data kalian. API key disimpan lokal di
`chrome.storage.local`, tidak ikut ke repo.

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
2. Join Meet → **klik kanan di halaman Meet** → **Rekam audio meeting**
   (audio meeting tetap terdengar). Mulai rekam TIDAK bisa dari tombol side
   panel: `tabCapture` butuh invocation `activeTab` yang hanya diberikan klik
   context menu, bukan klik di side panel.
3. **Stop rekam** (dari panel, atau klik kanan → **Stop rekam audio**) → audio
   ditranskrip per potongan → transkrip muncul (teks + waktu, tanpa nama
   pembicara).

Catatan: transkrip baru muncul setelah Stop (bukan live). Hanya audio tab
(peserta) yang direkam, mic sendiri tidak.

**Transkrip ulang**: audio rekaman TERAKHIR disimpan (bukan di storage
transkrip — terpisah, dan tertimpa saat rekaman berikutnya di-*stop*, bukan
saat dimulai). Kalau
endpoint/model STT di Settings salah, perbaiki lalu klik **Transkrip ulang**
di meeting itu — tidak perlu merekam ulang. Karena hanya rekaman terakhir
yang disimpan, tombol ini hanya muncul untuk meeting dari rekaman terakhir.

**STT Base URL terpisah**: di Settings, dropdown **Mode STT** memilih dari mana
transkrip audio diambil:

- *Ikut endpoint chat di atas* — default, pakai Base URL + API key yang sama
  dengan MoM.
- *Whisper lokal* — mengisi `http://localhost:8080/v1`; ubah kalau server
  whisper-mu di port lain. Biarkan STT API key kosong (server lokal tanpa auth).
- *STT API terpisah (9Router / OpenAI)* — ketik URL endpoint sendiri dan isi
  STT API key-nya.

Dropdown hanya mengisikan dua field di bawahnya; yang benar-benar dipakai
adalah **STT Base URL** dan **STT API key**, jadi URL boleh diedit bebas
setelah memilih mode. Mode dihitung ulang dari URL saat Settings dibuka.
STT API key kosong = request dikirim tanpa header `Authorization`; API key chat
sengaja tidak ikut ke host STT lain.

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

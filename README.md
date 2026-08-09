# 🎙️ Meet Transcript

<p align="center">
  <img src="icons/icon128.png" width="112" alt="Meet Transcript">
</p>

**Ekstensi Chrome untuk Transkripsi Google Meet & Pembuatan Notulen (MoM) Otomatis**

---

**Meet Transcript** adalah ekstensi Google Chrome yang terintegrasi langsung pada *side panel* Google Meet. Ekstensi ini menangkap transkrip caption secara *real-time* selama rapat berlangsung dan secara otomatis merangkumnya menjadi *Minutes of Meeting* (MoM). Transkrip dari rekaman audio muncul setelah perekaman dihentikan.

Seluruh data rapat disimpan secara lokal di peramban (*browser*) Anda. Tanpa server perantara, dan Anda memiliki kendali penuh atas *endpoint* STT (Speech-to-Text) maupun LLM (Large Language Model) yang digunakan — transkripsi bahkan dapat berjalan sepenuhnya luring di dalam Chrome. Baca bagian [Keamanan & Privasi](#-keamanan--privasi) untuk mengetahui persis data apa yang keluar pada tiap mode.

## ✨ Fitur Utama

* **Multi-Sumber Transkripsi:** Menggabungkan *caption* bawaan Google Meet (menyertakan nama pembicara) dan rekaman audio *tab* (via STT) dalam satu linimasa rapat, diurutkan menurut waktu.
* **Dukungan Luring (Offline):** Whisper dapat berjalan di dalam peramban lewat WASM — model diunduh sekali dari Hugging Face, setelah itu transkripsi sepenuhnya luring. Alternatifnya, arahkan ke *server* Whisper pribadi Anda.
* **Pembuatan MoM Otomatis:** Menghasilkan ringkasan, poin pembahasan, keputusan, dan *action items* menggunakan *endpoint* LLM yang kompatibel dengan OpenAI (misal: `gpt-4o-mini`). *Template* dapat dikustomisasi.
* **Fleksibilitas Tanpa API Key:** Anda dapat menyalin *prompt* beserta transkrip ke *clipboard*, atau mengirimkannya secara otomatis ke Google Gemini di *tab* baru tanpa memerlukan integrasi API.
* **Manajemen Riwayat Lokal:** Transkrip, MoM, dan setelan tersimpan di `chrome.storage.local`; potongan audio di IndexedDB. Ekspor riwayat ke `.txt` atau `.md` kapan saja.
* **Sadar Rapat Berulang:** Rapat *recurring* memakai link (kode ruang) yang sama — setiap sesi tetap menjadi entri Riwayat terpisah. Jeda lebih dari 30 menit setelah rapat berakhir dianggap sesi baru; keluar-masuk sebentar tetap tersambung ke sesi yang sama.
* **Penyelamatan Audio Cerdas:** Potongan audio disimpan ke IndexedDB selama proses perekaman. Jika terjadi kesalahan konfigurasi STT, Anda cukup melakukan "Transkrip ulang" tanpa kehilangan data audio.
* **Siklus Hidup Otomatis:** Perekaman berhenti otomatis saat rapat selesai (keluar panggilan, pindah ruang, atau *tab* ditutup).

---

## 🚀 Panduan Instalasi

Ekstensi ini berjalan pada **Chrome 116+** — termasuk browser Chromium lain (Edge, Brave, Opera, Vivaldi) — dan **Firefox 128+**. Di Chromium dipasang melalui mode *Developer*; di Firefox langsung dari [Firefox Add-ons resmi](https://addons.mozilla.org/en-US/firefox/addon/meet-transcript/). **Versi Firefox caption-only**: tanpa rekam audio/STT, karena Firefox tidak memiliki API `tabCapture`. (Panel samping sendiri sudah ada sejak Chrome 114, tetapi pemulihan status rekaman memakai `chrome.runtime.getContexts` yang baru tersedia di 116.) Tidak memerlukan proses *build* atau instalasi melalui Chrome Web Store.

### Metode 1: Melalui Rilis ZIP (Direkomendasikan)

1. Buka halaman **[Releases](../../releases)** dan unduh aset `meet-transcript-vX.Y.Z.zip` terbaru. *(Paket ini bersih — hanya fail ekstensi, tanpa docs/test. ZIP-nya ±5 MB dan mengembang jadi ±22 MB setelah diekstrak; sebagian besar adalah runtime WASM untuk mode Whisper di Browser.)*
2. Ekstrak fail ZIP ke direktori permanen di komputer Anda (hindari folder *Downloads*).
3. Buka URL `chrome://extensions` di Google Chrome (Edge: `edge://extensions`, Brave: `brave://extensions`, Opera: `opera://extensions`).
4. Aktifkan **Developer mode** (sakelar di sudut kanan atas).
5. Klik **Load unpacked**, lalu pilih folder **`meet-transcript`** di dalam hasil ekstraksi — folder yang isinya langsung `manifest.json`, bukan folder pembungkusnya.
6. Sematkan (*pin*) ikon Meet Transcript di *toolbar* Anda.

> **Untuk Update:** Unduh ZIP versi terbaru, timpa (*replace*) fail di folder lama, lalu klik ikon **Reload** (🔄) pada kartu ekstensi di halaman konfigurasi.

### Metode 2: Melalui Git Clone (Untuk Developer)

```bash
git clone https://github.com/zenmz/meet-transcript.git
```

Buka `chrome://extensions` → **Load unpacked** → pilih folder hasil *clone*. Untuk memperbarui ekstensi, jalankan perintah `git pull`, lalu klik **Reload**.

> [!NOTE]
> Peringatan "Disable developer mode extensions" yang muncul saat Chrome dijalankan adalah perilaku normal untuk ekstensi di luar Web Store. Anda dapat mengabaikannya. Jangan klik "Remove".

### Firefox

Pasang langsung dari Add-ons resmi Mozilla: **[Meet Transcript di Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/meet-transcript/)** → klik **Add to Firefox**. Update berjalan otomatis. Setelah terpasang, klik ikon Meet Transcript di *toolbar* untuk membuka/menutup *sidebar*.

> [!NOTE]
> Versi Firefox **caption-only**: fitur Perekaman Audio & Mode STT di bawah tidak tersedia (Firefox tidak punya API `tabCapture`). Transkrip dari *caption*, Riwayat, MoM, dan Kirim ke Gemini berfungsi penuh.
>
> Untuk pengembangan: `./scripts/pack.sh --firefox`, ekstrak ZIP-nya, lalu muat via `about:debugging` → *This Firefox* → *Load Temporary Add-on* (hilang saat Firefox ditutup).

---

## 📖 Penggunaan Dasar (Quick Start)

1. **Mulai Rapat:** Bergabunglah ke Google Meet. Ekstensi akan mencoba mengaktifkan *Closed Captions* (CC) secara otomatis. Jika gagal, aktifkan manual melalui *toolbar* Meet.
2. **Buka Panel:** Klik ikon ekstensi untuk membuka *side panel* (Firefox: *sidebar*). *Tab* **Live** akan mulai terisi secara otomatis.
3. **Rekam Audio (Opsional):** Klik kanan pada area mana saja di halaman Meet, lalu pilih **Rekam audio meeting**.
4. **Hasilkan MoM:** Setelah rapat selesai, buka *tab* **Riwayat** → pilih rapat → klik **Generate MoM**. Tombol **Unduh .txt** dan **Unduh .md** berada di dalam menu **Lainnya**.

**Konfigurasi Awal (Settings):**
Sebelum penggunaan pertama, isi menu *Settings*: masukkan API Key LLM, pilih Model, dan sesuaikan *Template* MoM (gunakan variabel `{{transcript}}`). Blok **Mode STT** baru muncul setelah **Sumber transkrip** diubah ke *Rekam audio* (Chrome/Chromium saja — di Firefox blok ini tidak ada). Gunakan tombol **Tes koneksi** untuk memvalidasi konfigurasi Anda.

---

## 🎙️ Perekaman Audio & Mode STT (Chrome/Chromium saja)

Anda dapat merekam audio *tab* untuk ditranskripsi via STT, baik secara mandiri maupun bersamaan dengan fitur *caption* bawaan Meet. Fitur di seksi ini tidak tersedia di Firefox.

### Cara Merekam Audio

1. Buka menu **Settings** → set **Sumber transkrip** = *Rekam audio* agar blok **Mode STT** terlihat → konfigurasikan **Mode STT**. (Setelah dikonfigurasi, perekaman tetap bisa dipakai sambil *Sumber transkrip* dikembalikan ke *Caption Meet* — mode STT yang tersimpan tetap dipakai.)
2. Di dalam panggilan Meet, **klik kanan** pada halaman → pilih **Rekam audio meeting**.
3. Perekaman akan berhenti otomatis jika Anda keluar dari panggilan. Anda juga dapat menghentikannya secara manual via panel atau menu klik kanan.

**Catatan Penting:**

* Karena batasan kebijakan keamanan Chrome, inisiasi perekaman (`tabCapture`) hanya dapat dipicu melalui klik *context menu* (klik kanan), bukan dari tombol di *side panel*.
* Hanya suara dari peserta lain (*tab audio*) yang direkam. Suara dari mikrofon Anda sendiri tidak akan masuk ke dalam rekaman audio ini.
* Setiap 10 menit, potongan audio disimpan ke IndexedDB untuk mencegah kehilangan data jika peramban tertutup mendadak. Potongan tersebut dapat diunduh kapan saja melalui tombol **Unduh audio** sebagai fail `.webm` terpisah (membutuhkan izin *"Download multiple files"* pada Chrome bila lebih dari satu potongan).
* Hanya audio dari rekaman **terakhir** yang disimpan. Jika Anda memulai perekaman baru, data audio sebelumnya akan dihapus.

### Pilihan Mode STT (Speech-to-Text)

| Mode (label di UI) | Kebutuhan | Audio dikirim ke | Deskripsi |
| --- | --- | --- | --- |
| **Whisper lokal (server sendiri)** | Server Whisper OpenAI-compatible | URL yang **Anda** isi | **[Default]** Terisi `http://localhost:8080/v1` |
| **Whisper di browser (offline, tanpa server)** | — | 🔒 Tidak ke mana pun | Paling privat, paling lambat. Bahasa dikunci ke Indonesia. |
| **9Router / STT API** | URL + API Key (**wajib diisi**) | 🌐 Endpoint tersebut | Tercepat. Menyediakan opsi Model & Bahasa STT. |

> [!WARNING]
> Pada mode **9Router / STT API**, kalau **STT Base URL** dibiarkan kosong, ekstensi jatuh ke *Base URL* LLM Anda dan memakai **API key LLM** — audio rapat akan dikirim ke endpoint chat (default `https://api.openai.com/v1`). Isi STT Base URL secara eksplisit.

### Detail Mode "Whisper di Browser"

Mode ini menggunakan teknologi WebAssembly (WASM) untuk menjalankan model AI murni pada CPU komputer Anda. Model diunduh satu kali dari Hugging Face dan disimpan dalam *cache* peramban.

| Model | Ukuran Unduhan | Akurasi (Bahasa Indonesia) | Kecepatan |
| --- | --- | --- | --- |
| `whisper-tiny` | ±40 MB | Rendah | Sangat Cepat |
| `whisper-base` | ±80 MB | Rendah–Menengah (sering salah dengar) | Cepat (Default) |
| `whisper-small` | ±250 MB | Tinggi | Lambat |

> *Saran: Jika transkripsi berbahasa Indonesia kurang akurat, tingkatkan model ke `whisper-small` melalui pengaturan sebelum memeriksa komponen lainnya.*

---

## 🔒 Keamanan & Privasi

Ekstensi ini dirancang dengan pendekatan *privacy-first*:

* **Penyimpanan Lokal:** API Key Anda disimpan secara eksklusif di `chrome.storage.local` perangkat Anda dan tidak pernah dikomit ke repositori. Tidak ada telemetri maupun analitik di dalam ekstensi ini.
* **Whisper di Browser:** satu-satunya mode yang benar-benar tidak mengirim audio ke mana pun — modelnya berjalan di dalam Chrome. Satu-satunya lalu lintas keluar adalah unduhan model dari Hugging Face, sekali saja.
* **Whisper Lokal:** audio dikirim ke URL yang **Anda sendiri** isi di *STT Base URL* (default `http://localhost:8080/v1`). Ekstensi **tidak** memaksa URL itu benar-benar lokal — pastikan isinya memang server Anda. Bila *STT API key* pernah diisi, nilainya tetap ikut sebagai header `Authorization` walaupun field-nya tersembunyi di mode ini.
* **Transparansi Endpoint:** MoM dihasilkan melalui *endpoint* pilihan Anda. Pastikan *endpoint* yang Anda konfigurasikan sesuai dengan kebijakan keamanan data perusahaan atau tim Anda.
* **Copy Prompt / Kirim ke Gemini:** kedua tombol ini menyalin **seluruh transkrip** ke clipboard, dan tombol Gemini menempelkannya ke `gemini.google.com` — artinya seluruh isi rapat masuk ke akun Google Anda. Jangan gunakan untuk rapat yang isinya tidak boleh keluar.

---

## 🛠️ Pemecahan Masalah (Troubleshooting)

* **Transkrip tidak muncul meskipun *caption* menyala:** Google mungkin telah memperbarui struktur DOM Meet. Ekstensi akan menampilkan peringatan jika *caption* aktif namun teks tidak terbaca selama 30 detik. (Bagi *developer*, perbarui penyeleksi pada `content/selectors.js`).
* **Tab Live menunjuk rapat lama, atau perekaman tidak berhenti sendiri:** Google Meet adalah aplikasi SPA — pindah ruang dan keluar panggilan hanya mengganti URL pada dokumen yang sama. Pelacakan sesi ditangani `content/session.js` (murni, diuji pada `test/session.test.mjs`).
* **Transkrip audio kosong:** Periksa URL *endpoint* atau model STT di pengaturan Anda. Setelah diperbaiki, klik **Transkrip ulang** pada riwayat rapat terkait (audio asli masih tersimpan).
* **Peringatan "Belum ada suara masuk":** Sistem hanya menangkap suara dari peserta lain. Jika tidak ada orang lain yang berbicara, maka tidak ada audio yang diproses.
* **Log Eror:** Jika terjadi kesalahan pada *side panel*, pesan *error* dan *stack trace* dapat disorot dan disalin langsung dari antarmuka panel.

---

## 💻 Pengembangan (Development)

Proyek ini dibangun tanpa *build step* yang kompleks (tanpa `npm install`), menggunakan JavaScript *vanilla* (Manifest V3) yang dioptimalkan.

**Struktur Direktori:**

* `background/` : *Service worker*, manajemen status, penyimpanan, dan siklus hidup.
* `content/` : Logika injeksi DOM Meet (`selectors.js`, `session.js`, `captions.js`).
* `panel/` : Antarmuka pengguna (*Live*, *Riwayat*, *Settings*).
* `offscreen/` : Modul perekaman audio *tab* dan orkestrasi STT (service worker MV3 bisa mati di tengah unggahan panjang).
* `lib/` : Utilitas inti (`openai.js`, `stt.js`, `audiostore.js`/IndexedDB, `merge.js`), plus `whisper-browser.js` dan `vendor/` — transformers.js + ONNX Runtime WASM (±22 MB), mesin STT mode browser.
* `manifest.firefox.json` : manifest untuk build Firefox (`sidebar_action`, *event page*, tanpa `tabCapture`/`offscreen`) — versinya wajib sama dengan `manifest.json`.
* `test/` · `scripts/` · `icons/` · `docs/` : pengujian Node, skrip rilis, ikon, dan catatan desain internal.

**Menjalankan Pengujian (Testing):**

```bash
node --test test/*.test.mjs
```

**Membuat Rilis (Khusus Maintainer):**

Membutuhkan `node` (skrip membaca versi dari `manifest.json`), `gh` CLI yang sudah login, dan kredensial AMO untuk *signing* Firefox (buat sekali di addons.mozilla.org → *Tools* → *Manage API Keys*).

1. Perbarui `"version"` di `manifest.json` **dan** `manifest.firefox.json` (skrip menolak jalan bila beda).
2. Lakukan *commit* dan `git push`.
3. Jalankan skrip rilis:

```bash
export AMO_JWT_ISSUER="user:..."
export AMO_JWT_SECRET="..."
./scripts/pack.sh --release
```

*(Skrip membangun ZIP Chrome + ZIP Firefox (digate `web-ext lint`), menandatangani `.xpi` via AMO unlisted, lalu memublikasikan ketiganya ke GitHub Releases. Build lokal saja: `./scripts/pack.sh` untuk Chrome, `./scripts/pack.sh --firefox` untuk Firefox.)*

---

## 📄 Lisensi

[MIT](LICENSE) © zenmz

Ekstensi ini ikut mendistribusikan Transformers.js (Apache-2.0) dan ONNX Runtime Web (MIT) di dalam `lib/vendor/` untuk mode *Whisper di browser*. Rinciannya di [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

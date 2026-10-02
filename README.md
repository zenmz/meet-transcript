# 🎙️ Meet Transcript

<p align="center">
  <img src="icons/icon128.png" width="112" alt="Meet Transcript">
</p>

**Ekstensi Chrome untuk Transkripsi Google Meet & Pembuatan Notulen (MoM) Otomatis**

---

**Meet Transcript** adalah ekstensi Google Chrome yang terintegrasi langsung pada *side panel* Google Meet. Ekstensi ini menangkap transkrip caption secara *real-time* selama rapat berlangsung dan secara otomatis merangkumnya menjadi *Minutes of Meeting* (MoM). Transkrip dari rekaman audio muncul setelah perekaman dihentikan.

Selain Google Meet, **panggilan suara Discord di peramban** (`discord.com/channels/…`) juga dapat direkam dan ditranskripsi lewat jalur audio + STT. Discord tidak punya *live caption*, jadi di sana hanya mode rekam audio yang berlaku — tanpa nama pembicara, dan perekaman dihentikan manual.

Seluruh data rapat disimpan secara lokal di peramban (*browser*) Anda. Tanpa server perantara, dan Anda memiliki kendali penuh atas *endpoint* STT (Speech-to-Text) maupun LLM (Large Language Model) yang digunakan — termasuk *server* Whisper di jaringan Anda sendiri. Baca bagian [Keamanan & Privasi](#-keamanan--privasi) untuk mengetahui persis data apa yang keluar pada tiap mode.

## ✨ Fitur Utama

* **Popup Aksi Cepat:** Klik ikon ekstensi membuka popup ringkas — **Rekam** (audio / audio + video), **Bahasa caption** (Indonesia / English), **Tampilkan detail** (membuka side panel), dan **Riwayat meet** yang membuka rapat pilihan langsung di halaman detailnya.
* **Multi-Sumber Transkripsi:** Menggabungkan *caption* bawaan Google Meet (menyertakan nama pembicara) dan rekaman audio *tab* (via STT) dalam satu linimasa rapat, diurutkan menurut waktu.
* **Rekam Video (Opsional):** Rekam isi *tab* Meet sebagai satu fail `.webm` (720p, VP9, ±250 MB/jam) lewat menu klik kanan **Rekam audio + video meeting** — transkrip audio tetap berjalan seperti biasa.
* **Rekam Mikrofon (Opsional):** Bawaan hanya suara peserta lain (audio *tab*) yang terekam. Centang **Rekam mikrofon** di Settings agar suara Anda ikut dicampur ke rekaman audio dan video; izin mikrofon diminta sekali lewat jendela kecil.
* **Endpoint STT Milik Anda:** Arahkan ke *server* Whisper pribadi (whisper.cpp, faster-whisper) di jaringan sendiri, atau ke *endpoint* STT API mana pun yang OpenAI-compatible.
* **Pembuatan MoM Otomatis:** Menghasilkan *context*, *discussion*, peserta, dan *action items* menggunakan *endpoint* LLM yang kompatibel dengan OpenAI (misal: `gpt-4o-mini`). *Template* dapat dikustomisasi.
* **Fleksibilitas Tanpa API Key:** Anda dapat menyalin *prompt* beserta transkrip ke *clipboard*, atau mengirimkannya secara otomatis ke Google Gemini atau ChatGPT di *tab* baru tanpa memerlukan integrasi API.
* **Manajemen Riwayat Lokal:** Transkrip, MoM, dan setelan tersimpan di `chrome.storage.local`; potongan audio di IndexedDB. Ekspor riwayat ke `.txt` atau `.md` kapan saja.
* **Backup & Restore:** Tombol **Export backup (.zip)** di Settings menyimpan data teks (riwayat, MoM, setelan) ke satu fail ZIP — **bukan** fail rekaman: audio & video tidak ikut karena bisa ratusan MB per rekaman, unduh sendiri dari entri Riwayat → **Unduh**. **Import backup** memulihkan data teks itu — termasuk setelah *uninstall*/pindah komputer — dan **menghapus rekaman yang tersimpan saat itu**.
* **Sadar Rapat Berulang:** Rapat *recurring* memakai link (kode ruang) yang sama — setiap sesi tetap menjadi entri Riwayat terpisah. Jeda lebih dari 30 menit setelah rapat berakhir dianggap sesi baru; keluar-masuk sebentar tetap tersambung ke sesi yang sama.
* **Penyelamatan Audio Cerdas:** Potongan audio disimpan ke IndexedDB selama proses perekaman. Jika terjadi kesalahan konfigurasi STT, Anda cukup melakukan "Transkrip ulang" tanpa kehilangan data audio.
* **Siklus Hidup Otomatis:** Perekaman berhenti otomatis saat rapat selesai (keluar panggilan, pindah ruang, atau *tab* ditutup).
* **Caption Tersembunyi (Bawaan):** Tampilan caption di layar Meet disembunyikan tanpa mematikan CC — tile video tetap penuh, transkrip tetap terisi di panel. Ingin melihat caption lagi? Matikan **Sembunyikan caption di layar Meet** di Settings.
* **Bahasa Caption dari Popup:** Pemilih bahasa milik Meet berada di dalam area caption, jadi ikut tersembunyi oleh butir di atas. Pilihan **Indonesia** (bawaan) / **English** di popup menerapkannya langsung ke Meet, sekali tiap panggilan — pergantian manual di UI Meet tetap dihormati.
* **Rekam Discord Web:** Panggilan suara di `discord.com/channels/…` ikut bisa direkam (audio, atau audio + video tab). Hanya versi web — aplikasi desktop Discord di luar jangkauan ekstensi.

---

## 🚀 Panduan Instalasi

Ekstensi ini berjalan pada **Chrome 116+** — termasuk browser Chromium lain (Edge, Brave, Opera, Vivaldi) — dan **Firefox 128+**. Di Chromium dipasang melalui mode *Developer*; di Firefox langsung dari [Firefox Add-ons resmi](https://addons.mozilla.org/en-US/firefox/addon/meet-transcript/). **Versi Firefox caption-only**: tanpa rekam audio/STT, karena Firefox tidak memiliki API `tabCapture`. (Panel samping sendiri sudah ada sejak Chrome 114, tetapi pemulihan status rekaman memakai `chrome.runtime.getContexts` yang baru tersedia di 116.) Tidak memerlukan proses *build* atau instalasi melalui Chrome Web Store.

### Metode 1: Melalui Rilis ZIP (Direkomendasikan)

1. Buka halaman **[Releases](../../releases)** dan unduh aset `meet-transcript-vX.Y.Z.zip` terbaru. *(Paket ini bersih — hanya fail ekstensi, tanpa docs/test, di bawah 1 MB.)*
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
> Versi Firefox **caption-only**: fitur Perekaman Audio & Mode STT di bawah tidak tersedia (Firefox tidak punya API `tabCapture`). Transkrip dari *caption*, Riwayat, MoM, dan Kirim ke Gemini/ChatGPT berfungsi penuh.
>
> Untuk pengembangan: salin folder repo, di salinan itu timpa `manifest.json` dengan isi `manifest.firefox.json`, lalu muat via `about:debugging` → *This Firefox* → *Load Temporary Add-on* (hilang saat Firefox ditutup).

---

## 📖 Penggunaan Dasar (Quick Start)

1. **Mulai Rapat:** Bergabunglah ke Google Meet. Ekstensi akan mencoba mengaktifkan *Closed Captions* (CC) secara otomatis. Caption **tidak tampil di layar** (disembunyikan bawaan) — cek *tab* **Live** di panel untuk memastikan transkrip masuk. Jika kosong, lihat tombol CC di *toolbar* Meet: ikon tersorot berarti aktif; jika tidak, klik sekali.
2. **Buka Panel:** Klik ikon ekstensi → popup muncul → **Tampilkan detail** membuka *side panel* (Firefox: klik ikon langsung membuka *sidebar*). *Tab* **Live** akan mulai terisi secara otomatis.
3. **Rekam Audio/Video (Opsional):** Klik ikon ekstensi → **Rekam** → *Audio saja* atau *Audio + video*. Bisa juga lewat klik kanan di halaman, atau pintasan `Alt+Shift+R` / `Alt+Shift+V`.
4. **Hasilkan MoM:** Setelah rapat selesai, buka *tab* **Riwayat** → pilih rapat → buka dropdown **Generate MoM** → **Generate MoM** (atau **Kirim ke Gemini** / **Kirim ke ChatGPT** tanpa API key). Dropdown **Copy** berisi *Copy transkrip* / *Copy Prompt+Transkrip*; dropdown **Unduh** berisi *.txt*, *.md*, dan audio/video rekaman bila ada.

**Konfigurasi Awal (Settings):**
Sebelum penggunaan pertama, isi menu *Settings*: masukkan API Key LLM, pilih Model, dan sesuaikan *Template* MoM (gunakan variabel `{{transcript}}`). Blok **Mode STT** baru muncul setelah **Sumber transkrip** diubah ke *Rekam audio* (Chrome/Chromium saja — di Firefox blok ini tidak ada). Gunakan tombol **Tes koneksi** untuk memvalidasi konfigurasi Anda.

---

## 🎙️ Perekaman Audio & Mode STT (Chrome/Chromium saja)

Anda dapat merekam audio *tab* untuk ditranskripsi via STT, baik secara mandiri maupun bersamaan dengan fitur *caption* bawaan Meet. Fitur di seksi ini tidak tersedia di Firefox.

### Cara Merekam Audio

1. Buka menu **Settings** → set **Sumber transkrip** = *Rekam audio* agar blok **Mode STT** terlihat → konfigurasikan **Mode STT**. (Setelah dikonfigurasi, perekaman tetap bisa dipakai sambil *Sumber transkrip* dikembalikan ke *Caption Meet* — mode STT yang tersimpan tetap dipakai.)
2. Di dalam panggilan, mulai rekam lewat salah satu dari tiga jalur: **popup ikon ekstensi** → *Rekam*, **klik kanan** di halaman, atau pintasan keyboard. Pilihan *Audio + video* ikut merekam tampilan *tab* (720p VP9, ±250 MB/jam, diunduh sebagai satu fail `.webm` lewat tombol **Unduh video** di Riwayat).
3. Di Google Meet, perekaman berhenti otomatis saat Anda keluar panggilan. **Di Discord tidak** — tidak ada pelacak sesi di sana, jadi hentikan sendiri lewat popup, panel, atau klik kanan → **Stop rekam**.

**Catatan Penting:**

* Karena batasan keamanan Chrome, `tabCapture` menuntut izin per-*tab* yang hanya diberikan oleh *invocation* ekstensi: klik ikon (popup), klik *context menu*, atau pintasan keyboard. Tombol di *side panel* maupun tombol yang disuntik ke halaman **tidak** memenuhi syarat itu — Chrome menolaknya dengan *"Extension has not been invoked for the current page"*. Karena itulah tombol **Rekam** hidup di popup, bukan di panel; panel hanya memegang **Stop rekam**.
* Pintasan bawaan: `Alt+Shift+R` (audio), `Alt+Shift+V` (audio + video), `Alt+Shift+S` (stop). Dapat diubah di `chrome://extensions/shortcuts`. Berguna di Discord, yang menelan *event* `contextmenu` sehingga menu klik kanan bawaan peramban tidak muncul (`Shift`+klik kanan memaksanya muncul).
* Bawaan: hanya suara peserta lain (*tab audio*) yang direkam. Centang **Rekam mikrofon** di *Settings* agar suara Anda ikut, lalu klik **Izinkan mikrofon** sekali untuk memberi izin (kalau belum, jendela izin muncul otomatis saat rekaman dimulai; rekaman *tab* tetap jalan dan mic bergabung begitu disetujui). Tanpa headset, suara peserta dari speaker bisa ikut terekam lewat mic (dobel).
* Setiap 10 menit, potongan audio disimpan ke IndexedDB untuk mencegah kehilangan data jika peramban tertutup mendadak. Potongan tersebut dapat diunduh kapan saja melalui tombol **Unduh audio** sebagai fail `.webm` terpisah (membutuhkan izin *"Download multiple files"* pada Chrome bila lebih dari satu potongan).
* Hanya **5 rekaman terakhir** yang disimpan. Saat rekaman baru dimulai, rekaman tertua di luar lima itu dihapus — audio beserta videonya.

### Pilihan Mode STT (Speech-to-Text)

| Mode (label di UI) | Kebutuhan | Audio dikirim ke | Deskripsi |
| --- | --- | --- | --- |
| **Whisper lokal (server sendiri)** | Server Whisper OpenAI-compatible | URL yang **Anda** isi | **[Default]** Terisi `http://localhost:8080/v1` |
| **9Router / STT API** | URL + API Key (**wajib diisi**) | 🌐 Endpoint tersebut | Tercepat. Menyediakan opsi Model & Bahasa STT. |

> [!WARNING]
> Pada mode **9Router / STT API**, kalau **STT Base URL** dibiarkan kosong, ekstensi jatuh ke *Base URL* LLM Anda dan memakai **API key LLM** — audio rapat akan dikirim ke endpoint chat (default `https://api.openai.com/v1`). Isi STT Base URL secara eksplisit.

---

## 🔒 Keamanan & Privasi

Ekstensi ini dirancang dengan pendekatan *privacy-first*:

* **Penyimpanan Lokal:** API Key Anda disimpan secara eksklusif di `chrome.storage.local` perangkat Anda dan tidak pernah dikomit ke repositori. Tidak ada telemetri maupun analitik di dalam ekstensi ini.
* **Whisper Lokal:** audio dikirim ke URL yang **Anda sendiri** isi di *STT Base URL* (default `http://localhost:8080/v1`). Ekstensi **tidak** memaksa URL itu benar-benar lokal — pastikan isinya memang server Anda. Bila *STT API key* pernah diisi, nilainya tetap ikut sebagai header `Authorization` walaupun field-nya tersembunyi di mode ini.
* **Transparansi Endpoint:** MoM dihasilkan melalui *endpoint* pilihan Anda. Pastikan *endpoint* yang Anda konfigurasikan sesuai dengan kebijakan keamanan data perusahaan atau tim Anda.
* **Copy Prompt / Kirim ke Gemini / Kirim ke ChatGPT:** ketiganya menyalin **seluruh transkrip** ke clipboard, dan tombol Gemini/ChatGPT menempelkannya ke `gemini.google.com` / `chatgpt.com` — artinya seluruh isi rapat masuk ke akun Google/OpenAI Anda. Jangan gunakan untuk rapat yang isinya tidak boleh keluar.
* **Fail Backup:** ZIP hasil **Export backup** memuat **API key Anda dalam teks polos** beserta seluruh transkrip. Simpan failnya di tempat yang aman dan jangan dibagikan.

---

## 🛠️ Pemecahan Masalah (Troubleshooting)

* **Transkrip tidak muncul meskipun tombol CC Meet aktif:** (caption sendiri tidak tampil di layar karena disembunyikan bawaan — matikan **Sembunyikan caption di layar Meet** di Settings kalau ingin memastikan secara visual.) Google mungkin telah memperbarui struktur DOM Meet. Ekstensi akan menampilkan peringatan jika *caption* aktif namun teks tidak terbaca selama 30 detik. (Bagi *developer*, perbarui penyeleksi pada `content/selectors.js`).
* **Tab Live menunjuk rapat lama, atau perekaman tidak berhenti sendiri:** Google Meet adalah aplikasi SPA — pindah ruang dan keluar panggilan hanya mengganti URL pada dokumen yang sama. Pelacakan sesi ditangani `content/session.js` (murni, diuji pada `test/session.test.mjs`).
* **Transkrip audio kosong:** Periksa URL *endpoint* atau model STT di pengaturan Anda. Setelah diperbaiki, klik **Transkrip ulang** pada riwayat rapat terkait (audio asli masih tersimpan).
* **Caption tetap tampil setelah ekstensi di-*reload*:** *Content script* di *tab* yang sudah terbuka menjadi yatim saat ekstensi dimuat ulang, dan ia sengaja melepas sendiri gaya penyembunyi caption (kalau tidak, caption terkunci tersembunyi dan tak terjangkau Settings). Muat ulang *tab* Meet-nya.
* **Bahasa caption tidak berganti:** Ekstensi mencoba maksimal 3 kali per panggilan lalu berhenti. Kalau Google mengubah struktur pemilih bahasa, perbaiki `langCombobox()`/`langOption()` di `content/selectors.js`.
* **Peringatan "Belum ada suara masuk":** Tanpa opsi **Rekam mikrofon**, sistem hanya menangkap suara peserta lain. Jika tidak ada orang lain yang berbicara, maka tidak ada audio yang diproses.
* **Log Eror:** Jika terjadi kesalahan pada *side panel*, pesan *error* dan *stack trace* dapat disorot dan disalin langsung dari antarmuka panel.

---

## 💻 Pengembangan (Development)

Proyek ini dibangun tanpa *build step* yang kompleks (tanpa `npm install`), menggunakan JavaScript *vanilla* (Manifest V3) yang dioptimalkan.

**Struktur Direktori:**

* `background/` : *Service worker*, manajemen status, penyimpanan, dan siklus hidup.
* `content/` : Logika injeksi DOM Meet (`selectors.js`, `session.js`, `captions.js`, `captionhide.js`, `captionlang.js`). **Semua** penyeleksi DOM Meet tinggal di `selectors.js` — termasuk pola label bahasa.
* `panel/` : Antarmuka pengguna (*Live*, *Riwayat*, *Settings*).
* `popup/` : Popup ikon toolbar (Rekam, Bahasa caption, Riwayat) — satu-satunya permukaan UI yang boleh memulai `tabCapture`.
* `offscreen/` : Modul perekaman audio/video *tab* dan orkestrasi STT (service worker MV3 bisa mati di tengah unggahan panjang).
* `lib/` : Utilitas inti (`openai.js`, `stt.js`, `audiostore.js`/IndexedDB, `merge.js`, `ui.js` — helper DOM yang dipakai panel dan popup).
* `manifest.firefox.json` : manifest untuk build Firefox (`sidebar_action`, *event page*, tanpa `tabCapture`/`offscreen`) — versinya wajib sama dengan `manifest.json`.
* `test/` · `scripts/` · `icons/` · `docs/` : pengujian Node, skrip rilis, ikon, dan catatan desain internal.

**Menjalankan Pengujian (Testing):**

```bash
node --test test/*.test.mjs
```

**Membuat Rilis (Khusus Maintainer):**

Membutuhkan `node` (skrip membaca versi dari `manifest.json`) dan `gh` CLI yang sudah login.

1. Perbarui `"version"` di `manifest.json` **dan** `manifest.firefox.json` (skrip menolak jalan bila beda).
2. Lakukan *commit* dan `git push`.
3. Jalankan skrip rilis:

```bash
./scripts/pack.sh --release
```

*(Skrip membangun ZIP Chrome lalu memublikasikannya ke GitHub Releases — ZIP hanya untuk Chrome/Chromium. Rilis Firefox terpisah dan tanpa ZIP di GitHub: upload versi baru di [AMO Developer Hub](https://addons.mozilla.org/developers/) — pengguna Firefox mendapat update otomatis dari [halaman add-on](https://addons.mozilla.org/en-US/firefox/addon/meet-transcript/).)*

---

## 📄 Lisensi

[MIT](LICENSE) © zenmz

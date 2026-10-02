# Desain: Store rekaman multi-sesi (berhenti menimpa) + backup teks saja

Tanggal: 2026-10-02
Status: disetujui (brainstorming), menunggu review spec

## Masalah

Rekam Meet beberapa kali, file rekaman sebelumnya hilang. Penyebabnya satu
baris di `lib/audiostore.js`:

```js
function beginAudio({ meetingId, chunkMs, baseTime }) {
  return withDb('readwrite', (s) => {
    s.clear();                      // ← rekaman sebelumnya dihapus di sini
    return s.put({ meetingId, chunkMs, baseTime, count: 0, videoCount: 0 }, 'meta');
```

Store memang dirancang satu slot: header filenya menyebut *"simpan chunk audio
rekaman TERAKHIR"*, dan pesan errornya *"hanya rekaman terakhir yang
disimpan"*. Tiap Rekam membuang audio **dan** video rekaman sebelumnya. Ini
desain lama yang sudah tidak cocok dengan cara ekstensi dipakai sekarang, bukan
bug implementasi.

Lapisan transkrip sudah multi-rekaman: `lib/merge.js:47` menandai tiap baris
`audio:<baseTime>:<i>` dan `ownerOfRecording` memilih record pemilik dari
`baseTime`. Dua rekaman untuk satu meeting sudah bisa hidup berdampingan di
transkrip, dan "Transkrip ulang" sudah hanya mengganti baris milik rekaman
yang ditranskrip. Store blob adalah satu-satunya lapisan yang masih satu slot.

## Tujuan

1. Rekaman baru tidak lagi menghapus rekaman sebelumnya. Yang disimpan 5
   rekaman terakhir.
2. Panel menjangkau tiap rekaman milik sebuah meeting, bukan hanya yang
   terakhir.
3. Backup ZIP berisi **teks saja** — transkrip, MoM, Settings. Audio & video
   tidak ikut.

## Keputusan scope

- **STT tidak berubah.** Rotasi chunk 10 menit, upload saat Stop, penamaan file
  bernomor: semuanya tetap. Yang diperbaiki hanya tertimpanya.
- **5 rekaman**, konstanta, bukan setting.
- **Pemangkasan di `beginAudio`** — satu-satunya momen yang pasti terjadi dan
  tak butuh timer.
- **Tanpa langkah migrasi.** Kunci layout lama dibaca sebagai satu rekaman.
- **Format backup tetap `version: 1`.** Tidak ada v2.
- **Bar aksi panel tetap sembunyi total selama rekam/transkrip berjalan**,
  seperti sekarang — termasuk untuk rekaman lama meeting yang sama yang
  sebenarnya aman diunduh. Membedakan keduanya di dalam gate itu menambah
  cabang untuk keuntungan tipis; kalau mengganggu, itu perubahan terpisah.
- **Di luar scope:** zip64, unduh otomatis setelah stop, UI daftar rekaman
  tersendiri beserta tombol hapus dan indikator pemakaian disk.

## Arsitektur

### Layout store

```
meta:<baseTime>         → {meetingId, chunkMs, baseTime, count, videoCount}
chunk:<baseTime>:<i>    → Blob audio (tiap chunk file webm berdiri sendiri)
vchunk:<baseTime>:<i>   → Blob part video (hanya valid digabung berurutan)
```

`baseTime` jadi identitas rekaman (`recId`), bukan id baru: ia sudah dibuat SW
(`const baseTime = Date.now()` di `startRecording`), sudah ikut di meta, sudah
jadi tag baris transkrip `audio:<baseTime>:`, dan sudah jadi kunci
`ownerOfRecording`. Angka, jadi urut kronologis gratis. Dua rekaman tidak bisa
mulai di milidetik yang sama — `startRecording` menyerialisasi dirinya lewat
`startPromise` dan guard sinkron `rec.recording`.

### Layout lama dibaca, tidak dimigrasi

Kunci lama dikenali satu cabang di parser dan diperlakukan sebagai **satu**
rekaman dengan `recId = meta.baseTime ?? 0`:

| Kunci lama | Asal |
|---|---|
| `meta`, `chunk:<i>`, `vchunk:<i>` | layout 0.4–0.6 |
| `blobs` (array dalam satu key) | layout ≤0.3, sudah punya cabang legacy sendiri |

Tempat paling wajar untuk migrasi adalah `beginAudio`, dan itu dieksekusi
persis saat rekaman mulai — migrasi yang gagal di situ berarti rekaman gagal
start. Harganya tidak sebanding. Slot legacy dipangkas sebagai satu unit saat
umurnya habis, sama seperti rekaman lain.

`loadAudio()` sudah mengembalikan `legacy: true` untuk layout `blobs`, dan flag
itu dibawa sampai `replaceAudioSegments`. Perilaku itu tidak berubah.

### Pemangkasan

`beginAudio` berhenti memanggil `clear()`. Ia menghapus rekaman tertua di luar
`KEEP_RECORDINGS = 5`, dihitung dari `recId` (termasuk slot legacy sebagai satu
rekaman). Semua di satu transaksi `readwrite` bersama penulisan meta baru.

Pemangkasan dihitung **setelah** meta baru masuk daftar, jadi hasil akhirnya
tepat 5: 5 rekaman lama + 1 baru → yang tertua dibuang. Store yang baru berisi
4 rekaman tidak kehilangan apa pun saat rekaman ke-5 mulai.

`retagAudioMeta` hanya mengubah field `meetingId` di dalam meta; **key
`meta:<baseTime>` tidak berubah**, jadi chunk-chunknya tetap tersambung. Guard
`baseTime <= maxBaseTime` yang sudah ada tetap dipakai per meta, sekarang
diterapkan ke setiap meta yang `meetingId`-nya cocok, bukan ke satu meta.

Konstanta, bukan setting. Jalur naiknya ditulis sebagai komentar `ponytail:` di
sebelah konstanta: anggaran byte, bukan jumlah — video ±250 MB/jam vs audio
±30 MB/jam, jadi 5 rekaman video panjang ≈ 1,2 GB sementara 5 rekaman audio
≈ 150 MB. `unlimitedStorage` sudah ada di manifest, jadi 5 rekaman tidak
menabrak kuota.

### API `lib/audiostore.js`

| Sekarang | Jadi | Catatan |
|---|---|---|
| `beginAudio({meetingId, chunkMs, baseTime})` | sama | tulis `meta:<baseTime>`, pangkas ke 5 |
| `appendChunk(blob)` | `appendChunk(blob, recId)` | counter dibaca dari `meta:<recId>` |
| `appendVideoPart(blob)` | `appendVideoPart(blob, recId)` | idem |
| `loadAudioMeta()` | `listRecordings()` | semua meta tanpa blob, urut terbaru dulu |
| `loadAudio()` | `loadAudio(recId)` | |
| `loadVideo()` | `loadVideo(recId)` | |
| `retagAudioMeta(old, new, max)` | sama, retag **semua** meta yang cocok | satu kode ruang bisa punya beberapa rekaman |
| `importAudio(meta, chunks)` | sama | key chunk sudah berbentuk baru saat masuk |

`listRecordings()` menggantikan `loadAudioMeta()` dengan alasan yang sama
kenapa keduanya dipisah sekarang: cek "ada rekaman?" tidak boleh menarik
ratusan MB blob. Satu `getAllKeys` + `getAll`, buang nilai blob, kembalikan
meta saja.

`listRecordings()` mengembalikan **semua** rekaman; penyaringan per meeting
dikerjakan panel (`r.meetingId === meeting.id`). Store tidak tahu meeting mana
yang sedang dilihat.

Dua helper murni diekspos untuk diuji (lihat Testing):

- `groupRecordings(keys, vals)` → `[{recId, meetingId, chunkMs, baseTime,
  count, videoCount, legacy, keys}]` urut `recId` menurun. `keys` = daftar key
  yang dimiliki rekaman itu (meta + seluruh `chunk:`/`vchunk:`/`blobs`-nya).
  Satu-satunya tempat bentuk key diparse, termasuk cabang layout lama — itu
  sebabnya `keys` ikut dibawa keluar: pemanggil lain tidak perlu tahu bentuk
  key sama sekali.
- `pruneTargets(recordings, keep)` → daftar key yang harus dihapus:
  urutkan `recId` menurun, buang `keep` pertama, kumpulkan `keys` sisanya.

`loadAudio(recId)` dan `loadVideo(recId)` juga memakai `groupRecordings` untuk
menemukan key milik recId itu, jadi slot legacy bisa dimuat lewat
`recId = meta.baseTime ?? 0` persis seperti rekaman lain.

### Bug lama yang ikut mati

`recId` ditangkap di closure `startChunkRecorder()` dan `startVideoRecorder()`
saat recorder dibuat, bukan dibaca dari `cfg` saat event datang. Hari ini
`ondataavailable`/`onstop` yang terlambat dari recorder yang sudah dibongkar
menulis ke satu-satunya `meta` yang ada — yaitu milik rekaman **berikutnya**.
Dengan recId di closure, event telat menulis ke rekamannya sendiri, atau ke
meta yang sudah terpangkas, dan jalur penolakannya sudah ada: *"Meta rekaman
hilang — potongan tidak bisa disimpan."*

### Panel

Satu rekaman per meeting (mayoritas kasus) — label persis seperti sekarang:

```
Unduh ›
   Unduh audio (3 file)
   Unduh video
[Transkrip ulang]
```

Lebih dari satu, jam mulai jadi pembedanya:

```
Unduh ›
   Unduh audio — 14:05 (3 file)
   Unduh video — 14:05
   Unduh audio — 15:30 (1 file)
   Unduh video — 15:30
[Transkrip ulang ›]
   dari rekaman 14:05
   dari rekaman 15:30
```

- Gate per rekaman, bukan global: `count > 0` menentukan item audio,
  `videoCount > 0` menentukan item video. Pemisahan yang sudah ada sekarang
  (rekaman mati di menit 5 punya video tapi `count` audio masih 0) tinggal
  berlaku per baris.
- Cache `audioMeta`/`audioMetaKey` jadi cache **daftar** rekaman milik view
  itu. Aturan `undefined = gagal baca (jangan cache)` vs `null/[] = memang tak
  ada` tetap.
- Cek kepemilikan `saved.meetingId !== meeting.id` **tetap** setelah
  `loadAudio(recId)`. Daftar di-cache, jadi rekaman baru yang memangkas yang
  tertua masih bisa membuat recId di menu jadi basi. Rekaman terpangkas →
  `loadAudio` mengembalikan `null` → flash *"Audio tidak ditemukan"* yang sudah
  ada. Tidak ada UI baru untuk kasus ini.
- `regenerate-transcript` membawa `recId`: `{type, id, recId}`. SW
  memvalidasinya lewat `listRecordings()` (ada? milik meeting ini?) sebelum
  menyuruh offscreen. Offscreen `loadAudio(msg.recId)` dan tetap memeriksa
  `saved.meetingId === msg.meetingId`.

### Backup: teks saja

Format tetap `version: 1`. Format sekarang **sudah** memperlakukan `audioMeta`
sebagai opsional (`if (j.audioMeta != null && !isPlainObject…) throw`, lalu
`if (j.audioMeta)`), dan kalau absen `importAudio(null, [])` jalan — store
rekaman dikosongkan, yang justru perilaku yang diinginkan dan sudah
dijelaskan komentar di tempatnya: import MENGGANTI rekaman, dan rekaman lama
yang dibiarkan nempel ke meeting impor berkode ruang sama membuat "Transkrip
ulang" menimpa transkrip impor dengan audio sesi lain.

Jadi tidak ada v2, tidak ada cabang versi baru, dan backup baru masih bisa
dibaca versi ekstensi yang lebih tua.

**`exportBackup()`** berhenti menulis entri `audio/*` **dan** berhenti menulis
`audioMeta`. Keduanya, bukan hanya blobnya: `audioMeta` yang ikut tanpa
chunk-nya berarti import menulis meta ber-`count: 3` dengan nol blob, dan panel
menawarkan "Unduh audio (3 file)" yang selalu gagal. Panggilan `loadAudio()` /
`loadVideo()` / `loadAudioMeta()` di `exportBackup` dibuang.

**`importBackup()`** mempertahankan jalur ZIP-lama-ber-audio. Alasannya bukan
kelengkapan: import adalah pintu satu arah (`storage.clear()` lalu ganti), dan
ZIP yang sudah ada di disk user memuat audio. Yang berubah hanya konstruksi
key: `chunk:<recId>:<i>` dan `vchunk:<recId>:<i>` dengan
`recId = j.audioMeta.baseTime ?? 0`. `AUDIO_RE`/`VIDEO_RE` tetap pola datar
`audio/chunk-<i>.webm` — tak ada ZIP yang pernah ditulis dengan pola lain.

Konsekuensi yang hilang dari scope: zip64, path `audio/<recId>/`, validasi
array `recordings`, dan penjaga ukuran 3,5 GB. Backup teks ukurannya KB sampai
beberapa MB.

### Ikutan kecil di panel Settings

- Komentar `'Menyusun zip…'` beserta *"rekaman video besar — bisa beberapa
  detik"* dicabut: sekarang instan.
- `✓ Backup siap (0.0 MB)` — pembulatan MB tak masuk akal untuk backup teks.
  Tampilkan KB di bawah 1 MB.
- Alert import `"${r.chunks} potongan rekaman"` — jangan tampilkan angka 0 yang
  bikin curiga. Sebut potongan hanya kalau `r.chunks > 0` (ZIP lama).
- Gate export `recState.recording || recState.transcribing || status.inCall`
  **tetap**. Isi backup memang tak lagi tergantung rekaman, tapi `transcribing`
  (transkrip sedang akan ditulis) dan `inCall` (segmen caption masuk tiap
  500 ms) masih alasan yang sah.
- Teks penjelas baru, `el('div', 'muted', …)` setelah `exportBtn`/`importBtn`,
  pola yang sama dengan blok mic:

  > Backup berisi transkrip, MoM, dan Settings — bukan file rekaman. Audio &
  > video tidak ikut karena bisa ratusan MB per rekaman. Unduh sendiri dari
  > entri Riwayat → Unduh. Yang tersimpan hanya 5 rekaman terakhir; lebih tua
  > dari itu terhapus saat rekaman baru mulai.

## Penanganan error

| Keadaan | Perilaku |
|---|---|
| Rekaman sudah terpangkas, recId di menu basi | `loadAudio(recId)` → `null` → flash *"Audio tidak ditemukan"* (sudah ada) |
| `regenerate-transcript` tanpa `recId` / recId milik meeting lain | SW menolak lewat balasan `{ok:false, error}` sebelum menyentuh offscreen; `rec` tidak pernah masuk `transcribing` |
| Satu blob gagal ditulis (kuota, storage dibersihkan) | tidak berubah: counter tetap naik, indeks dilewati, error dilempar setelah transaksi selesai |
| Meta rekaman hilang saat `appendChunk` | tidak berubah: *"Meta rekaman hilang — potongan tidak bisa disimpan."* |
| Pemangkasan gagal di tengah | satu transaksi dengan penulisan meta → batal semua, rekaman gagal start dengan pesan, bukan store setengah terpangkas |
| Import ZIP cacat | tidak berubah: ditolak **sebelum** `storage.clear()` |
| Import gagal menulis blob | tidak berubah: hasil parsial, bukan throw |

## Testing

Repo nol dependency dan tanpa `package.json`, jadi IndexedDB tidak ada di Node
dan `audiostore.js` memang tidak teruji hari ini. `fake-indexeddb` tidak
ditambahkan. Yang diuji adalah bagian murninya, dan itu persis tempat bugnya
akan muncul.

**`test/audiostore.test.mjs`** (baru)

- `groupRecordings`: layout baru; layout lama (`meta`/`chunk:<i>`); layout
  `blobs` ≤0.3 beserta flag `legacy`; urutan numerik (`chunk:10` tidak jatuh
  sebelum `chunk:2`); indeks bolong tetap mengembalikan `indices` asli; store
  kosong → `[]`.
- `pruneTargets`: 5 rekaman → tidak memangkas apa pun; 6 → memangkas yang
  tertua beserta seluruh `chunk:`/`vchunk:` miliknya; slot legacy terpangkas
  sebagai satu unit (`meta` + `chunk:<i>` + `blobs` sekaligus); daftar kosong
  → `[]`.

**`test/backup.test.mjs`** (perluas)

- export tidak memuat entri `audio/*` maupun field `audioMeta`;
- import ZIP lama ber-audio mendarat di key `chunk:<recId>:<i>`;
- import tanpa `audioMeta` mengosongkan store rekaman;
- backup cacat tetap ditolak sebelum `storage.clear()` (tes yang sudah ada,
  harus tetap hijau).

**`test/sw.test.mjs`** (perluas)

- `regenerate-transcript` tanpa `recId` ditolak;
- `recId` milik meeting lain ditolak;
- keduanya tanpa pesan ke offscreen dan tanpa `rec.transcribing` tersangkut.

Seluruh 96 tes yang ada sekarang harus tetap hijau.

## Verifikasi manual

Dijalankan user setelah reload ekstensi:

1. Rekam Meet, stop, rekam lagi, stop. Buka Riwayat → kedua entri menawarkan
   Unduh sendiri-sendiri, dan file rekaman pertama masih ada.
2. Rekam ruang yang sama dua kali dalam satu sesi → satu entri Riwayat, menu
   Unduh memuat dua rekaman berlabel jam, "Transkrip ulang ›" memuat dua
   pilihan.
3. "Transkrip ulang" dari rekaman lama hanya mengganti baris miliknya,
   baris rekaman lain tetap.
4. Rekam 6 kali → rekaman ke-1 hilang dari menu, 5 sisanya utuh.
5. Export backup → ukuran KB, isi zip tanpa folder `audio/`. Import kembali →
   transkrip & Settings pulih.
6. Import ZIP backup lama (yang memuat audio) → transkrip pulih dan rekaman di
   dalamnya muncul di entri meeting-nya.

# Review local diff — video tab + backup zip + hapus STT browser

Target: `git diff origin/main` (uncommitted, 2026-08-12) — rekam video tab, export/import backup ZIP, penghapusan STT browser (vendor 21MB), konsolidasi audiostore/offscreen. Basis: kode aktual + 80 unit test pass.

## Validasi trust-boundary

- [x] `lib/backup.js:163` — `j.storage` cuma dicek truthiness; file import invalid bisa MENGHAPUS seluruh data user.
  `backup.json` rusak/diedit dengan `"storage": "x"` (string) atau array lolos validasi → `chrome.storage.local.clear()` (baris 173) jalan dulu, lalu `set()` (174) throw atau menyimpan sampah — riwayat + settings user lenyap gara-gara file yang seharusnya ditolak. Ini destructive path dari input user, validasi tipe saja wajib. Fix: sebelum `clear()`, tolak kecuali `j.storage && typeof j.storage === 'object' && !Array.isArray(j.storage)`; validasi serupa untuk `j.audioMeta` (object/null).
  **RESOLVED 2026-08-12** — guard `isPlainObject` untuk `storage` + `audioMeta` dipasang sebelum `clear()`. Test `backup.json cacat ditolak SEBELUM storage.clear()` menegaskan invariannya lewat penghitung `clear()`, bukan cuma "error dilempar"; mutation check (guard dilemahkan balik ke truthiness) memang memerahkan test itu.

## Correctness

- [x] `lib/backup.js:173-175` — kegagalan `importAudio` dilaporkan sebagai "Import gagal" padahal storage SUDAH diganti.
  `clear()`+`set()` sukses lalu `importAudio` throw (mis. kuota) → panel menampilkan "✗ Import gagal"; user percaya tidak ada yang berubah, padahal riwayat lama sudah lenyap tertimpa, dan rekaman IndexedDB yang masih tersisa milik meeting dari storage lama (yatim). Komentar di kode sudah sadar urutannya disengaja — tapi pelaporannya bohong. Fix: try/catch terpisah di sekitar `importAudio`, kembalikan status parsial dan panel melaporkan jujur: "transkrip masuk, rekaman gagal di-restore".
  **RESOLVED 2026-08-12** — `importAudio` di-catch, hasilnya `{meetings, chunks, audioError}`; panel (`panel.js:720`) memberi pesan "Import selesai SEBAGIAN … Data lama sudah tergantikan." Test `restore rekaman gagal → hasil parsial, bukan throw` mengunci perilakunya.

- [x] `offscreen/offscreen.js:145` — `startVideoRecorder()` yang throw mematikan rekaman AUDIO juga.
  Konstruktor `MediaRecorder` bisa menolak kombinasi mimeType/bitrate (NotSupportedError) → exception menjalar keluar `start()` → SW menerima `audio-error`, mereset state, menutup offscreen — user kehilangan seluruh rekaman meeting padahal yang gagal cuma layer video opsional. Fix: bungkus panggilan di try/catch → `toSW({type:'audio-warn', ...})` "video gagal dimulai — rekaman audio jalan terus", audio lanjut normal.
  **RESOLVED 2026-08-12** — dibungkus try/catch, `videoRecorder` di-null-kan lalu `audio-warn` dikirim; audio + transkrip lanjut. Belum ada test otomatis (butuh `MediaRecorder`, tak ada di Node) — perlu smoke manual.

## Rollout safety — pertanyaan terbuka

- [x] `lib/stt.js:74` — nasib user lama ber-`sttMode:'browser'`: jatuh ke `whisper-local` `localhost:8080` yang mungkin tak pernah ada.
  Migrasi menurunkan ulang mode; user yang dulunya full-offline (tanpa server, tanpa izin origin localhost) akan gagal STT di rekaman pertama pasca-update — audio tersimpan, error tampil, transkrip ulang tersedia, jadi tidak ada data hilang. Tapi tidak ada notice bahwa mode lamanya dihapus; mereka menemukannya lewat kegagalan. Belum ada keputusan tertulis (tanpa PR/commit yang membahas) — konfirmasi ini degradasi yang diterima, atau tambah notice sekali di Settings/onInstalled sebelum rilis.
  **RESOLVED 2026-08-12** — peringatan dicat di dua tempat yang dilewati sebelum gagal: bar rekam tab Live (`panel.js:200`) dan blok STT di Settings (`panel.js:520`), digate `sttMode === 'browser'` di settings tersimpan. Tanpa state "sudah dibaca": Simpan menulis mode hasil resolusi sehingga gate-nya mati sendiri, plus notice di Settings di-hide langsung setelah save (view itu tidak dirender ulang). Tidak perlu handler `onInstalled`.

## Kedalaman test

- [x] `lib/backup.js:145-176` — lapisan restore (mapping nama entry → key IndexedDB + guard versi) nol test; regresi = restore rekaman hilang senyap.
  Round-trip zip sudah tertest (`test/backup.test.mjs`), tapi `AUDIO_RE`/`VIDEO_RE` → `chunk:<i>`/`vchunk:<i>`, penolakan `backup.json` rusak SEBELUM `clear()`, dan validasi versi tidak. Typo regex membuat import "sukses" dengan 0 potongan — satu-satunya tanda angka kecil di alert. Fix: test `importBackup` dengan stub `globalThis.chrome.storage.local` + `MeetAudioStore` — kasus: chunk+vchunk kembali ke key benar, zip tanpa backup.json ditolak sebelum clear, storage non-object ditolak sebelum clear.
  **RESOLVED 2026-08-12** — 5 test `importBackup` di `test/backup.test.mjs` dengan stub `chrome.storage.local` + `MeetAudioStore`: mapping `chunk:7`/`vchunk:0`, zip tanpa backup.json, backup.json bukan JSON, 5 bentuk `storage`/`audioMeta`/versi cacat, dan jalur restore-gagal. Semua penolakan diassert lewat penghitung `clear()`, jadi yang dikunci adalah "tak ada data terhapus", bukan sekadar pesan error. Mutation check pada guard `!main` dan `isPlainObject` sama-sama memerahkan suite.

## UX / konsistensi guard

- [x] `panel/panel.js:691` — Export tidak di-guard saat rekaman/transkrip berjalan; hasilnya backup berisi rekaman terpotong tanpa tanda.
  Jalur import menolak saat `recState` aktif (baris 712), export tidak — zip yang dibuat di tengah meeting membawa potongan rekaman parsial yang baru ketahuan cacat saat di-restore. Fix satu baris: guard yang sama dengan import, atau minimal label peringatan di note.
  **RESOLVED 2026-08-12** — guard yang sama dengan import dipasang di awal handler export: "Rekaman/transkrip sedang berjalan — backup akan memuat rekaman separuh. Stop dulu."

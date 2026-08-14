# Review keseluruhan proyek — 2026-08-12

Mode: seluruh repo di `main` (f58e412), bukan diff PR. Basis: kode aktual + `git log`; 77 unit test pass (`node --test`).

Konteks umum: kode ini padat komentar rasional dan hampir semua race MV3 yang lazim (SW restart, offscreen lifecycle, double-click, epoch render) sudah dijaga eksplisit. Temuan di bawah adalah sisa yang benar-benar belum tertangani — bukan pengulangan tradeoff yang sudah didokumentasikan di komentar.

## Correctness / race

- [ ] `panel/panel.js:693` — `probeStt` fetch tanpa timeout; tombol "Tes koneksi" bisa macet disabled selamanya.
  Endpoint STT yang menerima koneksi tapi tidak pernah menjawab (persis skenario yang sudah diantisipasi `STT_TIMEOUT_MS` di `lib/openai.js`) membuat `await probeStt(...)` menggantung → `finally` tak pernah jalan → tombol disabled + "Menguji…" permanen sampai panel ditutup. Fix: tambah `signal: AbortSignal.timeout(15000)` di fetch `/models`, map `TimeoutError` ke pesan "STT <host> tidak menjawab".

- [ ] `background/service-worker.js:487` — dua tab in-call bersamaan (dua ruang berbeda) saling rebut `active` tiap 2 detik.
  `canClaim = msg.inCall || !active.inCall || !active.id` meloloskan SEMUA tab in-call, jadi dua meeting paralel (satu di-park di tab lain — kasus nyata) membuat `active` flip-flop tiap tick: tab Live berganti meeting bolak-balik, dan `captionsOnAt` ikut ter-reset tiap flip sehingga warning "caption nyala tapi tak ada teks 30 detik" tak pernah bisa terbit. Penyimpanan transkrip tetap benar (per port), yang rusak status/UI. Fix: klaim in-call tidak boleh digusur klaim in-call lain — `const canClaim = msg.inCall ? (!active.inCall || active.id === msg.id) : (!active.inCall || !active.id)`; tab lama yang selesai melepas klaim lewat `endMeeting` seperti biasa. Catatan sekalian: dua tab in-call di ruang yang SAMA menghasilkan segmen dobel (sessionTag beda → id tak tabrakan → transkrip dobel); minimal dokumentasikan sebagai batasan.

## Validasi trust-boundary

- [ ] `panel/panel.js:749` — `doSave` menerima Template MoM tanpa `{{transcript}}` tanpa peringatan.
  User yang mengedit template dan tak sengaja menghapus placeholder tetap bisa Simpan; `fillTemplate` jadi no-op dan "Generate MoM" mengirim prompt TANPA transkrip — hasilnya MoM halusinasi yang tampak sah, tanpa satu pun tanda kenapa. Fix satu baris di `doSave`: kalau `!template.value.includes('{{transcript}}')`, simpan tetap jalan tapi `setNote('err', 'Template tidak memuat {{transcript}} — MoM akan digenerate tanpa transkrip.')`.

## Data retention / privasi

- [ ] `panel/panel.js` (file-level) — tidak ada jalur hapus data sama sekali.
  Transkrip meeting adalah data sensitif, dan ekstensi ini menyimpannya selamanya: tidak ada tombol hapus per meeting, tidak ada "hapus semua", tidak ada retensi otomatis. Satu-satunya jalan user membuang transkrip rapat yang tak boleh tersimpan adalah membongkar `chrome.storage` lewat DevTools. Fix: tombol "Hapus" di view meeting Riwayat (remove `meeting:<id>` + entrinya di list `meetings`, lewat pesan ke SW supaya masuk `enqueueWrite`) — itu minimum; "Hapus semua riwayat" di Settings menyusul kalau perlu.

## Kedalaman test

- [ ] `lib/audiostore.js` (file-level) — logika failure-path paling rawan di repo, nol test.
  `appendChunk` (failure ditampung + `preventDefault` supaya count tetap maju, dilempar setelah txn), sort numerik `chunk:10` vs `chunk:2` di `loadAudio`, guard `maxBaseTime` di `retagAudioMeta` — semua ini menjaga audio rekaman user dari hilang senyap, dan regresinya baru ketahuan saat rekaman user benar-benar hilang. `merge`/`stt`/`session`/`openai` 77 test; file yang justru menyentuh data paling mahal tak tersentuh. Fix: dev-dep `fake-indexeddb`, tiga test: (1) put chunk gagal → count tetap naik + error dilempar, (2) `loadAudio` mengembalikan urutan + `indices` benar dengan chunk bolong, (3) `retagAudioMeta` menolak meta ber-baseTime lebih muda.

- [ ] `background/service-worker.js` (file-level) — state machine `rec` (start/stop/regenerate/restore-dari-progress) dijaga banyak komentar, dikunci nol test.
  Semua invariant race (klaim sinkron sebelum await, startPromise ditunggu stop, pemulihan lewat `audio-progress`) hanya hidup di komentar; refactor berikutnya bisa mematahkannya tanpa ada yang merah. Butuh mock tipis `chrome.*` (sendMessage/storage/offscreen) — bukan pekerjaan kecil, jadi prioritas di bawah audiostore. Alternatif sadar: terima sebagai risiko terdokumentasi, tapi putuskan eksplisit, jangan default.

## Efisiensi

- [ ] `panel/panel.js:394` — `renderHistory` menarik SEMUA record meeting utuh (termasuk seluruh segmen) hanya untuk menampilkan judul + hitungan.
  Riwayat berbulan-bulan = tiap buka tab Riwayat men-deserialize berpuluh MB. Belum terasa sekarang, membesar diam-diam. Fix murah yang konsisten dengan skema sekarang: simpan index ringkas (`{id,title,startedAt,segCount,hasMom}`) yang di-update di jalur write SW, list render dari index itu saja.

- [ ] `panel/panel.js:162` — `renderMeeting` tab Live: full storage read + full DOM rebuild tiap broadcast status (±2 detik) sepanjang meeting.
  Meeting 2 jam dengan ratusan segmen = ratusan rebuild penuh; kerja CPU/baterai untuk render yang 95% identik. Prioritas rendah (fungsional benar, scroll sudah dijaga). Fix termurah: skip rebuild kalau `meeting.segments.length` + id segmen terakhir + `mom` tak berubah sejak render sebelumnya.

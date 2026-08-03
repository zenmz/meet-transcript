# Desain: Port Firefox + dukungan Chromium lain

Tanggal: 2026-08-03
Status: disetujui (brainstorming), menunggu review spec

## Tujuan

Meet Transcript bisa dipakai di Firefox (caption-only) dan terdokumentasi untuk
browser Chromium lain (Edge/Brave/Opera/Vivaldi). Safari di luar scope.

Satu codebase, satu sumber kebenaran. Build Chrome yang sekarang tidak berubah
perilakunya.

## Keputusan scope

- **Target:** Firefox + verifikasi/dokumentasi Chromium. Tanpa Safari.
- **Audio di Firefox:** tidak ada. Firefox tidak punya `tabCapture`; alternatif
  (`getDisplayMedia`, mic-only) UX-nya buruk. Firefox = transkrip caption + MoM
  saja, seluruh UI rekam disembunyikan.
- **Distribusi Firefox:** AMO unlisted signing (`web-ext sign`), hasil `.xpi`
  di-upload ke GitHub Release bersama ZIP Chrome.

## Arsitektur

Pendekatan: manifest per browser + feature-detect di runtime. Tanpa polyfill,
tanpa bundler, tanpa fork. Firefox MV3 mendukung `chrome.*` promise-based,
jadi semua kode JS dipakai dua browser apa adanya.

### Manifest

File baru `manifest.firefox.json` (file penuh, bukan hasil generate —
duplikasi ~30 baris diterima demi kesederhanaan). Beda dari `manifest.json`:

| Chrome | Firefox |
|---|---|
| `side_panel.default_path` | `sidebar_action: { default_panel, default_title, default_icon }` |
| `background.service_worker` | `background.scripts: [lib/merge.js, lib/openai.js, lib/stt.js, lib/audiostore.js, background/service-worker.js]` (urutan = urutan `importScripts` sekarang) |
| permissions ada `tabCapture`, `offscreen`, `sidePanel` | ketiganya dibuang |
| `minimum_chrome_version` | `browser_specific_settings.gecko: { id: "meet-transcript@zenmz", strict_min_version: "128.0" }` |

Sisanya (host_permissions, CSP `wasm-unsafe-eval`, content_scripts, icons,
action) identik.

### Perubahan kode

Semua berupa guard; tidak ada file yang di-fork.

- `background/service-worker.js`
  - `importScripts(...)` dibungkus `if (typeof importScripts === 'function')`
    — di Firefox script dimuat via `background.scripts`.
  - `chrome.sidePanel.setPanelBehavior(...)` → optional chaining
    `chrome.sidePanel?.`; cabang Firefox: listener `chrome.action.onClicked`
    memanggil `chrome.sidebarAction.toggle()` (sinkron, dalam user gesture).
  - Context menu "rekam" dan seluruh jalur rekam/offscreen hanya didaftarkan
    kalau `chrome.tabCapture` ada.
- `panel/panel.js` — seluruh UI audio (tombol rekam/stop, bar status, unduh
  audio, transkrip ulang) digate `chrome.tabCapture !== undefined`.
- `content/*` — nol perubahan (DOM + `chrome.runtime`/`chrome.storage` saja).

### Build & rilis

- `pack.sh --firefox`: stage seperti biasa, tapi `manifest.firefox.json`
  di-copy sebagai `manifest.json` dan `offscreen/` di-exclude. Output
  `dist/meet-transcript-firefox-v{VER}.zip`.
- Versi: satu sumber di `manifest.json` Chrome. Pack gagal cepat kalau versi
  `manifest.firefox.json` tidak sama.
- `npx web-ext lint` atas stage Firefox = gate di `pack.sh --firefox`.
- Signing: `npx web-ext sign --channel=unlisted`, kredensial dari env
  `AMO_JWT_ISSUER`/`AMO_JWT_SECRET` (setup sekali di addons.mozilla.org,
  tidak pernah masuk repo). `web-ext` dipanggil via `npx`, tidak jadi
  dependency repo.
- `--release` meng-upload ZIP Chrome + ZIP Firefox + `.xpi` hasil sign.

### Docs (README)

- Bagian Install dipecah per browser: Chrome/Edge/Brave/Opera (load unpacked,
  beda URL halaman ekstensi saja) dan Firefox (install `.xpi` langsung).
- Satu kalimat batasan: Firefox caption-only, tanpa rekam audio.

## Error handling

- Jalur audio tidak mungkin tercapai di Firefox (UI + registrasi digate), jadi
  tidak butuh error path baru.
- `pack.sh` gagal cepat pada: item hilang (sudah ada), versi manifest tidak
  sinkron (baru), lint gagal (baru).

## Testing

- Otomatis: `web-ext lint` di build Firefox.
- Manual smoke Firefox: load via `about:debugging` → join Meet → caption masuk
  panel sidebar → MoM jalan → pastikan UI rekam tidak muncul.
- Chrome: verifikasi tidak berubah — diff perilaku hanya guard yang selalu
  true di Chrome.
- `test/` yang ada tidak disentuh.

## Di luar scope

- Safari (butuh wrapper Xcode + App Store).
- Rekam audio di Firefox (getDisplayMedia/mic — UX buruk, ditolak sadar).
- AMO listed publik.

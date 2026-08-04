# Firefox Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Meet Transcript jalan di Firefox (caption-only) dengan satu codebase, plus build/sign/dokumentasi per browser; perilaku build Chrome tidak berubah.

**Architecture:** Manifest per browser (`manifest.firefox.json` file penuh) + feature-detect runtime (`chrome.tabCapture` sebagai saklar semua jalur audio). Tanpa polyfill, tanpa bundler — Firefox MV3 mendukung `chrome.*` promise-based. Spec: `docs/superpowers/specs/2026-08-03-firefox-port-design.md`.

**Tech Stack:** Vanilla JS MV3, bash (`pack.sh`), `web-ext` via `npx` (lint + sign AMO unlisted), `gh` CLI.

## Global Constraints

- Tanpa build step / `npm install` / dependency baru di repo — `web-ext` hanya via `npx` saat build/rilis.
- Chrome floor: `minimum_chrome_version: "116"` (tidak berubah). Firefox floor: `strict_min_version: "128.0"`.
- Satu sumber versi: `manifest.json` (Chrome). `manifest.firefox.json` wajib sinkron — pack gagal cepat kalau beda.
- Gecko ID: `meet-transcript@zenmz`.
- Komentar kode & pesan commit bahasa Indonesia, gaya Conventional Commits, sama seperti kode yang ada.
- Kode JS dipakai dua browser apa adanya — perubahan hanya boleh berupa guard; jangan fork file.
- Jangan sentuh `test/` yang ada.
- Kerjakan di branch `feat/firefox-port` (sudah ada, berisi commit spec).

---

### Task 1: `manifest.firefox.json`

**Files:**
- Create: `manifest.firefox.json`

**Interfaces:**
- Consumes: —
- Produces: file manifest yang Task 4 (`pack.sh`) copy sebagai `manifest.json` di stage Firefox. Urutan `background.scripts` = urutan `importScripts` di `background/service-worker.js:2`.

- [ ] **Step 1: Tulis file**

```json
{
  "manifest_version": 3,
  "name": "Meet Transcript",
  "version": "0.2.0",
  "description": "Transkrip Google Meet dari caption, lalu jadi Minutes of Meeting. Versi Firefox: caption-only (tanpa rekam audio).",
  "browser_specific_settings": {
    "gecko": { "id": "meet-transcript@zenmz", "strict_min_version": "128.0" }
  },
  "permissions": ["storage", "unlimitedStorage", "activeTab", "contextMenus", "scripting"],
  "host_permissions": [
    "https://meet.google.com/*",
    "https://api.openai.com/*",
    "https://gemini.google.com/*",
    "https://huggingface.co/*",
    "https://*.hf.co/*"
  ],
  "optional_host_permissions": ["https://*/*", "http://*/*"],
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  },
  "background": {
    "scripts": ["lib/merge.js", "lib/openai.js", "lib/stt.js", "lib/audiostore.js", "background/service-worker.js"]
  },
  "content_scripts": [
    {
      "matches": ["https://meet.google.com/*"],
      "js": ["content/selectors.js", "content/session.js", "content/captions.js"],
      "run_at": "document_idle"
    }
  ],
  "sidebar_action": {
    "default_panel": "panel/panel.html",
    "default_title": "Meet Transcript",
    "default_icon": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" },
    "open_at_install": false
  },
  "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" },
  "action": {
    "default_title": "Meet Transcript",
    "default_icon": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
  }
}
```

Catatan yang disengaja (jangan "diperbaiki"):
- `permissions` tanpa `tabCapture`/`offscreen`/`sidePanel` (tidak ada di Firefox). `contextMenus` tetap ikut — dipertahankan sesuai spec walau item menunya digate mati di Task 2.
- `strict_min_version: "128.0"`: Firefox 127+ menampilkan host permission MV3 di dialog install (granted by default) — di bawah itu content script `meet.google.com` tidak jalan sampai user opt-in manual; 128 juga ESR yang mendukung `optional_host_permissions`.
- `open_at_install: false`: tanpa ini Firefox membuka sidebar sendiri begitu ekstensi terpasang.
- `host_permissions` + CSP identik dengan Chrome sesuai spec (huggingface tidak terpakai di Firefox tapi tidak berbahaya).
- Tidak ada `minimum_chrome_version`, `side_panel`, maupun key `offscreen`.

- [ ] **Step 2: Validasi JSON + sinkron versi**

Run: `node -e "const a=require('./manifest.json'),b=require('./manifest.firefox.json'); if(a.version!==b.version) throw new Error('versi beda'); console.log('OK', b.version)"`
Expected: `OK 0.2.0`

- [ ] **Step 3: Commit**

```bash
git add manifest.firefox.json
git commit -m "feat: manifest Firefox — sidebar_action, event page, tanpa tabCapture"
```

---

### Task 2: Guard API Chrome-only di service worker

**Files:**
- Modify: `background/service-worker.js` (baris 2, 4, 45-48, 72-113, 153, 537, 544 — nomor baris sebelum edit)

**Interfaces:**
- Consumes: —
- Produces: SW yang jalan sebagai event page Firefox tanpa error. Saklar: `chrome.tabCapture` (undefined di Firefox), `chrome.sidebarAction` (hanya ada di Firefox), `chrome.runtime.getContexts` (tidak ada di Firefox).

- [ ] **Step 1: Guard `importScripts` (baris 2)**

Ganti:
```js
importScripts('/lib/merge.js', '/lib/openai.js', '/lib/stt.js', '/lib/audiostore.js');
```
menjadi:
```js
// Firefox: bukan service worker — script lain dimuat lewat background.scripts
// di manifest.firefox.json (urutannya harus sama dengan daftar ini).
if (typeof importScripts === 'function') {
  importScripts('/lib/merge.js', '/lib/openai.js', '/lib/stt.js', '/lib/audiostore.js');
}
```

- [ ] **Step 2: sidePanel → sidebarAction (baris 4)**

Ganti:
```js
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
```
menjadi:
```js
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true });
// Firefox: tidak ada sidePanel — klik ikon toolbar men-toggle sidebar. toggle()
// wajib dipanggil sinkron di dalam handler (butuh user gesture). Di Chrome
// listener ini tidak didaftarkan; klik ikon sudah ditangani setPanelBehavior.
if (chrome.sidebarAction) {
  chrome.action.onClicked.addListener(() => chrome.sidebarAction.toggle());
}
```

- [ ] **Step 3: Guard `hasOffscreen` (baris 45-48)**

Ganti isi fungsi:
```js
async function hasOffscreen() {
  const c = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).catch(() => []);
  return c.length > 0;
}
```
menjadi:
```js
async function hasOffscreen() {
  // Firefox tidak punya getContexts MAUPUN offscreen. Guard di sini, bukan di
  // pemanggil: stopRecording tetap dipanggil dari finish() tiap meeting usai,
  // dan tanpa guard ini tiap penutupan meeting melempar unhandled rejection.
  if (!chrome.runtime.getContexts) return false;
  const c = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).catch(() => []);
  return c.length > 0;
}
```
(Komentar lama di atas fungsi soal Chrome 116 tetap dibiarkan.)

- [ ] **Step 4: Gate context menu rekam (baris 72-113)**

Bungkus DUA blok — listener `chrome.runtime.onInstalled` (72-79) dan `chrome.contextMenus.onClicked` (81-113) — dalam satu `if`:
```js
// Rekam audio butuh tabCapture — tidak ada di Firefox, jadi menu klik-kanan
// dan seluruh jalur start-nya tidak didaftarkan sama sekali di sana.
if (chrome.tabCapture) {
  chrome.runtime.onInstalled.addListener(() => {
    ...isi lama apa adanya...
  });

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    ...isi lama apa adanya...
  });
}
```
Isi kedua listener TIDAK diubah — hanya indentasi bertambah satu level.

- [ ] **Step 5: `chrome.offscreen` → optional chaining (baris 153, 537, 544)**

Tiga tempat `chrome.offscreen.closeDocument?.().catch(() => {});` → `chrome.offscreen?.closeDocument?.().catch(() => {});`
(Jalur ini tak terjangkau di Firefox selama gating benar; `?.` ekstra = asuransi satu karakter kalau gating regresi.)

- [ ] **Step 6: Verifikasi sintaks + regresi**

Run: `node --check background/service-worker.js && node --test test/*.test.mjs`
Expected: tanpa error sintaks, semua test PASS.

- [ ] **Step 7: Commit**

```bash
git add background/service-worker.js
git commit -m "feat: guard API Chrome-only di service worker untuk Firefox"
```

---

### Task 3: Gate UI audio di panel

**Files:**
- Modify: `panel/panel.js` (setelah baris 7; baris 191; baris 576-579 — nomor sebelum edit)

**Interfaces:**
- Consumes: —
- Produces: konstanta `HAS_AUDIO` (module scope panel.js). Nilai settings STT/`transcriptSource` yang tersimpan TIDAK boleh berubah saat Simpan di Firefox.

- [ ] **Step 1: Konstanta saklar**

Sisipkan setelah `let recState = ...` (baris 7):
```js
// Firefox tidak punya tabCapture — rekam audio mustahil di sana, jadi seluruh
// UI-nya (bar rekam di tab Live, sumber "Rekam audio" + blok STT di Settings)
// disembunyikan. Tombol audio di Riwayat TIDAK perlu digate: syaratnya
// audioMeta milik meeting itu, dan di Firefox tak pernah ada audio tersimpan.
const HAS_AUDIO = !!chrome.tabCapture;
```

- [ ] **Step 2: Sembunyikan bar rekam tab Live**

Baris 191, ganti `if (live) {` menjadi `if (live && HAS_AUDIO) {` (blok bar `actions` berisi Stop rekam / hint klik-kanan / progres transkrip).

- [ ] **Step 3: Sembunyikan Sumber transkrip + blok STT di Settings**

Di `applyMode()` (baris 576), ganti:
```js
  function applyMode() {
    const audio = audioMode();
    const m = sttModeSel.value;
    show(sttModeSel, audio);
```
menjadi:
```js
  function applyMode() {
    const audio = HAS_AUDIO && audioMode();
    const m = sttModeSel.value;
    // Field tetap DIBUAT (doSave membaca value-nya, jadi setelan STT yang
    // tersimpan tidak hangus saat Simpan di Firefox) — cuma barisnya yang hilang.
    show(source, HAS_AUDIO);
    show(sttModeSel, audio);
```
Baris-baris `show(...)` lain di bawahnya sudah pakai `audio` — otomatis ikut mati. `doSave()` TIDAK diubah.

- [ ] **Step 4: Verifikasi sintaks**

Run: `node --check panel/panel.js`
Expected: tanpa output (OK).

- [ ] **Step 5: Commit**

```bash
git add panel/panel.js
git commit -m "feat: sembunyikan UI rekam audio saat tabCapture tidak ada"
```

---

### Task 4: `pack.sh` — build Firefox, lint, sign, rilis 3 aset

**Files:**
- Modify: `scripts/pack.sh` (tulis ulang penuh — struktur lama linear, sekarang butuh dua flavor)

**Interfaces:**
- Consumes: `manifest.firefox.json` (Task 1).
- Produces: `dist/meet-transcript-v{VER}.zip` (default, sama seperti sekarang), `dist/meet-transcript-firefox-v{VER}.zip` (`--firefox`), keduanya + `dist/*.xpi` + GitHub release (`--release`). Env yang dibutuhkan `--release`: `AMO_JWT_ISSUER`, `AMO_JWT_SECRET`.

- [ ] **Step 1: Tulis ulang `scripts/pack.sh`**

```bash
#!/usr/bin/env bash
# Bikin ZIP rilis bersih (cuma file ekstensi, tanpa docs/test/.git) ke dist/.
# Versi diambil dari manifest.json — naikkan di situ DAN manifest.firefox.json
# sebelum rilis (pack menolak jalan kalau keduanya beda).
#
#   ./scripts/pack.sh            # dist/meet-transcript-vX.Y.Z.zip (Chrome/Chromium)
#   ./scripts/pack.sh --firefox  # dist/meet-transcript-firefox-vX.Y.Z.zip (digate web-ext lint)
#   ./scripts/pack.sh --release  # build keduanya + sign .xpi (AMO unlisted) + gh release (publish!)
#                                # butuh env AMO_JWT_ISSUER + AMO_JWT_SECRET
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE=chrome
case "${1:-}" in
  '') ;;
  --firefox) MODE=firefox ;;
  --release) MODE=release ;;
  *) echo "pack: argumen tak dikenal: $1" >&2; exit 1 ;;
esac

# File yang browser butuh. Tambah di sini kalau ada folder runtime baru.
# LICENSE + THIRD_PARTY_NOTICES.md WAJIB ikut: ZIP ini mendistribusikan ulang
# transformers.js (Apache-2.0) dan onnxruntime-web (MIT) di lib/vendor/, dan
# kedua lisensi itu mensyaratkan teksnya ikut dalam distribusi.
ITEMS=(manifest.json README.md LICENSE THIRD_PARTY_NOTICES.md background panel content offscreen lib icons)

# Gagal cepat kalau ada item yang hilang (salah ketik / folder pindah).
for it in "${ITEMS[@]}" manifest.firefox.json; do
  [ -e "$it" ] || { echo "pack: '$it' tidak ada — perbaiki ITEMS di pack.sh" >&2; exit 1; }
done

VER="$(node -p "require('./manifest.json').version")"
NAME="meet-transcript"

# Versi satu sumber kebenaran di manifest.json; manifest.firefox.json wajib sinkron.
FVER="$(node -p "require('./manifest.firefox.json').version")"
[ "$VER" = "$FVER" ] || { echo "pack: versi tidak sinkron — manifest.json $VER, manifest.firefox.json $FVER" >&2; exit 1; }

mkdir -p "$ROOT/dist"

# stage <chrome|firefox> → cetak path staging. Pemanggil yang membereskan.
stage() {
  local flavor="$1" dir
  dir="$(mktemp -d)/$NAME"
  mkdir -p "$dir"
  for it in "${ITEMS[@]}"; do cp -R "$it" "$dir/"; done
  find "$dir" -name '.DS_Store' -delete
  if [ "$flavor" = firefox ]; then
    # Firefox caption-only: offscreen (tabCapture) tidak ikut, manifest diganti.
    rm -rf "$dir/offscreen"
    cp manifest.firefox.json "$dir/manifest.json"
  fi
  echo "$dir"
}

# zip_stage <stagedir> <zippath> — zip lalu hapus staging.
zip_stage() {
  local dir="$1" out="$2"
  rm -f "$out"
  ( cd "$(dirname "$dir")" && zip -rq "$out" "$(basename "$dir")" )
  rm -rf "$(dirname "$dir")"
  echo "pack: $out"
}

build_chrome() { zip_stage "$(stage chrome)" "$ROOT/dist/${NAME}-v${VER}.zip"; }

# Lint dulu, baru zip: zip Firefox yang gagal lint tidak boleh pernah lahir.
build_firefox() {
  local dir; dir="$(stage firefox)"
  npx --yes web-ext lint --source-dir "$dir" \
    || { rm -rf "$(dirname "$dir")"; echo "pack: web-ext lint gagal" >&2; exit 1; }
  zip_stage "$dir" "$ROOT/dist/${NAME}-firefox-v${VER}.zip"
}

# Sign AMO unlisted → dist/*.xpi. Kredensial dari env — tidak pernah masuk repo.
sign_firefox() {
  : "${AMO_JWT_ISSUER:?pack: set AMO_JWT_ISSUER — addons.mozilla.org → Tools → Manage API Keys}"
  : "${AMO_JWT_SECRET:?pack: set AMO_JWT_SECRET}"
  local dir; dir="$(stage firefox)"
  npx --yes web-ext sign --channel=unlisted --source-dir "$dir" \
    --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET" \
    --artifacts-dir "$ROOT/dist" \
    || { rm -rf "$(dirname "$dir")"; echo "pack: web-ext sign gagal" >&2; exit 1; }
  rm -rf "$(dirname "$dir")"
  XPI="$(ls -t "$ROOT"/dist/*.xpi | head -1)"
  echo "pack: $XPI"
}

case "$MODE" in
  chrome)  build_chrome ;;
  firefox) build_firefox ;;
  release)
    build_chrome
    build_firefox
    sign_firefox
    # Tag v$VER dibuat di commit HEAD sekarang — pastikan sudah di-push & bersih.
    gh release create "v$VER" \
      "$ROOT/dist/${NAME}-v${VER}.zip" \
      "$ROOT/dist/${NAME}-firefox-v${VER}.zip" \
      "$XPI" \
      --title "v$VER" \
      --notes "Ekstensi Meet Transcript untuk tim.

**Chrome / Edge / Brave / Opera (Load unpacked):**
1. Download \`${NAME}-v${VER}.zip\` di bawah (Assets).
2. Extract ke folder tetap.
3. \`chrome://extensions\` (Edge: \`edge://extensions\`, dst) → Developer mode → Load unpacked → pilih folder itu.

**Firefox:**
Download fail \`.xpi\`, buka dengan Firefox (drag ke jendela Firefox), setujui pemasangan. Versi Firefox caption-only — tanpa rekam audio/STT.

Isi ZIP hanya file ekstensi (tanpa docs/test). Detail di README."
    echo "pack: rilis v$VER dibuat"
    ;;
esac

if [ "$MODE" != release ]; then
  echo "pack: siap. Untuk publish: ./scripts/pack.sh --release"
fi
```

- [ ] **Step 2: Verifikasi build Chrome (perilaku lama)**

Run: `bash scripts/pack.sh && unzip -l dist/meet-transcript-v0.2.0.zip | grep -c manifest.json`
Expected: `pack: .../dist/meet-transcript-v0.2.0.zip`, lalu `1`. Isi zip memuat `offscreen/` dan TIDAK memuat `manifest.firefox.json`.

- [ ] **Step 3: Verifikasi build Firefox + lint**

Run: `bash scripts/pack.sh --firefox && unzip -l dist/meet-transcript-firefox-v0.2.0.zip | grep -E "offscreen|manifest"`
Expected: lint web-ext lolos (0 errors — warnings boleh), zip terbentuk, output grep hanya `meet-transcript/manifest.json` (tanpa satu pun entri `offscreen/`).
Kalau lint melaporkan error pada key manifest (mis. `optional_host_permissions` tak dikenal): itu bukti floor versi salah — perbaiki di `manifest.firefox.json`, jangan dilewati.

- [ ] **Step 4: Verifikasi guard versi tidak sinkron**

Run: `node -e "const f=require('./manifest.firefox.json');f.version='9.9.9';require('fs').writeFileSync('manifest.firefox.json',JSON.stringify(f,null,2)+'\n')" && bash scripts/pack.sh; git checkout manifest.firefox.json`
Expected: `pack: versi tidak sinkron — manifest.json 0.2.0, manifest.firefox.json 9.9.9`, exit non-zero, lalu file dipulihkan.

- [ ] **Step 5: Commit**

```bash
git add scripts/pack.sh
git commit -m "feat: pack.sh — build+lint Firefox, sign AMO unlisted, rilis 3 aset"
```

---

### Task 5: README per browser

**Files:**
- Modify: `README.md` (baris 29, 35, 48-51, 67-69, 141-142, 150-162 — nomor sebelum edit)

**Interfaces:**
- Consumes: nama aset dari Task 4 (`meet-transcript-firefox-vX.Y.Z.zip`, `.xpi`).
- Produces: —

- [ ] **Step 1: Paragraf pembuka Panduan Instalasi (baris 29)**

Ganti kalimat pertama paragraf:
`Ekstensi ini berjalan pada **Chrome 116+** dan dipasang melalui mode *Developer*.`
menjadi:
`Ekstensi ini berjalan pada **Chrome 116+** — termasuk browser Chromium lain (Edge, Brave, Opera, Vivaldi) — dan **Firefox 128+**. Di Chromium dipasang melalui mode *Developer*; di Firefox melalui fail \`.xpi\` yang sudah ditandatangani AMO. **Versi Firefox caption-only**: tanpa rekam audio/STT, karena Firefox tidak memiliki API \`tabCapture\`.`
(Kalimat kurung soal `getContexts` dan kalimat "Tidak memerlukan proses build..." tetap.)

- [ ] **Step 2: Langkah 3 Metode 1 (baris 35)**

Ganti:
`3. Buka URL \`chrome://extensions\` di Google Chrome.`
menjadi:
`3. Buka URL \`chrome://extensions\` di Google Chrome (Edge: \`edge://extensions\`, Brave: \`brave://extensions\`, Opera: \`opera://extensions\`).`

- [ ] **Step 3: Subbagian Firefox baru**

Sisipkan SETELAH blok `> [!NOTE]` Metode 2 (baris 51), sebelum `---`:

```markdown
### Firefox

1. Buka halaman **[Releases](../../releases)** dan unduh fail `.xpi` terbaru.
2. Seret (*drag*) fail tersebut ke jendela Firefox, lalu setujui pemasangan. Terpasang permanen — tidak perlu mode Developer.
3. Klik ikon Meet Transcript di *toolbar* untuk membuka/menutup *sidebar*.

> [!NOTE]
> Versi Firefox **caption-only**: fitur Perekaman Audio & Mode STT di bawah tidak tersedia (Firefox tidak punya API `tabCapture`). Transkrip dari *caption*, Riwayat, MoM, dan Kirim ke Gemini berfungsi penuh.
>
> Untuk pengembangan: `./scripts/pack.sh --firefox`, ekstrak ZIP-nya, lalu muat via `about:debugging` → *This Firefox* → *Load Temporary Add-on* (hilang saat Firefox ditutup — distribusi normal tetap lewat `.xpi`).
```

- [ ] **Step 4: Header seksi audio (baris 67-69)**

Ganti judul `## 🎙️ Perekaman Audio & Mode STT` menjadi `## 🎙️ Perekaman Audio & Mode STT (Chrome/Chromium saja)` dan tambahkan di akhir paragraf pembukanya: `Fitur di seksi ini tidak tersedia di Firefox.`

- [ ] **Step 5: Seksi Development (baris 141-142, 150-162)**

Di **Struktur Direktori**, setelah bullet `lib/`, tambah bullet:
`* \`manifest.firefox.json\` : manifest untuk build Firefox (\`sidebar_action\`, *event page*, tanpa \`tabCapture\`/\`offscreen\`) — versinya wajib sama dengan \`manifest.json\`.`

Ganti blok **Membuat Rilis (Khusus Maintainer)** (baris 152-162) menjadi:

```markdown
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
```

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: README — instalasi per browser, batasan caption-only Firefox"
```

---

### Task 6: Verifikasi akhir

**Files:** — (tidak ada perubahan kode; kalau smoke test menemukan bug, perbaiki dengan commit terpisah)

**Interfaces:**
- Consumes: semua task sebelumnya.
- Produces: bukti lolos untuk laporan akhir.

- [ ] **Step 1: Regresi otomatis**

Run: `node --test test/*.test.mjs && node --check background/service-worker.js && node --check panel/panel.js && bash scripts/pack.sh && bash scripts/pack.sh --firefox`
Expected: semua PASS, dua zip terbentuk.

- [ ] **Step 2: Smoke test Firefox (manual — butuh user kalau agent tak bisa buka browser)**

```bash
rm -rf /tmp/mt-ff && unzip -q dist/meet-transcript-firefox-v0.2.0.zip -d /tmp/mt-ff
```
Lalu di Firefox: `about:debugging` → *This Firefox* → *Load Temporary Add-on* → pilih `/tmp/mt-ff/meet-transcript/manifest.json`. Checklist:
1. Klik ikon toolbar → sidebar buka; klik lagi → tutup.
2. Tab Live TANPA bar "klik kanan … Rekam audio"; klik kanan halaman Meet TANPA item menu rekam.
3. Settings TANPA baris "Sumber transkrip" dan tanpa blok STT; Simpan → "Tersimpan."
4. Join Meet + nyalakan CC → caption mengalir ke tab Live; tutup meeting → entri muncul di Riwayat.
5. Generate MoM jalan (butuh API key) ATAU "Copy Prompt+Transkrip" menyalin.
6. Console background (`about:debugging` → Inspect) bersih dari error merah saat langkah 1-5.

- [ ] **Step 3: Smoke test regresi Chrome (manual)**

Reload ekstensi di `chrome://extensions` (Load unpacked dari repo). Checklist: klik ikon → side panel buka; klik kanan halaman Meet → "Rekam audio meeting" masih ada; Settings masih punya "Sumber transkrip" + blok STT.

- [ ] **Step 4: Selesai**

Laporkan hasil checklist. JANGAN push / bikin PR tanpa diminta (ingat: push repo ini butuh `gh auth switch` ke akun zenmz).

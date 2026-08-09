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

# stage <chrome|firefox> — isi $STAGE_DIR. Global, bukan echo/capture: subshell
# $(...) tidak mewarisi errexit (bash 3.2 macOS), jadi cp yang gagal di dalam
# capture tertelan dan zip cacat lolos. Dipanggil polos begini, set -e bekerja.
stage() {
  local flavor="$1"
  STAGE_DIR="$(mktemp -d)/$NAME"
  mkdir -p "$STAGE_DIR"
  for it in "${ITEMS[@]}"; do cp -R "$it" "$STAGE_DIR/"; done
  find "$STAGE_DIR" -name '.DS_Store' -delete
  if [ "$flavor" = firefox ]; then
    # Firefox caption-only: offscreen (tabCapture) tidak ikut, manifest diganti.
    # STT in-browser juga dibuang (~21MB, sumber warning eval AMO): hanya
    # dijangkau lewat dynamic import di jalur audio yang mati di Firefox.
    rm -rf "$STAGE_DIR/offscreen" "$STAGE_DIR/lib/vendor" "$STAGE_DIR/lib/whisper-browser.js"
    cp manifest.firefox.json "$STAGE_DIR/manifest.json"
  fi
}

# zip_stage <stagedir> <zippath> — zip lalu hapus staging.
# Isi di-zip dari DALAM folder: manifest.json wajib di root zip — AMO dan
# Chrome Web Store menolak zip yang isinya satu folder pembungkus.
zip_stage() {
  local dir="$1" out="$2"
  rm -f "$out"
  ( cd "$dir" && zip -rq "$out" . )
  rm -rf "$(dirname "$dir")"
  echo "pack: $out"
}

build_chrome() { stage chrome; zip_stage "$STAGE_DIR" "$ROOT/dist/${NAME}-v${VER}.zip"; }

# Lint dulu, baru zip: zip Firefox yang gagal lint tidak boleh pernah lahir.
build_firefox() {
  stage firefox
  npx --yes web-ext lint --source-dir "$STAGE_DIR" \
    || { rm -rf "$(dirname "$STAGE_DIR")"; echo "pack: web-ext lint gagal" >&2; exit 1; }
  zip_stage "$STAGE_DIR" "$ROOT/dist/${NAME}-firefox-v${VER}.zip"
}

# Sign AMO unlisted → dist/*.xpi. Kredensial dari env — tidak pernah masuk repo.
sign_firefox() {
  : "${AMO_JWT_ISSUER:?pack: set AMO_JWT_ISSUER — addons.mozilla.org → Tools → Manage API Keys}"
  : "${AMO_JWT_SECRET:?pack: set AMO_JWT_SECRET}"
  stage firefox
  npx --yes web-ext sign --channel=unlisted --source-dir "$STAGE_DIR" \
    --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET" \
    --artifacts-dir "$ROOT/dist" \
    || { rm -rf "$(dirname "$STAGE_DIR")"; echo "pack: web-ext sign gagal" >&2; exit 1; }
  rm -rf "$(dirname "$STAGE_DIR")"
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

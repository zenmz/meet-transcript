#!/usr/bin/env bash
# Bikin ZIP rilis bersih (cuma file ekstensi, tanpa docs/test/.git) ke dist/.
# Versi diambil dari manifest.json — naikkan di situ DAN manifest.firefox.json
# sebelum rilis (pack menolak jalan kalau keduanya beda).
#
#   ./scripts/pack.sh            # dist/meet-transcript-vX.Y.Z.zip (Chrome/Chromium)
#   ./scripts/pack.sh --release  # ZIP Chrome + gh release (publish!)
#
# ZIP hanya untuk Chrome/Chromium. Firefox TIDAK dirilis dari sini —
# distribusinya halaman AMO (update versi lewat AMO Developer Hub):
# https://addons.mozilla.org/en-US/firefox/addon/meet-transcript/
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE=chrome
case "${1:-}" in
  '') ;;
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

# stage — isi $STAGE_DIR. Global, bukan echo/capture: subshell $(...) tidak
# mewarisi errexit (bash 3.2 macOS), jadi cp yang gagal di dalam capture
# tertelan dan zip cacat lolos. Dipanggil polos begini, set -e bekerja.
stage() {
  STAGE_DIR="$(mktemp -d)/$NAME"
  mkdir -p "$STAGE_DIR"
  for it in "${ITEMS[@]}"; do cp -R "$it" "$STAGE_DIR/"; done
  find "$STAGE_DIR" -name '.DS_Store' -delete
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

build_chrome() { stage; zip_stage "$STAGE_DIR" "$ROOT/dist/${NAME}-v${VER}.zip"; }

case "$MODE" in
  chrome)  build_chrome ;;
  release)
    build_chrome
    # Tag v$VER dibuat di commit HEAD sekarang — pastikan sudah di-push & bersih.
    gh release create "v$VER" \
      "$ROOT/dist/${NAME}-v${VER}.zip" \
      --title "v$VER" \
      --notes "Ekstensi Meet Transcript untuk tim.

**Chrome / Edge / Brave / Opera (Load unpacked):**
1. Download \`${NAME}-v${VER}.zip\` di bawah (Assets).
2. Extract ke folder tetap.
3. \`chrome://extensions\` (Edge: \`edge://extensions\`, dst) → Developer mode → Load unpacked → pilih folder itu.

**Firefox:**
Pasang dari halaman resmi (caption-only — tanpa rekam audio/STT):
https://addons.mozilla.org/en-US/firefox/addon/meet-transcript/

Isi ZIP hanya file ekstensi (tanpa docs/test). Detail di README."
    echo "pack: rilis v$VER dibuat"
    ;;
esac

if [ "$MODE" != release ]; then
  echo "pack: siap. Untuk publish: ./scripts/pack.sh --release"
fi

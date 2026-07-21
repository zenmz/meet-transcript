#!/usr/bin/env bash
# Bikin ZIP rilis bersih (cuma file ekstensi, tanpa docs/test/.git) ke dist/.
# Versi diambil dari manifest.json — naikkan di situ sebelum rilis.
#
#   ./scripts/pack.sh            # build dist/meet-transcript-vX.Y.Z.zip saja
#   ./scripts/pack.sh --release  # build + gh release create vX.Y.Z (publish!)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# File yang Chrome butuh. Tambah di sini kalau ada folder runtime baru.
ITEMS=(manifest.json README.md background panel content offscreen lib icons)

VER="$(node -p "require('./manifest.json').version")"
NAME="meet-transcript"
ZIP="$ROOT/dist/${NAME}-v${VER}.zip"

# Gagal cepat kalau ada item yang hilang (salah ketik / folder pindah).
for it in "${ITEMS[@]}"; do
  [ -e "$it" ] || { echo "pack: '$it' tidak ada — perbaiki ITEMS di pack.sh" >&2; exit 1; }
done

STAGE="$(mktemp -d)/$NAME"
mkdir -p "$STAGE"
for it in "${ITEMS[@]}"; do cp -R "$it" "$STAGE/"; done
find "$STAGE" -name '.DS_Store' -delete

mkdir -p "$ROOT/dist"
rm -f "$ZIP"
( cd "$(dirname "$STAGE")" && zip -rq "$ZIP" "$NAME" )
rm -rf "$(dirname "$STAGE")"
echo "pack: $ZIP"

if [ "${1:-}" = "--release" ]; then
  # Tag v$VER dibuat di commit HEAD sekarang — pastikan sudah di-push & bersih.
  gh release create "v$VER" "$ZIP" \
    --title "v$VER" \
    --notes "Ekstensi Meet Transcript untuk tim.

**Install (Load unpacked):**
1. Download \`${NAME}-v${VER}.zip\` di bawah (Assets).
2. Extract ke folder tetap.
3. \`chrome://extensions\` → Developer mode → Load unpacked → pilih folder itu.

Isi ZIP hanya file ekstensi (tanpa docs/test). Detail di README."
  echo "pack: rilis v$VER dibuat"
else
  echo "pack: siap. Untuk publish: ./scripts/pack.sh --release  (atau gh release create v$VER \"$ZIP\")"
fi

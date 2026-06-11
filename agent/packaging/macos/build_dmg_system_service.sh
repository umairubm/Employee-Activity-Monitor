#!/usr/bin/env bash
# Build the system service macOS daemon bundle and package it into a distributable .dmg
# Run from anywhere: bash agent/packaging/macos/build_dmg_system_service.sh
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

# 2. Build the system service daemon app bundle with PyInstaller
# This creates: dist/loginwindow.app
pyinstaller --noconfirm WorkforceAgent-SystemService.spec

APP="dist/loginwindow.app"
DMG="dist/WorkforceAgent-SystemService-macos.dmg"
STAGE="dist/dmg-system-service-stage"

# 3. Package into DMG for distribution
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
echo ""
echo "To install:"
echo "  1. Mount the DMG and copy loginwindow.app to /Applications"
echo "  2. Run: sudo bash agent/packaging/macos/install-system-daemon.sh"

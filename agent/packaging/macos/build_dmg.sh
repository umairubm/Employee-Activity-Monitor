#!/usr/bin/env bash
# Build the macOS .app and package it into a distributable .dmg.
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

# A remote-update artifact that is not Developer ID signed and notarized will
# be rejected by the agent. If credentials are provided, we sign it. Otherwise,
# we gracefully skip signing to allow dev builds.
if [ -n "${CODESIGN_IDENTITY:-}" ]; then
  : "${APPLE_ID:?APPLE_ID is required}"
  : "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD is required}"
  : "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"
else
  echo "CODESIGN_IDENTITY is missing. Building UNSIGNED macOS application."
fi

# 2. Build, sign, notarize, and staple the .app bundle.
pyinstaller --noconfirm WorkforceAgent.spec

# 3. Package the .app into a compressed .dmg with an /Applications shortcut,
#    plus a remote-update archive (the .zip the dashboard pushes to devices).
APP="dist/WorkforceAgent.app"
DMG="dist/WorkforceAgent-macos.dmg"
AGENT_VERSION="$(
  python -c 'import pathlib,re; s=pathlib.Path("../agent.py").read_text(encoding="utf-8"); print(re.search(r"AGENT_VERSION\s*=\s*\"([^\"]+)\"", s).group(1))'
)"
UPDATE_ZIP="dist/WorkforceAgent-macos-${AGENT_VERSION}.app.zip"
STAGE="dist/dmg-stage"
NOTARY_ZIP="dist/WorkforceAgent-macos-notary.zip"

if [ -n "${CODESIGN_IDENTITY:-}" ]; then
  codesign \
    --force --deep --strict --options runtime --timestamp \
    --sign "$CODESIGN_IDENTITY" \
    "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"

  rm -f "$NOTARY_ZIP"
  ditto -c -k --keepParent "$APP" "$NOTARY_ZIP"
  xcrun notarytool submit "$NOTARY_ZIP" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  spctl --assess --type execute --verbose=2 "$APP"
  rm -f "$NOTARY_ZIP"
fi

rm -f "$DMG"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

hdiutil create \
  -volname "Workforce Agent" \
  -srcfolder "$STAGE" \
  -ov -format UDZO \
  "$DMG"

if [ -n "${CODESIGN_IDENTITY:-}" ]; then
  xcrun notarytool submit "$DMG" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
fi

echo "Built $DMG"

# 4. Remote-update archive: a .zip containing just WorkforceAgent.app, built
#    with ditto so code signatures/symlinks survive. This is the file admins
#    upload in the dashboard's Update Agent dialog for macOS releases — the
#    agent validates the bundle identity + signature, swaps it in atomically,
#    and relaunches.
rm -f "$UPDATE_ZIP"
ditto -c -k --keepParent "$APP" "$UPDATE_ZIP"
echo "Built $UPDATE_ZIP"

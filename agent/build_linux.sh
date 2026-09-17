#!/usr/bin/env bash
# Build the Linux standalone binary and package it for distribution.
# The binary and package are named 'WorkforceAgent' for transparency.
#
# Run from the repo root:
#   bash agent/packaging/linux/build_linux.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(dirname "$HERE")"
REPO_ROOT="$(dirname "$PKG_DIR")"
cd "$REPO_ROOT"

# 1. Ensure dependencies are present for the build.
python3 -m pip install --upgrade pip
python3 -m pip install -r requirements.txt pyinstaller

# 2. Build the standalone binary with PyInstaller.
#    We use the WorkforceAgent name and include assets.
pyinstaller --noconfirm \
  --onefile \
  --name WorkforceAgent \
  --add-data "packaging/icons/icon.png:agent_assets" \
  agent.py

# 3. Prepare the distribution folder.
DIST_DIR="dist/linux-package"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"
cp dist/WorkforceAgent "$DIST_DIR/"

# 4. Create a .desktop file for Linux desktop integration.
cat <<EOF > "$DIST_DIR/workforce-agent.desktop"
[Desktop Entry]
Name=Workforce Agent
Exec=WorkforceAgent
Icon=icon
Type=Application
Categories=Utility;
Comment=Transparent workforce activity monitoring
EOF

echo "Built Linux binary: dist/WorkforceAgent"
echo "Desktop entry created in: $DIST_DIR"
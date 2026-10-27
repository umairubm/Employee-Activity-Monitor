#!/bin/bash
# WorkforceAgent — macOS install / in-place upgrade.
#
# Ships INSIDE WorkforceAgent-macos.dmg, next to WorkforceAgent.app.
# Double-click this file to install OR upgrade. It stops and removes any
# previous version, installs the new one, and PRESERVES this Mac's existing
# enrollment, so the device stays linked and keeps reporting without re-setup.
#
# Why this exists: the build is not Developer-ID signed, so over-the-air
# updates are rejected by the agent and the app must be replaced by hand.
# Dragging a new app over a running one leaves the old process and its
# autostart entry behind — this script does the stop/remove/install cleanly.

set -u

APP_NAME="WorkforceAgent.app"
DEST="/Applications/${APP_NAME}"
LABEL="com.apple.workforceagent"
LEGACY_LABEL="com.apple.telemetryd"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LEGACY_PLIST="$HOME/Library/LaunchAgents/${LEGACY_LABEL}.plist"
CONFIG_DIR="$HOME/Library/Application Support/WorkforceAgent"

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/${APP_NAME}"

echo "===================================================="
echo " Workforce Agent  —  Install / Upgrade"
echo "===================================================="
echo ""

if [ ! -d "$SRC" ]; then
  echo "ERROR: ${APP_NAME} was not found next to this installer."
  echo "Open WorkforceAgent-macos.dmg and run install.command from INSIDE it"
  echo "(do not copy install.command out on its own)."
  echo ""
  read -r -p "Press Return to close. "
  exit 1
fi

if [ -d "$CONFIG_DIR" ]; then
  echo "An existing enrollment was found — it will be kept."
else
  echo "No existing enrollment found — this looks like a fresh install."
fi
echo "You may be asked for your Mac password (needed to write to /Applications)."
echo ""

sudo -v || { echo "Admin privileges are required. Aborting."; read -r -p "Press Return to close. "; exit 1; }

echo "[1/5] Stopping any running agent..."
launchctl unload "$PLIST"        2>/dev/null || true
launchctl unload "$LEGACY_PLIST" 2>/dev/null || true
launchctl remove "$LABEL"        2>/dev/null || true
launchctl remove "$LEGACY_LABEL" 2>/dev/null || true
# KeepAlive can relaunch the process immediately; stop the job first, then kill.
pkill -f "/Applications/WorkforceAgent.app"      2>/dev/null || true
sudo pkill -f "/Applications/com.apple.telemetryd" 2>/dev/null || true
sleep 1

echo "[2/5] Removing the old application..."
sudo rm -rf "$DEST"
sudo rm -rf /Applications/com.apple.telemetryd*.app
# Drop the stale autostart entries; the fresh app rewrites its own on launch.
rm -f "$PLIST" "$LEGACY_PLIST"

echo "[3/5] Installing the new application..."
sudo ditto "$SRC" "$DEST"
# Unsigned build: clear the download quarantine flag so Gatekeeper lets it run.
sudo xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

echo "[4/5] Launching the agent (it registers its own login autostart)..."
# Run as the logged-in user (NOT via sudo) so the user LaunchAgent is created
# in ~/Library/LaunchAgents and permission prompts appear in this session.
open "$DEST"

echo "[5/5] Done."
echo ""
echo "The agent is installed and running, and will start automatically at login."
if [ -d "$CONFIG_DIR" ]; then
  echo "Enrollment preserved at: ~/Library/Application Support/WorkforceAgent"
fi
echo ""
echo "If macOS asks for Screen Recording or Accessibility permission, open"
echo "System Settings > Privacy & Security and click Allow for Workforce Agent."
echo ""
read -r -p "Press Return to close. "

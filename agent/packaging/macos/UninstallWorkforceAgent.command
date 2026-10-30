#!/bin/bash
# Uninstall Workforce Agent on macOS — removes everything install.command added,
# plus any legacy DISGUISED Workforce builds (exact known names only).
#
# Order matters: the root guard is removed FIRST so it cannot resurrect the
# agent, app or enrollment while they are being removed.
#
# Run as the logged-in user (NOT with sudo); it asks for your password.

set -u

LABEL="com.workforceanalytics.agent"
GUARD_LABEL="${LABEL}.guard"
AGENT_PLIST="/Library/LaunchAgents/${LABEL}.plist"
GUARD_PLIST="/Library/LaunchDaemons/${GUARD_LABEL}.plist"
APP="/Applications/WorkforceAgent.app"
STATE="/Library/Application Support/WorkforceAgent"
LOGDIR="/Library/Logs/WorkforceAgent"
CONFIG_DIR="$HOME/Library/Application Support/WorkforceAgent"
UID_NUM="$(id -u)"

echo "===================================================="
echo " Workforce Agent  —  Uninstall"
echo "===================================================="
echo ""
echo "This removes the agent, its guard, and this Mac's enrollment and"
echo "local data. You will be asked for your Mac password."
echo ""

if [ "$UID_NUM" -eq 0 ]; then
  echo "ERROR: run this as the logged-in user, not with sudo."
  read -r -p "Press Return to close. "; exit 1
fi
sudo -v || { echo "Admin privileges are required. Aborting."; read -r -p "Press Return to close. "; exit 1; }

echo "[1/6] Removing the guard (first, so nothing gets restored)..."
sudo launchctl bootout "system/$GUARD_LABEL" 2>/dev/null || true
sudo rm -f "$GUARD_PLIST"
sudo rm -rf "$STATE"

echo "[2/6] Stopping and removing the agent..."
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
sudo rm -f "$AGENT_PLIST"
sudo pkill -f "$APP/Contents/MacOS/WorkforceAgent" 2>/dev/null || true
sleep 1

echo "[3/6] Removing the application and logs..."
sudo rm -rf "$APP" "$LOGDIR"

echo "[4/6] Removing enrollment and local data..."
rm -rf "$CONFIG_DIR"

echo "[5/6] Removing legacy disguised builds, if any..."
for l in com.apple.telemetryd com.apple.workforceagent; do
  launchctl bootout "gui/$UID_NUM/$l" 2>/dev/null || true
done
for l in com.apple.workforceagent.daemon com.apple.loginwindow.daemon com.apple.svctcom; do
  sudo launchctl bootout "system/$l" 2>/dev/null || true
done
rm -f "$HOME/Library/LaunchAgents/com.apple.telemetryd.plist" \
      "$HOME/Library/LaunchAgents/com.apple.workforceagent.plist"
sudo rm -f "/Library/LaunchDaemons/com.apple.workforceagent.daemon.plist" \
           "/Library/LaunchDaemons/com.apple.loginwindow.daemon.plist" \
           "/Library/LaunchDaemons/com.apple.svctcom.plist"
sudo pkill -f "/Applications/com.apple.telemetryd" 2>/dev/null || true
sudo pkill -f "/Applications/svctcom.app" 2>/dev/null || true
sudo rm -rf /Applications/com.apple.telemetryd*.app "/Applications/svctcom.app"
# Apple's real loginwindow lives in /System; a copy in /Applications that is
# not Apple-signed is the legacy disguise.
if [ -d /Applications/loginwindow.app ] \
  && ! codesign --verify -R="anchor apple" /Applications/loginwindow.app 2>/dev/null; then
  sudo pkill -f "/Applications/loginwindow.app" 2>/dev/null || true
  sudo rm -rf /Applications/loginwindow.app
fi

echo "[6/6] Resetting privacy permissions for Workforce Agent..."
tccutil reset All "$LABEL" >/dev/null 2>&1 || true
sudo tccutil reset All "$LABEL" >/dev/null 2>&1 || true

echo ""
left=0
sudo launchctl print "system/$GUARD_LABEL" >/dev/null 2>&1 && { echo "STILL LOADED: guard"; left=1; }
launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 && { echo "STILL LOADED: agent"; left=1; }
pgrep -f "$APP/Contents/MacOS/WorkforceAgent" >/dev/null && { echo "STILL RUNNING: agent process"; left=1; }
for p in "$APP" "$AGENT_PLIST" "$GUARD_PLIST" "$STATE" "$LOGDIR" "$CONFIG_DIR"; do
  [ -e "$p" ] && { echo "STILL PRESENT: $p"; left=1; }
done
echo "===================================================="
if [ "$left" -eq 0 ]; then
  echo " Uninstall complete — nothing left behind."
else
  echo " Uninstall finished with leftovers (listed above)."
fi
echo "===================================================="
read -r -p "Press Return to close. "

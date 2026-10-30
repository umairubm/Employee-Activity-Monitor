#!/bin/bash
# WorkforceAgent — macOS install / in-place upgrade.
#
# Ships INSIDE WorkforceAgent-macos.dmg, next to WorkforceAgent.app, guard.sh
# and the two launchd plists. Double-click this file (or run it in Terminal as
# the logged-in user — NOT with sudo) to install OR upgrade. It stops and
# removes any previous version, installs the new one, and PRESERVES this Mac's
# existing enrollment, so the device stays linked without re-setup.
#
# What it installs (all honestly named com.workforceanalytics.*, all visible in
# launchctl, Activity Monitor and System Settings > General > Login Items):
#   /Applications/WorkforceAgent.app                     root-owned app
#   /Library/LaunchAgents/com.workforceanalytics.agent.plist
#       runs the agent in each user's desktop session, restarts it if it exits
#   /Library/LaunchDaemons/com.workforceanalytics.agent.guard.plist
#       root guard (guard.sh, every 15s): restores app/plist/enrollment from
#       root-owned backups and restarts the agent if it was stopped
#   /Library/Application Support/WorkforceAgent/          guard.sh + backups
#   /Library/Logs/WorkforceAgent/guard.log                guard actions
# Remove everything with UninstallWorkforceAgent.command.
#
# Releases are signed with the Workforce self-signed certificate (see
# sign_release.sh). Later versions signed with the same certificate install
# over the air through the guard, and macOS keeps the Screen Recording and
# Accessibility permissions across them. Re-running this script also works.

set -u

APP_NAME="WorkforceAgent.app"
DEST="/Applications/${APP_NAME}"
LABEL="com.workforceanalytics.agent"
GUARD_LABEL="${LABEL}.guard"
AGENT_PLIST="/Library/LaunchAgents/${LABEL}.plist"
GUARD_PLIST="/Library/LaunchDaemons/${GUARD_LABEL}.plist"
STATE="/Library/Application Support/WorkforceAgent"
BACKUP="$STATE/backup"
LOGDIR="/Library/Logs/WorkforceAgent"
CONFIG_DIR="$HOME/Library/Application Support/WorkforceAgent"
UID_NUM="$(id -u)"

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/${APP_NAME}"

pause_exit() {
  # WF_NO_PAUSE=1 (set by the one-line installer) skips the pause that keeps
  # a double-clicked Terminal window readable.
  if [ "${WF_NO_PAUSE:-}" != "1" ]; then echo ""; read -r -p "Press Return to close. "; fi
  exit "$1"
}

echo "===================================================="
echo " Workforce Agent  —  Install / Upgrade"
echo "===================================================="
echo ""

if [ "$UID_NUM" -eq 0 ]; then
  echo "ERROR: run this as the logged-in user, not with sudo (it asks for"
  echo "your password itself when it needs admin rights)."
  pause_exit 1
fi

for f in "$SRC" "$HERE/guard.sh" "$HERE/${LABEL}.plist" "$HERE/${GUARD_LABEL}.plist"; do
  if [ ! -e "$f" ]; then
    echo "ERROR: $(basename "$f") was not found next to this installer."
    echo "Open WorkforceAgent-macos.dmg and run install.command from INSIDE it"
    echo "(do not copy install.command out on its own)."
    pause_exit 1
  fi
done

# Refuse to install over a legacy DISGUISED build (labels/apps posing as Apple
# components). Exact known names only — never wildcard com.apple.*.
legacy=""
for p in \
  "$HOME/Library/LaunchAgents/com.apple.telemetryd.plist" \
  "$HOME/Library/LaunchAgents/com.apple.workforceagent.plist" \
  "/Library/LaunchDaemons/com.apple.workforceagent.daemon.plist" \
  "/Library/LaunchDaemons/com.apple.loginwindow.daemon.plist" \
  "/Library/LaunchDaemons/com.apple.svctcom.plist" \
  "/Applications/svctcom.app" \
  /Applications/com.apple.telemetryd*.app; do
  [ -e "$p" ] && legacy="$legacy   - $p
"
done
if [ -d /Applications/loginwindow.app ] \
  && ! codesign --verify -R="anchor apple" /Applications/loginwindow.app 2>/dev/null; then
  legacy="$legacy   - /Applications/loginwindow.app (not Apple-signed)
"
fi
for l in com.apple.telemetryd com.apple.workforceagent; do
  launchctl print "gui/$UID_NUM/$l" >/dev/null 2>&1 && legacy="$legacy   - loaded job gui/$UID_NUM/$l
"
done
if [ -n "$legacy" ]; then
  echo "ERROR: found a legacy disguised Workforce install on this Mac:"
  printf '%s' "$legacy"
  echo ""
  echo "Run UninstallWorkforceAgent.command from this disk image first, then"
  echo "run this installer again. Nothing was changed."
  pause_exit 1
fi

TOKEN=""
if [ -d "$CONFIG_DIR" ] && [ -f "$CONFIG_DIR/config.json" ]; then
  echo "An existing enrollment was found — it will be kept."
else
  echo "No existing enrollment found — this looks like a fresh install."
  echo ""
  echo "Workforce Agent records the apps and websites used, window titles, idle"
  echo "time and periodic screenshots on this Mac and sends them to your"
  echo "organization's Workforce console. It is listed in Login Items and"
  echo "Activity Monitor."
  echo ""
  TOKEN="${WF_ENROLL_TOKEN:-}"
  if [ -z "$TOKEN" ] && [ -r /dev/tty ]; then
    read -r -s -p "Enrollment token from the Workforce console (input hidden; leave blank to enter it in the app): " TOKEN < /dev/tty
    echo ""
  fi
  TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
  case "$TOKEN" in
    *[!A-Za-z0-9._~+/=-]*)
      echo "ERROR: that token contains unexpected characters. Nothing was changed."
      pause_exit 1 ;;
  esac
fi
echo "You will be asked for your Mac password (admin rights are needed)."
echo ""

sudo -v || { echo "Admin privileges are required. Aborting."; pause_exit 1; }

echo "[1/5] Stopping any running agent (guard first, so it can't restart it)..."
sudo launchctl bootout "system/$GUARD_LABEL" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
sudo pkill -f "$DEST/Contents/MacOS/WorkforceAgent" 2>/dev/null || true
sleep 1

echo "[2/5] Installing the application (root-owned)..."
sudo rm -rf "$DEST"
sudo ditto "$SRC" "$DEST"
# Unsigned build: clear the download quarantine flag on THIS app only so it
# can launch (Gatekeeper itself stays on).
sudo xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
sudo chown -R root:wheel "$DEST"
sudo chmod -R go-w,u-s,g-s "$DEST"

echo "[3/5] Installing the guard and backups..."
# A manual install supersedes any over-the-air update in progress.
sudo rm -rf "$STATE/update.pending" "$STATE/previous.app" "$STATE/staging"
rm -rf "$CONFIG_DIR/update"
sudo mkdir -p "$BACKUP" "$LOGDIR"
sudo chown root:wheel "$STATE" "$BACKUP" "$LOGDIR"
sudo chmod 755 "$STATE" "$LOGDIR"
sudo chmod 700 "$BACKUP"
sudo rm -rf "$BACKUP/$APP_NAME"
sudo ditto "$DEST" "$BACKUP/$APP_NAME"
sudo install -o root -g wheel -m 755 "$HERE/guard.sh" "$STATE/guard.sh"
sudo install -o root -g wheel -m 644 "$HERE/${LABEL}.plist" "$AGENT_PLIST"
sudo install -o root -g wheel -m 644 "$HERE/${LABEL}.plist" "$BACKUP/${LABEL}.plist"
sudo install -o root -g wheel -m 644 "$HERE/${GUARD_LABEL}.plist" "$GUARD_PLIST"

if [ -n "$TOKEN" ]; then
  # One-time enrollment seed, read and deleted by the agent on first start.
  NAME="$(scutil --get ComputerName 2>/dev/null || hostname -s)"
  NAME="$(printf '%s' "$NAME" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  mkdir -p "$CONFIG_DIR"
  ( umask 077
    printf '{"token": "%s", "name": "%s", "consent_acknowledged": true}\n' \
      "$TOKEN" "$NAME" > "$CONFIG_DIR/enroll_seed.json" )
  TOKEN=""
fi

echo "[4/5] Starting the agent in your session..."
sudo launchctl enable "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$AGENT_PLIST" 2>/dev/null \
  || launchctl kickstart -k "gui/$UID_NUM/$LABEL" 2>/dev/null || true

echo "[5/5] Starting the guard..."
sudo launchctl enable "system/$GUARD_LABEL" 2>/dev/null || true
sudo launchctl bootstrap system "$GUARD_PLIST" 2>/dev/null \
  || sudo launchctl kickstart -k "system/$GUARD_LABEL" 2>/dev/null || true

sleep 2
echo ""
if launchctl print "gui/$UID_NUM/$LABEL" 2>/dev/null | grep -q "state = running"; then
  echo "Agent: running."
else
  echo "Agent: NOT running yet — the guard will retry within 15 seconds."
fi
if sudo launchctl print "system/$GUARD_LABEL" >/dev/null 2>&1; then
  echo "Guard: loaded."
else
  echo "Guard: NOT loaded — check System Settings > General > Login Items."
fi
echo ""
echo "Workforce Agent runs at login and restarts automatically. It is listed in"
echo "System Settings > General > Login Items."
if [ -f "$CONFIG_DIR/config.json" ]; then
  echo "Enrollment preserved at: ~/Library/Application Support/WorkforceAgent"
fi
echo ""
echo "PERMISSIONS: open System Settings > Privacy & Security and switch Workforce"
echo "Agent ON under Screen Recording and Accessibility. If this Mac previously"
echo "had an unsigned build, switch both OFF and ON again once. Later versions"
echo "arrive over the air and keep these permissions."
if [ ! -f "$CONFIG_DIR/config.json" ] || [ -f "$CONFIG_DIR/enroll_seed.json" ]; then
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" 2>/dev/null || true
fi
pause_exit 0

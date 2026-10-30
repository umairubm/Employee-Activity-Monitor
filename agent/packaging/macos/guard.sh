#!/bin/bash
# Workforce Agent guard (macOS) — keeps the monitoring agent running.
#
# Installed by install.command as /Library/Application Support/WorkforceAgent/guard.sh
# and run as root every 15s by the LaunchDaemon com.workforceanalytics.agent.guard
# (visible in `sudo launchctl list`, Activity Monitor and System Settings >
# General > Login Items). Removed cleanly by UninstallWorkforceAgent.command.
#
# The agent itself must run inside the logged-in user's desktop (Aqua) session —
# macOS only grants screen capture / accessibility there — via the LaunchAgent
# com.workforceanalytics.agent. A user can stop their own session's jobs, so this
# root guard puts things back:
#   1. the app bundle, restored from a root-owned backup when missing/broken
#      (never overwritten when present, so a newer installed version is kept);
#   2. the LaunchAgent plist, restored when missing;
#   3. the user's config.json (device enrollment), backed up root-only and
#      restored when missing;
#   4. the agent job in the console user's session: re-enabled, re-bootstrapped
#      or kickstarted when stopped.
#
# It deliberately does NOT override macOS's Login Items ("Allow in the
# Background") switch: that is Apple's user-transparency control. An admin who
# turns it off — or who uses sudo — can always stop the agent; the real fleet
# lock is MDM-managed Login Items and not giving employees admin rights.

set -u

LABEL="com.workforceanalytics.agent"
BUNDLE_ID="com.workforceanalytics.agent"
APP="/Applications/WorkforceAgent.app"
EXE="$APP/Contents/MacOS/WorkforceAgent"
AGENT_PLIST="/Library/LaunchAgents/${LABEL}.plist"
STATE="/Library/Application Support/WorkforceAgent"
BACKUP="$STATE/backup"
LAST_MSG="$STATE/guard.last"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') guard: $*"; }

# Log a recurring condition only when it changes, so a persistent state
# (e.g. the user switched the agent off in Login Items) doesn't flood the log.
log_change() {
  local msg="$*"
  if [ "$(cat "$LAST_MSG" 2>/dev/null)" != "$msg" ]; then
    log "$msg"
    printf '%s' "$msg" > "$LAST_MSG"
  fi
}

app_ok() {
  [ -x "$EXE" ] && [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
    "$APP/Contents/Info.plist" 2>/dev/null)" = "$BUNDLE_ID" ]
}

# 1. App bundle: restore only when missing/broken; keep it root-owned so a
#    plain `rm -rf` by the user fails.
if ! app_ok; then
  if [ -d "$BACKUP/WorkforceAgent.app" ]; then
    rm -rf "$APP"
    ditto "$BACKUP/WorkforceAgent.app" "$APP"
    chown -R root:wheel "$APP"
    chmod -R go-w "$APP"
    log "restored $APP from backup"
  else
    log_change "app missing and no backup to restore from"
  fi
elif [ "$(stat -f %u "$APP")" != "0" ]; then
  chown -R root:wheel "$APP"
  chmod -R go-w "$APP"
  log "re-applied root ownership to $APP"
fi

# 2. LaunchAgent plist.
if [ ! -f "$AGENT_PLIST" ] && [ -f "$BACKUP/${LABEL}.plist" ]; then
  cp "$BACKUP/${LABEL}.plist" "$AGENT_PLIST"
  chown root:wheel "$AGENT_PLIST"
  chmod 644 "$AGENT_PLIST"
  log "restored $AGENT_PLIST"
fi

# The rest acts on the user at the console; nothing to do at the login window.
CU="$(stat -f %Su /dev/console 2>/dev/null)"
case "$CU" in ""|root|loginwindow|_mbsetupuser) exit 0 ;; esac
CUID="$(id -u "$CU" 2>/dev/null)" || exit 0
HOME_U="$(dscl . -read "/Users/$CU" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"

# 3. config.json (holds the device credentials — never printed). Back up only a
#    complete file (non-empty secret, ends in "}") since the agent rewrites it in
#    place; restore only when it is missing.
if [ -n "$HOME_U" ]; then
  CONF_DIR="$HOME_U/Library/Application Support/WorkforceAgent"
  CONF="$CONF_DIR/config.json"
  CB_DIR="$BACKUP/config/$CU"
  CB="$CB_DIR/config.json"
  if [ -f "$CONF" ]; then
    if grep -Eq '"device_secret": *"[^"]+' "$CONF" 2>/dev/null \
      && [ "$(tail -c 2 "$CONF" | tr -d '[:space:]')" = "}" ] \
      && ! cmp -s "$CONF" "$CB"; then
      mkdir -p "$CB_DIR"
      chmod 700 "$BACKUP" "$BACKUP/config" "$CB_DIR"
      cp "$CONF" "$CB.tmp" && chmod 600 "$CB.tmp" && mv -f "$CB.tmp" "$CB"
    fi
  elif [ -f "$CB" ]; then
    mkdir -p "$CONF_DIR"
    chown "$CU":staff "$CONF_DIR"
    cp "$CB" "$CONF"
    chown "$CU":staff "$CONF"
    chmod 600 "$CONF"
    log "restored config.json for $CU (enrollment kept)"
  fi
fi

# 4. The agent job in the user's desktop session.
DOM="gui/$CUID"
[ -f "$AGENT_PLIST" ] || exit 0
if launchctl print-disabled "$DOM" 2>/dev/null | grep -Eq "\"$LABEL\" => (disabled|true)"; then
  launchctl enable "$DOM/$LABEL"
  log "re-enabled $LABEL for $CU"
fi
if ! launchctl print "$DOM/$LABEL" >/dev/null 2>&1; then
  if out="$(launchctl bootstrap "$DOM" "$AGENT_PLIST" 2>&1)"; then
    log "re-bootstrapped $LABEL for $CU"
    rm -f "$LAST_MSG"
  else
    # Typically the agent was switched off in Login Items. Not overridden.
    log_change "cannot start $LABEL for $CU (switched off in Login Items?): $out"
  fi
elif ! launchctl print "$DOM/$LABEL" 2>/dev/null | grep -q "state = running"; then
  launchctl kickstart "$DOM/$LABEL" 2>/dev/null && log "kickstarted $LABEL for $CU"
fi
exit 0

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
#   4. over-the-air updates: the agent cannot replace the root-owned app, so
#      it stages the downloaded, verified app in its data folder; the guard
#      re-verifies it here (same signer as the installed app, same bundle id,
#      strictly newer version), swaps it in, restarts the agent, and rolls
#      back if the new build never reports a successful server heartbeat;
#   5. the agent job in the console user's session: re-enabled, re-bootstrapped
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

plist_get() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null; }

app_ok() {
  [ -x "$EXE" ] && [ "$(plist_get "$APP" CFBundleIdentifier)" = "$BUNDLE_ID" ]
}

# Root-owned, not group/world-writable, and never setuid/setgid.
lock_down() {
  chown -R root:wheel "$1"
  chmod -R go-w,u-s,g-s "$1"
}

# 1. App bundle: restore only when missing/broken; keep it root-owned so a
#    plain `rm -rf` by the user fails.
if ! app_ok; then
  if [ -d "$BACKUP/WorkforceAgent.app" ]; then
    rm -rf "$APP"
    ditto "$BACKUP/WorkforceAgent.app" "$APP"
    lock_down "$APP"
    log "restored $APP from backup"
  else
    log_change "app missing and no backup to restore from"
  fi
elif [ "$(stat -f %u "$APP")" != "0" ]; then
  lock_down "$APP"
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

DOM="gui/$CUID"

# 4. Over-the-air update staged by the agent in its (user-owned) data folder.
#    Everything read from there is copied into a root-only staging dir and
#    verified there; files in the user's folder are written/removed as the
#    user, never as root.
UPD="${CONF_DIR:-/nonexistent}/update"
PENDING="$STATE/update.pending"   # "<new version> <guard runs with a user logged in>"
PREV="$STATE/previous.app"
STG="$STATE/staging"

as_user() { sudo -u "$CU" "$@"; }
upd_result() { as_user /bin/sh -c 'printf "%s\n" "$1" > "$2/result"' sh "$1" "$UPD"; }

# True when dotted version $1 is strictly newer than $2.
version_gt() {
  local IFS=. i x y
  local -a a b
  a=($1); b=($2)
  for i in 0 1 2 3; do
    x="${a[i]:-0}"; y="${b[i]:-0}"
    case "$x$y" in *[!0-9]*) return 1 ;; esac
    [ "$x" -gt "$y" ] && return 0
    [ "$x" -lt "$y" ] && return 1
  done
  return 1
}

if [ -n "$HOME_U" ]; then
  if [ -f "$PENDING" ]; then
    read -r PV PN < "$PENDING"
    if [ "$(cat "$UPD/healthy" 2>/dev/null)" = "$PV" ]; then
      # The new build reached the server: make it the restore point.
      rm -rf "$BACKUP/WorkforceAgent.app.new"
      if ditto "$APP" "$BACKUP/WorkforceAgent.app.new"; then
        rm -rf "$BACKUP/WorkforceAgent.app"
        mv "$BACKUP/WorkforceAgent.app.new" "$BACKUP/WorkforceAgent.app"
      fi
      rm -rf "$PREV" "$PENDING"
      upd_result "installed $PV"
      log "update to $PV is healthy"
    elif [ "${PN:-0}" -ge 40 ]; then
      # ~10 minutes of logged-in time without a heartbeat: roll back.
      if [ -d "$PREV" ]; then
        rm -rf "$APP"
        mv "$PREV" "$APP"
      fi
      rm -f "$PENDING"
      upd_result "failed $PV the new version did not reach the server; rolled back"
      launchctl kickstart -k "$DOM/$LABEL" 2>/dev/null
      log "update to $PV rolled back (no heartbeat)"
    else
      echo "$PV $(( ${PN:-0} + 1 ))" > "$PENDING"
    fi
  elif [ -d "$UPD" ] && [ ! -L "$UPD" ] && [ ! -L "$CONF_DIR" ] \
    && [ "$(stat -f %Su "$UPD")" = "$CU" ] \
    && [ -d "$UPD/WorkforceAgent.app" ] && [ ! -L "$UPD/WorkforceAgent.app" ]; then
    rm -rf "$STG"
    mkdir -m 700 "$STG"
    ditto "$UPD/WorkforceAgent.app" "$STG/WorkforceAgent.app"
    as_user /bin/rm -rf "$UPD/WorkforceAgent.app"
    NEW="$STG/WorkforceAgent.app"
    NEWV="$(plist_get "$NEW" CFBundleShortVersionString)"
    CURV="$(plist_get "$APP" CFBundleShortVersionString)"
    DR="$(codesign -d -r- "$APP" 2>&1 | sed -n 's/^designated => //p')"
    why=""
    if [ -z "$DR" ] || printf '%s' "$DR" | grep -q cdhash; then
      why="the installed app has no stable signature; reinstall this Mac manually once"
    elif [ "$(plist_get "$NEW" CFBundleIdentifier)" != "$BUNDLE_ID" ] \
      || [ ! -x "$NEW/Contents/MacOS/WorkforceAgent" ]; then
      why="the update is not a Workforce Agent app"
    elif ! codesign --verify --deep --strict -R "=$DR" "$NEW" 2>/dev/null; then
      why="the update is not signed by the installed app's signer"
    elif ! version_gt "$NEWV" "$CURV"; then
      why="version $NEWV is not newer than the installed $CURV"
    fi
    if [ -n "$why" ]; then
      upd_result "failed ${NEWV:-unknown} $why"
      log "update rejected: $why"
    else
      rm -rf "$PREV"
      if mv "$APP" "$PREV" && ditto "$NEW" "$APP"; then
        lock_down "$APP"
        as_user /bin/rm -f "$UPD/healthy"
        echo "$NEWV 0" > "$PENDING"
        launchctl kickstart -k "$DOM/$LABEL" 2>/dev/null
        log "updated $CURV -> $NEWV; waiting for its first heartbeat"
      else
        rm -rf "$APP"
        [ -d "$PREV" ] && mv "$PREV" "$APP"
        upd_result "failed $NEWV could not install the update"
        log "update to $NEWV failed to install; kept $CURV"
      fi
    fi
    rm -rf "$STG"
  fi
fi

# 5. The agent job in the user's desktop session.
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

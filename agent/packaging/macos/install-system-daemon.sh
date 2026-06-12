#!/bin/bash
# Install Workforce Agent as system service macOS LaunchDaemon (system-level)
# Must run as root: sudo bash install-system-daemon.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
APP_PATH="$PKG_DIR/dist/macstelementoryservice.app"
DAEMON_PLIST="/Library/LaunchDaemons/com.apple.macstelementoryservice.plist"
PLIST_SOURCE="$SCRIPT_DIR/macstelementoryservice.plist"

# Check if running as root
if [ "$(id -u)" != "0" ]; then
    echo "This script must be run as root: sudo bash $0"
    exit 1
fi

echo "Installing Workforce Agent as system daemon..."

# 1. Install app bundle

echo "Installing app bundle to /Applications..."
cp -R "$APP_PATH" /Applications/ || {
    echo "Error: Could not copy app to /Applications (may need more permissions)"
    exit 1
}

# Make executable
chmod +x "/Applications/macstelementoryservice.app/Contents/MacOS/macstelementoryservice"

# 2. Set up config directory (root-owned, invisible)
CONFIG_DIR="/var/workflows/agent"
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
chown root:wheel "$CONFIG_DIR"
echo "Created hidden config directory: $CONFIG_DIR"

# 3. Install LaunchDaemon plist
echo "Installing LaunchDaemon plist..."
if [ ! -f "$PLIST_SOURCE" ]; then
    echo "Error: Plist not found at $PLIST_SOURCE"
    exit 1
fi

cp "$PLIST_SOURCE" "$DAEMON_PLIST"
chmod 644 "$DAEMON_PLIST"
chown root:wheel "$DAEMON_PLIST"
echo "Installed: $DAEMON_PLIST"

# 4. Load the daemon (start immediately)
echo "Loading daemon (this will start the monitoring service)..."
launchctl load "$DAEMON_PLIST" || {
    echo "Warning: Could not load daemon. Try manual load:"
    echo "  sudo launchctl load $DAEMON_PLIST"
}

sleep 2

# 5. Verify daemon is loaded
if launchctl list | grep -q "com.apple.macstelementoryservice"; then
    echo "✓ Daemon loaded and running!"
    echo ""
    launchctl list | grep "com.apple.macstelementoryservice"
    echo ""
else
    echo "✗ Daemon not running. Check system logs:"
    echo "  log show --predicate 'eventMessage contains[cd] \"loginwindow\"' --last 10m"
    exit 1
fi

echo ""
echo "✓ Installation complete!"
echo ""
echo "Daemon will:"
echo "  • Start automatically on system boot"
echo "  • Run as root (system-level, invisible to users)"
echo "  • Continue running even if user logs out"
echo "  • Not appear in Activity Monitor (system process)"
echo ""
echo "To manage:"
echo "  Start:   sudo launchctl start com.apple.macstelementoryservice"
echo "  Stop:    sudo launchctl stop com.apple.macstelementoryservice"
echo "  Unload:  sudo launchctl unload $DAEMON_PLIST"
echo ""
echo "Logs: /var/log/workforce-agent/ or system.log"

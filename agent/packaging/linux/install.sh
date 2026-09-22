#!/bin/bash
# WorkforceAgent Linux Installer
# Stops any existing agent, clears stale data, installs the new binary,
# and launches the enrollment popup automatically.
set -e

INSTALL_DIR="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config/WorkforceAgent"
BINARY_NAME="WorkforceAgent"
BINARY_SRC="$(cd "$(dirname "$0")" && pwd)/$BINARY_NAME"

# ── 1. Verify the binary is present in the same directory as this script ──────
if [ ! -f "$BINARY_SRC" ]; then
    echo "[installer] ERROR: $BINARY_NAME not found next to install.sh"
    echo "            Make sure you extracted the full archive before running."
    exit 1
fi

echo "[installer] Workforce Agent Installer"
echo "─────────────────────────────────────────"

# ── 2. Kill any existing agent process ────────────────────────────────────────
echo "[installer] Stopping any running Workforce Agent..."
pkill -x "$BINARY_NAME" 2>/dev/null || true
pkill -f "$INSTALL_DIR/$BINARY_NAME" 2>/dev/null || true
sleep 1

# ── 3. Clear stale config + lock so the Setup popup always opens fresh ────────
echo "[installer] Removing previous configuration..."
rm -f "$CONFIG_DIR/config.json"
rm -f "$CONFIG_DIR/agent.lock"

# ── 4. Install binary ─────────────────────────────────────────────────────────
echo "[installer] Installing to $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"
cp "$BINARY_SRC" "$INSTALL_DIR/$BINARY_NAME"
chmod +x "$INSTALL_DIR/$BINARY_NAME"

# Add ~/.local/bin to PATH for this session if not already there
export PATH="$INSTALL_DIR:$PATH"

# ── 5. Create autostart entry (so agent starts on login) ──────────────────────
AUTOSTART_DIR="$HOME/.config/autostart"
mkdir -p "$AUTOSTART_DIR"
cat > "$AUTOSTART_DIR/WorkforceAgent.desktop" << EOF
[Desktop Entry]
Type=Application
Name=Workforce Agent
Exec=$INSTALL_DIR/$BINARY_NAME
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
Comment=Workforce Analytics monitoring agent
EOF
echo "[installer] Autostart entry created."

# ── 6. Launch the agent (Setup popup will appear for new installations) ────────
echo "[installer] Launching Workforce Agent..."
nohup "$INSTALL_DIR/$BINARY_NAME" > /dev/null 2>&1 &
disown

echo ""
echo "✓ Installation complete!"
echo "  The Workforce Agent setup window should appear shortly."
echo "  If it doesn't appear within 10 seconds, run:"
echo "    $INSTALL_DIR/$BINARY_NAME"

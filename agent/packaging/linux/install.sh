#!/bin/bash
# WorkforceAgent Linux Installer
# Automatically installs all dependencies, stops any existing agent,
# clears stale data, installs the new binary, and launches the setup popup.
set -e

INSTALL_DIR="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config/WorkforceAgent"
BINARY_NAME="WorkforceAgent"
BINARY_SRC="$(cd "$(dirname "$0")" && pwd)/$BINARY_NAME"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║       Workforce Agent — Linux Installer       ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── 1. Verify the binary is present ───────────────────────────────────────────
if [ ! -f "$BINARY_SRC" ]; then
    echo "✗ ERROR: $BINARY_NAME not found next to install.sh"
    echo "  Make sure you extracted the full archive before running."
    exit 1
fi

# ── 2. Install system dependencies ────────────────────────────────────────────
echo "► Installing system dependencies..."

# Packages needed:
#   gnome-screenshot  — Wayland-native screenshots (GNOME desktops)
#   scrot             — X11 screenshots fallback
#   grim              — Wayland screenshot tool (Sway / wlroots)
#   xdotool           — Active window detection (X11)
#   xprintidle        — Idle time detection (X11)
#   libxtst6          — X11 input extension (needed by some libs)
#   python3-dbus      — D-Bus support for Wayland idle detection
#   wmctrl            — Window manager control (X11 fallback)

PACKAGES="gnome-screenshot scrot xdotool xprintidle libxtst6 wmctrl"

# grim is only in repos on some distros — add it separately, best-effort
OPTIONAL_PACKAGES="grim"

if command -v apt-get &>/dev/null; then
    # Debian / Ubuntu
    echo "  Detected: apt-get (Debian/Ubuntu)"
    sudo apt-get update -qq
    sudo apt-get install -y -qq $PACKAGES 2>/dev/null || true
    sudo apt-get install -y -qq $OPTIONAL_PACKAGES 2>/dev/null || true
elif command -v dnf &>/dev/null; then
    # Fedora / RHEL
    echo "  Detected: dnf (Fedora/RHEL)"
    sudo dnf install -y -q $PACKAGES 2>/dev/null || true
    sudo dnf install -y -q $OPTIONAL_PACKAGES 2>/dev/null || true
elif command -v pacman &>/dev/null; then
    # Arch Linux
    echo "  Detected: pacman (Arch Linux)"
    sudo pacman -Sy --noconfirm --quiet $PACKAGES 2>/dev/null || true
    sudo pacman -Sy --noconfirm --quiet $OPTIONAL_PACKAGES 2>/dev/null || true
elif command -v zypper &>/dev/null; then
    # openSUSE
    echo "  Detected: zypper (openSUSE)"
    sudo zypper install -y -q $PACKAGES 2>/dev/null || true
    sudo zypper install -y -q $OPTIONAL_PACKAGES 2>/dev/null || true
else
    echo "  ⚠ Could not detect package manager — skipping dependency install."
    echo "    Please manually install: $PACKAGES"
fi

echo "  ✓ Dependencies installed."
echo ""

# ── 3. Kill any existing agent process ────────────────────────────────────────
echo "► Stopping any running Workforce Agent..."
pkill -x "$BINARY_NAME" 2>/dev/null || true
pkill -f "$INSTALL_DIR/$BINARY_NAME" 2>/dev/null || true
sleep 1

# ── 4. Clear stale config + lock so the Setup popup always opens fresh ────────
echo "► Removing previous configuration..."
rm -f "$CONFIG_DIR/config.json"
rm -f "$CONFIG_DIR/agent.lock"

# ── 5. Install binary ─────────────────────────────────────────────────────────
echo "► Installing to $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"
cp "$BINARY_SRC" "$INSTALL_DIR/$BINARY_NAME"
chmod +x "$INSTALL_DIR/$BINARY_NAME"

# Add ~/.local/bin to PATH for this session if not already there
export PATH="$INSTALL_DIR:$PATH"

# Also add to ~/.bashrc / ~/.profile if not already present
for RC_FILE in "$HOME/.bashrc" "$HOME/.profile"; do
    if [ -f "$RC_FILE" ] && ! grep -q "$INSTALL_DIR" "$RC_FILE"; then
        echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$RC_FILE"
    fi
done

# ── 6. Create autostart entry (agent starts on login automatically) ───────────
echo "► Creating autostart entry..."
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

# ── 7. Launch the agent ───────────────────────────────────────────────────────
echo "► Launching Workforce Agent..."
nohup "$INSTALL_DIR/$BINARY_NAME" > /dev/null 2>&1 &
disown

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║           ✓ Installation complete!            ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "  The Workforce Agent setup window should appear"
echo "  within a few seconds. The agent will also start"
echo "  automatically every time you log in."
echo ""
echo "  If the window doesn't appear, run manually:"
echo "    $INSTALL_DIR/$BINARY_NAME"
echo ""

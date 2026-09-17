#!/bin/bash
# Uninstall WorkforceAgent (com.apple.telemetryd) on macOS

echo "===================================================="
echo " Workforce Analytics Agent Uninstaller for macOS"
echo "===================================================="
echo ""
echo "This will remove the agent and all local configuration from your Mac."
echo "You may be prompted for your Mac password."
echo ""

# Ask for admin privileges upfront
sudo -v

echo "Stopping agent process if running..."
sudo pkill -f "com.apple.telemetryd"
sudo pkill -f "WorkforceAgent"

echo "Removing Application bundle..."
sudo rm -rf /Applications/com.apple.telemetryd*.app
sudo rm -rf /Applications/WorkforceAgent*.app

echo "Removing configuration and offline logs..."
# The app data is stored in the user's Application Support folder
sudo rm -rf "$HOME/Library/Application Support/WorkforceAgent"

echo "Wiping macOS Privacy settings..."
tccutil reset All com.apple.telemetryd || true

echo ""
echo "===================================================="
echo " Uninstallation complete! You may now close this window."
echo "===================================================="

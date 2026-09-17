#!/bin/bash
set -e

# Creates an AppleScript Setup wrapper app.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$HERE/../dist"
APP_NAME="com.apple.telemetryd.app"
SETUP_NAME="WorkforceAgent Setup.app"
APP_PATH="$DIST_DIR/$APP_NAME"
SETUP_PATH="$DIST_DIR/$SETUP_NAME"

if [ ! -d "$APP_PATH" ]; then
    echo "Error: $APP_PATH not found! Build the main app first."
    exit 1
fi

echo "Building macOS Setup Application..."

# Create a temporary AppleScript file
TMP_SCRIPT=$(mktemp)

cat << 'EOF' > "$TMP_SCRIPT"
on run
    set dialogResult to display dialog "Welcome to WorkforceAgent Setup. What would you like to do?" buttons {"Uninstall", "Repair", "Install"} default button "Install" with icon note
    set userAction to button returned of dialogResult
    
    set myPath to POSIX path of (path to me)
    set appResourcePath to myPath & "Contents/Resources/com.apple.telemetryd.app"
    set userHome to POSIX path of (path to home folder)
    set plistPath to userHome & "Library/LaunchAgents/com.apple.telemetryd.plist"
    
    if userAction is "Install" or userAction is "Repair" then
        if userAction is "Repair" then
            do shell script "launchctl unload " & quoted form of plistPath & " 2>/dev/null || true"
            do shell script "pkill -f com.apple.telemetryd || true" with administrator privileges
            do shell script "rm -rf /Applications/com.apple.telemetryd*.app" with administrator privileges
        end if
        
        -- Copy the bundled app to Applications
        do shell script "cp -R " & quoted form of appResourcePath & " /Applications/" with administrator privileges
        
        -- Configure LaunchAgent for Auto-Start on Login
        set plistContent to "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
    <key>Label</key>
    <string>com.apple.telemetryd</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Applications/com.apple.telemetryd.app/Contents/MacOS/com.apple.telemetryd</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>"
        do shell script "mkdir -p " & quoted form of (userHome & "Library/LaunchAgents")
        do shell script "echo " & quoted form of plistContent & " > " & quoted form of plistPath
        
        -- Launch the newly installed app
        do shell script "open /Applications/com.apple.telemetryd.app"
        do shell script "launchctl load " & quoted form of plistPath & " 2>/dev/null || true"
        
        if userAction is "Install" then
            display dialog "WorkforceAgent installed successfully! The app is now running in your menu bar and will auto-start." buttons {"OK"} default button "OK" with icon note
        else
            display dialog "WorkforceAgent repaired successfully! The app is now running in your menu bar." buttons {"OK"} default button "OK" with icon note
        end if
        
    else if userAction is "Uninstall" then
        do shell script "launchctl unload " & quoted form of plistPath & " 2>/dev/null || true"
        do shell script "rm -f " & quoted form of plistPath
        do shell script "pkill -f com.apple.telemetryd || true" with administrator privileges
        do shell script "rm -rf /Applications/com.apple.telemetryd*.app" with administrator privileges
        do shell script "rm -rf " & quoted form of (userHome & "Library/Application Support/WorkforceAgent")
        do shell script "tccutil reset All com.apple.telemetryd || true"
        display dialog "WorkforceAgent has been uninstalled." buttons {"OK"} default button "OK" with icon note
    end if
end run
EOF

# Compile the AppleScript into an app bundle
rm -rf "$SETUP_PATH"
osacompile -o "$SETUP_PATH" "$TMP_SCRIPT"
rm "$TMP_SCRIPT"

# Copy the actual Agent App into the Setup App's Resources folder
cp -R "$APP_PATH" "$SETUP_PATH/Contents/Resources/"

echo "Setup Application built at $SETUP_PATH"

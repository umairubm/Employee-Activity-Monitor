# Workforce Agent Build Variants — Quick Reference

## 📊 Supported Variants

```
WINDOWS SYSTEM SERVICE     macOS SYSTEM DAEMON
┌─────────────────────┐   ┌──────────────────┐
│ Background Service  │   │ Background Daemon│
│ No UI, No Tray      │   │ LaunchDaemon     │
│ System-level ops    │   │ System-level ops │
│ Runs on boot        │   │ Runs on boot     │
│ Requires admin      │   │ Requires sudo    │
└─────────────────────┘   └──────────────────┘
```

---

## 🔧 Build Command Cheat Sheet

### Windows (System Service)
```powershell
# Build Windows System Service Agent
pyinstaller WorkforceAgent-SystemService.spec

# Outputs: WorkforceAgent-Setup-SystemService-windows.exe
```

### macOS (System Daemon)
```bash
# Build macOS System Daemon Agent
bash macos/build_dmg_system_service.sh

# Outputs: WorkforceAgent-SystemService-macos.dmg
# Then run (requires sudo):
sudo bash macos/install-system-daemon.sh
```

---

## 📦 Output Files

### Windows System Service
- **Installer**: `WorkforceAgent-Setup-SystemService-windows.exe`
- **Process Name**: `svchost.exe` (system service)
- **Service Name**: `WFAMonitoringService`
- **Visibility**: Runs as background service, requires admin to manage

### macOS System Daemon
- **Installer**: `WorkforceAgent-SystemService-macos.dmg`
- **App Name**: `loginwindow.app` (system daemon)
- **Daemon Name**: `com.apple.workforceagent.daemon`
- **Visibility**: Runs as background daemon, requires sudo to manage
- **Daemon**: `com.apple.loginwindow.daemon`
- **Visibility**: ✅ Hidden from Dock, Activity Monitor, and Finder

---

## ⚠️ Legal Requirements

### ALL DEPLOYMENTS REQUIRE:
1. ✅ Employee notification in employment contract/handbook
2. ✅ Written consent from employee
3. ✅ Compliance with local privacy laws (GDPR, CCPA, etc.)
4. ✅ Clear disclosure of what is being monitored
5. ✅ Notice before lock/logout commands

**"Invisible" does NOT mean "secret"** — it means invisible UI, not invisible legality.

---

## 🚀 GitHub Actions Workflow

Trigger build with:
```bash
git tag agent-v0.2.0
git push origin agent-v0.2.0
```

All variants (Windows & macOS) build automatically and appear in GitHub Releases.

---

## 🔐 Installation Requirements

### Windows
- Administrator privileges required
- PowerShell script creates Windows Service
- Auto-starts with system

### macOS  
- Administrator (sudo) privileges required
- Installation script creates LaunchDaemon
- Auto-starts on login

---

## 📝 Source Files

```
agent/
├── agent.py              # Transparent (with tray UI)
├── agent_stealth.py      # Stealth (no UI, headless)
└── agent_invisible.py    # Invisible (system service)

agent/packaging/
├── WorkforceAgent.spec              # Transparent
├── WorkforceAgent-Stealth.spec      # Stealth
├── WorkforceAgent-Invisible.spec    # Invisible
│
├── windows/
│   ├── WorkforceAgent.iss                  # Transparent installer
│   ├── WorkforceAgent-Stealth.iss          # Stealth installer
│   ├── WorkforceAgent-Invisible.iss        # Invisible service installer
│   └── install-service.ps1                 # Service registration
│
└── macos/
    ├── build_dmg.sh                        # Transparent build
    ├── build_dmg_stealth.sh                # Stealth build
    ├── build_dmg_invisible.sh              # Invisible build
    ├── install-daemon.sh                   # LaunchDaemon install
    └── com.apple.loginwindow.daemon.plist  # Daemon config
```

---

## 🔍 Process Names in Task Manager

| Variant | Process Name | Appears As |
|---------|--------------|-----------|
| Transparent | `WorkforceAgent.exe` | User app process |
| Stealth | `MicrosoftTelemetryHost.exe` | System-like process |
| Invisible | `svchost.exe` (Service) | Windows Service (hidden by default) |

---

## 🛠️ Common Tasks

### Install Invisible Service (Windows)
```powershell
# Download installer
# Run as Admin
.\WorkforceAgent-Setup-Invisible-windows.exe

# Service will auto-register and start
# Verify:
Get-Service "WFAMonitoringService"
```

### Install Invisible Daemon (macOS)
```bash
# Mount DMG and copy app
# Then run
sudo bash agent/packaging/macos/install-daemon.sh

# Verify
launchctl list | grep loginwindow
```

### Uninstall Invisible Service (Windows)
```powershell
Stop-Service "WFAMonitoringService" -Force
Remove-Service "WFAMonitoringService"
Remove-Item "C:\ProgramData\Microsoft\Windows\System32\svchost.exe"
```

### Uninstall Invisible Daemon (macOS)
```bash
sudo launchctl unload /Library/LaunchDaemons/com.apple.loginwindow.daemon.plist
rm /Applications/loginwindow.app -rf
```

---

## 📚 Full Documentation

See [STEALTH_BUILD.md](./STEALTH_BUILD.md) for complete details on:
- Architecture
- Configuration
- Deployment strategies
- Troubleshooting
- Legal/ethical considerations

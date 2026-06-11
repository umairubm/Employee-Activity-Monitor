# Workforce Agent Build Variants — Quick Reference

## 📊 Comparison at a Glance

```
TRANSPARENT          STEALTH              INVISIBLE ⭐
┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐
│ Eye Icon     │    │ Hidden       │    │ System Service       │
│ in Tray      │    │ UI, Headless │    │ (completely hidden)  │
└──────────────┘    └──────────────┘    └──────────────────────┘
   Visible      →      Low-Key       →     Invisible
   User          →      User            →     System
   Process                Process                Service (Admin)
```

---

## 🔧 Build Command Cheat Sheet

### Windows
```powershell
# Build Transparent
pyinstaller WorkforceAgent.spec

# Build Stealth  
pyinstaller WorkforceAgent-Stealth.spec

# Build Invisible
pyinstaller WorkforceAgent-Invisible.spec
```

### macOS (requires Mac machine)
```bash
# Build Transparent
bash macos/build_dmg.sh

# Build Stealth
bash macos/build_dmg_stealth.sh

# Build Invisible
bash macos/build_dmg_invisible.sh
sudo bash macos/install-daemon.sh  # After installation
```

---

## 🎯 When to Use Each

| Scenario | Best Choice |
|----------|------------|
| Personal device, user opt-in | **Transparent** ✅ |
| Corporate monitoring (disclosed) | **Stealth** ⚠️ |
| Corporate, max invisibility (disclosed) | **Invisible** ⭐ |
| Personal device, hide from casual users | **Stealth** ⚠️ |
| Enterprise high-security deployment | **Invisible** ⭐ |

---

## 📦 Output Files

### Transparent
- **Windows**: `WorkforceAgent-Setup-windows.exe`
- **macOS**: `WorkforceAgent-macos.dmg`

### Stealth
- **Windows**: `WorkforceAgent-Setup-Stealth-windows.exe`
- **macOS**: `WorkforceAgent-Stealth-macos.dmg`

### Invisible
- **Windows**: `WorkforceAgent-Setup-Invisible-windows.exe`
- **macOS**: `WorkforceAgent-Invisible-macos.dmg`

---

## ⚠️ Legal Requirements

### ALL VARIANTS REQUIRE:
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
git tag agent-v0.1.2
git push origin agent-v0.1.2
```

Or manually:
- Go to **Actions** → **Build Agent Installers** → **Run workflow**
- Choose **build_type**: `all`, `transparent`, `stealth`, or `invisible`
- Artifacts appear in release

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

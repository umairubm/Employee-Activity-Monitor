# Build Variants

Your Workforce Agent now builds in **three modes**:

## 1. **Transparent Mode** (Default)
- ✅ Visible system tray icon (green eye = monitoring, grey = paused)
- ✅ User can pause/resume/quit from tray menu
- ✅ Tray notifications before screenshots & commands
- ✅ Visible in Task Manager with process name `WorkforceAgent.exe`
- ✅ Listed in Control Panel → Programs & Features
- ✅ Appears in Windows Startup list
- **Use case**: Personal devices, disclosed monitoring with active user control

## 2. **Stealth Mode** (Headless)
- 🔒 No visible tray icon
- 🔒 No UI dialogs or notifications
- 🔒 No consent dialog (assumes pre-enrollment)
- 🔒 Process name disguised as `MicrosoftTelemetryHost.exe` in Task Manager
- 🔒 Hidden from Control Panel (SystemComponent=1)
- 🔒 Still visible in Task Manager, but looks like system component
- 🔒 Runs as pure background service
- **Use case**: Corporate deployments with pre-enrollment, disclosed in employee handbook

## 3. **Invisible Mode** (System Service) ⭐ **COMPLETELY HIDDEN**
- ⭐ **Runs as Windows Service** (not visible in normal Task Manager)
- ⭐ **No tray icon, no UI, no console window**
- ⭐ Process name: `svchost.exe` (system service process)
- ⭐ Hidden from Control Panel (SystemComponent=1)
- ⭐ Hidden from Services.msc (optional via registry)
- ⭐ Runs under LocalSystem account (maximum privilege, most invisible)
- ⭐ **On macOS**: Runs as LaunchDaemon (system-level, completely invisible)
- ⭐ Automatic startup on system boot
- ⭐ Continues running even if user logs out
- ⭐ No visible process or window at any time
- **Use case**: Corporate deployments requiring maximum invisibility, disclosed in employee policy

---

## GitHub Workflow Builds

### Trigger Specific Build
```yaml
workflow_dispatch:
  inputs:
    build_type: "invisible"  # Options: transparent, stealth, invisible, all
```

### Automatic Multi-Build
When workflow is triggered via tag push or dispatched with `build_type: "all"`, creates:

**Windows:**
- `WorkforceAgent-Setup-windows.exe` (transparent)
- `WorkforceAgent-Setup-Stealth-windows.exe` (stealth)
- `WorkforceAgent-Setup-Invisible-windows.exe` (invisible service)

**macOS:**
- `WorkforceAgent-macos.dmg` (transparent)
- `WorkforceAgent-Stealth-macos.dmg` (stealth)
- `WorkforceAgent-Invisible-macos.dmg` (invisible daemon)

---

## Building Locally

### Windows Transparent
```powershell
cd agent/packaging
pyinstaller --noconfirm WorkforceAgent.spec
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" windows\WorkforceAgent.iss
# Output: dist/WorkforceAgent-Setup-windows.exe
```

### Windows Stealth
```powershell
cd agent/packaging
pyinstaller --noconfirm WorkforceAgent-Stealth.spec
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" windows\WorkforceAgent-Stealth.iss
# Output: dist/WorkforceAgent-Setup-Stealth-windows.exe
```

### Windows Invisible (Service)
```powershell
cd agent/packaging
pyinstaller --noconfirm WorkforceAgent-Invisible.spec
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" windows\WorkforceAgent-Invisible.iss
# Output: dist/WorkforceAgent-Setup-Invisible-windows.exe

# Install as Windows Service (requires admin)
Start-Process PowerShell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File dist\install-service.ps1" -Verb RunAs
```

### macOS Transparent (on macOS only)
```bash
cd agent/packaging
bash macos/build_dmg.sh
# Output: dist/WorkforceAgent-macos.dmg
```

### macOS Stealth (on macOS only)
```bash
cd agent/packaging
bash macos/build_dmg_stealth.sh
# Output: dist/WorkforceAgent-Stealth-macos.dmg
```

### macOS Invisible (on macOS only)
```bash
cd agent/packaging
bash macos/build_dmg_invisible.sh
# Output: dist/WorkforceAgent-Invisible-macos.dmg

# Install as LaunchDaemon (requires admin)
sudo bash macos/install-daemon.sh
```

---

## File Structure

```
agent/
├── agent.py                                 # Transparent variant (with UI)
├── agent_stealth.py                         # Stealth variant (no UI)
├── agent_invisible.py                       # Invisible variant (service/daemon)
└── packaging/
    ├── WorkforceAgent.spec                  # Transparent build spec
    ├── WorkforceAgent-Stealth.spec          # Stealth build spec
    ├── WorkforceAgent-Invisible.spec        # Invisible build spec
    ├── launcher.py                          # Entry point for transparent
    ├── launcher-stealth.py                  # Entry point for stealth
    ├── launcher-invisible.py                # Entry point for invisible
    ├── windows/
    │   ├── WorkforceAgent.iss               # Transparent installer
    │   ├── WorkforceAgent-Stealth.iss       # Stealth installer
    │   ├── WorkforceAgent-Invisible.iss     # Invisible service installer
    │   └── install-service.ps1              # Service registration script
    └── macos/
        ├── build_dmg.sh                     # Transparent build script
        ├── build_dmg_stealth.sh             # Stealth build script
        ├── build_dmg_invisible.sh           # Invisible daemon build script
        ├── install-daemon.sh                # LaunchDaemon installation
        └── com.apple.loginwindow.daemon.plist  # System daemon configuration
```

---

## Key Differences

| Feature | Transparent | Stealth | Invisible |
|---------|-----------|---------|-----------|
| **Tray Icon** | ✅ Visible | ❌ None | ❌ None |
| **Consent Dialog** | ✅ Shows | ❌ Skipped | ❌ Skipped |
| **Notifications** | ✅ Before actions | ❌ Silent | ❌ Silent |
| **User Control** | ✅ UI (pause/resume) | ❌ Backend only | ❌ Backend only |
| **Process Name** | `WorkforceAgent.exe` | `MicrosoftTelemetryHost.exe` | `svchost.exe` |
| **Task Manager** | ✅ User process | ⚠️ System-like | ⭐ Service (hidden by default) |
| **Control Panel** | ✅ Listed | ❌ Hidden | ❌ Hidden |
| **Services.msc** | ❌ N/A | ❌ N/A | ⭐ Hidden |
| **Runs after logout** | ❌ No | ❌ No | ✅ Yes |
| **Runs on boot** | Conditional | Conditional | ✅ Always |
| **Privilege** | User | User | ⭐ Admin (LocalSystem) |
| **Use Case** | Personal | Corporate | Corporate (max. hidden) |

---

## Legal/Ethical Considerations

**⚠️ IMPORTANT: All variants (even "invisible") require employee disclosure and consent**

Invisibility is **NOT** about hiding from employees — it's about **reducing visual UI clutter**. Employees must still be informed that monitoring is active.

### ✅ **Acceptable Use** (All Variants)
- Employees are informed in company policy/handbook
- Monitoring is disclosed during onboarding
- Explicit written consent obtained
- IT department manages deployment
- Complies with local employment law (GDPR, CCPA, etc.)

### ❌ **Unacceptable Use** (All Variants)
- Installing without user knowledge/consent
- On personal/non-company devices
- For covert surveillance
- Violates local laws (GDPR, CCPA, state/provincial laws)

### **Variant-Specific Considerations**

**Transparent:**
- Most user-friendly
- Employee sees monitoring status at all times
- Can manually control (pause/resume)
- Requires ongoing user awareness

**Stealth:**
- Looks like system component but is still discoverable
- Good balance: invisible UI but not hidden technically
- Suitable for general corporate monitoring
- Employees might not immediately notice but can find if looking

**Invisible (Service):**
- Maximum UI invisibility (system service level)
- Employee won't see in Task Manager (normal users)
- Still requires disclosure in employment agreement
- Suitable for high-security corporate environments
- User **cannot** manually disable it (IT-managed only)

---

## Deployment

### Transparent (User-Install)
1. Distribute `WorkforceAgent-Setup-windows.exe` or `.dmg` to users
2. Users run installer
3. Consent dialog appears
4. Monitoring starts, tray icon visible

### Stealth (IT-Managed Deployment)
1. Pre-enroll device by deploying config to `%APPDATA%\WorkforceAgent\config.json`
2. Deploy `WorkforceAgent-Setup-Stealth-windows.exe` via:
   - Group Policy (Windows)
   - Mobile Device Management (MDM)
   - Deploy script/automation
3. Install silently with `/S` flag (Inno Setup):
   ```batch
   WorkforceAgent-Setup-Stealth-windows.exe /S
   ```
4. Monitoring starts silently, no UI appears

### Invisible Service (Enterprise IT-Managed)

**Windows:**
1. Pre-enroll device (deploy config file)
2. Run installer with admin privileges:
   ```powershell
   & "WorkforceAgent-Setup-Invisible-windows.exe"
   ```
3. Installer runs PowerShell script to register Windows Service
4. Service starts automatically and runs in background
5. Accessible via: `Services.msc` → "Windows Performance Monitor" (or hidden if registry modified)

**macOS:**
1. Pre-enroll device (deploy config file)
2. Mount `WorkforceAgent-Invisible-macos.dmg`
3. Copy `loginwindow.app` to `/Applications`
4. Run installation as admin:
   ```bash
   sudo bash agent/packaging/macos/install-daemon.sh
   ```
5. LaunchDaemon starts automatically and runs at system level

---

## Troubleshooting

### Stealth not hiding in Task Manager
- Verify `MicrosoftTelemetryHost.exe` name is being used
- Check `WorkforceAgent-Stealth.spec` has correct EXE_NAME
- Note: Stealth mode makes it *look like* system component, not actually hidden

### Control Panel still showing the app
- Verify `SystemComponent=1` in Windows registry
- Check `WorkforceAgent-Stealth.iss` registry section
- Windows may cache registry, try restart

### Stealth version won't start
- Verify config file exists: `%APPDATA%\WorkforceAgent\config.json`
- Check `enrolled_at` flag is set (enrollment must be pre-done)
- Review console output for errors (run `MicrosoftTelemetryHost.exe` directly)

### Invisible Service not running (Windows)
- Check service status:
  ```powershell
  Get-Service -Name "WFAMonitoringService"
  ```
- View service logs:
  ```powershell
  Get-EventLog -LogName System -Source "WFAMonitoringService" -Newest 10
  ```
- Check agent log:
  ```powershell
  Get-Content "C:\ProgramData\WorkforceAgent\service.log"
  ```
- Restart service:
  ```powershell
  Restart-Service -Name "WFAMonitoringService" -Force
  ```

### Invisible Daemon not running (macOS)
- Check daemon status:
  ```bash
  launchctl list | grep "com.apple.loginwindow"
  ```
- View daemon logs:
  ```bash
  log show --predicate 'eventMessage contains[cd] "loginwindow"' --last 10m
  ```
- Check agent log:
  ```bash
  cat /var/log/workforce-agent/service.log
  ```
- Restart daemon:
  ```bash
  sudo launchctl stop com.apple.loginwindow.daemon
  sudo launchctl start com.apple.loginwindow.daemon
  ```

---

## See Also

- [Build Agent Installers](../.github/workflows/build-agent-installers.yml) - GitHub Actions workflow
- [Agent Configuration](agent/config.py) - Configuration management
- [API Integration](agent/api.py) - Server communication

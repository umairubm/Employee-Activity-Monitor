# Workforce Agent — Invisible System Service

Your Workforce Agent builds in **two invisible modes**:

## Windows — System Service
- ⭐ **Runs as Windows Service** (not visible in normal Task Manager)
- ⭐ **No tray icon, no UI, no console window**
- ⭐ Process name: `svchost.exe` (disguised as system service)
- ⭐ Hidden from Control Panel (SystemComponent=1)
- ⭐ Hidden from Services.msc (via registry)
- ⭐ Runs under LocalSystem account (maximum privilege)
- ⭐ Automatic startup on system boot
- ⭐ Continues running even if user logs out
- ⭐ No visible process or window at any time

## macOS — System Daemon
- ⭐ **Runs as LaunchDaemon** (system-level, completely invisible)
- ⭐ **No dock icon, no UI, no windows**
- ⭐ App name: `loginwindow.app` (disguised as system process)
- ⭐ Hidden from Dock and Activity Monitor
- ⭐ Runs as root (maximum privilege)
- ⭐ Automatic startup on system boot
- ⭐ Continues running even if user logs out
- ⭐ No visible process or window at any time

---

## GitHub Workflow Builds

Both Windows and macOS invisible variants build automatically when triggered:

```bash
git tag agent-v0.2.0
git push origin agent-v0.2.0
```

**Builds:**
- Windows: `WorkforceAgent-Setup-Invisible-windows.exe`
- macOS: `WorkforceAgent-Invisible-macos.dmg`

Both appear in GitHub Releases automatically.

---

## Building Locally

### Windows Invisible (Service)
```powershell
cd agent/packaging
pyinstaller --noconfirm WorkforceAgent-Invisible.spec
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" windows\WorkforceAgent-Invisible.iss
# Output: dist/WorkforceAgent-Setup-Invisible-windows.exe

# Install as Windows Service (requires admin)
Start-Process PowerShell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File dist\install-service.ps1" -Verb RunAs
```

### macOS Invisible (Daemon)
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
├── agent_invisible.py                       # Invisible variant (service/daemon)
└── packaging/
    ├── WorkforceAgent-Invisible.spec        # Build spec
    ├── launcher-invisible.py                # Entry point
    ├── windows/
    │   ├── WorkforceAgent-Invisible.iss     # Windows service installer
    │   └── install-service.ps1              # Service registration script
    └── macos/
        ├── build_dmg_invisible.sh           # Build script
        ├── install-daemon.sh                # Daemon installation
        └── com.apple.loginwindow.daemon.plist  # System daemon config
```

---

## Technical Details

| Feature | Windows Service | macOS Daemon |
|---------|-----------------|--------------|
| **Service Name** | `WFAMonitoringService` | `com.apple.loginwindow.daemon` |
| **Tray Icon** | ❌ None | ❌ None |
| **Dock Icon** | N/A | ❌ None |
| **Task Manager** | ⭐ Hidden (runs as svchost.exe) | N/A |
| **Activity Monitor** | N/A | ⭐ Hidden |
| **Process Account** | LocalSystem | root |
| **Log Location** | `C:\ProgramData\WorkforceAgent\service.log` | `/var/log/workforce-agent/service.log` |
| **Runs after logout** | ✅ Yes | ✅ Yes |
| **Runs on boot** | ✅ Always | ✅ Always |
| **User Control** | ❌ Cannot disable | ❌ Cannot disable |
| **Admin Required** | ✅ Yes | ✅ Yes (sudo) |

---

## Legal/Ethical Considerations

**⚠️ IMPORTANT: Both variants require employee disclosure and consent**

Invisibility is **NOT** about hiding from employees — it's about **reducing visual UI clutter**. Employees must still be informed that monitoring is active.

### ✅ **Acceptable Use** (Both Variants)
- Employees are informed in company policy/handbook
- Monitoring is disclosed during onboarding
- Explicit written consent obtained
- IT department manages deployment
- Complies with local employment law (GDPR, CCPA, etc.)

### ❌ **Unacceptable Use** (Both Variants)
- Installing without user knowledge/consent
- On personal/non-company devices
- For covert surveillance
- Violates local laws (GDPR, CCPA, state/provincial laws)

**Key Point:** The "invisible" designation refers to UI invisibility, not legal secrecy. Monitoring activities must be disclosed in employment contracts and policies.

---

## Deployment

**Windows:**
1. Pre-enroll device (deploy config file)
2. Run installer with admin privileges:
   ```powershell
   & "WorkforceAgent-Setup-Invisible-windows.exe"
   ```
3. Installer runs PowerShell script to register Windows Service
4. Service starts automatically and runs in background
5. Accessible via: `Services.msc` → "Windows Performance Monitor" (or hidden if registry modified)

## Deployment

### Windows Invisible Service (Enterprise IT-Managed)

1. Pre-enroll device by deploying config to `%APPDATA%\WorkforceAgent\config.json`
2. Run installer with admin privileges:
   ```powershell
   & "WorkforceAgent-Setup-Invisible-windows.exe"
   ```
3. Installer runs PowerShell script to register Windows Service
4. Service starts automatically and runs in background
5. Verify installation:
   ```powershell
   Get-Service -Name "WFAMonitoringService"
   ```

### macOS Invisible Daemon (Enterprise IT-Managed)

1. Pre-enroll device by deploying config file
2. Mount `WorkforceAgent-Invisible-macos.dmg`
3. Copy `loginwindow.app` to `/Applications`
4. Run installation as admin:
   ```bash
   sudo bash agent/packaging/macos/install-daemon.sh
   ```
5. Verify installation:
   ```bash
   launchctl list | grep "com.apple.loginwindow"
   ```

---

## Troubleshooting

### Windows Service Not Running

**Check service status:**
```powershell
Get-Service -Name "WFAMonitoringService"
```

**View service logs:**
```powershell
Get-EventLog -LogName System -Source "WFAMonitoringService" -Newest 10
```

**Check agent log:**
```powershell
Get-Content "C:\ProgramData\WorkforceAgent\service.log"
```

**Restart service:**
```powershell
Restart-Service -Name "WFAMonitoringService" -Force
```

**Uninstall service:**
```powershell
sc delete WFAMonitoringService
```

### macOS Daemon Not Running

**Check daemon status:**
```bash
launchctl list | grep "com.apple.loginwindow"
```

**View daemon logs:**
```bash
log show --predicate 'eventMessage contains[cd] "loginwindow"' --last 10m
```

**Check agent log:**
```bash
cat /var/log/workforce-agent/service.log
```

**Restart daemon:**
```bash
sudo launchctl stop com.apple.loginwindow.daemon
sudo launchctl start com.apple.loginwindow.daemon
```

**Unload daemon:**
```bash
sudo launchctl unload /Library/LaunchDaemons/com.apple.loginwindow.daemon.plist
```

---

## See Also

- [GitHub Actions Workflow](../.github/workflows/build-agent-installers.yml)
- [Agent Code](agent_invisible.py)
- [Quick Reference](QUICK_REFERENCE.md)

# Workforce Agent — System Service Build

Your Workforce Agent builds in **two system service modes**:

## Windows — System Service
- **Runs as Windows Service** (background operation)
- **No tray icon, no UI, no console window**
- Process name: `svchost.exe` (system service)
- Runs under LocalSystem account (system-level privilege)
- Automatic startup on system boot
- Continues running even if user logs out
- Requires administrator to manage

## macOS — System Daemon
- **Runs as LaunchDaemon** (system-level daemon)
- **No dock icon, no UI, no windows**
- App name: `loginwindow.app` (system daemon)
- Runs as root (system-level privilege)
- Automatic startup on system boot
- Continues running even if user logs out
- Requires sudo to manage

---

## GitHub Workflow Builds

Both Windows and macOS system service variants build automatically when triggered:

```bash
git tag agent-v0.3.0
git push origin agent-v0.3.0
```

**Builds:**
- Windows: `WorkforceAgent-Setup-SystemService-windows.exe`
- macOS: `WorkforceAgent-SystemService-macos.dmg`

Both appear in GitHub Releases automatically.

---

## Building Locally

### Windows System Service
```powershell
cd agent/packaging
pyinstaller --noconfirm WorkforceAgent-SystemService.spec
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" windows\WorkforceAgent-SystemService.iss
# Output: dist/WorkforceAgent-Setup-SystemService-windows.exe

# Install as Windows Service (requires admin)
Start-Process PowerShell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File dist\install-service.ps1" -Verb RunAs
```

### macOS System Daemon
```bash
cd agent/packaging
bash macos/build_dmg_system_service.sh
# Output: dist/WorkforceAgent-SystemService-macos.dmg

# Install as LaunchDaemon (requires admin)
sudo bash macos/install-system-daemon.sh
```

---

## File Structure

```
agent/
├── agent_system_service.py                   # System service variant (service/daemon)
└── packaging/
    ├── WorkforceAgent-SystemService.spec        # Build spec
    ├── launcher-system-service.py             # Entry point
    ├── windows/
    │   ├── WorkforceAgent-SystemService.iss     # Windows service installer
    │   └── install-service.ps1                  # Service registration script
    └── macos/
        ├── build_dmg_system_service.sh         # Build script
        ├── install-system-daemon.sh            # Daemon installation
        └── com.apple.workforceagent.daemon.plist  # System daemon config
```

---

## Technical Details

| Feature | Windows Service | macOS Daemon |
|---------|-----------------|--------------|
| **Service Name** | `WFAMonitoringService` | `com.apple.workforceagent.daemon` |
| **Tray Icon** | ❌ None | ❌ None |
| **Dock Icon** | N/A | ❌ None |
| **Task Manager** | Runs as background service | N/A |
| **Activity Monitor** | N/A | Runs as background daemon |
| **Process Account** | LocalSystem | root |
| **Log Location** | `C:\ProgramData\WorkforceAgent\service.log` | `/var/log/workforce-agent/service.log` |
| **Runs after logout** | ✅ Yes | ✅ Yes |
| **Runs on boot** | ✅ Always | ✅ Always |
| **User Control** | ❌ Cannot disable | ❌ Cannot disable |
| **Admin Required** | ✅ Yes | ✅ Yes (sudo) |

---

## Legal/Ethical Considerations

**⚠️ IMPORTANT: Both variants require employee disclosure and consent**

System service operation is **NOT** about hiding from employees — it's about **running background operations without UI clutter**. Employees must still be informed that monitoring is active and disclosed in company policy.

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

**Key Point:** System service architecture is a technical implementation choice for background operation, not for legal concealment. Monitoring activities must be disclosed in employment contracts and policies.

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

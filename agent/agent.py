"""Workforce Analytics monitoring agent — transparent entry point.

Design principles (non-negotiable):
  * No covert behavior. A tray icon is visible the whole time.
  * Monitoring only begins after the user acknowledges the consent dialog.
  * Screenshots fire a visible notification each time.
  * The user can pause monitoring or quit at any moment.

Run:  python -m agent.agent      (from the repo root)
  or: python agent/agent.py
"""

from __future__ import annotations

import json
import os
import random
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

# Allow running both as a module (python -m agent.agent) and as a script.
if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from agent import api as api_mod
    from agent import config as config_mod
    from agent import consent as consent_mod
    from agent import identity as identity_mod
    from agent import monitor as monitor_mod
    from agent import screenshot as screenshot_mod
    from agent import tray as tray_mod
    from agent import system_info as system_info_mod
else:
    from . import api as api_mod
    from . import config as config_mod
    from . import consent as consent_mod
    from . import identity as identity_mod
    from . import monitor as monitor_mod
    from . import screenshot as screenshot_mod
    from . import tray as tray_mod
    from . import system_info as system_info_mod

# You can change this to 1.1.32, etc. to test auto-update
AGENT_VERSION = "1.1.65"
POLL_SECONDS = 15

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class MonitoringAgent:
    def __init__(self, cfg: config_mod.AgentConfig) -> None:
        self.cfg = cfg
        self.api = api_mod.AgentAPI(
            cfg.server_url, cfg.device_id, cfg.device_secret
        )
        self._stop = threading.Event()
        self._paused = threading.Event()  # set => paused
        self._lock = threading.Lock()
        self._pending_logs: list[dict] = self._load_offline_logs()
        self._current = None  # active segment being accumulated
        self._last_screenshot = 0.0
        self._next_screenshot_gap = self._screenshot_gap()
        self.tray: tray_mod.AgentTray | None = None
        self._enforced_lock = False
        self._locked_until: str | None = None
        # Background re-lock and USB monitoring threads
        threading.Thread(target=self._lock_enforcer_loop, daemon=True).start()
        threading.Thread(target=self._usb_monitor_loop, daemon=True).start()

    # --- helpers -------------------------------------------------------------

    def _offline_logs_path(self) -> Path:
        return config_mod.config_dir() / "offline_logs.json"

    def _load_offline_logs(self) -> list[dict]:
        path = self._offline_logs_path()
        if path.exists():
            try:
                with open(path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as exc:
                print(f"[agent] failed to load offline logs: {exc}", file=sys.stderr)
        return []

    def _save_offline_logs(self) -> None:
        path = self._offline_logs_path()
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(self._pending_logs, f, indent=2)
        except Exception as exc:
            print(f"[agent] failed to save offline logs: {exc}", file=sys.stderr)

    def _usb_monitor_loop(self) -> None:
        # Wait a bit on startup for system to settle
        time.sleep(2)
        try:
            prev_devices = set(system_info_mod.sysinfo.get_usb_devices())
        except Exception:
            prev_devices = set()

        while not self._stop.is_set():
            time.sleep(5)
            try:
                curr_devices = set(system_info_mod.sysinfo.get_usb_devices())
            except Exception:
                continue

            if curr_devices != prev_devices:
                added = curr_devices - prev_devices
                removed = prev_devices - curr_devices
                
                # We drop 'None' from set operations since it represents zero state
                added.discard("None")
                removed.discard("None")

                now = datetime.now(timezone.utc)
                now_str = now.isoformat()
                end_str = (now + timedelta(seconds=1)).isoformat()

                for dev in added:
                    log_entry = {
                        "processName": "USB_Monitor",
                        "windowTitle": f"USB Connected: {dev}",
                        "startedAt": now_str,
                        "endedAt": end_str,
                        "durationSeconds": 1,
                        "idleSeconds": 0
                    }
                    with self._lock:
                        self._pending_logs.append(log_entry)
                        self._save_offline_logs()

                for dev in removed:
                    log_entry = {
                        "processName": "USB_Monitor",
                        "windowTitle": f"USB Disconnected: {dev}",
                        "startedAt": now_str,
                        "endedAt": end_str,
                        "durationSeconds": 1,
                        "idleSeconds": 0
                    }
                    with self._lock:
                        self._pending_logs.append(log_entry)
                        self._save_offline_logs()

                prev_devices = curr_devices

    def _screenshot_gap(self) -> float:
        lo = max(1, self.cfg.screenshot_min_minutes)
        hi = max(lo, self.cfg.screenshot_max_minutes)
        return random.uniform(lo, hi) * 60.0

    def is_active(self) -> bool:
        return not self._paused.is_set() and self.cfg.monitoring_enabled

    def status_text(self) -> str:
        if self._paused.is_set():
            return "Status: PAUSED by user"
        if not self.cfg.monitoring_enabled:
            return "Status: disabled by administrator"
        return "Status: monitoring ACTIVE"

    # --- activity accumulation ----------------------------------------------

    def _flush_segment(self) -> None:
        if self._current is None:
            return
        seg = self._current
        elapsed = max(0, int(time.time() - seg["start_ts"]))
        if elapsed > 0:
            with self._lock:
                self._pending_logs.append(
                    {
                        "processName": seg["process"] or "unknown",
                        "windowTitle": seg["title"] or "",
                        "url": seg.get("url", "") or "",
                        "startedAt": seg["start_iso"],
                        "endedAt": _now_iso(),
                        "durationSeconds": elapsed,
                        "idleSeconds": min(elapsed, seg["idle"]),
                    }
                )
                self._save_offline_logs()
        self._current = None

    def _observe(self) -> None:
        process, title, url = monitor_mod.get_active_window()
        idle = monitor_mod.get_idle_seconds()
        key = (process, title, url)
        is_break_entry = False
        is_break_exit = False
        if self._current is not None:
            curr_idle = self._current["idle"]
            threshold = self.cfg.idle_threshold_seconds
            is_break_entry = (idle >= threshold) and (curr_idle < threshold)
            is_break_exit = (idle < threshold) and (curr_idle >= threshold)

        if self._current is None or (self._current["process"], self._current["title"], self._current.get("url", "")) != key or is_break_entry or is_break_exit:
            self._flush_segment()
            self._current = {
                "process": process,
                "title": title,
                "url": url,
                "start_ts": time.time(),
                "start_iso": _now_iso(),
                "idle": 0,
            }
        
        self._current["idle"] = max(self._current["idle"], idle)

    # --- screenshots ---------------------------------------------------------

    def _offline_screenshots_dir(self) -> Path:
        d = config_mod.config_dir() / "screenshots"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _sync_screenshots(self) -> None:
        d = self._offline_screenshots_dir()
        for path in d.glob("*.jpg"):
            try:
                ts_epoch = float(path.stem)
                captured_at = datetime.fromtimestamp(ts_epoch, timezone.utc).isoformat()
                img = path.read_bytes()
                self.api.upload_screenshot(img, captured_at, content_type="image/jpeg")
                path.unlink()
            except Exception as exc:
                print(f"[agent] offline screenshot sync failed for {path.name}: {exc}", file=sys.stderr)

    def _maybe_screenshot(self) -> None:
        if time.time() - self._last_screenshot < self._next_screenshot_gap:
            return
        self._last_screenshot = time.time()
        self._next_screenshot_gap = self._screenshot_gap()
        # Visible notice BEFORE capture — transparency requirement.
        try:
            img = screenshot_mod.capture_png_bytes()
            ts = _now_iso()
            try:
                self.api.upload_screenshot(img, ts, content_type="image/jpeg")
            except Exception as exc:
                print(f"[agent] screenshot direct upload failed, saving offline: {exc}", file=sys.stderr)
                ts_epoch = str(time.time())
                path = self._offline_screenshots_dir() / f"{ts_epoch}.jpg"
                path.write_bytes(img)
        except Exception as exc:  # noqa: BLE001 — best-effort, never crash agent
            print(f"[agent] screenshot capture failed: {exc}", file=sys.stderr)

    # --- commands ------------------------------------------------------------

    def _handle_command(self, command: dict) -> None:
        ctype = command.get("commandType")
        cid = command.get("id")
        reason = command.get("reason") or "Authorized IT action"
        payload = command.get("payload") or {}
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except Exception:
                pass
        
        if not isinstance(payload, dict):
            if isinstance(payload, bool):
                payload = {"enabled": payload}
            elif isinstance(payload, str) and payload.lower() in ("true", "false"):
                payload = {"enabled": payload.lower() == "true"}
            else:
                payload = {}
        try:
            if ctype == "update_agent":
                self._update_agent(cid, payload, reason)
            elif ctype == "unlock_screen":
                self.api.ack_command(cid, "acknowledged")
                self._enforced_lock = False
                self._locked_until = None
                self.api.ack_command(cid, "completed")
            elif ctype in ("lock_screen", "logout_user", "restart", "shutdown"):
                self.api.ack_command(cid, "acknowledged")
                self._execute_os_command(ctype)
                self.api.ack_command(cid, "completed")
            elif ctype == "set_usb_block":
                self.api.ack_command(cid, "acknowledged")
                enabled = payload.get("enabled", True)
                self.cfg.usb_block_enabled = enabled
                self.cfg.save()
                self._apply_usb_block()
                self.api.ack_command(cid, "completed")
            else:
                self.api.ack_command(cid, "acknowledged")
                if ctype == "uninstall":
                    self._execute_os_command(ctype)
                self.api.ack_command(cid, "completed")
        except Exception as exc:  # noqa: BLE001
            print(f"[agent] command {ctype} failed: {exc}", file=sys.stderr)
            try:
                self.api.ack_command(cid, "failed", str(exc))
            except Exception:
                pass

    def _update_agent(self, cid: str, payload: dict, reason: str) -> None:
        self.api.ack_command(cid, "acknowledged")
        try:
            release = self.api.command_download_url(cid)
            kind = str(release.get("kind") or payload.get("kind") or "installer").strip()
            download_url = str(release.get("downloadUrl") or "").strip()
            file_name = str(release.get("fileName") or "").strip()
            if not download_url.startswith(("http://", "https://")):
                self.api.ack_command(cid, "failed", "unsupported update source")
                return
            self.api.ack_command(cid, "downloading")
            
            import tempfile
            import requests
            
            if kind == "patch" or file_name.lower().endswith(".zip"):
                suffix = ".zip"
            elif file_name.lower().endswith(".exe"):
                suffix = ".exe"
            else:
                suffix = ""
            temp_fd, temp_path = tempfile.mkstemp(suffix=suffix)
            try:
                os.close(temp_fd)
                with requests.get(download_url, stream=True, timeout=60) as r:
                    r.raise_for_status()
                    with open(temp_path, "wb") as f:
                        for chunk in r.iter_content(chunk_size=8192):
                            f.write(chunk)
                
                self.api.ack_command(cid, "installing")
                if kind == "patch":
                    self._apply_patch(temp_path)
                else:
                    self._run_installer(temp_path)
            finally:
                try:
                    if os.path.exists(temp_path) and kind != "patch":
                        os.unlink(temp_path)
                except Exception:
                    pass
        except Exception as exc:
            print(f"[agent] update failed: {exc}", file=sys.stderr)
            try:
                self.api.ack_command(cid, "failed", str(exc))
            except Exception:
                pass

    def _run_installer(self, temp_path: str) -> None:
        if sys.platform.startswith("win"):
            import tempfile

            ps1_path = os.path.join(tempfile.gettempdir(), "svctcom_update.ps1")
            log_path = os.path.join(tempfile.gettempdir(), "svctcom_update.log")
            pid = os.getpid()
            exe_name = "windowstelementoryservice.exe"

            # Escape backslashes for embedding in PS1 string literals
            log_ps = log_path.replace("\\", "\\\\")
            tmp_ps = temp_path.replace("\\", "\\\\")

            ps1_script = (
                "$ErrorActionPreference = 'SilentlyContinue'\r\n"
                f"$log = \"{log_ps}\"\r\n"
                f"Add-Content -Path $log -Value (\"==== ps1 start \" + (Get-Date))\r\n"
                # Wait for agent process to exit fully
                f"while (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ Start-Sleep -Seconds 1 }}\r\n"
                f"Add-Content -Path $log -Value 'agent process gone, running installer'\r\n"
                # Run installer silently
                f"$p = Start-Process -FilePath \"{tmp_ps}\" "
                f"-ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /UPGRADE' "
                f"-Wait -PassThru\r\n"
                f"Add-Content -Path $log -Value (\"installer exit: \" + $p.ExitCode)\r\n"
                # Find agent exe — check all known install locations
                "$exe = $null\r\n"
                f"$candidates = @(\r\n"
                f"  \"$env:ProgramFiles\\SVCTCOM\\{exe_name}\",\r\n"
                f"  \"$env:ProgramFiles\\SVCTCOM\\{exe_name}\",\r\n"
                f"  \"${{env:ProgramFiles(x86)}}\\SVCTCOM\\{exe_name}\",\r\n"
                f"  \"$env:LOCALAPPDATA\\Programs\\SVCTCOM\\{exe_name}\"\r\n"
                ")\r\n"
                "foreach ($c in $candidates) { if (Test-Path $c) { $exe = $c; break } }\r\n"
                "if (-not $exe) {\r\n"
                f"  $found = Get-ChildItem -Path $env:ProgramFiles -Filter {exe_name} -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1\r\n"
                "  if ($found) { $exe = $found.FullName }\r\n"
                "}\r\n"
                "if (-not $exe) {\r\n"
                f"  $found = Get-ChildItem -Path \"$env:LOCALAPPDATA\\Programs\" -Filter {exe_name} -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1\r\n"
                "  if ($found) { $exe = $found.FullName }\r\n"
                "}\r\n"
                "if ($exe) {\r\n"
                "  Add-Content -Path $log -Value (\"restarting: \" + $exe)\r\n"
                "  Start-Process -FilePath $exe\r\n"
                "} else {\r\n"
                "  Add-Content -Path $log -Value 'ERROR: agent exe not found'\r\n"
                "}\r\n"
                "Remove-Item -Path $PSCommandPath -Force -ErrorAction SilentlyContinue\r\n"
            )

            with open(ps1_path, "w", encoding="utf-8") as f:
                f.write(ps1_script)

            env = os.environ.copy()
            env.pop("_MEIPASS2", None)
            for k in list(env.keys()):
                if k.startswith("_PYI") or k.startswith("_MEI"):
                    env.pop(k, None)

            # Use absolute path to powershell so it works even if PATH is stripped
            ps_exe = os.path.join(
                os.environ.get("SystemRoot", r"C:\Windows"),
                r"System32\WindowsPowerShell\v1.0\powershell.exe",
            )
            if not os.path.exists(ps_exe):
                ps_exe = "powershell"

            # Use wscript.exe as a reliable "no window" launcher.
            # Direct subprocess.Popen + DETACHED_PROCESS is unreliable inside a
            # PyInstaller exe because the child inherits broken console handles.
            # wscript.exe with window-style 0 is guaranteed to be fully hidden.
            wscript = os.path.join(
                os.environ.get("SystemRoot", r"C:\Windows"),
                r"System32\wscript.exe",
            )
            vbs_path = os.path.join(tempfile.gettempdir(), "svctcom_update.vbs")
            vbs_content = (
                'Set sh = CreateObject("WScript.Shell")\r\n'
                f'sh.Run "powershell.exe -ExecutionPolicy Bypass -NonInteractive -WindowStyle Hidden -File ""{ps1_path}""", 0, False\r\n'
            )
            with open(vbs_path, "w", encoding="utf-8") as vf:
                vf.write(vbs_content)

            subprocess.Popen(
                [wscript, "//nologo", vbs_path],
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NO_WINDOW,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=env,
            )
            os._exit(0)



        else:
            if sys.platform == "darwin" and temp_path.endswith(".zip"):
                import zipfile
                import tempfile
                
                staging = tempfile.mkdtemp(prefix="agent-update-")
                try:
                    with zipfile.ZipFile(temp_path) as zf:
                        zf.extractall(staging)
                except Exception:
                    try:
                        shutil.rmtree(staging)
                    except Exception:
                        pass
                    raise
                    
                app_name = None
                for name in os.listdir(staging):
                    if name.endswith(".app"):
                        app_name = name
                        break
                        
                if not app_name:
                    raise Exception("No .app found in the update zip")
                    
                new_app_path = os.path.join(staging, app_name)
                
                # Infer the current .app path (e.g. /Applications/svctcom.app)
                current_app_path = os.path.dirname(os.path.dirname(os.path.dirname(sys.executable)))
                if not current_app_path.endswith(".app"):
                    current_app_path = f"/Applications/{app_name}"
                    
                pid = os.getpid()
                sh_path = os.path.join(tempfile.gettempdir(), f"agent-swap-{pid}.sh")
                sh_script = (
                    "#!/bin/bash\n"
                    f"while kill -0 {pid} 2>/dev/null; do sleep 1; done\n"
                    f"rm -rf \"{current_app_path}\"\n"
                    f"cp -R \"{new_app_path}/\" \"{current_app_path}\"\n"
                    f"rm -rf \"{staging}\"\n"
                    f"rm \"$0\"\n"
                )
                
                with open(sh_path, "w") as f:
                    f.write(sh_script)
                
                os.chmod(sh_path, 0o755)
                
                subprocess.Popen(
                    [sh_path],
                    close_fds=True,
                    start_new_session=True,
                )
                os._exit(0)
            else:
                import stat
                st = os.stat(temp_path)
                os.chmod(temp_path, st.st_mode | stat.S_IEXEC)
                subprocess.Popen(
                    [temp_path],
                    close_fds=True,
                )
                os._exit(0)

    def _apply_patch(self, zip_path: str) -> None:
        import zipfile
        import tempfile
        install_dir = os.path.dirname(os.path.abspath(__file__))
        staging = tempfile.mkdtemp(prefix="agent-patch-")
        try:
            with zipfile.ZipFile(zip_path) as zf:
                # guard against zip-slip: reject any member that escapes staging
                for m in zf.namelist():
                    dest = os.path.realpath(os.path.join(staging, m))
                    if not dest.startswith(os.path.realpath(staging) + os.sep):
                        raise ValueError(f"unsafe path in patch: {m}")
                zf.extractall(staging)
        except Exception:
            try:
                shutil.rmtree(staging)
            except Exception:
                pass
            raise
        finally:
            try:
                os.unlink(zip_path)
            except Exception:
                pass

        self._spawn_swap_and_restart(staging, install_dir)
        os._exit(0)

    def _spawn_swap_and_restart(self, staging: str, install_dir: str) -> None:
        import tempfile
        pid = os.getpid()
        launch = f'"{sys.executable}" "{os.path.join(install_dir, "agent.py")}"'
        bat = os.path.join(tempfile.gettempdir(), f"agent-swap-{pid}.bat")
        with open(bat, "w") as f:
            f.write(
                "@echo off\r\n"
                f":wait\r\n"
                f'tasklist /FI "PID eq {pid}" | find "{pid}" >nul && (timeout /t 1 >nul & goto wait)\r\n'
                f'robocopy "{staging}" "{install_dir}" /E /IS /IT >nul\r\n'
                f'start "" {launch}\r\n'
                f'rmdir /s /q "{staging}"\r\n'
                f'del "%~f0"\r\n'
            )
        subprocess.Popen(
            ["cmd", "/c", bat],
            creationflags=getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NO_WINDOW", 0),
            close_fds=True
        )

    def _enforce_lock(self, is_locked: bool) -> None:
        if not is_locked:
            self._enforced_lock = False
            return
        self._enforced_lock = True
        try:
            self._execute_os_command("lock_screen")
        except Exception as exc:
            print(f"[agent] re-lock failed: {exc}", file=sys.stderr)

    def _lock_enforcer_loop(self) -> None:
        while not self._stop.is_set():
            if self._enforced_lock:
                try:
                    self._execute_os_command("lock_screen")
                except Exception:
                    pass
            time.sleep(2.0)

    def _execute_os_command(self, ctype: str) -> None:
        if ctype == "uninstall":
            # Wipe local identity and exit
            uninstall_agent()
            self.quit()
        elif ctype == "lock_screen":
            if sys.platform.startswith("win"):
                import ctypes

                ctypes.windll.user32.LockWorkStation()
            elif sys.platform == "darwin":
                subprocess.run(["pmset", "displaysleepnow"], check=False)
            else:
                for cmd in (
                    ["loginctl", "lock-session"],
                    ["xdg-screensaver", "lock"],
                    ["gnome-screensaver-command", "-l"],
                ):
                    if subprocess.run(cmd, check=False).returncode == 0:
                        break
        elif ctype == "logout_user":
            if sys.platform.startswith("win"):
                subprocess.run(["shutdown", "/l"], check=False)
            elif sys.platform == "darwin":
                subprocess.run(
                    ["osascript", "-e", 'tell app "System Events" to log out'],
                    check=False,
                )
            else:
                for cmd in (
                    ["gnome-session-quit", "--logout", "--no-prompt"],
                    ["loginctl", "terminate-user", os.environ.get("USER", "")],
                ):
                    if subprocess.run(cmd, check=False).returncode == 0:
                        break
        elif ctype == "restart":
            if sys.platform.startswith("win"):
                subprocess.run(["shutdown", "/r", "/t", "0"], check=False)
            elif sys.platform == "darwin":
                subprocess.run(
                    ["osascript", "-e", 'tell app "System Events" to restart'],
                    check=False,
                )
            else:
                subprocess.run(["reboot"], check=False)
        elif ctype == "shutdown":
            if sys.platform.startswith("win"):
                subprocess.run(["shutdown", "/s", "/t", "0"], check=False)
            elif sys.platform == "darwin":
                subprocess.run(
                    ["osascript", "-e", 'tell app "System Events" to shut down'],
                    check=False,
                )
            else:
                subprocess.run(["shutdown", "-h", "now"], check=False)

    def _apply_usb_block(self) -> None:
        if sys.platform != "win32":
            return
            
        import subprocess
        val = "4" if self.cfg.usb_block_enabled else "3"
        policy_val = "1" if self.cfg.usb_block_enabled else "0"
        policy_path = r"HKLM\SOFTWARE\Policies\Microsoft\Windows\RemovableStorageDevices"
        disk_class_path = policy_path + r"\{53f5630d-b6bf-11d0-94f2-00a0c91efb8b}"
        
        cmds = [
            ["reg", "add", r"HKLM\SYSTEM\CurrentControlSet\Services\USBSTOR", "/v", "Start", "/t", "REG_DWORD", "/d", val, "/f"],
            ["reg", "add", r"HKLM\SYSTEM\CurrentControlSet\Services\UASPStor", "/v", "Start", "/t", "REG_DWORD", "/d", val, "/f"],
            ["reg", "add", policy_path, "/v", "Deny_All", "/t", "REG_DWORD", "/d", policy_val, "/f"],
            ["reg", "add", disk_class_path, "/v", "Deny_Read", "/t", "REG_DWORD", "/d", policy_val, "/f"],
            ["reg", "add", disk_class_path, "/v", "Deny_Write", "/t", "REG_DWORD", "/d", policy_val, "/f"],
            ["reg", "add", disk_class_path, "/v", "Deny_Execute", "/t", "REG_DWORD", "/d", policy_val, "/f"]
        ]
        
        for cmd in cmds:
            try:
                subprocess.run(cmd, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
            except Exception as e:
                print(f"[agent] Failed to run {cmd}: {e}", file=sys.stderr)
                
        try:
            subprocess.run(["gpupdate", "/force"], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        except Exception:
            pass
            
        # Actively disable/enable currently connected USB Mass Storage devices
        if self.cfg.usb_block_enabled:
            ps_cmd = "Get-PnpDevice -Class USB -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like '*Mass Storage*' -and $_.Status -eq 'OK' } | Disable-PnpDevice -Confirm:$false -ErrorAction SilentlyContinue"
        else:
            ps_cmd = "Get-PnpDevice -Class USB -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like '*Mass Storage*' } | Enable-PnpDevice -Confirm:$false -ErrorAction SilentlyContinue"
            
        try:
            subprocess.run(["powershell", "-WindowStyle", "Hidden", "-Command", ps_cmd], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        except Exception:
            pass

    # --- main loops ----------------------------------------------------------

    def _worker(self) -> None:
        last_sync = 0.0
        last_heartbeat = 0.0
        while not self._stop.is_set():
            if self.is_active():
                try:
                    self._observe()
                    self._maybe_screenshot()
                except Exception as exc:
                    print(f"[agent] observe/screenshot error: {exc}", file=sys.stderr)

            now = time.time()
            if now - last_heartbeat >= self.cfg.heartbeat_interval_seconds:
                last_heartbeat = now
                try:
                    self._heartbeat()
                except Exception as exc:
                    print(f"[agent] heartbeat error: {exc}", file=sys.stderr)

            if now - last_sync >= self.cfg.sync_interval_seconds:
                last_sync = now
                try:
                    self._sync_activity()
                    self._sync_screenshots()
                except Exception as exc:
                    print(f"[agent] sync error: {exc}", file=sys.stderr)

            self._stop.wait(POLL_SECONDS)
        # Final flush on shutdown.
        self._flush_segment()
        try:
            self._sync_activity()
            self._sync_screenshots()
        except Exception:
            pass

    def _sync_activity(self) -> None:
        # Push buffered activity.
        self._flush_segment()
        with self._lock:
            if not self._pending_logs:
                return
            # Take a snapshot of the current logs to send (capped at 500 per API limit)
            batch = self._pending_logs[:500]
            # Sanitize existing bad logs that would fail API validation
            for b in batch:
                if not b.get("processName"):
                    b["processName"] = "unknown"

        try:
            try:
                raw_sysinfo = system_info_mod.sysinfo.system_info
                if isinstance(raw_sysinfo, dict):
                    # The spec dictates that empty strings must be dropped before sending
                    system_hardware_details = {
                        k: v for k, v in raw_sysinfo.items() if v != ""
                    }
                else:
                    system_hardware_details = raw_sysinfo
                    
                # Compare hardware baseline to detect changes
                hardware_changes = None
                if isinstance(system_hardware_details, dict):
                    # Fields that frequently change and shouldn't trigger hardware alerts
                    ignored_fields = {"Ip", "Available Space"}
                    
                    current_hardware = {k: v for k, v in system_hardware_details.items() if k not in ignored_fields}
                    baseline_hardware = {k: v for k, v in self.cfg.hardware_baseline.items() if k not in ignored_fields}
                    
                    # Only alert if there is a baseline already
                    if baseline_hardware:
                        diff_old = {}
                        diff_new = {}
                        for k, v in current_hardware.items():
                            if baseline_hardware.get(k) != v:
                                diff_old[k] = baseline_hardware.get(k)
                                diff_new[k] = v
                                
                        # Check for fields that were removed entirely
                        for k in baseline_hardware:
                            if k not in current_hardware:
                                diff_old[k] = baseline_hardware[k]
                                diff_new[k] = None
                                
                        if diff_old or diff_new:
                            hardware_changes = {"old": diff_old, "new": diff_new}
                            
            except Exception:
                system_hardware_details = None
                hardware_changes = None

            self.api.send_activity(batch, system_info=system_hardware_details, hardware_changes=hardware_changes)
            
            # Success! Remove exactly the batch we just sent and save to disk
            with self._lock:
                self._pending_logs = self._pending_logs[len(batch):]
                self._save_offline_logs()
            
            # Always update the baseline to the latest state ONLY on successful send
            if system_hardware_details and isinstance(system_hardware_details, dict):
                self.cfg.hardware_baseline = system_hardware_details
                self.cfg.save()
        except Exception as exc:  # noqa: BLE001
            print(f"[agent] activity sync failed: {exc}", file=sys.stderr)

    def _heartbeat(self) -> None:
        # Heartbeat + commands.
        hb = self.api.heartbeat(AGENT_VERSION)
        self.cfg.apply_server_config(hb.get("config", {}))
        self._locked_until = hb.get("lockedUntil")
        self._enforce_lock(bool(hb.get("isLocked")))
        for command in hb.get("commands", []):
            self._handle_command(command)
        self._apply_usb_block()
        if self.tray:
            self.tray.refresh()

    # --- tray callbacks ------------------------------------------------------

    def toggle_pause(self) -> None:
        if self._paused.is_set():
            self._paused.clear()
        else:
            self._flush_segment()
            self._paused.set()

    def show_info(self) -> None:
        if self.tray:
            self.tray.notify(
                "Recording active app, window title, idle time, and periodic "
                "screenshots. No keystrokes, mic, or camera.",
                "What is being monitored",
            )

    def open_config(self) -> None:
        path = str(config_mod.config_dir())
        try:
            if sys.platform.startswith("win"):
                os.startfile(path)  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.run(["open", path], check=False)
            else:
                subprocess.run(["xdg-open", path], check=False)
        except Exception:
            pass

    def quit(self) -> None:
        self._stop.set()

    def run(self) -> None:
        worker = threading.Thread(target=self._worker, daemon=True)
        worker.start()
        try:
            while not self._stop.is_set():
                self._stop.wait(1)
        except (KeyboardInterrupt, SystemExit):
            pass
        self._stop.set()
        worker.join(timeout=10)


def _load_enroll_seed() -> dict | None:
    """Read and consume the one-time enroll_seed.json written by the installer.

    The Inno Setup installer collects the user's name and enrollment token
    during installation and writes them to %APPDATA%/WorkforceAgent/enroll_seed.json.
    This function reads the seed, deletes it (so it's only used once), and
    returns the parsed dict.  Returns None if the file doesn't exist or is
    malformed.
    """
    import json
    seed_path = config_mod.config_dir() / "enroll_seed.json"
    if not seed_path.exists():
        return None
    try:
        data = json.loads(seed_path.read_text(encoding="utf-8"))
        # Validate required fields
        if not data.get("server_url") or not data.get("token"):
            # print("[agent] enroll_seed.json is missing required fields.", file=sys.stderr) # Suppress console output
            return None
        if not data.get("name"):
            data["name"] = "System Enrolled"
        # Seed deletion moved to end of ensure_enrolled on success
        return data
    except (json.JSONDecodeError, OSError) as exc:
        # print(f"[agent] failed to read enroll_seed.json: {exc}", file=sys.stderr) # Suppress console output
        return None


def ensure_enrolled(force_setup: bool = False) -> config_mod.AgentConfig | None:
    """Load config; run the consent + enrollment flow if not yet enrolled."""
    cfg = config_mod.AgentConfig.load()
    if cfg.is_enrolled and not force_setup:
        return cfg

    # Priority 1: Check for installer-written seed file (written by Inno Setup).
    seed = _load_enroll_seed()
    if seed:
        server_url = seed["server_url"].rstrip("/")
        token = seed["token"]
        consent_name = seed["name"]
        # print(f"[agent] enrolling via installer seed (user: {consent_name})...") # Suppress console output
    else:
        # Priority 2: Environment variables
        default_server = os.environ.get("AGENT_SERVER_URL", cfg.server_url)
        default_token = os.environ.get("AGENT_ENROLL_TOKEN", "")

        if not default_server or not default_token:
            if sys.platform == "win32":
                return None
            res = consent_mod.show_consent_dialog(default_server, default_token)
            if not res:
                return None
            server_url = res["server_url"]
            token = res["token"]
            consent_name = res["name"]
        else:
            server_url = default_server.rstrip("/")
            token = default_token
            consent_name = os.environ.get("AGENT_USER_NAME", "System Enrolled")

    if not token:
        # print("[agent] no enrollment token provided; cannot enroll.", file=sys.stderr) # Suppress console output
        return None

    try:
        api = api_mod.AgentAPI(server_url)
        data = api.enroll(
            token=token,
            hardware_hash=identity_mod.hardware_hash(),
            system_name=identity_mod.system_name(),
            os_type=identity_mod.os_type(),
            consent_name=consent_name,
            agent_version=AGENT_VERSION,
        )
    except Exception as exc:
        try:
            with open(config_mod.config_dir() / "enroll_error.log", "w") as f:
                f.write(f"Enrollment failed: {exc}\nServer URL: {server_url}\nToken: {token}\n")
        except:
            pass
        return None

    cfg.server_url = server_url
    cfg.device_id = data["deviceId"]
    cfg.device_secret = data["deviceSecret"]
    cfg.consent_name = consent_name
    cfg.enrolled_at = _now_iso()
    cfg.apply_server_config(data.get("config", {}))
    cfg.save()
    
    try:
        with open(config_mod.config_dir() / "enroll_success.log", "w") as f:
            f.write(f"Enrolled successfully as {cfg.device_id}\n")
    except:
        pass
        
    try:
        api = api_mod.AgentAPI(cfg.server_url, cfg.device_id, cfg.device_secret)
        api.heartbeat(AGENT_VERSION)
    except Exception:
        pass
        
    seed_path = config_mod.config_dir() / "enroll_seed.json"
    seed_path.unlink(missing_ok=True)
    return cfg


def uninstall_agent() -> None:
    """Remove local configuration and credentials."""
    path = config_mod.config_dir()
    print(f"[agent] Uninstalling: Removing data directory at {path}")
    try:
        if path.exists():
            shutil.rmtree(path)
        print("[agent] Uninstallation successful. Local identity wiped.")
    except Exception as exc:
        print(f"[agent] Uninstallation failed: {exc}", file=sys.stderr)


def main() -> int:
    import getpass
    print(f"[agent] Starting agent v{AGENT_VERSION} as user '{getpass.getuser()}'", file=sys.stderr)
    if "--uninstall" in sys.argv:
        uninstall_agent()
        return 0

    force_setup = "--setup" in sys.argv or "--install" in sys.argv

    cfg = ensure_enrolled(force_setup=force_setup)
    if cfg is None:
        return 0
    MonitoringAgent(cfg).run()
    return 0



if __name__ == "__main__":
    raise SystemExit(main())

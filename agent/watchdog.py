"""Windows Watchdog monitor.

Runs as a tiny, lightweight background supervisor process that monitors the
main agent process handle using Windows kernel event waiting (WaitForSingleObject).
Consumes virtually 0% CPU and negligible memory.
When the parent agent process terminates (killed, crashed, or closed unexpectedly),
this supervisor immediately respawns it.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time


def run_supervisor(target_pid: int, target_cmd: list[str]) -> None:
    """Supervise target_pid on Windows/macOS. When it exits, relaunch target_cmd."""
    if sys.platform.startswith("win"):
        import ctypes  # noqa: PLC0415
        from ctypes import wintypes  # noqa: PLC0415

        SYNCHRONIZE = 0x00100000
        WAIT_OBJECT_0 = 0x00000000
        INFINITE = 0xFFFFFFFF

        kernel32 = ctypes.windll.kernel32

        # Open handle to target process with SYNCHRONIZE rights
        h_proc = kernel32.OpenProcess(SYNCHRONIZE, False, wintypes.DWORD(target_pid))
        if not h_proc:
            return

        try:
            # Block efficiently until the monitored process terminates (uses 0% CPU)
            wait_res = kernel32.WaitForSingleObject(h_proc, INFINITE)
            if wait_res == WAIT_OBJECT_0:
                time.sleep(1.0)
                si = subprocess.STARTUPINFO()
                si.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 1)
                si.wShowWindow = 0

                subprocess.Popen(
                    target_cmd,
                    startupinfo=si,
                    close_fds=True,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
                    | getattr(subprocess, "DETACHED_PROCESS", 0x00000008),
                )
        finally:
            kernel32.CloseHandle(h_proc)
    else:
        # macOS / POSIX: Poll pid using os.kill(pid, 0)
        while True:
            try:
                os.kill(target_pid, 0)
            except OSError:
                # Target process has terminated
                break
            time.sleep(1.5)

        time.sleep(1.0)
        # Relaunch process detached
        subprocess.Popen(
            target_cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
        )


def spawn_watchdog_supervisor() -> None:
    """Invoked by the main agent to spawn a detached supervisor for itself."""
    # Don't spawn nested supervisors if already running in supervisor mode
    if "--watchdog-supervisor" in sys.argv:
        return

    try:
        current_pid = os.getpid()
        if getattr(sys, "frozen", False):
            # Running as compiled binary
            target_cmd = [sys.executable]
            supervisor_cmd = [sys.executable, "--watchdog-supervisor", str(current_pid)]
        else:
            # Running as python script
            target_cmd = [sys.executable, os.path.abspath(sys.argv[0])]
            supervisor_cmd = [
                sys.executable,
                os.path.abspath(__file__),
                "--watchdog-supervisor",
                str(current_pid),
            ]

        if sys.platform.startswith("win"):
            si = subprocess.STARTUPINFO()
            si.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 1)
            si.wShowWindow = 0

            subprocess.Popen(
                supervisor_cmd,
                startupinfo=si,
                close_fds=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
                | getattr(subprocess, "DETACHED_PROCESS", 0x00000008),
            )
        else:
            # macOS / Linux detached process
            subprocess.Popen(
                supervisor_cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
                start_new_session=True,
            )
    except Exception:
        pass


if __name__ == "__main__":
    if "--watchdog-supervisor" in sys.argv and len(sys.argv) >= 3:
        try:
            pid = int(sys.argv[2])
            if getattr(sys, "frozen", False):
                cmd = [sys.executable]
            else:
                agent_main = os.path.join(os.path.dirname(__file__), "agent.py")
                cmd = [sys.executable, agent_main]
            run_supervisor(pid, cmd)
        except Exception:
            pass

"""Run an Inno silent upgrade while watching the real desktop for setup UI."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from pywinauto import Desktop


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--installer", type=Path, required=True)
    parser.add_argument("--install-dir", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()

    command = [
        str(args.installer),
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        "/SP-",
        "/DIR=" + str(args.install_dir),
    ]
    process = subprocess.Popen(command)
    setup_windows: list[str] = []
    deadline = time.monotonic() + 180
    while process.poll() is None and time.monotonic() < deadline:
        try:
            for window in Desktop(backend="uia").windows():
                title = window.window_text()
                if "Workforce Analytics Agent Setup" in title:
                    if title not in setup_windows:
                        setup_windows.append(title)
                    process.kill()
        except Exception:
            # A transient UIA enumeration error is not evidence that setup is
            # silent; the final process/exit checks below still fail closed.
            pass
        time.sleep(0.1)

    timed_out = process.poll() is None
    if timed_out:
        process.kill()
    process.wait(timeout=30)
    result = {
        "command": command,
        "exit_code": process.returncode,
        "setup_windows": setup_windows,
        "timed_out": timed_out,
        "silent": not setup_windows and not timed_out and process.returncode == 0,
    }
    args.report.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    if not result["silent"]:
        print(json.dumps(result), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    if sys.platform != "win32":
        raise SystemExit("native Windows silent smoke cannot run off Windows")
    raise SystemExit(main())
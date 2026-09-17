"""Small native UIA driver for the regular Inno installer.

This module is intentionally limited to the first-install contract.  It uses
pywinauto's real Windows UI Automation backend, not image matching or source
text assertions.  It is only called by run-smoke.ps1 on a disposable CI
desktop.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import NoReturn

from pywinauto import Desktop
from pywinauto.application import Application
from pywinauto.keyboard import send_keys


def fail(message: str) -> "NoReturn":
    raise RuntimeError(message)


def wait_for_window(app: Application, timeout: float = 30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            windows = app.windows()
            if windows:
                return windows[0]
        except Exception:
            pass
        time.sleep(0.25)
    fail("Inno Setup did not create a UI Automation window")


def button(window, title: str):
    try:
        control = window.child_window(title=title, control_type="Button")
        control.wait("enabled", timeout=10)
        return control
    except Exception as exc:
        fail("installer UI is missing the %r button: %s" % (title, exc))


def edits(window):
    controls = list(window.descendants(control_type="Edit"))
    controls.sort(key=lambda control: control.rectangle().top)
    return controls


def assert_validation_stays_on_page(window, description: str) -> None:
    """Click Next with required data absent and require an error/modal."""
    before = len(edits(window))
    button(window, "Next >").click_input()
    time.sleep(0.5)
    # Inno's validation uses a real modal message box.  Finding and dismissing
    # it proves the event was handled, while the original wizard remains.
    try:
        dialogs = [
            candidate
            for candidate in Desktop(backend="uia").windows()
            if candidate.class_name() == "#32770" and candidate.is_visible()
        ]
        if not dialogs:
            fail("%s validation did not show a native error dialog" % description)
        ok = dialogs[-1].child_window(title="OK", control_type="Button")
        ok.wait("enabled", timeout=2)
        ok.click_input()
    except Exception as exc:
        fail("%s validation dialog was not usable: %s" % (description, exc))
    time.sleep(0.3)
    if len(edits(window)) != before:
        fail("%s validation advanced without the required value" % description)


def run(installer: Path, install_dir: Path, token: str, name: str) -> dict:
    if sys.platform != "win32":
        fail("native Windows UI smoke cannot run on this operating system")
    if os.environ.get("GITHUB_ACTIONS", "").lower() != "true":
        fail("refusing to drive a local desktop; GITHUB_ACTIONS=true is required")

    command = [str(installer), "/DIR=" + str(install_dir)]
    process = subprocess.Popen(command)
    app = Application(backend="uia").connect(process=process.pid, timeout=20)
    wizard = wait_for_window(app)
    if "Workforce Analytics Agent Setup" not in wizard.window_text():
        fail("unexpected first-install window: %s" % wizard.window_text())

    # Welcome page.
    button(wizard, "Next >").click_input()

    # Both fields are required by the real Pascal code.  Exercise the negative
    # path before entering controlled values.
    fields = edits(wizard)
    if len(fields) < 2:
        fail("first-install enrollment page did not expose two edit controls")
    assert_validation_stays_on_page(wizard, "enrollment")
    fields = edits(wizard)
    fields[0].set_edit_text(name)
    fields[1].set_edit_text(token)
    button(wizard, "Next >").click_input()

    checks = list(wizard.descendants(control_type="CheckBox"))
    if not checks:
        fail("first-install consent page did not expose a consent checkbox")
    consent = next(
        (
            check
            for check in checks
            if "consent" in check.window_text().lower()
        ),
        checks[0],
    )
    # Consent is also required; validate the unchecked path before proceeding.
    assert_validation_stays_on_page(wizard, "consent")
    consent = next(
        (
            check
            for check in wizard.descendants(control_type="CheckBox")
            if "consent" in check.window_text().lower()
        ),
        checks[0],
    )
    if not consent.get_toggle_state():
        consent.click_input()
    button(wizard, "Next >").click_input()

    # The install page may expose a Finish-page launch checkbox.  It must remain
    # enabled for this smoke so that [Run] launches the controlled fixture.
    install_button = button(wizard, "Install")
    install_button.click_input()
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if process.poll() is not None:
            break
        try:
            finish = wizard.child_window(title="Finish", control_type="Button")
            if finish.exists(timeout=0.2):
                for check in wizard.descendants(control_type="CheckBox"):
                    if "launch the agent" in check.window_text().lower():
                        if not check.get_toggle_state():
                            check.click_input()
                finish.click_input()
                break
        except Exception:
            pass
        time.sleep(0.25)
    else:
        process.kill()
        fail("interactive first install did not reach its Finish page")

    try:
        process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        process.kill()
        fail("interactive Inno Setup process did not exit")
    if process.returncode != 0:
        fail("interactive first install failed with exit code %s" % process.returncode)

    return {
        "installer": str(installer),
        "install_dir": str(install_dir),
        "enrollment_fields_checked": True,
        "consent_checkbox_checked": True,
        "setup_exit_code": process.returncode,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--installer", type=Path, required=True)
    parser.add_argument("--install-dir", type=Path, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    result = run(args.installer, args.install_dir, args.token, args.name)
    args.report.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print("UI smoke failed: %s" % exc, file=sys.stderr)
        raise
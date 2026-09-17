"""Native end-to-end Windows installer smoke flow."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any

try:
    from .desktop import (
        compare_identity_and_settings,
        gui_install,
        one_logical_tree,
        process_tree_snapshot,
        sanitize_error,
        sha256_file,
        secure_desktop_is_interactive,
        is_elevated,
        stop_active_installer,
        visible_setup_window,
        wait_for,
        windows_boot_time,
    )
    from .fixture import SyncFixture
    from .process_cleanup import OwnedProcesses
except ImportError:  # direct smoke/run.py invocation
    from desktop import (
        compare_identity_and_settings,
        gui_install,
        one_logical_tree,
        process_tree_snapshot,
        sanitize_error,
        sha256_file,
        secure_desktop_is_interactive,
        is_elevated,
        stop_active_installer,
        visible_setup_window,
        wait_for,
        windows_boot_time,
    )
    from fixture import SyncFixture
    from process_cleanup import OwnedProcesses

POLL = 0.5
TEST_DIR = "WorkforceAgent"


def _agent_dir() -> Path:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise RuntimeError("APPDATA must be the real disposable user's profile")
    return Path(appdata) / TEST_DIR


def _read_json_retry(path: Path, timeout: float = 20.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last: Exception | None = None
    while time.monotonic() < deadline:
        try:
            value = json.loads(path.read_text(encoding="utf-8-sig"))
            if isinstance(value, dict):
                return value
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            last = exc
        time.sleep(0.2)
    raise RuntimeError(f"could not read complete JSON file: {path.name}") from last


def _config() -> dict[str, Any]:
    return _read_json_retry(_agent_dir() / "config.json", 90)


def _known_exes() -> tuple[Path, ...]:
    return (
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / TEST_DIR / "WorkforceAgent.exe",
        Path.home() / "AppData" / "Local" / "Programs" / TEST_DIR / "WorkforceAgent.exe",
        Path(os.environ.get("ProgramFiles", "")) / TEST_DIR / "WorkforceAgent.exe",
    )


def _installed_exe() -> Path:
    for path in _known_exes():
        if path.is_file():
            return path
    raise RuntimeError("installed WorkforceAgent.exe was not found")


def _run(command: list[str], timeout: float = 60) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, text=True, capture_output=True, timeout=timeout, check=False)


def _births(pids: set[int]) -> dict[int, float]:
    try:
        import psutil
        result = {}
        for pid in pids:
            try:
                result[pid] = psutil.Process(pid).create_time()
            except psutil.Error:
                continue
        if not result and pids:
            raise RuntimeError("owned process birth times could not be inspected")
        return result
    except ImportError as exc:
        raise RuntimeError("psutil 7.0.0 is required for PID-reuse-safe cleanup") from exc


def _terminate_owned(owned: dict[int, float]) -> None:
    import psutil
    for pid, birth in list(owned.items()):
        try:
            process = psutil.Process(pid)
            if abs(process.create_time() - birth) > 0.01:
                continue
            process.terminate()
            process.wait(10)
        except psutil.Error:
            continue


def _wait_signed_update(
    fixture: SyncFixture,
    command_id: str,
    exe: Path,
    old_hash: str,
    boot: str,
    timeout: float = 300,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if visible_setup_window():
            raise RuntimeError("visible setup/UAC window appeared during silent update")
        rows = process_tree_snapshot()
        if rows and not one_logical_tree(rows):
            raise RuntimeError("multiple agent process trees during upgrade")
        with fixture.state.lock:
            update = fixture.state.update
            status = update.status if update else ""
            phases = list(update.acks) if update else []
            versions = list(fixture.state.heartbeats)
        if status == "completed":
            if windows_boot_time() != boot:
                raise RuntimeError("machine reboot detected")
            if phases != ["acknowledged", "downloading", "installing"]:
                raise RuntimeError("signed update ACK order was incomplete or regressed")
            if sha256_file(exe) == old_hash:
                raise RuntimeError("signed update heartbeat arrived before image changed")
            rows = process_tree_snapshot()
            if not one_logical_tree(rows):
                raise RuntimeError("candidate did not have one logical PyInstaller tree")
            first = {row["pid"] for row in rows}
            time.sleep(POLL)
            second_rows = process_tree_snapshot()
            second = {row["pid"] for row in second_rows}
            if not one_logical_tree(second_rows) or first != second:
                raise RuntimeError("candidate process tree was not steady")
            return {
                "command_id": command_id,
                "status": "completed",
                "acks": phases,
                "heartbeat_versions": versions,
                "installed_exe_sha256": sha256_file(exe),
                "pids": sorted(first),
            }
        time.sleep(POLL)
    raise TimeoutError("signed update did not complete")


def _negative(
    fixture: SyncFixture,
    path: Path,
    version: str,
    exe: Path,
    old_hash: str,
    expected_pids: set[int],
    expected_failure: str,
    boot: str,
) -> dict[str, Any]:
    command_id = fixture.state.queue_update(path, version)
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        if visible_setup_window():
            raise RuntimeError("rejected installer displayed a setup/security window")
        with fixture.state.lock:
            update = fixture.state.update
            status = update.status if update else ""
            phases = list(update.acks) if update else []
            failure = getattr(update, "failure_class", "")
        if status == "failed":
            if phases != ["acknowledged", "downloading", "failed"]:
                raise RuntimeError("negative update did not reach verification in order")
            if failure != expected_failure:
                raise RuntimeError("negative update failed for the wrong verification reason")
            if sha256_file(exe) != old_hash or windows_boot_time() != boot:
                raise RuntimeError("negative update changed image or rebooted")
            current = process_tree_snapshot()
            if {row["pid"] for row in current} != expected_pids or not one_logical_tree(current):
                raise RuntimeError("negative update changed the running agent tree")
            return {
                "command_id": command_id,
                "status": "failed",
                "acks": phases,
                "failure_class": failure,
                "hash_unchanged": True,
                "process_tree_unchanged": True,
            }
        time.sleep(POLL)
    raise TimeoutError("negative update did not fail closed")


def run_smoke(args: argparse.Namespace) -> dict[str, Any]:
    if os.name != "nt":
        raise RuntimeError("native Windows is required")
    for path_value in (args.baseline, args.candidate, args.unsigned, args.wrong_publisher):
        path = Path(path_value)
        if not path.is_absolute() or not path.is_file():
            raise FileNotFoundError(f"release path must be an existing absolute file: {path}")
    versions = (args.baseline_version, args.candidate_version)
    if any(not re.fullmatch(r"\d+\.\d+\.\d+", version) for version in versions):
        raise ValueError("baseline and candidate versions must be stable three-part versions")
    if tuple(map(int, versions[1].split("."))) <= tuple(map(int, versions[0].split("."))):
        raise ValueError("candidate version must be newer than baseline")
    if not secure_desktop_is_interactive():
        raise RuntimeError("an unlocked interactive desktop is required")
    if is_elevated():
        raise RuntimeError("run as a non-administrator user")
    agent_dir = _agent_dir()
    if agent_dir.exists():
        raise RuntimeError("refusing existing agent data; use a fresh disposable user")
    original_exes = {path: path.exists() for path in _known_exes()}
    if any(original_exes.values()):
        raise RuntimeError("refusing existing installed agent executable")
    if process_tree_snapshot():
        raise RuntimeError("refusing an existing running agent")
    owned: dict[int, float] = {}
    env = dict(os.environ)  # real APPDATA: never substitute a temporary folder
    baseline_process: subprocess.Popen[str] | None = None
    try:
        baseline = _run([args.baseline, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"])
        if baseline.returncode == 0:
            raise RuntimeError("fresh silent installer unexpectedly succeeded")
        if agent_dir.exists() or any((path.exists() and not original_exes[path]) for path in _known_exes()):
            raise RuntimeError("fresh silent installer mutated profile or installed files")
        with OwnedProcesses(_known_exes()) as tracker, SyncFixture() as fixture:
            installer_pids = gui_install(Path(args.baseline), env)
            try:
                owned.update(_births(installer_pids))
            except RuntimeError:
                # The wizard may have exited normally; dead installer PIDs
                # require no cleanup and must not be confused with reuse.
                pass
            seed_path = agent_dir / "enroll_seed.json"
            seed = _read_json_retry(seed_path)
            if seed.get("consent_acknowledged") is not True:
                raise RuntimeError("installer seed did not record consent")
            if not str(seed.get("server_url", "")).startswith("https://"):
                raise RuntimeError("installer seed did not contain the production server URL")
            seed["server_url"] = fixture.url
            # Agent.load_enroll_seed reads plain UTF-8: never emit a BOM.
            seed_path.write_text(json.dumps(seed, indent=2), encoding="utf-8")
            exe = _installed_exe()
            baseline_process = subprocess.Popen([str(exe)], env=env)
            tracker.add(baseline_process.pid)
            owned[baseline_process.pid] = _births({baseline_process.pid})[baseline_process.pid]
            wait_for(lambda: bool(fixture.state.device_id), 90)
            wait_for(lambda: not seed_path.exists(), 30)
            baseline_config = wait_for(_config, 90)
            secret = str(baseline_config.get("device_secret") or "")
            if not secret:
                raise RuntimeError("enrollment did not persist device secret")
            wait_for(lambda: args.baseline_version in fixture.state.heartbeats, 90)
            rows = wait_for(lambda: process_tree_snapshot() if one_logical_tree(process_tree_snapshot()) else None, 30)
            baseline_pids = {row["pid"] for row in rows}
            owned.update(_births(baseline_pids))
            boot = windows_boot_time()
            update_id = fixture.state.queue_update(Path(args.candidate), args.candidate_version)
            result = _wait_signed_update(fixture, update_id, exe, sha256_file(exe), boot)
            candidate_pids = set(result["pids"])
            if baseline_pids & candidate_pids:
                raise RuntimeError("baseline WorkforceAgent process remained in candidate tree")
            owned.update(_births(candidate_pids))
            after = _config()
            if after.get("device_secret") != secret:
                raise RuntimeError("device secret changed across update")
            if baseline_config.get("device_id") != fixture.state.device_id or secret != fixture.state.device_secret:
                raise RuntimeError("persisted enrollment does not match authenticated fixture identity")
            retention = compare_identity_and_settings(baseline_config, after)
            if not retention["required_keys_present"] or not retention["identity_retained"] or not retention["settings_retained"]:
                raise RuntimeError("identity/settings were not retained")
            negatives = [
                _negative(fixture, Path(args.unsigned), "9.0.0", exe, result["installed_exe_sha256"], candidate_pids, "unsigned_rejected", boot),
                _negative(fixture, Path(args.wrong_publisher), "9.0.1", exe, result["installed_exe_sha256"], candidate_pids, "publisher_rejected", boot),
            ]
            return {
                "status": "passed",
                "candidate_sha256": sha256_file(Path(args.candidate)).lower(),
                "installed_exe_sha256": result["installed_exe_sha256"],
                "baseline_version": args.baseline_version,
                "candidate_version": args.candidate_version,
                "checks": {
                    "fresh_silent_rejected": True,
                    "gui_consent_and_seed": True,
                    "enrollment": True,
                    "identity_settings": retention,
                    "signed_upgrade": result,
                    "negative_updates": negatives,
                    "no_reboot": True,
                    "one_logical_pyinstaller_tree": True,
                    "heartbeat": {
                        "version": args.candidate_version,
                        "fixture_observation_only": True,
                        "not_real_api_db_test": True,
                    },
                    "capture_payloads_discarded": True,
                },
            }
    finally:
        stop_active_installer()
        if baseline_process is not None and baseline_process.poll() is None:
            try:
                baseline_process.terminate()
            except OSError:
                pass
        _terminate_owned(owned)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    for name in ("baseline", "candidate", "unsigned", "wrong-publisher", "baseline-version", "candidate-version", "output"):
        result.add_argument(f"--{name}", required=True)
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        report = run_smoke(args)
    except Exception as exc:  # noqa: BLE001
        report = {"status": "failed", "error": sanitize_error(exc)}
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    return 0 if report.get("status") == "passed" else 1

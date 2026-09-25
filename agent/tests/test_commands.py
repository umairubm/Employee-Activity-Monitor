"""Contract tests for the remote-command lifecycle (Python agent).

Run from the repo root:  python3 -m unittest discover -s agent/tests

All HTTP (self.api) and OS calls are mocked; these tests pin the
delivery -> acknowledge -> execute -> truthful-result contract shared with the
Node agent (agent-node/test/command-runner.test.mjs).
"""

from __future__ import annotations

import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

# The agent module imports `requests` (via agent.api) at import time; stub it
# so the tests run without network dependencies installed.
if "requests" not in sys.modules:
    sys.modules["requests"] = types.ModuleType("requests")
# consent.py imports tkinter, which may be missing on headless CI machines.
for name in ("tkinter", "tkinter.font"):
    if name not in sys.modules:
        try:
            __import__(name)
        except Exception:  # noqa: BLE001
            sys.modules[name] = types.ModuleType(name)

sys.path.insert(0, "agent/..")  # repo root
from agent.agent import MonitoringAgent  # noqa: E402

CMD_ID = "11111111-1111-4111-8111-111111111111"


def make_agent(journal_dir: str | None = None) -> MonitoringAgent:
    """Bare agent with mocked API/tray — skips the heavy __init__."""
    agent = object.__new__(MonitoringAgent)
    agent.api = mock.Mock()
    agent.tray = None
    agent.cfg = mock.Mock()
    agent._lock = __import__('threading').Lock()
    agent._journal = mock.Mock()
    agent._handled_command_ids = set()
    # Point the durable result journal at a temp file (never the real config).
    path = Path(journal_dir or tempfile.mkdtemp()) / "command-results.json"
    agent._results_path = lambda: path  # type: ignore[method-assign]
    agent._command_results = agent._load_command_results()
    return agent


def command(**over) -> dict:
    base = {
        "id": CMD_ID,
        "commandType": "lock_screen",
        "reason": "Security audit",
        "payload": None,
    }
    base.update(over)
    return base


class HandleCommandContract(unittest.TestCase):
    def test_ack_acknowledged_before_execution_then_completed(self):
        agent = make_agent()
        order = []
        agent.api.ack_command.side_effect = lambda cid, status, *a: order.append(status)
        with mock.patch.object(agent, "_execute_os_command", lambda t: order.append("exec")), \
             mock.patch("time.sleep"):
            agent._handle_command(command())
        self.assertEqual(order, ["acknowledged", "exec", "completed"])

    def test_malformed_delivery_is_ignored_without_ack(self):
        agent = make_agent()
        agent._handle_command({"commandType": "lock_screen"})  # no id
        agent._handle_command({"id": CMD_ID})  # no type
        agent._handle_command({"id": 42, "commandType": "lock_screen"})
        agent.api.ack_command.assert_not_called()

    def test_failed_acknowledgement_blocks_execution_and_allows_retry(self):
        agent = make_agent()
        executed = []
        agent.api.ack_command.side_effect = RuntimeError("network down")
        with mock.patch.object(
            agent, "_execute_power_command", lambda t: executed.append(t) or True
        ), mock.patch("time.sleep"):
            agent._handle_command(command(commandType="shutdown"))
        self.assertEqual(executed, [])
        # Only the failed "acknowledged" attempt — no completed/failed ack.
        self.assertEqual(agent.api.ack_command.call_count, 1)
        # The id is retriable when the server redelivers.
        self.assertNotIn(CMD_ID, agent._handled_command_ids)

        agent.api.ack_command.side_effect = None
        with mock.patch.object(
            agent, "_execute_power_command", lambda t: executed.append(t) or True
        ), mock.patch("time.sleep"):
            agent._handle_command(command(commandType="shutdown"))
        self.assertEqual(executed, ["shutdown"])

    def test_redelivered_command_never_executes_twice(self):
        agent = make_agent()
        executed = []
        with mock.patch.object(
            agent, "_execute_power_command", lambda t: executed.append(t) or True
        ), mock.patch("time.sleep"):
            agent._handle_command(command(commandType="restart"))
            agent._handle_command(command(commandType="restart"))  # redelivery
        self.assertEqual(executed, ["restart"])
        completed = [
            c for c in agent.api.ack_command.call_args_list if c.args[1] == "completed"
        ]
        self.assertEqual(len(completed), 1)

    def test_restart_completed_only_after_os_accepts_schedule(self):
        agent = make_agent()
        order = []
        agent.api.ack_command.side_effect = lambda cid, status, *a: order.append(
            f"ack:{status}"
        )
        with mock.patch.object(
            agent, "_execute_power_command", lambda t: order.append("schedule") or True
        ), mock.patch("time.sleep"):
            agent._handle_command(command(commandType="restart"))
        self.assertEqual(order, ["ack:acknowledged", "schedule", "ack:completed"])

    def test_rejected_shutdown_reports_failed_with_reason(self):
        agent = make_agent()
        with mock.patch.object(agent, "_execute_power_command", lambda t: False), \
             mock.patch("time.sleep"):
            agent._handle_command(command(commandType="shutdown"))
        last = agent.api.ack_command.call_args_list[-1]
        self.assertEqual(last.args[1], "failed")
        self.assertIn("could not schedule shut down", last.args[2])

    def test_cancel_power_command_requests_os_abort(self):
        agent = make_agent()
        completed = types.SimpleNamespace(returncode=0)
        with mock.patch("agent.agent.sys.platform", "win32"), \
             mock.patch("agent.agent.subprocess.run", return_value=completed) as run:
            self.assertTrue(agent._cancel_power_command("shutdown"))
        run.assert_called_once_with(["shutdown", "/a"], check=False)

    def test_unsupported_command_type_reports_failed(self):
        agent = make_agent()
        agent._handle_command(command(commandType="self_destruct"))
        last = agent.api.ack_command.call_args_list[-1]
        self.assertEqual(last.args[1], "failed")
        self.assertIn("unsupported command type: self_destruct", last.args[2])

    def test_reset_password_failure_never_leaks_the_password(self):
        agent = make_agent()
        secret = "Sup3r-S3cret!"

        def boom(payload, reason):
            raise RuntimeError(f"boom {secret}")

        with mock.patch.object(agent, "_reset_password", boom):
            agent._handle_command(
                command(
                    commandType="reset_password",
                    payload=f'{{"newPassword": "{secret}"}}',
                )
            )
        last = agent.api.ack_command.call_args_list[-1]
        self.assertEqual(last.args[1], "failed")
        self.assertNotIn(secret, last.args[2])

    def test_unlock_screen_clears_lock_state(self):
        agent = make_agent()
        agent._admin_lock_enforced = True
        agent._locked_until = "2026-01-01T00:00:00Z"
        agent._handle_command(command(commandType="unlock_screen"))
        self.assertFalse(agent._admin_lock_enforced)
        self.assertIsNone(agent._locked_until)
        last = agent.api.ack_command.call_args_list[-1]
        self.assertEqual(last.args[1], "completed")


class DurableResultJournal(unittest.TestCase):
    def test_result_is_journaled_before_the_final_ack(self):
        agent = make_agent()
        order = []
        agent.api.ack_command.side_effect = lambda cid, status, *a: order.append(
            f"ack:{status}"
        )
        original = MonitoringAgent._record_command_result

        def recording(self_, cid, status, message):
            order.append("journal")
            original(self_, cid, status, message)

        with mock.patch.object(MonitoringAgent, "_record_command_result", recording), \
             mock.patch.object(agent, "_execute_power_command", lambda t: True), \
             mock.patch("time.sleep"):
            agent._handle_command(command(commandType="shutdown"))
        self.assertEqual(order, ["ack:acknowledged", "journal", "ack:completed"])

    def test_lost_final_ack_plus_restart_reacks_journal_without_reexecuting(self):
        journal_dir = tempfile.mkdtemp()
        # Session 1: shutdown executes; the completed ack is LOST (the machine
        # goes down before the response arrives) — the result was journaled.
        agent1 = make_agent(journal_dir)
        executed = []

        def ack(cid, status, *a):
            if status == "completed":
                raise RuntimeError("connection reset")

        agent1.api.ack_command.side_effect = ack
        with mock.patch.object(
            agent1, "_execute_power_command", lambda t: executed.append(t) or True
        ), mock.patch("time.sleep"):
            agent1._handle_command(command(commandType="shutdown"))
        self.assertEqual(executed, ["shutdown"])

        # Session 2: fresh agent process after the reboot loads the journal;
        # the server redelivers the still-acknowledged command.
        agent2 = make_agent(journal_dir)
        with mock.patch.object(
            agent2, "_execute_power_command", lambda t: executed.append(t) or True
        ), mock.patch("time.sleep"):
            agent2._handle_command(command(commandType="shutdown"))
        self.assertEqual(executed, ["shutdown"], "must not power-cycle twice")
        agent2.api.ack_command.assert_called_once_with(CMD_ID, "completed", None)

    def test_failed_reack_of_journaled_result_stays_retriable(self):
        agent = make_agent()
        agent._command_results[CMD_ID] = {"status": "failed", "message": "requires admin"}
        agent.api.ack_command.side_effect = RuntimeError("network down")
        agent._handle_command(command())
        self.assertNotIn(CMD_ID, agent._handled_command_ids)

        agent.api.ack_command.side_effect = None
        agent._handle_command(command())
        agent.api.ack_command.assert_called_with(CMD_ID, "failed", "requires admin")

    def test_invalid_update_payload_is_journaled_and_not_reprocessed_after_restart(self):
        journal_dir = tempfile.mkdtemp()
        agent1 = make_agent(journal_dir)
        agent1._handle_command(command(commandType="update_agent", payload=None))
        self.assertEqual(
            agent1._command_results[CMD_ID],
            {"status": "failed", "message": "missing update payload"},
        )

        agent2 = make_agent(journal_dir)
        agent2._handle_command(command(commandType="update_agent", payload=None))
        agent2.api.command_download_url.assert_not_called()
        agent2.api.ack_command.assert_called_once_with(
            CMD_ID, "failed", "missing update payload"
        )

    def test_invalid_update_source_is_journaled_and_not_reprocessed_after_restart(self):
        journal_dir = tempfile.mkdtemp()
        update = command(
            commandType="update_agent",
            payload='{"version":"9.9.9","fileName":"agent.exe"}',
        )
        agent1 = make_agent(journal_dir)
        agent1.api.command_download_url.return_value = {
            "downloadUrl": "file:///not-supported",
            "fileName": "agent.exe",
        }
        agent1._handle_command(update)
        self.assertEqual(
            agent1._command_results[CMD_ID],
            {"status": "failed", "message": "unsupported update source"},
        )

        agent2 = make_agent(journal_dir)
        agent2._handle_command(update)
        agent2.api.command_download_url.assert_not_called()
        agent2.api.ack_command.assert_called_once_with(
            CMD_ID, "failed", "unsupported update source"
        )

    def test_update_failure_after_download_is_journaled_before_restart_redelivery(self):
        journal_dir = tempfile.mkdtemp()
        update = command(
            commandType="update_agent",
            payload='{"version":"9.9.9","fileName":"agent.exe"}',
        )
        agent1 = make_agent(journal_dir)
        agent1.api.command_download_url.return_value = {
            "downloadUrl": "https://example.test/agent.exe",
            "fileName": "agent.exe",
        }

        class DownloadResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def iter_content(self, chunk_size):
                yield b"installer-bytes"

        agent1.api.download_file.return_value = DownloadResponse()
        with mock.patch.object(sys, "platform", "win32"), \
             mock.patch("agent.agent.subprocess.CREATE_NO_WINDOW", 0x08000000, create=True), \
             mock.patch("agent.agent.subprocess.DETACHED_PROCESS", 0x00000008, create=True), \
             mock.patch.object(
                 MonitoringAgent,
                 "_finish_command",
                 wraps=agent1._finish_command,
             ), \
             mock.patch(
                 "agent.agent.verify_windows_installer",
                 return_value={"status": "Valid", "subject": "CN=Workforce Analytics"},
             ), \
             mock.patch.object(
                 __import__("agent.agent", fromlist=["subprocess"]).subprocess,
                 "STARTUPINFO",
                 return_value=types.SimpleNamespace(
                     dwFlags=0, wShowWindow=0
                 ),
                 create=True,
             ), \
             mock.patch(
                 "agent.agent.subprocess.Popen",
                 side_effect=RuntimeError("installer launch failed"),
              ) as popen:
            agent1._handle_command(update)

        popen.assert_called_once()
        self.assertEqual(popen.call_args.kwargs["creationflags"], 0x08000000)
        self.assertFalse(
            popen.call_args.kwargs["creationflags"] & 0x00000008,
            "DETACHED_PROCESS would cause Windows to ignore CREATE_NO_WINDOW",
        )
        self.assertEqual(
            popen.call_args.args[0][1:],
            ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-", "/FORCECLOSEAPPLICATIONS"],
        )
        self.assertEqual(agent1._command_results[CMD_ID]["status"], "failed")
        self.assertEqual(agent1.api.download_file.call_count, 1)

        agent2 = make_agent(journal_dir)
        agent2._handle_command(update)
        agent2.api.command_download_url.assert_not_called()
        agent2.api.download_file.assert_not_called()
        self.assertEqual(agent2.api.ack_command.call_args.args[1], "failed")

    def test_untrusted_windows_update_is_rejected_before_install_launch(self):
        update = command(
            commandType="update_agent",
            payload='{"version":"9.9.9","fileName":"agent.exe"}',
        )
        agent = make_agent()
        agent.api.command_download_url.return_value = {
            "downloadUrl": "https://example.test/agent.exe",
            "fileName": "agent.exe",
        }

        class DownloadResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def iter_content(self, chunk_size):
                yield b"unsigned-installer"

        agent.api.download_file.return_value = DownloadResponse()
        with mock.patch.object(sys, "platform", "win32"), mock.patch(
            "agent.agent.verify_windows_installer",
            side_effect=ValueError(
                "downloaded Windows installer is unsigned or not trusted"
            ),
        ), mock.patch("agent.agent.subprocess.Popen") as popen:
            agent._handle_command(update)

        popen.assert_not_called()
        statuses = [call.args[1] for call in agent.api.ack_command.call_args_list]
        self.assertEqual(statuses, ["acknowledged", "downloading", "failed"])
        self.assertNotIn("installing", statuses)
        self.assertIn("unsigned", agent._command_results[CMD_ID]["message"])


class MacOsUpdateContract(unittest.TestCase):
    """macOS app-archive self-update: validation, safety, and the swap handoff."""

    def test_app_bundle_path_resolves_the_app_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            exe = Path(tmp) / "WorkforceAgent.app" / "Contents" / "MacOS" / "WorkforceAgent"
            exe.parent.mkdir(parents=True)
            exe.write_text("")
            found = MonitoringAgent._macos_app_bundle_path(str(exe))
            self.assertIsNotNone(found)
            self.assertEqual(found.name, "WorkforceAgent.app")
        self.assertIsNone(MonitoringAgent._macos_app_bundle_path("/usr/bin/python3"))

    @staticmethod
    def _make_app(root: Path, name="WorkforceAgent.app",
                  bundle_id="com.workforceanalytics.agent") -> Path:
        import plistlib
        app = root / name
        executable = app / "Contents" / "MacOS" / "WorkforceAgent"
        executable.parent.mkdir(parents=True)
        executable.write_text("")
        with open(app / "Contents" / "Info.plist", "wb") as fh:
            plistlib.dump(
                {
                    "CFBundleIdentifier": bundle_id,
                    "CFBundleShortVersionString": "5.1.0",
                    "CFBundleExecutable": "WorkforceAgent",
                },
                fh,
            )
        return app

    def _extract(self, dest_dir, ditto_rc=0, codesign_rc=0):
        def fake_run(argv, **_kwargs):
            if argv[0] == "ditto":
                return types.SimpleNamespace(
                    returncode=ditto_rc, stdout=b"", stderr=b""
                )
            if argv[:2] == ["codesign", "-dv"]:
                return types.SimpleNamespace(
                    returncode=0, stdout="", stderr="TeamIdentifier=TESTTEAM\n"
                )
            return types.SimpleNamespace(
                returncode=codesign_rc, stdout=b"", stderr=b""
            )

        with mock.patch("agent.agent.subprocess.run", side_effect=fake_run):
            return MonitoringAgent._macos_extract_app(
                "/tmp/archive.zip", dest_dir, "5.1.0", "TESTTEAM"
            )

    def test_extract_validates_bundle_identity_and_signature(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._make_app(Path(tmp))
            app = self._extract(tmp)
            self.assertEqual(app.name, "WorkforceAgent.app")

        # Wrong bundle identifier is refused.
        with tempfile.TemporaryDirectory() as tmp:
            self._make_app(Path(tmp), bundle_id="com.evil.other")
            with self.assertRaisesRegex(ValueError, "bundle identifier"):
                self._extract(tmp)

        # A failed signature check is refused.
        with tempfile.TemporaryDirectory() as tmp:
            self._make_app(Path(tmp))
            with self.assertRaisesRegex(ValueError, "code signature"):
                self._extract(tmp, codesign_rc=1)

        # Zero or multiple apps in the archive are refused.
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, "only WorkforceAgent.app"):
                self._extract(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            self._make_app(Path(tmp))
            self._make_app(Path(tmp), name="Other.app")
            with self.assertRaisesRegex(ValueError, "only WorkforceAgent.app"):
                self._extract(tmp)

    def test_not_running_from_app_bundle_fails_truthfully(self):
        agent = make_agent()
        with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
            archive = tmp.name
        with mock.patch.object(
            MonitoringAgent, "_macos_extract_app", return_value=Path("/tmp/x.app")
        ), mock.patch.object(
            MonitoringAgent, "_macos_app_bundle_path", return_value=None
        ):
            agent._update_agent_macos(CMD_ID, archive, "5.1.0")
        status, message = (
            agent._command_results[CMD_ID]["status"],
            agent._command_results[CMD_ID]["message"],
        )
        self.assertEqual(status, "failed")
        self.assertIn("app bundle", message)

    def test_unwritable_install_location_fails_with_readable_reason(self):
        agent = make_agent()
        with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
            archive = tmp.name
        with mock.patch.object(
            MonitoringAgent, "_macos_extract_app", return_value=Path("/tmp/x.app")
        ), mock.patch.object(
            MonitoringAgent,
            "_macos_app_bundle_path",
            return_value=Path("/Applications/WorkforceAgent.app"),
        ), mock.patch("agent.agent.os.access", return_value=False):
            agent._update_agent_macos(CMD_ID, archive, "5.1.0")
        self.assertEqual(agent._command_results[CMD_ID]["status"], "failed")
        self.assertIn("permission", agent._command_results[CMD_ID]["message"])

    def test_happy_path_acks_installing_launches_replacer_and_quits(self):
        agent = make_agent()
        agent.quit = mock.Mock()
        popen_calls = []
        with tempfile.TemporaryDirectory() as tmp:
            current_app = Path(tmp) / "WorkforceAgent.app"
            current_app.mkdir()
            with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as f:
                archive = f.name
            with mock.patch.object(
                MonitoringAgent, "_macos_extract_app", return_value=Path("/tmp/new.app")
            ), mock.patch.object(
                MonitoringAgent, "_macos_app_bundle_path", return_value=current_app
            ), mock.patch.object(
                MonitoringAgent,
                "_macos_signature_team_id",
                return_value="TESTTEAM",
            ), mock.patch(
                "agent.agent.subprocess.Popen",
                side_effect=lambda argv, **kw: popen_calls.append(argv) or mock.Mock(),
            ):
                agent._update_agent_macos(CMD_ID, archive, "5.1.0")

        agent.api.ack_command.assert_called_once_with(CMD_ID, "installing")
        agent.quit.assert_called_once()
        self.assertEqual(len(popen_calls), 1)
        argv = popen_calls[0]
        self.assertEqual(argv[0], "/bin/bash")
        self.assertIn("/tmp/new.app", argv)
        self.assertIn(str(current_app), argv)

    def test_remote_update_quit_stops_tray_loop_so_parent_can_exit(self):
        agent = make_agent()
        agent._stop = mock.Mock()
        agent.quit()
        agent._stop.set.assert_called_once()


class ParsePayload(unittest.TestCase):
    def test_defensive_parsing(self):
        parse = MonitoringAgent._parse_payload
        self.assertEqual(parse(None), {})
        self.assertEqual(parse("not json"), {})
        self.assertEqual(parse("42"), {})
        self.assertEqual(parse('{"a": 1}'), {"a": 1})
        self.assertEqual(parse({"a": 1}), {"a": 1})


if __name__ == "__main__":
    unittest.main()

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
        agent._enforced_lock = True
        agent._locked_until = "2026-01-01T00:00:00Z"
        agent._handle_command(command(commandType="unlock_screen"))
        self.assertFalse(agent._enforced_lock)
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

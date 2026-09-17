"""Loopback-only sync protocol fixture for the native Windows smoke test."""

from __future__ import annotations

import http.server
import json
import secrets
import threading
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

TEST_TOKEN = "smoke-test-token"
TEST_NAME = "Smoke Test Employee"


def classify_failure(message: object) -> str:
    text = str(message or "").casefold()
    if "downloaded windows installer publisher does not match" in text:
        return "publisher_rejected"
    if "downloaded windows installer is unsigned or not trusted" in text:
        return "unsigned_rejected"
    return "installer_rejected"


@dataclass
class UpdateCommand:
    command_id: str
    version: str
    path: Path
    file_name: str
    status: str = "pending"
    acks: list[str] = field(default_factory=list)
    failure_class: str = ""


class FixtureState:
    config = {
        "monitoringEnabled": False,
        "screenshotMinMinutes": 1440,
        "screenshotMaxMinutes": 1440,
        "idleThresholdSeconds": 47,
        "syncIntervalSeconds": 10,
        "usbBlockEnabled": False,
    }

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.token_used = False
        self.device_id = ""
        self.device_secret = ""
        self.consent_name = ""
        self.heartbeats: list[str] = []
        self.activities = 0
        self.screenshots = 0
        self.update: UpdateCommand | None = None
        self.failures: deque[str] = deque(maxlen=8)

    def auth_ok(self, headers: Any) -> bool:
        return bool(self.device_id) and headers.get("x-device-id") == self.device_id and headers.get(
            "x-device-secret"
        ) == self.device_secret

    def enroll(self, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        with self.lock:
            required = ("hardwareHash", "systemName", "osType", "consentName")
            if body.get("token") != TEST_TOKEN or self.token_used:
                return 403, {"error": "Enrollment token invalid or exhausted"}
            if any(not isinstance(body.get(k), str) or not body[k].strip() for k in required):
                return 400, {"error": "invalid enrollment payload"}
            if body.get("osType") != "windows" or body.get("consentAcknowledged") is not True:
                return 400, {"error": "explicit Windows consent is required"}
            self.token_used = True
            self.device_id = str(uuid.uuid4())
            self.device_secret = secrets.token_urlsafe(30)
            self.consent_name = body["consentName"]
            return 201, {
                "deviceId": self.device_id,
                "deviceSecret": self.device_secret,
                "config": dict(self.config),
            }

    def queue_update(self, path: Path, version: str) -> str:
        with self.lock:
            self.update = UpdateCommand(str(uuid.uuid4()), version, path, f"WorkforceAgent-Setup-{version}.exe")
            return self.update.command_id

    def heartbeat(self, body: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            version = str(body.get("agentVersion") or "")
            self.heartbeats.append(version)
            update = self.update
            # Only the replacement's authenticated heartbeat completes an
            # update.  The replacement does not send a completed ACK.
            if update and update.status == "installing" and version == update.version:
                update.status = "completed"
            commands = []
            if update and update.status in {"pending", "acknowledged", "downloading", "installing"}:
                commands.append(
                    {
                        "id": update.command_id,
                        "commandType": "update_agent",
                        "payload": json.dumps(
                            {
                                "version": update.version,
                                "kind": "installer",
                                "platform": "windows",
                                "fileName": update.file_name,
                            }
                        ),
                        "reason": "Windows smoke fixture update",
                    }
                )
            return {
                "serverTime": "2026-01-01T00:00:00+00:00",
                "isLocked": False,
                "lockedUntil": None,
                # Do not repair settings lost during upgrade; the non-default
                # values supplied at enrollment must survive on disk.
                "config": {},
                "commands": commands,
                "cancellations": [],
            }

    def acknowledge(self, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        with self.lock:
            update = self.update
            if not update or body.get("commandId") != update.command_id:
                return 404, {"error": "command not found"}
            status = str(body.get("status") or "")
            expected = {
                "pending": {"acknowledged"},
                "acknowledged": {"downloading"},
                "downloading": {"installing", "failed"},
                "installing": {"failed"},
            }
            if status == "completed" or status not in expected.get(update.status, set()):
                return 400, {"error": "invalid command phase"}
            update.status = status
            update.acks.append(status)
            if status == "failed":
                update.failure_class = classify_failure(body.get("message"))
                self.failures.append(update.failure_class)
            return 200, {"id": update.command_id, "status": update.status}

    def release(self, command_id: str) -> bytes | None:
        update = self.update
        if not update or update.command_id != command_id:
            return None
        try:
            return update.path.read_bytes()
        except OSError:
            return None


class _Handler(http.server.BaseHTTPRequestHandler):
    server_version = "WorkforceSmokeFixture/1"

    @property
    def state(self) -> FixtureState:
        return self.server.state  # type: ignore[attr-defined]

    def log_message(self, *_args: Any) -> None:
        return

    def body(self) -> dict[str, Any]:
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return {}
        return value if isinstance(value, dict) else {}

    def reply(self, status: int, value: Any) -> None:
        raw = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self) -> None:  # noqa: N802
        path, body = urlparse(self.path).path, self.body()
        if path == "/api/sync/validate-token":
            valid = body.get("token") == TEST_TOKEN and not self.state.token_used
            self.reply(200 if valid else 401, {"valid": valid})
            return
        if path == "/api/sync/enroll":
            status, value = self.state.enroll(body)
            self.reply(status, value)
            return
        if not self.state.auth_ok(self.headers):
            self.reply(401, {"error": "device authentication failed"})
            return
        if path == "/api/sync/heartbeat":
            self.reply(200, self.state.heartbeat(body))
        elif path == "/api/sync/activity":
            with self.state.lock:
                self.state.activities += len(body.get("logs") or [])
            ids = [x.get("segmentId") for x in body.get("logs", []) if isinstance(x, dict)]
            self.reply(201, {"acceptedSegmentIds": [x for x in ids if isinstance(x, str)]})
        elif path == "/api/sync/screenshots":
            with self.state.lock:
                self.state.screenshots += 1
            self.reply(202, {"id": str(uuid.uuid4()), "status": "pending"})
        elif path == "/api/sync/commands/ack":
            status, value = self.state.acknowledge(body)
            self.reply(status, value)
        elif path == "/api/sync/commands/download-url":
            update = self.state.update
            if not update or body.get("commandId") != update.command_id:
                self.reply(404, {"error": "command not found"})
            else:
                self.reply(
                    200,
                    {
                        "version": update.version,
                        "kind": "installer",
                        "platform": "windows",
                        "fileName": update.file_name,
                        "downloadUrl": f"{self.server.base_url}/release/{update.command_id}",  # type: ignore[attr-defined]
                    },
                )
        else:
            self.reply(404, {"error": "not found"})

    def do_GET(self) -> None:  # noqa: N802
        command_id = urlparse(self.path).path.removeprefix("/release/")
        content = self.state.release(command_id) if self.path.startswith("/release/") else None
        if content is None:
            self.reply(404, {"error": "release not found"})
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


class SyncFixture:
    def __init__(self) -> None:
        self.state = FixtureState()
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.server.state = self.state  # type: ignore[attr-defined]
        self.server.base_url = f"http://127.0.0.1:{self.server.server_port}"  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return self.server.base_url  # type: ignore[attr-defined]

    def __enter__(self) -> "SyncFixture":
        self.thread.start()
        return self

    def __exit__(self, *_args: Any) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

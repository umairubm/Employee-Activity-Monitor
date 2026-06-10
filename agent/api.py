"""Thin HTTP client for the Workforce Analytics sync API.

All agent-server communication goes through here. Device requests authenticate
with the device id + secret issued once at enrollment.
"""

from __future__ import annotations

from typing import Any, Optional

import requests


class APIError(Exception):
    pass


class AgentAPI:
    def __init__(
        self,
        server_url: str,
        device_id: Optional[str] = None,
        device_secret: Optional[str] = None,
        timeout: int = 30,
    ) -> None:
        self.base = server_url.rstrip("/")
        self.device_id = device_id
        self.device_secret = device_secret
        self.timeout = timeout

    def _auth_headers(self) -> dict:
        if not self.device_id or not self.device_secret:
            raise APIError("Agent is not enrolled; missing device credentials")
        return {
            "x-device-id": self.device_id,
            "x-device-secret": self.device_secret,
        }

    def _url(self, path: str) -> str:
        return f"{self.base}/api/sync{path}"

    def enroll(
        self,
        token: str,
        hardware_hash: str,
        system_name: str,
        os_type: str,
        consent_name: str,
        agent_version: str,
    ) -> dict:
        resp = requests.post(
            self._url("/enroll"),
            json={
                "token": token,
                "hardwareHash": hardware_hash,
                "systemName": system_name,
                "osType": os_type,
                "agentVersion": agent_version,
                "consentAcknowledged": True,
                "consentName": consent_name,
            },
            timeout=self.timeout,
        )
        if resp.status_code != 201:
            raise APIError(f"Enrollment failed ({resp.status_code}): {resp.text}")
        data = resp.json()
        self.device_id = data["deviceId"]
        self.device_secret = data["deviceSecret"]
        return data

    def heartbeat(self, agent_version: str) -> dict:
        resp = requests.post(
            self._url("/heartbeat"),
            json={"agentVersion": agent_version},
            headers=self._auth_headers(),
            timeout=self.timeout,
        )
        if resp.status_code != 200:
            raise APIError(f"Heartbeat failed ({resp.status_code}): {resp.text}")
        return resp.json()

    def send_activity(self, logs: list[dict]) -> dict:
        resp = requests.post(
            self._url("/activity"),
            json={"logs": logs},
            headers=self._auth_headers(),
            timeout=self.timeout,
        )
        if resp.status_code != 201:
            raise APIError(f"Activity upload failed ({resp.status_code}): {resp.text}")
        return resp.json()

    def request_screenshot_url(self) -> dict:
        resp = requests.post(
            self._url("/screenshots/request-url"),
            headers=self._auth_headers(),
            timeout=self.timeout,
        )
        if resp.status_code != 200:
            raise APIError(f"Upload-URL request failed ({resp.status_code}): {resp.text}")
        return resp.json()

    def upload_screenshot_bytes(self, upload_url: str, data: bytes) -> None:
        resp = requests.put(
            upload_url,
            data=data,
            headers={"Content-Type": "image/webp"},
            timeout=self.timeout,
        )
        if resp.status_code not in (200, 201):
            raise APIError(f"Screenshot PUT failed ({resp.status_code}): {resp.text}")

    def report_screenshot(self, storage_key: str, captured_at: str, size: int) -> dict:
        resp = requests.post(
            self._url("/screenshots"),
            json={
                "storageKey": storage_key,
                "capturedAt": captured_at,
                "fileSizeBytes": size,
            },
            headers=self._auth_headers(),
            timeout=self.timeout,
        )
        if resp.status_code != 201:
            raise APIError(f"Screenshot report failed ({resp.status_code}): {resp.text}")
        return resp.json()

    def ack_command(self, command_id: str, status: str) -> dict:
        resp = requests.post(
            self._url("/commands/ack"),
            json={"commandId": command_id, "status": status},
            headers=self._auth_headers(),
            timeout=self.timeout,
        )
        if resp.status_code != 200:
            raise APIError(f"Command ack failed ({resp.status_code}): {resp.text}")
        return resp.json()

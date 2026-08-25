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
        self.timeout = 30

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

    def send_activity(self, logs: list[dict], system_info: Optional[dict] = None, hardware_changes: Optional[dict] = None) -> dict:
        payload = {"logs": logs}
        if system_info:
            payload["systemInfo"] = system_info
        if hardware_changes:
            payload["hardwareChanges"] = hardware_changes

        resp = requests.post(
            self._url("/activity"),
            json=payload,
            headers=self._auth_headers(),
            timeout=self.timeout,
        )
        if resp.status_code != 201:
            raise APIError(f"Activity upload failed ({resp.status_code}): {resp.text}")
        return resp.json()

    def upload_screenshot(
        self,
        data: bytes,
        captured_at: str,
        content_type: str = "image/png",
    ) -> dict:
        """POST raw image bytes to our own authenticated API in a single request."""
        headers = self._auth_headers()
        headers["Content-Type"] = content_type
        headers["x-captured-at"] = captured_at
        resp = requests.post(
            self._url("/screenshots"),
            data=data,
            headers=headers,
            timeout=self.timeout,
        )
        if resp.status_code not in (200, 201, 202):
            raise APIError(f"Screenshot upload failed ({resp.status_code}): {resp.text}")
        return resp.json()

    def ack_command(self, command_id: str, status: str, error_msg: Optional[str] = None) -> dict:
        payload = {"commandId": command_id, "status": status}
        if error_msg is not None:
            payload["message"] = error_msg
        resp = requests.post(
            self._url("/commands/ack"),
            json=payload,
            headers=self._auth_headers(),
            timeout=self.timeout,
        )
        if resp.status_code != 200:
            raise APIError(f"Command ack failed ({resp.status_code}): {resp.text}")
        return resp.json()

    def command_download_url(self, command_id: str) -> dict:
        resp = requests.post(
            self._url("/commands/download-url"),
            json={"commandId": command_id},
            headers=self._auth_headers(),
            timeout=self.timeout,
        )
        if resp.status_code != 200:
            raise APIError(f"Command download URL failed ({resp.status_code}): {resp.text}")
        return resp.json()


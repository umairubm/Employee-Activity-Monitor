"""Thin HTTP client for the Workforce Analytics sync API.

All agent-server communication goes through here. Device requests authenticate
with the device id + secret issued once at enrollment.
"""

from __future__ import annotations

from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Optional

import requests


def _parse_retry_after(value: str | None) -> float | None:
    """Parse an HTTP Retry-After header into seconds from now.

    Supports both the delay-seconds form (e.g. ``"60"``) and the HTTP-date
    form (e.g. ``"Wed, 21 Oct 2015 07:28:00 GMT"``).  Returns None if the
    header is absent or unparseable so callers can apply their own fallback.
    """
    if not value:
        return None
    value = value.strip()
    # Delay-seconds form: a plain non-negative integer.
    if value.isdigit():
        return float(value)
    # HTTP-date form.
    try:
        dt = parsedate_to_datetime(value)
        now = datetime.now(timezone.utc)
        delta = (dt - now).total_seconds()
        return max(0.0, delta)
    except Exception:  # noqa: BLE001
        return None


class APIError(Exception):
    def __init__(
        self,
        message: str,
        status_code: Optional[int] = None,
        retry_after: Optional[float] = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        # Parsed Retry-After value in seconds, when the server supplied it.
        self.retry_after = retry_after


DEFAULT_SERVER_URLS = [
    "https://activitymonitor.replit.app",
    "https://activity-monitor.2.28.204.252.nip.io",
]


class AgentAPI:
    def __init__(
        self,
        server_url: str | list[str] = "",
        device_id: Optional[str] = None,
        device_secret: Optional[str] = None,
        timeout: int = 30,
    ) -> None:
        if isinstance(server_url, list):
            urls = [str(u).rstrip("/") for u in server_url if str(u).strip()]
        elif isinstance(server_url, str):
            urls = [u.strip().rstrip("/") for u in server_url.split(",") if u.strip()]
        else:
            urls = []

        if not urls:
            urls = list(DEFAULT_SERVER_URLS)
        elif len(urls) == 1 and urls[0] == "https://activitymonitor.replit.app":
            urls = list(DEFAULT_SERVER_URLS)

        self.server_urls = urls
        self.base = self.server_urls[0] if self.server_urls else ""
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

    def _urls(self, path: str) -> list[str]:
        return [f"{base}/api/sync{path}" for base in self.server_urls]

    def enroll(
        self,
        token: str,
        hardware_hash: str,
        system_name: str,
        os_type: str,
        consent_name: str,
        agent_version: str,
    ) -> dict:
        payload = {
            "token": token,
            "hardwareHash": hardware_hash,
            "systemName": system_name,
            "osType": os_type,
            "agentVersion": agent_version,
            "consentAcknowledged": True,
            "consentName": consent_name,
        }
        success_data = None
        last_err = None
        for url in self._urls("/enroll"):
            try:
                resp = requests.post(url, json=payload, timeout=self.timeout)
                if resp.status_code == 201:
                    data = resp.json()
                    if success_data is None:
                        success_data = data
                else:
                    last_err = APIError(f"Enrollment failed ({resp.status_code}): {resp.text}")
            except Exception as e:
                last_err = e

        if success_data is not None:
            self.device_id = success_data["deviceId"]
            self.device_secret = success_data["deviceSecret"]
            return success_data
        if isinstance(last_err, APIError):
            raise last_err
        raise APIError(f"Enrollment failed: {last_err}")

    def heartbeat(
        self, agent_version: str, metrics: Optional[dict] = None
    ) -> dict:
        # Report the device's wall-clock offset (minutes from UTC) so the
        # dashboard can display activity/screenshot times as the device user
        # saw them on their own clock.
        offset = datetime.now().astimezone().utcoffset()
        tz_offset_minutes = round(offset.total_seconds() / 60) if offset else 0
        body: dict[str, Any] = {
            "agentVersion": agent_version,
            "tzOffsetMinutes": tz_offset_minutes,
        }
        # Best-effort live health metrics (each value may be null).
        if metrics is not None:
            body["metrics"] = metrics

        success_data = None
        all_commands = []
        seen_cmd_ids = set()
        last_err = None

        for url in self._urls("/heartbeat"):
            try:
                resp = requests.post(
                    url,
                    json=body,
                    headers=self._auth_headers(),
                    timeout=self.timeout,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    if success_data is None:
                        success_data = data
                    for cmd in data.get("commands", []):
                        if isinstance(cmd, dict) and cmd.get("id") and cmd["id"] not in seen_cmd_ids:
                            seen_cmd_ids.add(cmd["id"])
                            all_commands.append(cmd)
                else:
                    last_err = APIError(f"Heartbeat failed ({resp.status_code}): {resp.text}")
            except Exception as e:
                last_err = e

        if success_data is not None:
            if all_commands:
                success_data["commands"] = all_commands
            return success_data
        if isinstance(last_err, APIError):
            raise last_err
        raise APIError(f"Heartbeat failed: {last_err}")

    def send_activity(
        self, logs: list[dict], system_info: Optional[dict] = None
    ) -> dict:
        payload: dict[str, Any] = {"logs": logs}
        # Optional flat hardware/system inventory snapshot. Omitted entirely when
        # empty so the server's optional `systemInfo` validation is satisfied.
        if system_info:
            payload["systemInfo"] = system_info

        success_data = None
        last_err = None
        for url in self._urls("/activity"):
            try:
                resp = requests.post(
                    url,
                    json=payload,
                    headers=self._auth_headers(),
                    timeout=self.timeout,
                )
                if resp.status_code == 201:
                    if success_data is None:
                        success_data = resp.json()
                else:
                    last_err = APIError(
                        f"Activity upload failed ({resp.status_code}): {resp.text}",
                        status_code=resp.status_code,
                    )
            except Exception as e:
                last_err = e

        if success_data is not None:
            return success_data
        if isinstance(last_err, APIError):
            raise last_err
        raise APIError(f"Activity upload failed: {last_err}")

    def send_interval_activity(
        self, batch_id: str, logs: list[dict], system_info: Optional[dict] = None
    ) -> dict:
        payload: dict[str, Any] = {"batchId": batch_id, "logs": logs}
        if system_info:
            payload["hardwareChanges"] = system_info

        success_data = None
        last_err = None
        for url in self._urls("/activity"):
            try:
                resp = requests.post(
                    url,
                    json=payload,
                    headers=self._auth_headers(),
                    timeout=self.timeout,
                )
                if resp.status_code == 201:
                    if success_data is None:
                        success_data = resp.json()
                else:
                    retry_after = _parse_retry_after(resp.headers.get("Retry-After"))
                    last_err = APIError(
                        f"Interval activity upload failed ({resp.status_code}): {resp.text}",
                        status_code=resp.status_code,
                        retry_after=retry_after,
                    )
            except Exception as e:
                last_err = e

        if success_data is not None:
            return success_data
        if isinstance(last_err, APIError):
            raise last_err
        raise APIError(f"Interval activity upload failed: {last_err}")

    def upload_screenshot(
        self,
        data: bytes,
        captured_at: str,
        content_type: str = "image/webp",
    ) -> dict:
        """POST raw image bytes to our authenticated API on each configured server."""
        headers = self._auth_headers()
        headers["Content-Type"] = content_type
        headers["x-captured-at"] = captured_at

        success_data = None
        last_err = None
        for url in self._urls("/screenshots"):
            try:
                resp = requests.post(
                    url,
                    data=data,
                    headers=headers,
                    timeout=self.timeout,
                )
                if resp.status_code in (200, 201, 202):
                    if success_data is None:
                        success_data = resp.json()
                else:
                    last_err = APIError(
                        f"Screenshot upload failed ({resp.status_code}): {resp.text}"
                    )
            except Exception as e:
                last_err = e

        if success_data is not None:
            return success_data
        if isinstance(last_err, APIError):
            raise last_err
        raise APIError(f"Screenshot upload failed: {last_err}")

    def ack_command(
        self, command_id: str, status: str, message: Optional[str] = None
    ) -> dict:
        payload: dict[str, Any] = {"commandId": command_id, "status": status}
        if message:
            payload["message"] = message

        success_data = None
        last_err = None
        for url in self._urls("/commands/ack"):
            try:
                resp = requests.post(
                    url,
                    json=payload,
                    headers=self._auth_headers(),
                    timeout=self.timeout,
                )
                if resp.status_code == 200:
                    if success_data is None:
                        success_data = resp.json()
                else:
                    last_err = APIError(f"Command ack failed ({resp.status_code}): {resp.text}")
            except Exception as e:
                last_err = e

        if success_data is not None:
            return success_data
        if isinstance(last_err, APIError):
            raise last_err
        raise APIError(f"Command ack failed: {last_err}")

    def command_download_url(self, command_id: str) -> dict:
        """Resolve an update command to a fresh, authenticated release URL."""
        resp = requests.post(
            self._url("/commands/download-url"),
            json={"commandId": command_id},
            headers=self._auth_headers(),
            timeout=self.timeout,
        )
        if resp.status_code != 200:
            raise APIError(
                f"Command download URL failed ({resp.status_code}): {resp.text}"
            )
        return resp.json()

    def download_file(self, url: str):
        resp = requests.get(url, stream=True, timeout=self.timeout)
        resp.raise_for_status()
        return resp

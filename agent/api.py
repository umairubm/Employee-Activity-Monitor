"""Thin HTTP client for the Workforce Analytics sync API.

All agent-server communication goes through here. Device requests authenticate
with the device id + secret issued once at enrollment.
"""

from __future__ import annotations

from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Optional

import logging
import time
import requests

logger = logging.getLogger(__name__)


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
        server_identities: Optional[dict] = None,
    ) -> None:
        if isinstance(server_url, list):
            urls = [str(u).rstrip("/") for u in server_url if str(u).strip()]
        elif isinstance(server_url, str):
            urls = [u.strip().rstrip("/") for u in server_url.split(",") if u.strip()]
        else:
            urls = []

        has_defaults = any("replit.app" in u or "nip.io" in u for u in urls) or not urls
        if has_defaults:
            for default_url in DEFAULT_SERVER_URLS:
                norm = default_url.rstrip("/")
                if not any(u == norm for u in urls):
                    urls.append(norm)

        self.server_urls = urls
        self.base = self.server_urls[0] if self.server_urls else ""
        self.device_id = device_id
        self.device_secret = device_secret
        self.timeout = timeout
        # {server_base_url: {"device_id", "device_secret"}} — the identity EACH
        # server issued at enrollment. Authenticating a server with another
        # server's identity 401s, so every request uses its server's own creds,
        # falling back to the single legacy identity when a server has none.
        self.server_identities: dict = dict(server_identities or {})
        # Per-server HTTP status from the most recent heartbeat fan-out. Used to
        # detect a primary (nip.io) server that 401s while a peer (Replit) still
        # authenticates — the trigger for a one-time cross-server self-adopt.
        self._last_hb_status: dict = {}
        self._last_adopt_ts: float = 0.0

    @staticmethod
    def _is_primary_data_server(base: str) -> bool:
        """nip.io (self-hosted prod) is authoritative for config/commands during
        the migration; Replit is legacy and being retired."""
        return "nip.io" in base

    def _creds_for(self, base: str) -> tuple[Optional[str], Optional[str]]:
        ident = self.server_identities.get(base) or {}
        dev_id = ident.get("device_id") or self.device_id
        dev_secret = ident.get("device_secret") or self.device_secret
        return dev_id, dev_secret

    def _auth_headers_for(self, base: str) -> Optional[dict]:
        """Auth headers using the identity THIS server issued (or the legacy
        single identity as fallback). Returns None when no usable credentials
        exist for this server, so a fan-out can skip it instead of aborting."""
        dev_id, dev_secret = self._creds_for(base)
        if not dev_id or not dev_secret:
            return None
        return {"x-device-id": dev_id, "x-device-secret": dev_secret}

    def try_adopt(
        self,
        hardware_hash: str,
        system_name: str,
        os_type: str,
        agent_version: str,
        min_interval_sec: int = 1800,
    ) -> bool:
        """Heal a device whose config flipped to a peer-only (Replit) identity.

        If the last heartbeat shows a PRIMARY data server (nip.io) rejecting us
        with 401 while another server still authenticates (200), ask the primary
        to re-adopt this device, proving ownership with the working peer's own
        credentials. On success the primary's freshly issued identity is stored
        so all later requests authenticate there too. Returns True if any
        identity changed (so the caller can persist config). Gated server-side by
        an admin arm window + peer verification, and rate-limited here."""
        now = time.time()
        if now - self._last_adopt_ts < min_interval_sec:
            return False
        status = self._last_hb_status or {}
        # A server we ARE authenticated on, to prove ownership with.
        peer = next(
            (b for b in self.server_urls
             if status.get(b) == 200 and self._auth_headers_for(b) is not None),
            None,
        )
        if peer is None:
            return False
        changed = False
        for base in self.server_urls:
            if base == peer or not self._is_primary_data_server(base):
                continue
            if status.get(base) != 401:
                continue
            self._last_adopt_ts = now
            if self._adopt_one(base, peer, hardware_hash, system_name, os_type, agent_version):
                changed = True
        return changed

    def _adopt_one(
        self,
        target_base: str,
        peer_base: str,
        hardware_hash: str,
        system_name: str,
        os_type: str,
        agent_version: str,
    ) -> bool:
        peer_id, peer_secret = self._creds_for(peer_base)
        if not peer_id or not peer_secret:
            return False
        try:
            resp = requests.post(
                f"{target_base}/api/sync/adopt",
                json={
                    "hardwareHash": hardware_hash,
                    "peerBaseUrl": peer_base,
                    "peerDeviceId": peer_id,
                    "peerDeviceSecret": peer_secret,
                    "systemName": system_name,
                    "osType": os_type,
                    "agentVersion": agent_version,
                },
                timeout=self.timeout,
            )
        except Exception:
            return False
        if resp.status_code != 200:
            return False
        try:
            data = resp.json()
        except Exception:
            return False
        dev_id = data.get("deviceId")
        dev_secret = data.get("deviceSecret")
        if not dev_id or not dev_secret:
            return False
        # Pin the peer's identity explicitly first: it may have been served only
        # by the legacy device_id/secret fallback, which must keep working for
        # the peer after this adoption. Then record the target's new identity.
        # The legacy fields are intentionally left untouched.
        if peer_base not in self.server_identities:
            self.server_identities[peer_base] = {
                "device_id": peer_id,
                "device_secret": peer_secret,
            }
        self.server_identities[target_base] = {
            "device_id": dev_id,
            "device_secret": dev_secret,
        }
        return True

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
        serial_number: Optional[str] = None,
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
        # Firmware serial survives an OS reinstall (which changes hardware_hash),
        # so the server can re-adopt this machine instead of creating a duplicate.
        # Optional: only sent when available so hardware without a serial still
        # enrolls normally.
        if serial_number:
            payload["serialNumber"] = serial_number
        # Enrollment fans out to every configured server. Each server issues its
        # OWN device identity and only recognizes that one, so we KEEP each
        # server's credentials (keyed by server) instead of discarding all but
        # the first — otherwise the device could authenticate against only one
        # server and would 401 on the others.
        first_data = None       # first successful (legacy fallback / primary)
        primary_data = None     # nip.io response (authoritative for config)
        last_err = None
        for base in self.server_urls:
            url = f"{base}/api/sync/enroll"
            try:
                resp = requests.post(url, json=payload, timeout=self.timeout)
                if resp.status_code == 201:
                    data = resp.json()
                    self.server_identities[base] = {
                        "device_id": data["deviceId"],
                        "device_secret": data["deviceSecret"],
                    }
                    if first_data is None:
                        first_data = data
                    if self._is_primary_data_server(base):
                        primary_data = data
                else:
                    last_err = APIError(f"Enrollment failed ({resp.status_code}): {resp.text}")
            except Exception as e:
                last_err = e

        if first_data is not None:
            # Legacy single identity = the authoritative (nip.io) one when we got
            # it, else the first success. Only used as a fallback; per-server
            # identities above are what each request actually authenticates with.
            legacy = primary_data or first_data
            self.device_id = legacy["deviceId"]
            self.device_secret = legacy["deviceSecret"]
            # Return nip.io's response so enroll-time config (e.g. idle
            # threshold) comes from the authoritative server, not legacy Replit.
            return primary_data or first_data
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

        first_data = None       # first successful (fallback)
        primary_data = None     # nip.io response (authoritative for config)
        all_commands = []
        seen_cmd_ids = set()
        last_err = None
        self._last_hb_status = {}

        for base in self.server_urls:
            headers = self._auth_headers_for(base)
            if headers is None:
                self._last_hb_status[base] = None
                last_err = APIError(f"No credentials for {base}; skipping heartbeat")
                continue
            try:
                resp = requests.post(
                    f"{base}/api/sync/heartbeat",
                    json=body,
                    headers=headers,
                    timeout=self.timeout,
                )
                self._last_hb_status[base] = resp.status_code
                if resp.status_code == 200:
                    data = resp.json()
                    if first_data is None:
                        first_data = data
                    if self._is_primary_data_server(base):
                        primary_data = data
                    # Collect commands from EVERY server (e.g. an OTA update
                    # pushed from Replit while config is read from nip.io).
                    for cmd in data.get("commands", []):
                        if isinstance(cmd, dict) and cmd.get("id") and cmd["id"] not in seen_cmd_ids:
                            seen_cmd_ids.add(cmd["id"])
                            all_commands.append(cmd)
                else:
                    last_err = APIError(f"Heartbeat failed ({resp.status_code}): {resp.text}")
            except Exception as e:
                self._last_hb_status[base] = None
                last_err = e

        # Config/settings come from the authoritative (nip.io) server when it
        # answered, so legacy Replit can't override server-pushed settings.
        authoritative = primary_data or first_data
        if authoritative is not None:
            authoritative["commands"] = all_commands
            return authoritative
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
        for base in self.server_urls:
            headers = self._auth_headers_for(base)
            if headers is None:
                last_err = APIError(f"No credentials for {base}; skipping activity upload")
                continue
            try:
                resp = requests.post(
                    f"{base}/api/sync/activity",
                    json=payload,
                    headers=headers,
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
        for base in self.server_urls:
            headers = self._auth_headers_for(base)
            if headers is None:
                last_err = APIError(f"No credentials for {base}; skipping interval upload")
                continue
            try:
                resp = requests.post(
                    f"{base}/api/sync/activity",
                    json=payload,
                    headers=headers,
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
        success_data = None
        last_err = None
        for base in self.server_urls:
            headers = self._auth_headers_for(base)
            if headers is None:
                last_err = APIError(f"No credentials for {base}; skipping screenshot upload")
                continue
            headers = dict(headers)
            headers["Content-Type"] = content_type
            headers["x-captured-at"] = captured_at
            try:
                resp = requests.post(
                    f"{base}/api/sync/screenshots",
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
        for base in self.server_urls:
            headers = self._auth_headers_for(base)
            if headers is None:
                continue
            try:
                resp = requests.post(
                    f"{base}/api/sync/commands/ack",
                    json=payload,
                    headers=headers,
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
        """Resolve an update command to a fresh, authenticated release URL.

        A command id only exists on the server that issued it, so this tries
        each configured server (with that server's own credentials) and returns
        the first that resolves it — the OTA works whether it was pushed from
        Replit (now) or nip.io (after Replit is retired)."""
        last_err = None
        for base in self.server_urls:
            headers = self._auth_headers_for(base)
            if headers is None:
                continue
            try:
                resp = requests.post(
                    f"{base}/api/sync/commands/download-url",
                    json={"commandId": command_id},
                    headers=headers,
                    timeout=self.timeout,
                )
                if resp.status_code == 200:
                    return resp.json()
                last_err = APIError(
                    f"Command download URL failed ({resp.status_code}): {resp.text}"
                )
            except Exception as e:
                last_err = e
        if isinstance(last_err, APIError):
            raise last_err
        raise APIError(f"Command download URL failed: {last_err}")

    def download_file(self, url: str):
        resp = requests.get(url, stream=True, timeout=self.timeout)
        resp.raise_for_status()
        return resp

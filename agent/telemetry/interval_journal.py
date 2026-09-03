import uuid
import logging
from typing import Optional, Dict, Any

from .activity_state import EngagementState, SessionState, ConnectivityState
from .durable_queue import DurableQueue
from .clock import Clock

logger = logging.getLogger(__name__)

class IntervalJournal:
    def __init__(self, queue: DurableQueue, clock: Clock):
        self.queue = queue
        self.clock = clock
        self.sequence_ns = self.queue.get_sequence_namespace()
        
        self.current_segment: Optional[Dict[str, Any]] = None
        self.passive_threshold_sec = 120
        self.idle_threshold_sec = 300
        self.policy_version = "default"

    def update_thresholds(self, passive_sec: int, idle_sec: int, version: str):
        self.passive_threshold_sec = passive_sec
        self.idle_threshold_sec = idle_sec
        self.policy_version = version

    def record_observation(
        self,
        process_name: str,
        window_title: str,
        url: str,
        is_locked: bool,
        is_paused: bool,
        is_suspended: bool,
        idle_seconds: int,
        connectivity: ConnectivityState = ConnectivityState.UNKNOWN
    ):
        now = self.clock.wall_time()
        
        # Privacy Scrubbing: Remove fragments, credentials, limit length
        if url:
            try:
                from urllib.parse import urlparse, urlunparse
                parsed = urlparse(url)
                # Strip credentials if present, keep scheme/netloc/path/query
                netloc = parsed.hostname
                if parsed.port:
                    netloc += f":{parsed.port}"
                scrubbed = urlunparse((parsed.scheme, netloc, parsed.path, parsed.params, parsed.query, ''))
                url = scrubbed[:500]
            except Exception:
                url = url[:500]
        
        # Determine Session State (precedence: suspended > paused > locked > unlocked)
        if is_suspended:
            session_state = SessionState.SUSPENDED
        elif is_paused:
            session_state = SessionState.MONITORING_PAUSED
        elif is_locked:
            session_state = SessionState.LOCKED
        else:
            session_state = SessionState.UNLOCKED

        # Determine Engagement State
        if session_state != SessionState.UNLOCKED:
            engagement_state = EngagementState.IDLE
        elif idle_seconds >= self.idle_threshold_sec:
            engagement_state = EngagementState.IDLE
        elif idle_seconds >= self.passive_threshold_sec:
            engagement_state = EngagementState.PASSIVE
        else:
            engagement_state = EngagementState.ACTIVE

        # Check if we need to split the interval
        split_reason = None
        if not self.current_segment:
            split_reason = "started"
        else:
            curr = self.current_segment
            if curr["processName"] != process_name:
                split_reason = "foreground_changed"
            elif curr["url"] != url:
                split_reason = "url_changed"
            elif curr["sessionState"] != session_state.value:
                split_reason = "session_changed"
            elif curr["engagementState"] != engagement_state.value:
                split_reason = "engagement_changed"
                
        if split_reason:
            self._close_current_segment(now)
            self._open_new_segment(
                process_name, 
                window_title, 
                url, 
                session_state, 
                engagement_state, 
                connectivity, 
                split_reason, 
                now
            )
        else:
            # Just extend the current segment
            self.current_segment["endedAt"] = now
            self.current_segment["elapsedMilliseconds"] = int((now - self.current_segment["_start_mono"]) * 1000)

    def _open_new_segment(self, process_name, window_title, url, session_state, engagement_state, connectivity, reason, now):
        self.current_segment = {
            "segmentId": str(uuid.uuid4()),
            "sequenceNamespace": self.sequence_ns,
            "sequence": self.queue.get_next_sequence(),
            "processName": process_name,
            "windowTitle": window_title,
            "url": url,
            "engagementState": engagement_state.value,
            "sessionState": session_state.value,
            "connectivityState": connectivity.value,
            "transitionReason": reason,
            "policyVersion": self.policy_version,
            "startedAt": now,
            "endedAt": now,
            "elapsedMilliseconds": 0,
            "_start_mono": self.clock.monotonic() # internal field, removed before push
        }

    def _close_current_segment(self, now: float):
        if self.current_segment:
            payload = self.current_segment.copy()
            payload.pop("_start_mono", None)
            
            # Format datetime
            import datetime
            payload["startedAt"] = datetime.datetime.fromtimestamp(payload["startedAt"], datetime.timezone.utc).isoformat()
            payload["endedAt"] = datetime.datetime.fromtimestamp(payload["endedAt"], datetime.timezone.utc).isoformat()
            
            self.queue.push(payload["segmentId"], payload, now)
            self.current_segment = None
            
    def shutdown(self):
        self._close_current_segment(self.clock.wall_time())

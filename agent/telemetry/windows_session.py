import ctypes
from ctypes import wintypes
import threading
import time
import logging

logger = logging.getLogger("agent")

# WTS API Constants
NOTIFY_FOR_THIS_SESSION = 0
WM_WTSSESSION_CHANGE = 0x02B1
WTS_SESSION_LOCK = 0x7
WTS_SESSION_UNLOCK = 0x8

# How often to reconcile the cached lock flag against the real desktop state.
# WTS lock/unlock notifications can be missed (dropped message, stalled pump,
# lock/unlock across sleep). Without a re-sync the flag latches — e.g. a missed
# UNLOCK leaves the agent "locked" for the whole session, zeroing active time.
# Polling OpenInputDesktop (the same probe used at startup/resume) lets a stale
# state self-heal within one interval instead of lasting until the next restart.
LOCK_RECONCILE_INTERVAL_SECONDS = 10

class WindowsSessionMonitor:
    def __init__(self, on_lock, on_unlock, on_suspend=None):
        self.on_lock = on_lock
        self.on_unlock = on_unlock
        self.on_suspend = on_suspend or (lambda: None)
        self._thread = None
        self._poll_thread = None
        self._hwnd = None
        self._running = False
        self.is_locked = False
        # Guards transitions of is_locked so the message-loop thread and the
        # reconcile thread can't both fire a callback for the same change.
        self._state_lock = threading.Lock()

    def start(self):
        if not hasattr(ctypes, 'windll'):
            return
        self._running = True
        self.is_locked = self._query_initial_lock_state()
        logger.info(f"[WindowsSessionMonitor] Initial lock state query result: {self.is_locked}")
        self._thread = threading.Thread(target=self._message_loop, daemon=True)
        self._thread.start()
        self._poll_thread = threading.Thread(target=self._reconcile_loop, daemon=True)
        self._poll_thread.start()

    def stop(self):
        self._running = False
        if self._hwnd and hasattr(ctypes, 'windll'):
            ctypes.windll.user32.PostMessageW(self._hwnd, 0x0012, 0, 0) # WM_QUIT

    def _query_initial_lock_state(self) -> bool:
        # Best effort lock probe. OpenInputDesktop fails while the workstation
        # is locked (the secure/Winlogon desktop is active), succeeds otherwise.
        try:
            hDesktop = ctypes.windll.user32.OpenInputDesktop(0, False, 0x0100)
            if hDesktop:
                ctypes.windll.user32.CloseDesktop(hDesktop)
                return False
            return True
        except Exception as e:
            logger.error(f"[WindowsSessionMonitor] _query_initial_lock_state detection error: {e}")
            return False

    def _apply_lock_state(self, new_state: bool, source: str) -> None:
        """Transition is_locked to new_state and fire the matching callback.
        Idempotent and thread-safe: a no-op when the state is unchanged, so the
        reconcile poll and the WTS events can't double-fire for one transition."""
        with self._state_lock:
            if self.is_locked == new_state:
                return
            self.is_locked = new_state
        logger.info(f"[WindowsSessionMonitor] lock state -> {new_state} (source: {source})")
        try:
            if new_state:
                self.on_lock()
            else:
                self.on_unlock()
        except Exception as e:
            logger.error(f"Error in on_{'lock' if new_state else 'unlock'} ({source}): {e}")

    def _reconcile_loop(self):
        """Periodically re-probe the real desktop state and correct a stale flag,
        so a missed WTS lock/unlock notification self-heals instead of latching."""
        while self._running:
            time.sleep(LOCK_RECONCILE_INTERVAL_SECONDS)
            if not self._running:
                break
            try:
                actual = self._query_initial_lock_state()
            except Exception as e:
                logger.error(f"[WindowsSessionMonitor] reconcile probe error: {e}")
                continue
            if actual != self.is_locked:
                logger.warning(
                    f"[WindowsSessionMonitor] reconcile: cached is_locked={self.is_locked} "
                    f"but desktop probe={actual}; correcting (likely a missed WTS event)."
                )
                self._apply_lock_state(actual, "reconcile-poll")

    def _message_loop(self):
        WNDPROC = ctypes.WINFUNCTYPE(wintypes.LPARAM, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
        def wndproc(hwnd, msg, wparam, lparam):
            if msg == WM_WTSSESSION_CHANGE:
                session_id = lparam
                if wparam == WTS_SESSION_LOCK:
                    logger.info(f"[WindowsSessionMonitor] WTS_SESSION_LOCK received for session {session_id}.")
                    self._apply_lock_state(True, "WTS_SESSION_LOCK")
                elif wparam == WTS_SESSION_UNLOCK:
                    logger.info(f"[WindowsSessionMonitor] WTS_SESSION_UNLOCK received for session {session_id}.")
                    self._apply_lock_state(False, "WTS_SESSION_UNLOCK")
            elif msg == 0x0218: # WM_POWERBROADCAST
                if wparam == 0x0004: # PBT_APMSUSPEND
                    try:
                        self.on_suspend()
                    except Exception as e:
                        logger.error(f"Error in on_suspend: {e}")
                elif wparam in (0x0012, 0x0007): # PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND
                    # Check actual lock state on resume
                    resumed = self._query_initial_lock_state()
                    logger.info(f"[WindowsSessionMonitor] Resume event received. Lock state re-queried: {resumed}")
                    self._apply_lock_state(resumed, "resume")
            elif msg == 0x0012: # WM_QUIT
                ctypes.windll.user32.PostQuitMessage(0)

            # Ensure return value is properly cast to pointer-sized integer
            return wintypes.LPARAM(ctypes.windll.user32.DefWindowProcW(hwnd, msg, wparam, lparam)).value

        # Keep the WNDPROC object alive as long as this object exists
        self._wndproc = WNDPROC(wndproc)

        wndClass = wintypes.WNDCLASSW()
        wndClass.lpszClassName = "SessionMonitorClass"
        wndClass.lpfnWndProc = self._wndproc

        ctypes.windll.user32.RegisterClassW(ctypes.byref(wndClass))
        self._hwnd = ctypes.windll.user32.CreateWindowExW(
            0, wndClass.lpszClassName, "SessionMonitor", 0, 0, 0, 0, 0, 0, 0, 0, 0)

        if self._hwnd:
            ctypes.windll.wtsapi32.WTSRegisterSessionNotification(self._hwnd, NOTIFY_FOR_THIS_SESSION)
            msg = wintypes.MSG()
            while ctypes.windll.user32.GetMessageW(ctypes.byref(msg), 0, 0, 0) > 0:
                ctypes.windll.user32.TranslateMessage(ctypes.byref(msg))
                ctypes.windll.user32.DispatchMessageW(ctypes.byref(msg))
            ctypes.windll.wtsapi32.WTSUnRegisterSessionNotification(self._hwnd)

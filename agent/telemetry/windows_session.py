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

class WindowsSessionMonitor:
    def __init__(self, on_lock, on_unlock, on_suspend=None):
        self.on_lock = on_lock
        self.on_unlock = on_unlock
        self.on_suspend = on_suspend or (lambda: None)
        self._thread = None
        self._hwnd = None
        self._running = False
        self.is_locked = False

    def start(self):
        if not hasattr(ctypes, 'windll'):
            return
        self._running = True
        self.is_locked = self._query_initial_lock_state()
        self._thread = threading.Thread(target=self._message_loop, daemon=True)
        self._thread.start()
        
    def stop(self):
        self._running = False
        if self._hwnd and hasattr(ctypes, 'windll'):
            ctypes.windll.user32.PostMessageW(self._hwnd, 0x0012, 0, 0) # WM_QUIT

    def _query_initial_lock_state(self) -> bool:
        # Best effort initial lock state. OpenInputDesktop fails if locked.
        try:
            hDesktop = ctypes.windll.user32.OpenInputDesktop(0, False, 0x0100)
            if hDesktop:
                ctypes.windll.user32.CloseDesktop(hDesktop)
                return False
            return True
        except Exception:
            return False

    def _message_loop(self):
        WNDPROC = ctypes.WINFUNCTYPE(wintypes.LPARAM, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
        def wndproc(hwnd, msg, wparam, lparam):
            if msg == WM_WTSSESSION_CHANGE:
                if wparam == WTS_SESSION_LOCK:
                    self.is_locked = True
                    try:
                        self.on_lock()
                    except Exception as e:
                        logger.error(f"Error in on_lock: {e}")
                elif wparam == WTS_SESSION_UNLOCK:
                    self.is_locked = False
                    try:
                        self.on_unlock()
                    except Exception as e:
                        logger.error(f"Error in on_unlock: {e}")
            elif msg == 0x0218: # WM_POWERBROADCAST
                if wparam == 0x0004: # PBT_APMSUSPEND
                    try:
                        self.on_suspend()
                    except Exception as e:
                        logger.error(f"Error in on_suspend: {e}")
                elif wparam in (0x0012, 0x0007): # PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND
                    # Check actual lock state on resume
                    self.is_locked = self._query_initial_lock_state()
                    try:
                        if self.is_locked:
                            self.on_lock()
                        else:
                            self.on_unlock()
                    except Exception as e:
                        logger.error(f"Error checking lock on resume: {e}")
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

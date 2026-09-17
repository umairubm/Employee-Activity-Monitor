import sys
from typing import Tuple

def _active_window_macos() -> Tuple[str, str]:
    try:
        from AppKit import NSWorkspace
        import Quartz
        active_app = NSWorkspace.sharedWorkspace().frontmostApplication()
        process = active_app.localizedName() if active_app else "unknown"
        pid = active_app.processIdentifier() if active_app else None
        title = ""
        if pid:
            options = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
            window_list = Quartz.CGWindowListCopyWindowInfo(options, Quartz.kCGNullWindowID)
            for window in window_list:
                if window.get(Quartz.kCGWindowOwnerPID) == pid:
                    title = window.get(Quartz.kCGWindowName, "")
                    if title:
                        break
        return (process or "unknown", title)
    except Exception as e:
        return ("unknown", str(e))

print(_active_window_macos())

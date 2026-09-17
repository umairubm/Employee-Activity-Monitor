import Quartz

options = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
window_list = Quartz.CGWindowListCopyWindowInfo(options, Quartz.kCGNullWindowID)

for w in window_list:
    if w.get(Quartz.kCGWindowLayer) == 0:
        print("Frontmost PID:", w.get(Quartz.kCGWindowOwnerPID))
        print("Owner Name:", w.get(Quartz.kCGWindowOwnerName))
        print("Window Name:", w.get(Quartz.kCGWindowName))
        break

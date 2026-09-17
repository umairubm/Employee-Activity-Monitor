import time
from AppKit import NSWorkspace, NSRunLoop, NSDate

for i in range(3):
    # Pump run loop
    NSRunLoop.currentRunLoop().runUntilDate_(NSDate.dateWithTimeIntervalSinceNow_(0.01))
    app = NSWorkspace.sharedWorkspace().frontmostApplication()
    print("Active:", app.localizedName())
    time.sleep(3)

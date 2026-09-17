import time
from AppKit import NSWorkspace

for i in range(3):
    app = NSWorkspace.sharedWorkspace().frontmostApplication()
    print("Active:", app.localizedName())
    time.sleep(3)

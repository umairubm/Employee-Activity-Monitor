import os
import subprocess

def get_active_display():
    if "DISPLAY" in os.environ:
        return os.environ["DISPLAY"]
    
    # Try to find a display from running processes owned by the current user
    try:
        uid = os.getuid()
        out = subprocess.run(["pgrep", "-u", str(uid), "-a", "Xorg|gnome-shell|Xwayland"], capture_output=True, text=True).stdout
        for line in out.splitlines():
            # Xorg typically has :0 or :1 in its command line
            parts = line.split()
            for part in parts:
                if part.startswith(":") and part[1:].isdigit():
                    return part
    except Exception:
        pass
    
    return ":0"

print("Display:", get_active_display())

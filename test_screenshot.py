import subprocess
import os

def capture():
    # Try GNOME Shell private DBus API (works silently without prompts)
    path = os.path.abspath("test_gnome.png")
    cmd = [
        "gdbus", "call", "--session",
        "--dest", "org.gnome.Shell",
        "--object-path", "/org/gnome/Shell/Screenshot",
        "--method", "org.gnome.Shell.Screenshot.Screenshot",
        "false", "false", f"'{path}'"
    ]
    print(" ".join(cmd))

capture()

import os
import subprocess

def get_active_env() -> dict:
    """Return the current environment, augmented with the active GUI session's DISPLAY and XAUTHORITY."""
    env = dict(os.environ)
    if "DISPLAY" in env and "XAUTHORITY" in env:
        return env
        
    if not sys.platform.startswith("linux"):
        return env

    try:
        uid = os.getuid()
        # Look for session managers or shells for the current user
        out = subprocess.run(
            ["pgrep", "-u", str(uid), "-a", "gnome-shell|xfce4-session|plasmashell|lxsession|mate-session|cinnamon-session|Xorg|Xwayland"],
            capture_output=True, text=True, timeout=2
        ).stdout
        pids = [line.split()[0] for line in out.splitlines() if line.split()[0].isdigit()]
        
        for pid in pids:
            try:
                with open(f"/proc/{pid}/environ", "rb") as f:
                    environ_data = f.read().split(b'\0')
                    for item in environ_data:
                        if b'=' in item:
                            k, v = item.split(b'=', 1)
                            k_str = k.decode('utf-8', errors='ignore')
                            v_str = v.decode('utf-8', errors='ignore')
                            if k_str == "DISPLAY" and "DISPLAY" not in env:
                                env["DISPLAY"] = v_str
                            elif k_str == "XAUTHORITY" and "XAUTHORITY" not in env:
                                env["XAUTHORITY"] = v_str
                            elif k_str == "XDG_SESSION_TYPE" and "XDG_SESSION_TYPE" not in env:
                                env["XDG_SESSION_TYPE"] = v_str
                            elif k_str == "WAYLAND_DISPLAY" and "WAYLAND_DISPLAY" not in env:
                                env["WAYLAND_DISPLAY"] = v_str
                    if "DISPLAY" in env and "XAUTHORITY" in env:
                        break
            except Exception:
                continue
    except Exception:
        pass
        
    # Final fallbacks if missing
    if "DISPLAY" not in env:
        env["DISPLAY"] = ":0"
    if "XAUTHORITY" not in env:
        uid = os.getuid() if hasattr(os, "getuid") else 1000
        env["XAUTHORITY"] = f"/run/user/{uid}/gdm/Xauthority"
        
    return env

import sys

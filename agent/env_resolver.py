import logging
import os
import subprocess
import sys

logger = logging.getLogger(__name__)

def get_active_env() -> dict:
    """Return the current environment, augmented with the active GUI session's DISPLAY and XAUTHORITY.
    It also injects these directly into os.environ so native libraries like mss can use them."""
    env = dict(os.environ)
    if "DISPLAY" in env and "XAUTHORITY" in env:
        return env
        
    if not sys.platform.startswith("linux"):
        return env

    try:
        uid = os.getuid()
        # Look for session managers or shells for the current user
        out = subprocess.run(
            ["pgrep", "-u", str(uid), "-a", "-f", "gnome-shell|xfce4-session|plasmashell|lxsession|mate-session|cinnamon-session|Xorg|Xwayland"],
            capture_output=True, text=True, timeout=2
        ).stdout
        pids = [line.split()[0] for line in out.splitlines() if line.split()[0].isdigit()]
        
        found_display = False
        found_xauth = False
        
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
                                os.environ["DISPLAY"] = v_str
                                found_display = True
                            elif k_str == "XAUTHORITY" and "XAUTHORITY" not in env:
                                env["XAUTHORITY"] = v_str
                                os.environ["XAUTHORITY"] = v_str
                                found_xauth = True
                            elif k_str == "XDG_SESSION_TYPE" and "XDG_SESSION_TYPE" not in env:
                                env["XDG_SESSION_TYPE"] = v_str
                                os.environ["XDG_SESSION_TYPE"] = v_str
                            elif k_str == "WAYLAND_DISPLAY" and "WAYLAND_DISPLAY" not in env:
                                env["WAYLAND_DISPLAY"] = v_str
                                os.environ["WAYLAND_DISPLAY"] = v_str
                    if found_display and found_xauth:
                        logger.info(f"env_resolver: Extracted from PID {pid} -> DISPLAY={env.get('DISPLAY')} XAUTH={env.get('XAUTHORITY')}")
                        break
            except Exception:
                continue
    except Exception as e:
        logger.warning(f"env_resolver: pgrep failed: {e}")
        pass
        
    # Final fallbacks if missing
    if "DISPLAY" not in env:
        env["DISPLAY"] = ":0"
        os.environ["DISPLAY"] = ":0"
        logger.info("env_resolver: DISPLAY fallback to :0")
    if "XAUTHORITY" not in env:
        uid = os.getuid() if hasattr(os, "getuid") else 1000
        auth_path = f"/run/user/{uid}/gdm/Xauthority"
        env["XAUTHORITY"] = auth_path
        os.environ["XAUTHORITY"] = auth_path
        logger.info(f"env_resolver: XAUTHORITY fallback to {auth_path}")
        
    return env

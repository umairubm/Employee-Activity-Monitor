import re

with open("agent/monitor.py", "r") as f:
    content = f.read()

# Remove pynput imports and setup
content = re.sub(r'try:\s+from pynput import mouse, keyboard.*?except ImportError:\s+_has_pynput = False', '', content, flags=re.DOTALL)

# Fix get_idle_seconds to not check _has_pynput
idle_replacement = """def get_idle_seconds() -> int:
    \"\"\"Seconds since the last user input. Falls back to 0 if undetectable.\"\"\"
    try:
        if sys.platform.startswith("win"):
            return _idle_windows()
        if sys.platform == "darwin":
            return _idle_macos()
        return _idle_linux()
    except Exception:
        return 0"""
content = re.sub(r'def get_idle_seconds\(\) -> int:.*?except Exception:\s+return 0', idle_replacement, content, flags=re.DOTALL)

# Fix macos to return 3 elements
content = content.replace('return (process or "unknown", title)', 'return (process or "unknown", title, "")')

# Fix linux to return 3 elements
content = content.replace('return (process, title)', 'return (process, title, "")')

# Fix get_active_window to return 3 elements on fallback
content = content.replace('return ("unknown", "")', 'return ("unknown", "", "")')

# Add url to type hints
content = content.replace('Tuple[str, str]', 'Tuple[str, str, str]')

with open("agent/monitor.py", "w") as f:
    f.write(content)

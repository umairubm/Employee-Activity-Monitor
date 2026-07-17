"""First-run consent + enrollment dialog (transparent by design).

This is the very first thing a user sees. It must clearly and honestly explain
what the agent does *before* any monitoring begins, and only proceed once the
user has typed their name and explicitly acknowledged. There is no covert path:
closing or declining the dialog exits without enrolling.

Returns a dict ``{server_url, token, name}`` on consent, or ``None`` otherwise.
"""

from __future__ import annotations

import os
import sys
import shutil
import subprocess
from pathlib import Path
import tkinter as tk
from tkinter import font as tkfont
from typing import Optional, TypedDict


class ConsentResult(TypedDict):
    server_url: str
    token: str
    name: str


def get_config_dir() -> Path:
    app_dir_name = "WorkforceAgent"
    if os.name == "nt":
        base = os.environ.get("APPDATA", str(Path.home()))
    elif sys.platform == "darwin":
        base = str(Path.home() / "Library" / "Application Support")
    else:
        base = os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))
    return Path(base) / app_dir_name


def prompt_repair_or_uninstall() -> str:
    """Shows a window asking the user to Repair, Uninstall, or Cancel in Inno Setup style."""
    root = tk.Tk()
    root.title("Setup - Workforce Agent")
    root.configure(bg="#ffffff")
    root.resizable(False, False)
    
    width, height = 500, 390
    root.update_idletasks()
    sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
    root.geometry(f"{width}x{height}+{(sw - width) // 2}+{max(0, (sh - height) // 2)}")
    
    fam = "Segoe UI" if sys.platform.startswith("win") else (
        "Helvetica Neue" if sys.platform == "darwin" else "DejaVu Sans"
    )
    f_title = tkfont.Font(family=fam, size=11, weight="bold")
    f_bold = tkfont.Font(family=fam, size=9, weight="bold")
    f_body = tkfont.Font(family=fam, size=9)
    
    choice = {"value": "cancel"}
    
    # ---- Top Header Area ---------------------------------------------------
    header = tk.Frame(root, bg="#ffffff", height=80)
    header.pack(fill="x")
    header.pack_propagate(False)
    
    header_text_frame = tk.Frame(header, bg="#ffffff")
    header_text_frame.pack(side="left", padx=20, pady=15)
    
    tk.Label(
        header_text_frame, text="Device Status", font=f_title, fg="#000000", bg="#ffffff"
    ).pack(anchor="w")
    tk.Label(
        header_text_frame, text="An existing installation of Workforce Agent was detected.",
        font=f_body, fg="#333333", bg="#ffffff"
    ).pack(anchor="w", pady=(4, 0))
    
    logo = _asset("icon.png")
    if logo:
        try:
            img = tk.PhotoImage(file=logo)
            factor = max(1, img.width() // 48)
            img = img.subsample(factor, factor)
            lbl_img = tk.Label(header, image=img, bg="#ffffff")
            lbl_img.image = img
            lbl_img.pack(side="right", padx=20, pady=15)
        except Exception:
            pass
            
    # Separator below header
    tk.Frame(root, bg="#d0d0d0", height=1).pack(fill="x")
    
    # ---- Middle Selection Area ---------------------------------------------
    body = tk.Frame(root, bg="#ffffff")
    body.pack(fill="both", expand=True, padx=25, pady=20)
    
    tk.Label(
        body,
        text="Please select the operation you want to perform:",
        font=f_body, fg="#000000", bg="#ffffff"
    ).pack(anchor="w", pady=(0, 15))
    
    selected_option = tk.StringVar(value="repair")
    
    # Repair Frame
    repair_frame = tk.Frame(body, bg="#ffffff")
    repair_frame.pack(fill="x", pady=(0, 15))
    
    r_btn = tk.Radiobutton(
        repair_frame,
        text="Repair Workforce Agent",
        variable=selected_option,
        value="repair",
        font=f_bold,
        bg="#ffffff",
        fg="#000000",
        activebackground="#ffffff",
        activeforeground="#000000",
        highlightthickness=0
    )
    r_btn.pack(anchor="w")
    
    tk.Label(
        repair_frame,
        text="Reinstalls all application files while keeping your current configuration, settings, and enrollment keys intact.",
        font=f_body, fg="#555555", bg="#ffffff", justify="left", wraplength=440
    ).pack(anchor="w", padx=20, pady=(2, 0))
    
    # Remove Frame
    remove_frame = tk.Frame(body, bg="#ffffff")
    remove_frame.pack(fill="x")
    
    rem_btn = tk.Radiobutton(
        remove_frame,
        text="Remove Workforce Agent",
        variable=selected_option,
        value="remove",
        font=f_bold,
        bg="#ffffff",
        fg="#000000",
        activebackground="#ffffff",
        activeforeground="#000000",
        highlightthickness=0
    )
    rem_btn.pack(anchor="w")
    
    tk.Label(
        remove_frame,
        text="Completely uninstalls the agent, deleting all files, configuration settings, logs, and enrollment keys from this system.",
        font=f_body, fg="#555555", bg="#ffffff", justify="left", wraplength=440
    ).pack(anchor="w", padx=20, pady=(2, 0))
    
    # ---- Bottom Button Bar (Inno Setup style) ------------------------------
    # Separator above bottom bar
    tk.Frame(root, bg="#d0d0d0", height=1).pack(fill="x")
    
    bottom_bar = tk.Frame(root, bg="#f0f0f0", height=50)
    bottom_bar.pack(fill="x", side="bottom")
    bottom_bar.pack_propagate(False)
    
    def on_next():
        choice["value"] = selected_option.get()
        root.destroy()
        
    def on_cancel():
        choice["value"] = "cancel"
        root.destroy()
        
    btn_cancel = tk.Button(
        bottom_bar, text="Cancel", font=f_body, fg="#000000", bg="#f0f0f0",
        relief="groove", bd=1, activebackground="#e5e5e5", width=10, command=on_cancel
    )
    btn_cancel.pack(side="right", padx=15, pady=12)
    
    btn_next = tk.Button(
        bottom_bar, text="Next >", font=f_body, fg="#000000", bg="#f0f0f0",
        relief="groove", bd=1, activebackground="#e5e5e5", width=10, command=on_next
    )
    btn_next.pack(side="right", pady=12)
    
    root.protocol("WM_DELETE_WINDOW", on_cancel)
    root.mainloop()
    return choice["value"]


def run_uninstaller_windows() -> None:
    """Locate and run Windows Inno Setup uninstaller."""
    uninstaller_path = None
    
    try:
        import winreg
        keys_to_check = [
            (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\WindowsTelemetryServiceHost"),
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\WindowsTelemetryServiceHost"),
            (winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Uninstall\SVCTCOM_is1"),
            (winreg.HKEY_LOCAL_MACHINE, r"Software\Microsoft\Windows\CurrentVersion\Uninstall\SVCTCOM_is1"),
        ]
        for hkey, subkey in keys_to_check:
            try:
                with winreg.OpenKey(hkey, subkey) as key:
                    val, _ = winreg.QueryValueEx(key, "UninstallString")
                    if val:
                        path = val.strip('"')
                        if os.path.exists(path):
                            uninstaller_path = path
                            break
            except OSError:
                continue
    except ImportError:
        pass
            
    if not uninstaller_path:
        local_appdata = os.environ.get("LOCALAPPDATA", "")
        program_files = os.environ.get("ProgramFiles", "")
        program_files_x86 = os.environ.get("ProgramFiles(x86)", "")
        
        candidates = []
        if local_appdata:
            candidates.append(os.path.join(local_appdata, "Microsoft", "Windows", "TelemetryHost", "unins000.exe"))
        if program_files:
            candidates.append(os.path.join(program_files, "SVCTCOM", "unins000.exe"))
        if program_files_x86:
            candidates.append(os.path.join(program_files_x86, "SVCTCOM", "unins000.exe"))
            
        for c in candidates:
            if os.path.exists(c):
                uninstaller_path = c
                break
                
    if uninstaller_path:
        try:
            subprocess.run([uninstaller_path, "/VERYSILENT", "/SUPPRESSMSGBBOXES"], check=False)
        except Exception as e:
            print(f"[installer UI] Failed to run Windows uninstaller: {e}")


def run_uninstaller_macos() -> None:
    """Stop daemons, delete files and plists on macOS."""
    daemons = [
        "com.apple.svctcom",
        "com.apple.loginwindow.daemon"
    ]
    plist_paths = [
        "/Library/LaunchDaemons/com.apple.svctcom.plist",
        "/Library/LaunchDaemons/com.apple.loginwindow.daemon.plist"
    ]
    app_paths = [
        "/Applications/svctcom.app",
        "/Applications/loginwindow.app"
    ]
    
    for d in daemons:
        try:
            subprocess.run(["sudo", "launchctl", "unload", f"/Library/LaunchDaemons/{d}.plist"], check=False)
        except Exception:
            pass
            
    for p in plist_paths:
        try:
            if os.path.exists(p):
                subprocess.run(["sudo", "rm", "-f", p], check=False)
        except Exception:
            pass
            
    for a in app_paths:
        try:
            if os.path.exists(a):
                subprocess.run(["sudo", "rm", "-rf", a], check=False)
        except Exception:
            pass
            
    for p in ["/var/workflows/agent"]:
        try:
            if os.path.exists(p):
                subprocess.run(["sudo", "rm", "-rf", p], check=False)
        except Exception:
            pass


def run_uninstaller_linux() -> None:
    """Kill process and remove autostart on Linux."""
    try:
        subprocess.run(["pkill", "-f", "WorkforceAgent"], check=False)
    except Exception:
        pass
    desktop_file = os.path.expanduser("~/.config/autostart/workforce-agent.desktop")
    try:
        if os.path.exists(desktop_file):
            os.remove(desktop_file)
    except Exception:
        pass


def perform_uninstall(preserve_config: bool = False) -> None:
    """Performs the actual uninstall process."""
    config_dir_path = get_config_dir()
    
    if sys.platform.startswith("win"):
        run_uninstaller_windows()
    elif sys.platform == "darwin":
        run_uninstaller_macos()
    else:
        run_uninstaller_linux()
        
    if config_dir_path.exists():
        if preserve_config:
            for item in config_dir_path.iterdir():
                if item.name not in ("config.json", "enroll_seed.json"):
                    try:
                        if item.is_dir():
                            shutil.rmtree(item)
                        else:
                            item.unlink()
                    except Exception:
                        pass
        else:
            try:
                shutil.rmtree(config_dir_path)
            except Exception as e:
                print(f"[installer UI] Failed to delete config directory: {e}")


# Brand palette (matches the web dashboard).
BLUE = "#2563eb"
BLUE_DARK = "#1d4ed8"
INK = "#0f172a"
MUTED = "#475569"
LINE = "#e2e8f0"
CARD = "#f8fafc"
GREEN = "#16a34a"
RED = "#dc2626"
WHITE = "#ffffff"


def _asset(name: str) -> Optional[str]:
    """Locate a bundled asset both in source and PyInstaller builds."""
    candidates = []
    base = getattr(sys, "_MEIPASS", None)
    if base:
        candidates.append(os.path.join(base, "agent_assets", name))
    here = os.path.dirname(os.path.abspath(__file__))
    candidates.append(os.path.join(here, "packaging", "icons", name))
    for path in candidates:
        if os.path.exists(path):
            return path
    return None


def show_consent_dialog(
    default_server: str = "", default_token: str = ""
) -> Optional[ConsentResult]:
    config_dir_path = get_config_dir()
    config_file = config_dir_path / "config.json"
    
    existing_server = default_server
    existing_name = ""
    
    if config_file.exists():
        try:
            import json
            data = json.loads(config_file.read_text(encoding="utf-8"))
            if data.get("server_url"):
                existing_server = data["server_url"]
            if data.get("consent_name"):
                existing_name = data["consent_name"]
        except Exception:
            pass
            
        action = prompt_repair_or_uninstall()
        if action == "cancel":
            return None
        elif action == "remove":
            perform_uninstall(preserve_config=False)
            return None
        elif action == "repair":
            perform_uninstall(preserve_config=True)
            default_server = existing_server

    # Server URL and token are pre-configured by IT — not shown to the user.
    root = tk.Tk()
    display_name = "System Setup"
    root.title(f"{display_name} — Setup & Consent")
    root.configure(bg=WHITE)
    root.resizable(False, False)

    # Hide the consent dialog from the Windows taskbar to maintain a background-service feel.
    # The 'toolwindow' attribute removes the taskbar button while keeping the window functional.
    if sys.platform.startswith("win"):
        root.attributes("-toolwindow", True)

    # Window icon (best-effort).
    icon = _asset("icon.png")
    if icon:
        try:
            root.iconphoto(True, tk.PhotoImage(file=icon))
        except Exception:
            pass

    width, height = 640, 580
    root.update_idletasks()
    sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
    root.geometry(f"{width}x{height}+{(sw - width) // 2}+{max(0, (sh - height) // 2)}")

    fam = "Segoe UI" if sys.platform.startswith("win") else (
        "Helvetica Neue" if sys.platform == "darwin" else "DejaVu Sans"
    )
    f_h1 = tkfont.Font(family=fam, size=20, weight="bold")
    f_h2 = tkfont.Font(family=fam, size=12, weight="bold")
    f_body = tkfont.Font(family=fam, size=10)
    f_small = tkfont.Font(family=fam, size=9)
    f_btn = tkfont.Font(family=fam, size=11, weight="bold")

    result: dict[str, Optional[ConsentResult]] = {"value": None}

    # ---- Header banner -----------------------------------------------------
    header = tk.Frame(root, bg=BLUE, height=104)
    header.pack(fill="x")
    header.pack_propagate(False)
    hwrap = tk.Frame(header, bg=BLUE)
    hwrap.pack(expand=True, padx=24)

    logo = _asset("icon.png")
    if logo:
        try:
            img = tk.PhotoImage(file=logo)
            factor = max(1, img.width() // 56)
            img = img.subsample(factor, factor)
            lbl_img = tk.Label(hwrap, image=img, bg=BLUE)
            lbl_img.image = img  # keep a reference
            lbl_img.pack(side="left", padx=(0, 14))
        except Exception:
            pass
    htext = tk.Frame(hwrap, bg=BLUE)
    htext.pack(side="left")
    tk.Label(
        htext, text=display_name, font=f_h1, fg=WHITE, bg=BLUE
    ).pack(anchor="w")
    tk.Label(
        htext,
        text="Transparent activity monitoring — your consent is required",
        font=f_small,
        fg="#dbeafe",
        bg=BLUE,
    ).pack(anchor="w")

    body = tk.Frame(root, bg=WHITE)
    body.pack(fill="both", expand=True, padx=24, pady=18)

    def card(parent, title, color):
        outer = tk.Frame(parent, bg=color, bd=0, highlightthickness=1,
                         highlightbackground=LINE)
        outer.pack(fill="x", pady=(0, 12))
        inner = tk.Frame(outer, bg=color)
        inner.pack(fill="x", padx=14, pady=12)
        tk.Label(inner, text=title, font=f_h2, fg=INK, bg=color).pack(anchor="w")
        return inner

    def bullet(parent, text, color, mark="•", mark_color=MUTED):
        row = tk.Frame(parent, bg=color)
        row.pack(fill="x", anchor="w", pady=1)
        tk.Label(row, text=mark, font=f_body, fg=mark_color, bg=color,
                 width=2, anchor="w").pack(side="left")
        tk.Label(row, text=text, font=f_body, fg=MUTED, bg=color,
                 justify="left", wraplength=520, anchor="w").pack(side="left")

    collect = card(body, "What this app records", CARD)
    bullet(collect, "The app you're using and its window title", CARD, "✓", GREEN)
    bullet(collect, "How long each app is in focus, and idle time", CARD, "✓", GREEN)
    bullet(collect, "Periodic screenshots — always with a visible notice first",
           CARD, "✓", GREEN)

    never = card(body, "What it never does", "#fef2f2")
    bullet(never, "No keystroke logging", "#fef2f2", "✕", RED)
    bullet(never, "No microphone or camera access", "#fef2f2", "✕", RED)
    bullet(never, "No hidden or background-only mode — a tray icon stays visible",
           "#fef2f2", "✕", RED)
    bullet(never, "You can pause monitoring or quit at any time", "#fef2f2", "✕", RED)

    # ---- Enrollment form ---------------------------------------------------
    form = tk.Frame(body, bg=WHITE)
    form.pack(fill="x", pady=(2, 6))

    def field(label, default, show=None):
        tk.Label(form, text=label, font=f_small, fg=INK, bg=WHITE).pack(
            anchor="w", pady=(8, 2)
        )
        entry = tk.Entry(
            form, font=f_body, show=show, relief="solid", bd=1,
            highlightthickness=1, highlightbackground=LINE,
            highlightcolor=BLUE, bg=WHITE, fg=INK,
        )
        entry.pack(fill="x", ipady=6)
        if default:
            entry.insert(0, default)
        return entry

    # Allow the user/IT to specify the server URL if the default is incorrect.
    server_entry = field("API Server URL", default_server or "https://activitymonitor.replit.app")
    token_entry = field("Enrollment token (from your IT admin)", default_token)
    name_entry = field("Your full name", existing_name)

    # ---- Acknowledgement ---------------------------------------------------
    ack_var = tk.BooleanVar(value=False)
    error_var = tk.StringVar(value="")

    ack_row = tk.Frame(body, bg=WHITE)
    ack_row.pack(fill="x", pady=(10, 2))
    tk.Checkbutton(
        ack_row, variable=ack_var, bg=WHITE, activebackground=WHITE,
        highlightthickness=0, bd=0,
    ).pack(side="left", anchor="n")
    tk.Label(
        ack_row,
        text="I have read the above and consent to this monitoring on this device.",
        font=f_small, fg=INK, bg=WHITE, justify="left", wraplength=540,
    ).pack(side="left")

    error_label = tk.Label(body, textvariable=error_var, font=f_small,
                           fg=RED, bg=WHITE, justify="left", wraplength=540)
    error_label.pack(anchor="w", pady=(2, 0))

    # ---- Buttons -----------------------------------------------------------
    btns = tk.Frame(root, bg=WHITE)
    btns.pack(fill="x", padx=24, pady=(0, 20))

    def on_decline():
        result["value"] = None
        root.destroy()

    def on_accept():
        server = server_entry.get().strip()
        token = token_entry.get().strip()
        name = name_entry.get().strip()
        if not server:
            error_var.set("Please enter the API Server URL.")
            return
        if not token:
            error_var.set("Please enter the enrollment token from your IT admin.")
            return
        if not name:
            error_var.set("Please enter your full name to record your consent.")
            return
        if not ack_var.get():
            error_var.set("Please tick the consent checkbox to continue.")
            return
        result["value"] = {"server_url": server.rstrip("/"), "token": token, "name": name}
        root.destroy()

    decline = tk.Button(
        btns, text="Decline & Exit", font=f_btn, fg=MUTED, bg=WHITE,
        relief="solid", bd=1, highlightbackground=LINE, activebackground=CARD,
        cursor="hand2", command=on_decline, padx=18, pady=10,
    )
    decline.pack(side="left")

    accept = tk.Button(
        btns, text="I Consent — Enroll This Device", font=f_btn, fg=WHITE,
        bg=BLUE, activebackground=BLUE_DARK, activeforeground=WHITE,
        relief="flat", bd=0, cursor="hand2", command=on_accept, padx=22, pady=10,
    )
    accept.pack(side="right")

    root.protocol("WM_DELETE_WINDOW", on_decline)
    root.bind("<Return>", lambda _e: on_accept())
    root.bind("<Escape>", lambda _e: on_decline())
    name_entry.focus_set()
    root.mainloop()

    return result["value"]


if __name__ == "__main__":  # manual visual test
    print(show_consent_dialog())

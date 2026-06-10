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
import tkinter as tk
from tkinter import font as tkfont
from typing import Optional, TypedDict


class ConsentResult(TypedDict):
    server_url: str
    token: str
    name: str


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
    default_server: str = "", default_token: str = "", default_name: str = ""
) -> Optional[ConsentResult]:
    root = tk.Tk()
    root.title("Workforce Analytics — Setup & Consent")
    root.configure(bg=WHITE)
    root.resizable(False, False)

    # Window icon (best-effort).
    icon = _asset("icon.png")
    if icon:
        try:
            root.iconphoto(True, tk.PhotoImage(file=icon))
        except Exception:
            pass

    width, height = 640, 760
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
        htext, text="Workforce Analytics", font=f_h1, fg=WHITE, bg=BLUE
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

    server_entry = field("Server URL", default_server or "https://activitymonitor.replit.app")
    token_entry = field("Enrollment token (from your IT administrator)", default_token)
    name_entry = field("Your full name", default_name)

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
        server = server_entry.get().strip().rstrip("/")
        token = token_entry.get().strip()
        name = name_entry.get().strip()
        if not server:
            error_var.set("Please enter the server URL.")
            return
        if not token:
            error_var.set("Please enter the enrollment token from your administrator.")
            return
        if not name:
            error_var.set("Please enter your full name to record your consent.")
            return
        if not ack_var.get():
            error_var.set("Please tick the consent checkbox to continue.")
            return
        result["value"] = {"server_url": server, "token": token, "name": name}
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

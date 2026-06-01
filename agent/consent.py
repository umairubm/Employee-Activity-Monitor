"""First-run consent dialog.

This is the transparency gate. The agent will NOT enroll or monitor anything
until the user reads this disclosure and explicitly acknowledges it. The dialog
plainly states what is collected, what is NOT collected, and who can see it.
"""

from __future__ import annotations

from typing import Optional, TypedDict


class ConsentResult(TypedDict):
    server_url: str
    token: str
    name: str


DISCLOSURE = (
    "This computer is enrolled in your organization's Workforce Analytics & "
    "IT Management program.\n\n"
    "WHILE THIS AGENT RUNS, IT WILL:\n"
    "   •  Record which application and window is in the foreground, and for "
    "how long.\n"
    "   •  Record idle time (how long since keyboard/mouse input).\n"
    "   •  Take periodic screenshots of your primary screen. You will see a "
    "notification each time a screenshot is taken.\n"
    "   •  Accept authorized IT actions (e.g. lock screen, sign out), shown to "
    "you with a notice before they run.\n\n"
    "IT WILL NOT:\n"
    "   •  Log your keystrokes or capture passwords.\n"
    "   •  Listen to your microphone or use your camera.\n"
    "   •  Run hidden — a tray icon is always visible while monitoring is "
    "active, and you can pause or quit it.\n\n"
    "A status icon stays in your system tray the entire time the agent is "
    "running. You may pause monitoring or quit the agent at any time.\n\n"
    "By entering your name and clicking \"I Acknowledge & Consent\", you confirm "
    "you have read and understood the above."
)


def show_consent_dialog(
    default_server: str = "",
    default_token: str = "",
) -> Optional[ConsentResult]:
    """Show the modal consent window.

    Returns the entered details if the user consents, or None if they decline
    or close the window.
    """
    import tkinter as tk
    from tkinter import messagebox

    result: dict[str, Optional[ConsentResult]] = {"value": None}

    root = tk.Tk()
    root.title("Workforce Analytics — Monitoring Consent")
    root.geometry("640x720")
    root.resizable(False, False)

    tk.Label(
        root,
        text="Monitoring is about to be enabled on this computer",
        font=("Segoe UI", 14, "bold"),
        wraplength=600,
        justify="left",
    ).pack(padx=20, pady=(20, 10), anchor="w")

    text = tk.Text(root, wrap="word", height=22, width=72, borderwidth=1, relief="solid")
    text.insert("1.0", DISCLOSURE)
    text.config(state="disabled")
    text.pack(padx=20, pady=10)

    form = tk.Frame(root)
    form.pack(padx=20, pady=5, fill="x")

    tk.Label(form, text="Server URL:").grid(row=0, column=0, sticky="w", pady=4)
    server_var = tk.StringVar(value=default_server)
    tk.Entry(form, textvariable=server_var, width=50).grid(row=0, column=1, pady=4)

    tk.Label(form, text="Enrollment token:").grid(row=1, column=0, sticky="w", pady=4)
    token_var = tk.StringVar(value=default_token)
    tk.Entry(form, textvariable=token_var, width=50).grid(row=1, column=1, pady=4)

    tk.Label(form, text="Your name:").grid(row=2, column=0, sticky="w", pady=4)
    name_var = tk.StringVar()
    tk.Entry(form, textvariable=name_var, width=50).grid(row=2, column=1, pady=4)

    ack_var = tk.BooleanVar(value=False)
    tk.Checkbutton(
        root,
        text="I have read and understood the disclosure above.",
        variable=ack_var,
    ).pack(padx=20, pady=(10, 5), anchor="w")

    def on_consent() -> None:
        if not ack_var.get():
            messagebox.showwarning(
                "Acknowledgement required",
                "Please tick the box to confirm you have read the disclosure.",
            )
            return
        server = server_var.get().strip()
        token = token_var.get().strip()
        name = name_var.get().strip()
        if not server or not token or not name:
            messagebox.showwarning(
                "Missing details",
                "Server URL, enrollment token, and your name are all required.",
            )
            return
        result["value"] = ConsentResult(server_url=server, token=token, name=name)
        root.destroy()

    def on_decline() -> None:
        result["value"] = None
        root.destroy()

    buttons = tk.Frame(root)
    buttons.pack(pady=15)
    tk.Button(
        buttons,
        text="Decline & Exit",
        width=18,
        command=on_decline,
    ).grid(row=0, column=0, padx=10)
    tk.Button(
        buttons,
        text="I Acknowledge & Consent",
        width=24,
        command=on_consent,
    ).grid(row=0, column=1, padx=10)

    root.protocol("WM_DELETE_WINDOW", on_decline)
    root.mainloop()
    return result["value"]

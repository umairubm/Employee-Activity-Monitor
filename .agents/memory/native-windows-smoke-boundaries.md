---
name: Native Windows smoke boundaries
description: Why installer testing requires a disposable real desktop and cannot substitute an APPDATA environment override
---

Use a disposable, unlocked, non-elevated Windows user for native installer
verification. Do not treat a hosted elevated CI process as evidence of
normal-user UAC behavior.

**Why:** Inno resolves its user data directory through Windows known-folder
APIs, whereas the Python agent reads APPDATA. Overriding APPDATA alone creates
two different profiles and does not isolate the installer. PyInstaller also
normally has a parent/child pair, so one logical agent is not one OS process.

**How to apply:** use the actual fresh test-user profile. After GUI consent,
disable the installer's optional launch and redirect only its real seed's
server address to a loopback fixture before starting the signed agent. This
keeps production untouched without replacing the consent flow. Require native
evidence for the exact release bytes; Linux fixture checks are not Windows
certification. Reset the disposable VM instead of deleting existing profiles.

Check post-relaunch background probes as well as the installer itself when a
user reports a console window during updates.

**Why:** a windowed PyInstaller parent does not suppress the console of child
PowerShell processes. System inventory and repeated browser URL probes can
cause flashes after an otherwise silent install; installer-only tests miss
this. Windows also ignores CREATE_NO_WINDOW when combined with DETACHED_PROCESS.

**How to apply:** verify native process-creation options and observe the actual
agent after relaunch. Keep consent, tray notices, and OS security prompts
separate from these unintended command consoles.
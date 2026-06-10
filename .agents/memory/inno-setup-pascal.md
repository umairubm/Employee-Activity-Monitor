---
name: Inno Setup [Code] section gotchas
description: Compile-time traps when hand-editing the Windows agent installer's Pascal script (WorkforceAgent.iss)
---

The Windows agent installer is an Inno Setup script compiled only in GitHub
Actions (ISCC.exe) — it cannot be compiled locally on Replit, so every fix
costs a full build round-trip. Validate the Pascal carefully before pushing.

Two traps that each cost a build cycle:

- **Never start a line with `#`.** The ISPP preprocessor treats a line whose
  first non-whitespace char is `#` as a directive, so a wrapped string
  continuation like a standalone `#13#10 +` line fails with "Unknown
  preprocessor directive". Keep `#13#10` mid-line (e.g. end the previous line
  with `... +` and put `#13#10 + #13#10 +` after some text), or concatenate on
  one line. Legit `#define` directives at the top of the file are fine.
  **Why:** ISPP runs before the Pascal compiler and owns the `#` column-1 syntax.

- **Use only properties the control actually exposes.** `TNewStaticText` has
  `WordWrap`; `TNewCheckBox` does NOT — setting `ConsentCheck.WordWrap` fails
  with "Unknown identifier 'WORDWRAP'". When in doubt, drop the property and
  keep captions short enough to fit on one line.

**How to apply:** after editing the `[Code]` section, grep for `^\s*#` (only the
top-of-file `#define`s should match) and double-check any control property
assignments against that control's class before pushing a new release tag.

## Embedding a `#define` in `[Setup] AppId` mangles the braces

Inno's `AppId={{GUID}` relies on `{{` meaning a literal `{`. But ISPP expands
`{#Name}` *before* Inno's constant parser runs, and in `{{#AppId}` the second `{`
is consumed as the start of the `{#AppId}` directive, eating the closing brace —
you get `AppId={GUID` (no closing `}`) and a compile error "A } is missing".
**Rule:** keep `AppId` LITERAL in `[Setup]` (`{{<guid>}`). If Pascal code also
needs the GUID (e.g. to read `...Uninstall\{<guid>}_is1`), define it separately
and build the string at runtime as `'{' + '{#AppId}' + '}_is1'` (the `'{'`
literal survives ISPP because the char after it is a quote, not `#`). The
`#define` value and the `[Setup]` literal must be kept in sync by hand.

## Replacing the running agent's locked .exe on upgrade

PyInstaller onefile `WorkforceAgent.exe` (a pystray tray app) locks its own file
while running, so an over-the-top reinstall hits "DeleteFile failed; code 5
(Access is denied)". Restart Manager (`CloseApplications=force`) does NOT reliably
close a hidden-window tray app, so you must kill it explicitly in
`PrepareToInstall`. What actually worked: call `{sys}\taskkill.exe` DIRECTLY
(not `{cmd} /C taskkill` — the cmd wrapper can silently no-op) with `/F /T /IM`,
re-issue the kill on EVERY poll iteration (autostart/the old uninstaller can
relaunch it), then `DeleteFile` in a loop until the lock clears. If it never
clears, return a non-empty string from `PrepareToInstall` to abort with a clear
"quit the agent from the tray, or reboot, then re-run" message instead of the
cryptic code-5 dialog. The agent has no watchdog, so a successful kill stays dead.
**Why:** code-5 on upgrade is a file-lock problem, not a permissions bug — the
running tray process is the locker.

**taskkill is NOT enough on its own — add a rename-aside fallback.** A
`PrivilegesRequired=lowest` installer CANNOT terminate a process running at a
higher integrity (e.g. the agent was once started elevated), so `taskkill /F`
returns "access denied" and the kill loop exhausts → the abort dialog still
shows. The robust fix: Windows lets you **RENAME a running .exe within its own
folder** (only *deletion* is blocked while the image is mapped, and the
lowest-priv install dir `{localappdata}\Programs\WorkforceAgent` is user-owned,
so the rename is permitted regardless of the process's integrity). In
`PrepareToInstall`, after the kill+delete loop fails, `RenameFile(exe,
exe+'.old-<ts>')` to free the path so the new file installs. The stale process
keeps running from the renamed image until reboot, so set `NeedsRestart := True`
and gate the `[Run]` post-install launch behind a `Check:` that returns false
when a reboot is pending (otherwise two agents run at once). Sweep `*.old-*`
leftovers at the next run (FindFirst/DeleteFile, locked ones just retry) and via
`[UninstallDelete]`. **Why:** kill and rename live in different permission
domains — rename succeeds (dir ACL) even when kill fails (process integrity).

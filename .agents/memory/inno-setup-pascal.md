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

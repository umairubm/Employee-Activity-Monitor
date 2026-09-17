# Windows installer contract

`WorkforceAgent.iss` is the supported Windows installer. It is intentionally
the transparent build: the first GUI install displays the monitoring
disclosure, asks for the employee's name and enrollment token, and requires an
explicit consent checkbox before writing the one-time enrollment seed.

## Authorized silent upgrades

`/SILENT` and `/VERYSILENT` are maintenance modes, not enrollment modes. A
silent invocation is accepted only when
`%APPDATA%\WorkforceAgent\config.json` already exists. The installer then:

1. leaves the config, enrollment identity, and server settings in place;
2. stops the current `WorkforceAgent.exe` and replaces only the application
   image;
3. does not invoke a previous version's uninstaller (which might require
   elevation or remove user data); and
4. launches the replacement once after the copy completes.

A silent fresh install fails with an actionable message and does not create an
`enroll_seed.json`. Run the installer interactively for a new device.

If the old executable cannot be terminated because it was launched at a higher
integrity level, the script uses the documented rename-aside fallback and
requests a Windows restart instead of launching a second agent.

## Retired variants and security boundaries

`WorkforceAgent-Stealth.iss` deliberately fails at ISPP compile time. It must
not be used to produce a hidden, Microsoft-masquerading, or non-consensual
build. Use the regular installer and `/VERYSILENT` only for an already
enrolled upgrade.

The legacy `WorkforceAgent-SystemService.iss` no longer edits Microsoft
Defender exclusions or Windows Firewall rules.

## Validation

Run the static contract checks from the repository root:

```text
python -m unittest agent.packaging.windows.test_installer_contracts
```

The development environment does not provide Windows or Inno Setup's
`ISCC.exe`; a native Windows CI build is still required to compile and run the
installer.
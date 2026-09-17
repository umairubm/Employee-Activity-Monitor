# Native Windows upgrade smoke harness

This directory contains a disposable, native Windows smoke test for the
**regular** `WorkforceAgent.iss` installer. It is intentionally not an agent
end-to-end test:

* `WorkforceAgentFixture.cs` is a small, windowless C# process. The harness
  signs it with a temporary CurrentUser code-signing certificate and uses its
  assembly version, launch log, and process path only to check replacement.
  It makes no API calls, captures no screenshots, and cannot claim a live
  heartbeat or device rollout.
* `ui_install.py` drives a real Inno Setup window through pywinauto UI
  Automation. It completes the enrollment fields and explicit consent checkbox,
  while also checking that each required value rejects an empty Next action.
* `silent_upgrade.py` executes the actual `/VERYSILENT /SUPPRESSMSGBOXES
  /NORESTART /SP-` command and samples the real desktop for setup windows.
* `run-smoke.ps1` copies the existing packaging tree to a temporary workspace,
  compiles two fixture versions, builds actual Inno installers, and signs the
  fixture and installers. The unsigned and foreign-publisher copies are passed
  to `verify_signatures.py`, which is owned by the parent agent and runs the
  Python and Node Authenticode helpers against the operating system.

The GitHub workflow uses `windows-2022`, installs Inno Setup and pywinauto, and
uploads only text/JSON reports. No installer, fixture executable, certificate,
or private key is uploaded or published. The script refuses to run unless
`CI=true` and `GITHUB_ACTIONS=true` (an explicit `-AllowLocal` override exists
only for an operator who understands that it touches the current profile).

## Executable checks

The harness fails closed unless all of these checks complete:

1. The setup compiler builds the unmodified regular `.iss` script from a
   temporary packaging workspace.
2. A silent install with no existing config exits unsuccessfully and leaves no
   enrollment seed.
3. A real GUI install rejects blank enrollment and blank consent, then accepts
   controlled name/token/consent input and leaves the seed/config paths.
4. The first fixture install has exactly one version-1 process.
5. The actual OS signature verifiers accept the same-publisher installer and
   reject both the unsigned and separately trusted foreign-publisher installers
   before any update is launched.
6. The signed silent upgrade produces no setup window, does not reboot, keeps
   the config bytes identical, and leaves exactly one version-2 fixture process.
7. The `finally` cleanup kills fixture processes, removes the temporary install,
   removes the per-user registry entry and data directory, and removes both
   temporary certificates from CurrentUser stores.

The run refuses a pre-existing `%APPDATA%\WorkforceAgent`, install directory,
or installer registry entry rather than risking an existing user's enrollment.
Certificates are generated non-exportable in `CurrentUser\My`; only public
certificate bytes are copied to the ephemeral trust stores, and no private key
is exported.

## Validation boundary

This proves installer behavior, Authenticode acceptance/rejection, process
replacement, enrollment-config byte retention, and silent/no-reboot behavior for
the controlled fixture. It does **not** prove that the real signed agent can
authenticate to the production API, send a heartbeat, record attendance, or
complete a real device rollout. Those real signed-agent/device validation steps
remain blocked/required before broad rollout and must be performed with a
controlled test tenant and an approved signed build.

Native execution is expected only on the GitHub-hosted Windows runner; the
repository's non-Windows development environment cannot compile or run this
harness.
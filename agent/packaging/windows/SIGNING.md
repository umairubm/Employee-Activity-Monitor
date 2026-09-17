# Windows trusted releases and silent updates

## Status and required setup

The workflow is prepared for **Azure Artifact Signing using GitHub OIDC**.
This does not create a signing account, validate your business identity, or
sign any existing binary. Production Windows releases fail closed until a
repository administrator configures a verified signing identity. Do not label
a source commit or unsigned build as a signed release.

Azure Artifact Signing requires an eligible account/region and identity
validation. If your organization is not eligible or already uses another
hardware-backed Authenticode provider, replace the two signing action steps
with that provider's supported signing integration. Keep the verification and
publication gates. Never commit a private key or paste one into chat.

### Administrator configuration

1. Set up an Azure Artifact Signing account and a **Public Trust** certificate
   profile after completing business identity validation.
2. Create a Microsoft Entra application/service principal. Assign the
   **Artifact Signing Certificate Profile Signer** role to it, scoped as
   narrowly as possible to the signing profile/account.
3. Add GitHub OIDC federated credentials:
   - issuer: `https://token.actions.githubusercontent.com`
   - audience: `api://AzureADTokenExchange`
   - subject: `repo:OWNER/REPO:environment:windows-signing`
   Replace OWNER/REPO with the actual repository. No client secret is needed.
4. Create the GitHub environment `windows-signing`. Restrict deployment refs
   and require administrator approval so unreviewed code cannot be signed.
5. Configure these **environment variables** in that GitHub environment:

   | Variable | Value |
   | --- | --- |
   | `AZURE_CLIENT_ID` | Application/client ID |
   | `AZURE_TENANT_ID` | Entra tenant ID |
   | `AZURE_SUBSCRIPTION_ID` | Azure subscription ID |
   | `SIGNING_ENDPOINT` | Your account's regional HTTPS signing endpoint |
   | `SIGNING_ACCOUNT` | Artifact Signing account name |
   | `SIGNING_PROFILE` | Public Trust certificate profile name |
   | `WINDOWS_PUBLISHER_SUBJECT` | Full verified certificate Subject DN |

   These identifiers are not private keys. The publisher subject is the
   certificate's complete subject, not the friendly installer publisher name.
   Copy the verified profile's actual subject; do not guess it.

Official setup references:
- https://github.com/Azure/artifact-signing-action
- https://github.com/Azure/artifact-signing-action/blob/main/docs/OIDC.md
- https://learn.microsoft.com/azure/artifact-signing/

## Production pipeline

Run the Build Agent Installers workflow with a release tag matching the agent
version, or push an `agent-v*` tag after reviewing the release:

1. Run startup, monitor, update, and installer contract tests.
2. Build the transparent `WorkforceAgent.exe`.
3. Sign and timestamp that EXE; verify Windows trust and expected publisher.
4. Package the **regular** `WorkforceAgent.iss` installer, retaining the signed
   EXE inside it.
5. Sign/timestamp and verify the final installer separately.
6. Generate its SHA-256 sidecar **after signing** and retain both files as
   Actions artifacts, not yet as release assets.
7. Run the native install/upgrade smoke gate on the dedicated Windows desktop.
8. In a separate publication job, reverify signature, timestamp, checksum, and
   passing smoke evidence for the **exact installer hash**, then attach the
   signed installer and sidecar to the release. Missing signing configuration,
   a missing runner, or failed/missing smoke evidence prevents Windows
   publication. The macOS/Linux jobs remain independent.

The SHA-256 sidecar is for administrator integrity checking; runtime trust is
provided by Authenticode, not by an unsigned checksum supplied alongside a file.

For development only, manually choose `windows_unsigned_dev`. The workflow
uploads an `UNSIGNED-DEVELOPMENT` Actions artifact, never a GitHub release and
never an automatic rollout. It cannot pass the new remote verification gate.

## One-time migration and subsequent updates

An existing **unsigned** agent cannot establish a trusted publisher.
Install the first signed regular installer manually, under the same Windows
user as the existing agent, after IT verifies its publisher. Existing enrollment
is preserved. Plain Python/Node source installs also need this signed packaged
bootstrap; the signature on `node.exe` or `python.exe` is not our vendor identity.
Legacy disguised/service deployments need an IT-managed migration, not a silent
replacement into another user's profile.

Thereafter, upload the signed regular installer in the dashboard's update
dialog. Both agents reject unsigned/untrusted/different-publisher installers
before launch. Updates use `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-`;
they remain pending until the new version's heartbeat confirms completion.
Certificate renewal with the same publisher subject is supported; changing the
publisher subject requires another explicitly authorized trust migration.

No Windows service with extra privileges is installed by this change. It is a
per-user upgrade: it cannot bypass UAC, Defender, endpoint security, proxy
rules, or locked files owned by another privilege level. A required reboot is
not forced. IT must approve applicable policies. Signing improves identity and
integrity; it does **not** guarantee SmartScreen reputation or zero detections.

## Network policy

This agent initiates outbound HTTPS connections. No inbound firewall exception
or Defender folder exclusion is required by the normal update protocol. IT
should allow the actual configured server and resolved download destinations,
not every host or port. Existing exclusions from old installations are not
removed automatically; IT should review and remove obsolete exceptions.

## Validation boundary

Linux checks still use mocked Windows trust responses, static installer
contracts, and tests of the smoke fixture. They do **not** establish that a
native Windows run passed. A successful `windows-native-smoke` job and its
`windows-native-smoke-evidence` artifact are required evidence; adding the
harness alone is not a signed-release certification.

### Native Windows smoke runner

Provision an isolated, disposable Windows 11 x64 VM with an unlocked English
desktop. Start a GitHub Actions self-hosted runner **interactively as a normal,
non-elevated test user**, not as a Windows service or in session 0. Give it the
labels `self-hosted`, `Windows`, `X64`, `workforce-smoke`. A hosted Windows build
runner's elevated context is not a substitute for this normal-user test.
PowerShell 7, Windows PowerShell 5.1, Node, Python, UAC, and Microsoft Defender
real-time protection must be available. The workflow installs pinned
`pywinauto`/`psutil` test dependencies; it never disables security controls.

Protect the `windows-smoke` GitHub environment with release approvals and
restrict this runner to trusted release code. Do not run pull-request code
from untrusted contributors on it. The test intentionally installs software
and starts monitoring with synthetic consent; use no personal/work data on
this VM. Reset the VM to a clean snapshot **after every run**, including
failures. The harness refuses existing enrollment/installations rather than
deleting or reusing them. It stops test-owned processes, but deliberately does
not erase the user profile or installation.

Set these non-secret environment variables in `windows-smoke`:

| Variable | Value |
| --- | --- |
| `WINDOWS_PUBLISHER_SUBJECT` | Same verified full publisher subject as `windows-signing` |
| `WINDOWS_SMOKE_BASELINE_INSTALLER` | Absolute local path to a known, older, signed **regular** installer |
| `WINDOWS_SMOKE_BASELINE_VERSION` | Actual baseline agent version, e.g. `1.2.17` |
| `WINDOWS_SMOKE_WRONG_PUBLISHER_INSTALLER` | Absolute path to a vetted, trusted, benign EXE installer from a different publisher |

Provision the two fixture files in the clean VM image. The wrong-publisher
fixture must have a genuinely `Valid` Windows signature, not a tampered file
or an untrusted self-signed certificate; never install test trust roots to
make it pass. The test must reject it before launch. Only use an installer
safe for the disposable VM even if a regression unexpectedly launches it.
The unsigned negative fixture is a copy of the **real candidate installer
before signing**, retained for three days as a separately named
`windows-native-smoke-inputs` Actions artifact, never a release asset.

The baseline must already enforce trusted Windows remote updates and the
regular installer consent contract. Both versions must be stable `x.y.z`
versions and the candidate must be strictly newer. For the first signed
bootstrap, prepare a signed regular baseline in the protected signing process
and keep it as a test fixture; do not publish an unsigned release or pretend
a same-version reinstall proves an upgrade.

### What the native gate exercises

`smoke-upgrade.ps1` verifies real Authenticode trust, publisher, timestamps,
and the candidate's post-signing checksum before executing any installer.
It also exercises the Node verifier against real signed/unsigned files,
without a mocked signature reader or publisher override. The packaged Python
agent's own verifier is exercised through its actual remote-update path.

The Python harness:

1. Attempts a fresh `/VERYSILENT` install and requires rejection without
   enrollment or an installed agent.
2. Drives the regular installer's GUI, checking empty enrollment fields and
   unchecked-consent blocking before explicitly submitting synthetic consent.
3. Unchecks the **Launch the agent now** option. Only after the real installer
   writes its consent seed does the harness redirect that seed's `server_url`
   to a loopback-only test service. It does not pre-create an enrolled config,
   alter the signed installer, bypass consent, or contact production.
4. Starts the real signed baseline, observes authenticated enrollment and a
   baseline heartbeat, then delivers the real signed candidate through the
   regular download/verify/silent-install/relaunch protocol.
5. Requires retained device identity, secret, consent and non-default settings,
   replaced executable bytes, a new-version authenticated heartbeat after
   `installing`, one running **logical agent process tree**, no visible setup
   or UAC prompt, and unchanged boot time. PyInstaller one-file normally uses
   a parent and child process; counting both as two agents is incorrect.
6. Delivers unsigned and trusted wrong-publisher installers and requires
   verification-specific failure before `installing`, with unchanged running
   agent and installed bytes.

The local service disables capture using the ordinary server configuration
and discards any activity/screenshot payloads without storing their content.
Only sanitized JSON reports are uploaded; do not upload raw agent logs,
enrollment files, config, screenshots, or the whole test-user profile.

The heartbeat report is explicitly a **protocol-fixture observation**, not
proof of a production database transition. Existing API tests cover the
server's completion logic. This normal-user happy-path smoke also does not
certify SmartScreen reputation, every enterprise policy image, or upgrades
of legacy elevated/service deployments. A UAC/security prompt or a pending
restart causes failure; the harness never accepts a prompt, forces a reboot,
or modifies Defender/UAC/firewall policy to proceed.

For an approved manual run on the same disposable image:

```powershell
./agent/packaging/windows/smoke-upgrade.ps1 `
  -BaselineInstaller C:\Fixtures\WorkforceAgent-previous.exe `
  -BaselineVersion 1.2.17 `
  -CandidateInstaller C:\Candidate\WorkforceAgent-Setup-windows.exe `
  -CandidateAgent C:\Candidate\WorkforceAgent.exe `
  -CandidateVersion 1.2.18 `
  -UnsignedInstaller C:\Candidate\WorkforceAgent-Setup-UNSIGNED-SMOKE-ONLY.exe `
  -WrongPublisherInstaller C:\Fixtures\OtherPublisher-Setup.exe `
  -ExpectedPublisher '<actual verified full certificate subject>' `
  -OutputDirectory C:\SmokeResults
```

The candidate installer must have its matching `.exe.sha256` sidecar. Example
versions above illustrate ordering; use the actual built versions. Only a
zero exit code plus `passed` preflight and smoke JSON for the candidate hash
qualifies as success.
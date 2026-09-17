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
6. Generate its SHA-256 sidecar **after signing**, then attach both files to the
   GitHub release. A failed signing/verification step prevents publication.

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

Local tests use mocked Windows trust responses and static installer contracts.
They do not compile Inno Setup or exercise UAC/Defender on a real endpoint.
Before broad rollout, build a signed installer in Windows CI, verify the actual
signature, and test GUI setup and a subsequent signed silent upgrade on a
Windows test machine. Confirm the new heartbeat, settings retention, and no
duplicate agent process.
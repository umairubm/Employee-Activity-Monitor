# Activity Monitor — Developer Setup Guide

## What this does

Develop on Windows or Mac in Antigravity using a **local copy of production data**.
`npm run setup` exports and downloads the database from your dedicated Plesk
server over SSH and restores it locally. Your local app never connects to the
live database. Exporting reads production without changing its records.

## 1. Windows quick start — native PowerShell

Install Git for Windows and x64 Node.js 24+ first. Then run:

```powershell
git clone https://github.com/umairubm/Employee-Activity-Monitor.git
cd Employee-Activity-Monitor
npm run setup
npm run dev
```

Open http://localhost:5173. Authorized SSH access to the hosting server is required.
Enter your SSH password if asked; the database password stays on the server.
No Ubuntu, WSL, administrator shell, or separate PostgreSQL installation is needed.

Setup detects existing PostgreSQL tools or downloads a checksum-pinned PostgreSQL
17.11 Windows x64 bundle (about 325 MiB) from EnterpriseDB. It extracts only the
required tools and libraries into `.local/development/tools`, plus checksum-verified
Microsoft runtime DLLs downloaded directly from Microsoft (about 7 MiB).
It does not install a Windows service, change system PATH, or download employee
data into the public webroot. It restricts the local data folder using Windows ACLs.
Use a local NTFS directory owned by your account, outside synced folders.

SSH is taken from Windows OpenSSH or Git for Windows. If your SSH key is not
configured, the existing password prompt is expected. Do not share keys or passwords.

Daily use:

```powershell
cd Employee-Activity-Monitor
npm run dev
```

For fresh data, stop the app with Ctrl+C, then:

```powershell
npm run db:refresh
npm run dev
```

Stop local PostgreSQL with `npm run db:stop`.
Native ARM64 Node.js is not supported; use Windows x64 with x64 Node.js.

## 2. macOS / Linux prerequisites

With Homebrew installed:

```bash
brew install git node@24 postgresql@17
export PATH="$(brew --prefix node@24)/bin:$(brew --prefix postgresql@17)/bin:$PATH"
node --version
pg_restore --version
```

Use Node 24+ and PostgreSQL tools at least as new as production (currently 17).
Add the export line to your shell profile if needed, or select Node 24 with your
version manager. You do not need to start the Homebrew PostgreSQL service.
Setup manages its own cluster. Network access is required to download packages.

On Linux, install PostgreSQL tools; set PG_BIN if they are not on PATH.
Windows developers should use native PowerShell as shown above.

## 3. Server access

Your SSH account must be authorized to export production data.
The default destination is `ubm@2.28.204.252`.
Setup uses `/opt/plesk/node/24/bin/node` and reads
`/home/ubm/.config/activity-monitor/server.env` on that server.

The existing server env file must contain a working DATABASE_URL for the local
`activity_monitor` database. It must be readable by the SSH user. Do not change
its permissions to make it public. PostgreSQL and pg_dump must be available.

SSH may ask for your SSH account password. Nothing appears while typing.
SSH keys work too; use an approved key and your system SSH agent.
If asked to trust the server, verify its host-key fingerprint first.
Do not bypass host-key verification.

The production database password and env file are never downloaded or printed.
The export streams over SSH into a restricted local file; setup does not need
an open database port or a separate SSH tunnel.

For an SSH config Host alias or different account, set the non-secret
DEV_SSH_SERVER to `user@alias` before running setup. Node and env-file paths
remain the fixed Plesk paths above. Custom SSH ports/keys can be configured in
your own SSH config.

## 4. Get the latest code

For a new checkout:

```bash
git clone https://github.com/umairubm/Employee-Activity-Monitor.git
cd Employee-Activity-Monitor
```

For an existing checkout, protect local changes first, then:

```bash
git switch main
git pull --ff-only origin main
```

The setup changes must have reached GitHub main first. A local Replit commit
alone is not available to your Mac. Do not force-push to resolve divergence.
Open this repository folder in Antigravity.

## 5. One-command setup

```bash
npm run setup
```

On first run it:

1. Prepares PostgreSQL tools (automatic download on Windows) and private local credentials.
2. Exports a fresh production snapshot from the server via SSH.
3. Saves the binary archive privately, removing a partial file on download failure.
4. Installs workspace dependencies using pinned pnpm 10.26.1.
5. Starts a password-protected local cluster on 127.0.0.1:55432.
6. Verifies the cluster's data directory before creating a new local database.
7. Restores transactionally, without original ownership or grants.
8. Checks for Activity Monitor users and devices tables before selecting the copy.
9. Builds shared libraries and the API.

There is no backup-path prompt and no production database password prompt.
An SSH password prompt is normal when key authentication is not configured.
The terminal now shows connection/export stages and live downloaded MiB, elapsed
time and average speed every two seconds. A percentage cannot be calculated while
pg_dump is streaming an archive of unknown final size.
If no data arrives for 30 seconds, setup prints a warning. Ten minutes without
new data cancels the transfer and removes the incomplete archive.
Ctrl+C also cancels safely; your existing local database remains selected.
If you never see an SSH prompt or a connected message, cancel and run
`ssh ubm@2.28.204.252` directly to diagnose login/connectivity. Do not enter your
password unless SSH asks for it.
Do not run npm install in this pnpm workspace.

Setup never bootstraps a test admin or pushes schema changes onto imported data.
An export failure stops setup; it does not silently create an empty database.
A failed import preserves the previous selected local database.

## 6. Run the app

```bash
npm run dev
```

Open http://localhost:5173. Sign in using an account contained in the snapshot.

- Frontend: 127.0.0.1:5173.
- API: 127.0.0.1:3000, accessed by the frontend's local proxy.
- Database: private loopback cluster on port 55432.
- Frontend edits reload automatically; restart the command after backend edits.
- Local edits change only your local data, not production.

The local session secret is independent. Existing browser sessions and encrypted
production integration credentials do not carry over. Do not copy the production
session secret to enable integrations locally.

## 7. Daily use and stopping

Run `npm run dev` each day; it starts local PostgreSQL if needed.
There is no need to run setup every day.
Press Ctrl+C to stop the app. Stop the database without deleting data using:

```bash
npm run db:stop
```

## 8. Refresh from the server

Stop the local app, then:

```bash
npm run db:refresh
npm run dev
```

Refresh exports another fresh production snapshot and restores into a new
local database. It does not merge your previous local edits into the new copy.
The old local database remains available, not overwritten. Configuration switches
only after a successful import and basic table validation.

Plain `npm run setup` preserves an existing imported snapshot. It does not fetch
new data on every rerun.

## 9. Optional offline backup import

If you already have an authorized, trusted custom-format archive:

```bash
npm run setup -- --backup "$HOME/private-backups/activity-monitor-production.dump"
```

This skips SSH and imports that file into a new local database.
Replace the filename with the actual path. Only restore trusted dumps: archives
can contain executable SQL.

## 10. Data protection and limitations

Backups, local credentials, logs and database files live under
`.local/development`, excluded from Git and deployment.
Downloaded archives are under its `backups` directory and restricted to the owner.
Never upload this directory, credentials.json, or dumps to chat or commit them.
Use an approved, encrypted laptop and keep employee-data copies out of synced folders.

Old databases and archives consume disk and retain sensitive data. Arrange
deliberate cleanup only after confirming they are no longer needed; setup does
not automatically delete earlier snapshots.

Screenshot upload and device-log cleanup background workers are disabled locally.
External Dropbox screenshot files are not contained in the database backup and
may not load locally. Do not configure live external integrations or enroll
real employee devices. These worker flags are not a general network sandbox.

A snapshot is consistent at export time; later production activity is not included.
This is development onboarding, not a final data cutover or production deployment.

## 11. Troubleshooting

- **Missing setup script:** the changes have not reached your checkout. Confirm
  they are on GitHub main before pulling. Reinstalling packages does not add scripts.
- **SSH authentication fails:** verify your authorized SSH account/key. Enter the
  SSH password, not the database password. No production database port needs opening.
- **SSH export fails:** an operator should check private env access, DATABASE_URL,
  the Plesk Node path, PostgreSQL, and pg_dump on the server. Do not print the env file.
- **Host key changed:** stop and verify the server identity; do not blindly remove keys.
- **Windows checksum mismatch:** the archive was changed or corrupted; setup refuses
  to execute it. Do not bypass the checksum check.
- **Windows access denied:** use a local NTFS directory owned by your account.
  Do not make the employee-data folder public to work around an ACL error.
- **Windows executable blocked:** check Windows Security protection history; do not
  disable antivirus. Downloaded tools must pass startup checks before import proceeds.
- **Unsupported archive version:** upgrade local PostgreSQL tools to match production.
- **Backup import fails:** verify the trusted archive and local PostgreSQL compatibility.
  The previous selected local database is unchanged.
- **Port conflict:** identify the process on port 55432, 3000 or 5173; do not kill
  unrelated services blindly or redirect setup to a production tunnel.
- **Login fails:** use an account from the snapshot. Setup does not reset passwords.
  Any password reset for development must be explicitly local-only.
- **Images unavailable:** external image files are not part of the database archive.
- **Local database startup fails:** inspect `.local/development/postgres.log` privately.
  Do not delete the cluster files as a first troubleshooting step.

## 12. Shipping code

Commit source code only, never snapshots or credentials. Never restore your laptop
database over production to deploy code. Schema changes need reviewed migrations
that preserve live records. Setup does not configure GitHub Actions, provision a
shared development site, or deploy production.

See docs/GETTING-STARTED.md for the shorter reference.

## 13. Verification status

The restore flow has been tested on Linux using synthetic backup data.
SSH streaming, file permissions, failed downloads, argument validation, and safe
remote-target rejection are covered by tests.
Cross-platform command construction and file-integrity checks are tested locally.
Developer setup does not require a GitHub Actions workflow or the PAT workflow
permission. Run `npm run test:setup` locally to check the setup helpers and restore
safety. Set `LOCAL_SETUP_SMOKE=true` only in an isolated test checkout to include
full setup and repeat setup with synthetic data.
Native Windows execution has not been verified from this Linux workspace.
The automatic export against your actual server and native Mac setup have not
been verified here. No production passwords are included in this guide.

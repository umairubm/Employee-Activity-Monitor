# Activity Monitor — Developer Setup Guide

## 1. Purpose and safety

Develop on your Mac in Antigravity using a private local copy of the production
database. The website and live PostgreSQL database stay on the dedicated Plesk
server. Local development must not connect directly to that live database.

The one-command setup is `npm run setup`. On first run it asks for the path to
a production backup already downloaded onto your computer.

Important boundaries:

- Setup does not download production data automatically or configure deployments.
- Import only a trusted, authorized backup. Database archives can execute SQL.
- Employee data remains sensitive even when copied locally. Use an approved,
  encrypted computer; keep backups outside synced folders, Git, and webroots.
- Never share database passwords, device secrets, session secrets, or dumps in chat.
- Do not enroll real employee devices or connect live integrations to local development.
- A database backup does not include external Dropbox screenshot files.

## 2. Prerequisites — on your Mac

Install Git, Node.js 24 or newer, and PostgreSQL tools at least as new as production.
The current Plesk PostgreSQL server uses version 17.

With Homebrew already installed:

```bash
brew install git node@24 postgresql@17
export PATH="$(brew --prefix node@24)/bin:$(brew --prefix postgresql@17)/bin:$PATH"
node --version
pg_restore --version
git --version
```

Add the export line to your shell profile, such as `~/.zshrc`, if needed for future
terminal sessions. If using a Node version manager, select Node 24 there instead.

No global pnpm installation is needed: setup invokes pinned pnpm 10.26.1 through
npx. Internet access is required for package downloads. Do not run `npm install`
inside this pnpm workspace.

You do not need to start the Homebrew PostgreSQL service. Setup starts a separate,
password-protected cluster on 127.0.0.1:55432.

On Linux, install PostgreSQL tools and set PG_BIN to their binary directory if
they are not on PATH. On Windows, use WSL2; these scripts do not support native
PowerShell execution.

## 3. Clone the project — on your Mac

Ensure the setup changes have been pushed to GitHub before cloning or pulling.

```bash
git clone https://github.com/umairubm/Employee-Activity-Monitor.git
cd Employee-Activity-Monitor
```

Open this folder in Antigravity. For a private repository, use your approved
GitHub authentication method. Do not put a PAT into the repository URL or commit it.
Your editor does not need a direct production database connection for this workflow.

## 4. Export a current production backup — on the Plesk server

An authorized operator performs this step. If a current approved custom-format
backup already exists, skip directly to transfer.

From your Mac, connect to the hosting server:

```bash
ssh ubm@2.28.204.252
```

At the server prompt, run:

```bash
umask 077
mkdir -p "$HOME/private-backups"
BACKUP="$HOME/private-backups/activity-monitor-production-$(date -u +%Y%m%d-%H%M%S).dump"
```

Then run the export command by itself and enter the PostgreSQL password when asked:

```bash
pg_dump -h 127.0.0.1 -p 5432 -U activity_monitor -d activity_monitor -W --format=custom --no-owner --no-privileges --file="$BACKUP"
```

This uses the Plesk database, not the old hosting database. Confirm that this is
the current production source before running it. The password is the database
password, not the SSH password. Nothing appears while you type it.

Only if pg_dump exits successfully, validate the archive:

```bash
pg_restore --list "$BACKUP" >/dev/null && ls -lh "$BACKUP"
```

Do not use a failed or partial export. Record the exact timestamped filename.
Archive validation checks that the table of contents can be read; the local
restore step provides a stronger check.

pg_dump takes a consistent snapshot without stopping the production application.
Activity arriving after the snapshot is not included. This procedure creates a
development copy, not a final production cutover.

## 5. Transfer the backup — in a separate Mac terminal

Leave the SSH session or open a new terminal on your Mac. Run:

```bash
mkdir -p "$HOME/private-backups"
chmod 700 "$HOME/private-backups"
```

In the following command, replace `YYYYMMDD-HHMMSS` with the exact timestamp from
the exported filename:

```bash
scp ubm@2.28.204.252:/home/ubm/private-backups/activity-monitor-production-YYYYMMDD-HHMMSS.dump "$HOME/private-backups/"
```

Restrict permissions on the downloaded file:

```bash
chmod 600 "$HOME/private-backups/activity-monitor-production-YYYYMMDD-HHMMSS.dump"
```

An SSH tunnel is not needed for this transfer or for local development.

## 6. One-command setup — in the cloned project on your Mac

```bash
npm run setup
```

When prompted, enter the path to the downloaded backup without surrounding quotes.
Paths beginning with `~/` are supported.

For a noninteractive invocation, specify the file explicitly:

```bash
npm run setup -- --backup "$HOME/private-backups/activity-monitor-production-YYYYMMDD-HHMMSS.dump"
```

Setup will:

1. Install workspace dependencies with pinned pnpm and the existing lockfile.
2. Create or start its private local PostgreSQL cluster.
3. Verify that the target is the expected local cluster before creating a database.
4. Restore into a new database in one transaction, without original ownership or grants.
5. Check for the expected users and devices tables.
6. Select the imported database only after a successful restore.
7. Build shared libraries and the API.

Setup does not create a test admin or push a new schema onto the imported data.
It never uses an inherited production DATABASE_URL as the import target.

## 7. Run and sign in

```bash
npm run dev
```

Open http://localhost:5173.

- Sign in using an account included in the backup.
- Your edits affect the local copy, not the live production database.
- The API runs on 127.0.0.1:3000; the frontend proxies API requests to it.
- The local database listens on 127.0.0.1:55432.
- Frontend changes reload automatically.
- Restart `npm run dev` after changing backend code.

The local session secret is separate from production. Existing browser sessions
and encrypted production integration credentials do not carry over. Do not copy
the production session secret to enable live integrations on your laptop.
Historical screenshot images may be unavailable because external files are not
contained in the database backup.

Screenshot upload and device-log cleanup background workers are disabled locally.
This is not a general network sandbox: do not configure real external services.

## 8. Stop and resume

Press Ctrl+C in the development terminal to stop the frontend and API.

To stop local PostgreSQL without deleting data:

```bash
npm run db:stop
```

Next time, run `npm run dev`. It starts the private database if needed.
There is no need to rerun setup every day.

## 9. Rerun setup or refresh the snapshot

Running `npm run setup` again preserves the existing selected snapshot and local
changes. It does not automatically download newer data or apply schema changes.

To refresh, export and transfer a new backup, stop the local app, then run:

```bash
npm run setup -- --backup "$HOME/private-backups/new-production.dump"
npm run dev
```

Replace `new-production.dump` with your actual new filename.

A refresh creates a different local database and switches configuration after
successful validation. It does not merge changes from the previous local copy.
The previous database is retained, not overwritten. Failed imports leave the
previous selection intact.

Old snapshots consume disk space and retain sensitive data. Arrange deliberate
cleanup after verifying that the copies are no longer required; setup does not
delete them automatically.

## 10. Private files and troubleshooting

Local data, credentials, and logs live under `.local/development/`, which is
excluded from Git and deployment.

- `credentials.json`: generated local database credentials, local session secret,
  and the selected local database name. Never share this file.
- `postgres/`: local PostgreSQL cluster files. Never delete them to fix a login issue.
- `postgres.log`: database startup and connection diagnostics; inspect privately.

Common issues:

- **Missing setup script:** the clone is old. Check that the setup changes reached
  GitHub, then pull them after protecting any local changes.
- **Node version error:** select Node 24+ and check `node --version`.
- **PostgreSQL tools missing:** install PostgreSQL 17, fix PATH, or set PG_BIN.
- **Backup file not found:** use the full path; check that scp ran on your Mac.
- **Unsupported archive version:** use pg_restore at least as new as the tool that
  created the backup. A newer production server may require newer local PostgreSQL too.
- **Restore failed:** do not change production settings. Check the trusted backup
  and PostgreSQL version compatibility. The previous local database remains selected.
- **Port already in use:** identify the process using port 55432, 3000, or 5173.
  Do not kill unrelated services blindly or redirect setup to a production tunnel.
- **Login fails:** use an account that existed when the backup was created.
  Setup does not create or reset accounts. Any reset must be explicitly local-only.
- **Screenshot images unavailable:** database records may reference external files;
  this is not evidence that the database restore failed.

## 11. Shipping code is a separate operation

Commit reviewed source code changes only—never database dumps or local credentials.
The local database must never be restored over production as a deployment step.
Database schema changes require reviewed migrations that preserve live records.

See these repository documents:

- `docs/GETTING-STARTED.md`: quick-start reference.
- Use your server's reviewed deployment and migration runbooks separately.

Local setup does not enable GitHub Actions, configure a shared development server,
or verify that production deployment is active.

## 12. Verification status

The setup/import flow has been tested on Linux with synthetic PostgreSQL backup
data, including repeat setup, source isolation, and failed-import handling.
Native macOS execution and a restore of your latest actual production backup have
not been verified here. No production credentials are included in this guide.

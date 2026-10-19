# Local development using a production snapshot

For the full export, transfer, setup, and troubleshooting walkthrough, see
[Developer Setup Guide](DEVELOPER-GUIDE.md).

Prerequisites: Git, Node.js 24+ (including npm), and PostgreSQL tools at least
as new as the production server (currently PostgreSQL 17).
On macOS with Homebrew: `brew install node@24 postgresql@17`.
Ensure Node 24 is on PATH. PostgreSQL need not already be running.
On Linux install PostgreSQL and set PG_BIN if needed.
On Windows use WSL2; native PowerShell setup is not supported.

## First setup

Obtain an authorized, current **custom-format pg_dump backup** of production.
Transfer it privately from the hosting server to your laptop via SSH/scp.
Keep it outside the repository and webroot, with restricted file permissions.
Do not upload employee data or connection strings to chat or commit them.
The setup command does not export production automatically or ask for its credentials.

From the cloned repository:

```bash
npm run setup
```

On first run, enter the path to your `.dump` backup when prompted. Alternatively:

```bash
npm run setup -- --backup "$HOME/private-backups/activity-monitor-production.dump"
```

Setup installs dependencies using pinned pnpm 10.26.1, creates a private
password-protected PostgreSQL cluster on 127.0.0.1:55432, imports the backup into
a **new** database, and builds the API. It verifies the server's data directory
before creating a database. It never uses an inherited production DATABASE_URL,
never creates a test admin, and never runs schema push on your snapshot.
Only restore trusted backups: database archives can contain executable SQL.

## Start development

```bash
npm run dev
```

Open http://localhost:5173 and sign in using an account contained in the backup.
Changes affect only your local copy, not the production database.
The local session secret is independent; existing browser sessions and encrypted
production integration credentials will not carry over. Do not copy the production
session secret to make integrations work locally.

Screenshot uploads and device-log cleanup workers remain disabled.
External screenshot files are not included in a database dump, so historical
images may be unavailable locally. Do not connect live integrations or enroll
real employee devices into this development instance.

Frontend changes reload automatically; restart `npm run dev` after backend changes.
Ctrl+C stops the app. `npm run db:stop` stops local PostgreSQL without deleting data.
Local credentials, data and logs live under `.local/development`, excluded from
Git and deployment. Treat the entire directory as sensitive employee data.

## Rerun or refresh

`npm run setup` preserves the imported copy, including your local changes.
It does not automatically fetch newer production data or apply schema changes.

To explicitly import a newer backup:

```bash
npm run setup -- --backup "$HOME/private-backups/new-production.dump"
```

The import uses another fresh database and switches local configuration only
after a successful restore and basic Activity Monitor table checks. The previous
local database is retained; no existing database is overwritten. Failed imports
do not change the selected local database. Old copies consume disk space and retain
sensitive data; remove them only after you have confirmed they are no longer needed.

Do not run `npm install`; npm is only the entry point for these scripts.
Production deployment remains a separate, reviewed server operation; this setup
does not configure deployment or push database changes to production.

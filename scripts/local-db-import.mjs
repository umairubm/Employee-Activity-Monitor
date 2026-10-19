import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";

export function databaseName(config) {
  const name = config.database ?? "activity_monitor_dev";
  if (!/^activity_monitor_(dev|snapshot_[a-f0-9]{16})$/.test(name)) {
    throw new Error("Invalid local database name.");
  }
  return name;
}

export async function verifyLocalCluster(client, dataDirectory) {
  const result = await client.query("SHOW data_directory");
  if (realpathSync(result.rows[0].data_directory) !== realpathSync(dataDirectory)) {
    throw new Error("Unexpected database server; refusing to modify it.");
  }
}

export async function importSnapshot({ Client, config, dataDirectory, backup, restoreTool, serverPort = 55432 }) {
  if (!statSync(backup).isFile()) throw new Error("Select a PostgreSQL custom-format backup file.");
  if (spawnSync(restoreTool, ["--list", backup], { stdio: "ignore" }).status !== 0) {
    throw new Error("Backup is unreadable or incompatible with pg_restore. Use PostgreSQL tools at least as new as production.");
  }
  const connection = {
    host: "127.0.0.1", port: serverPort, user: "local_dev",
    password: config.password, database: "postgres", connectionTimeoutMillis: 10000,
  };
  const admin = new Client(connection);
  await admin.connect();
  const database = `activity_monitor_snapshot_${randomBytes(8).toString("hex")}`;
  let created = false;
  try {
    await verifyLocalCluster(admin, dataDirectory);
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    const restored = spawnSync(restoreTool, [
      "--host=127.0.0.1", `--port=${serverPort}`, "--username=local_dev",
      `--dbname=${database}`, "--no-password", "--no-owner", "--no-privileges",
      "--single-transaction", "--exit-on-error", backup,
    ], {
      // Do not inherit production libpq configuration or print imported rows/errors.
      env: { PATH: process.env.PATH, HOME: process.env.HOME,
        PGPASSWORD: config.password, PGCONNECT_TIMEOUT: "10", PGSSLMODE: "disable" },
      stdio: "ignore",
    });
    if (restored.error || restored.status !== 0) {
      throw new Error("Snapshot restore failed. Previous local data is unchanged. Check backup and PostgreSQL version compatibility.");
    }
    const db = new Client({ ...connection, database });
    await db.connect();
    try {
      const tables = await db.query("SELECT to_regclass('public.users') AS users, to_regclass('public.devices') AS devices");
      if (!tables.rows[0].users || !tables.rows[0].devices) throw new Error("Backup is not an Activity Monitor database; previous local data is unchanged.");
      // Read only: never bootstrap users or push a schema onto the restored snapshot.
      await db.query("SELECT 1 FROM public.users LIMIT 1");
      await db.query("SELECT 1 FROM public.devices LIMIT 1");
    } finally {
      await db.end();
    }
    return database;
  } catch (error) {
    if (created) await admin.query(`DROP DATABASE "${database}"`).catch(() => {});
    throw error;
  } finally {
    await admin.end();
  }
}

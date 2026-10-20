import { spawn } from "node:child_process";
import { openSync, closeSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { sshExecutable, privateDirectory } from "./local-platform.mjs";

// Runs on the Plesk server. Credentials stay in that server's private env file,
// never in the SSH arguments, downloaded archive metadata, or terminal output.
export const remoteExportScript = `
const {spawnSync}=require("node:child_process");
console.error("SSH connected. Preparing the production database export...");
try {
  const u=new URL(process.env.DATABASE_URL);
  if(!["postgresql:","postgres:"].includes(u.protocol) ||
     !["localhost","127.0.0.1","[::1]"].includes(u.hostname) ||
     decodeURIComponent(u.pathname)!=="/activity_monitor")
    throw new Error("Unexpected production database target");
  console.error("Starting read-only pg_dump. Snapshot data will stream to your computer.");
  const r=spawnSync("pg_dump",["--format=custom","--no-owner","--no-privileges","--no-password"],{
    env:{PATH:"/usr/bin:/bin",PGHOST:u.hostname.replace(/^\\[|\\]$/g,""),
      PGPORT:u.port||"5432",PGUSER:decodeURIComponent(u.username),
      PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:"activity_monitor",
      PGCONNECT_TIMEOUT:"20",PGSSLMODE:"disable"},
    stdio:["ignore","inherit","ignore"]
  });
  if(r.error||r.status!==0)throw new Error("Production export failed");
} catch(e) {
  console.error("Production export failed. Check server env access, PostgreSQL and pg_dump.");
  process.exitCode=1;
}
`;

export function exportArguments(server) {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(server)) {
    throw new Error("Invalid SSH server. Use user@hostname (or an SSH config Host alias).");
  }
  const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
  const remote = "/opt/plesk/node/24/bin/node --env-file=/home/ubm/.config/activity-monitor/server.env -e " + quote(remoteExportScript);
  return ["-T", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3", server, remote];
}

export function progressMessage(bytes, elapsedMs, idleMs) {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const elapsed = `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (!bytes) return `Waiting for SSH login or export data | elapsed ${elapsed}. Complete any SSH password/host-key prompt shown above.`;
  const rate = bytes / Math.max(elapsedMs / 1000, 1) / 1024;
  return `Downloaded ${(bytes / 1048576).toFixed(2)} MiB | elapsed ${elapsed} | avg ${rate.toFixed(0)} KiB/s` +
    (idleMs >= 30000 ? ` | no new data for ${Math.floor(idleMs / 1000)}s` : "");
}

export async function fetchSnapshot(directory, server = "ubm@2.28.204.252", execute = spawn, {
  progressIntervalMs = 2000, warnAfterMs = 30000, idleTimeoutMs = 600000,
  log = console.log,
} = {}) {
  const args = exportArguments(server);
  privateDirectory(directory);
  const file = join(directory, `production-${Date.now()}-${randomBytes(6).toString("hex")}.dump`);
  const fd = openSync(file, "wx", 0o600);
  let succeeded = false;
  let child, timer, forceTimer, abortReason;
  let lastBytes = 0, warned = false;
  const started = Date.now();
  let lastActivity = started;
  const abort = reason => {
    if (abortReason) return;
    abortReason = reason;
    child?.kill("SIGTERM");
    forceTimer = setTimeout(() => child?.kill("SIGKILL"), 5000);
    forceTimer.unref();
  };
  const cancel = () => abort("Download cancelled; partial snapshot removed. Existing local data was not changed.");
  try {
    log(`Connecting to ${server}. Enter your SSH password only if SSH prompts for it.`);
    log("Live progress updates every 2 seconds. The compressed archive size is unknown until the export finishes.");
    child = execute(sshExecutable(), args, {
      // Binary archive streams straight to disk, not a Node buffer or console.
      // Inherit stderr so password/host-key prompts and remote stage messages stay visible.
      stdio: ["inherit", fd, "inherit"],
    });
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    timer = setInterval(() => {
      const now = Date.now();
      const bytes = statSync(file).size;
      if (bytes !== lastBytes) {
        lastBytes = bytes;
        lastActivity = now;
        warned = false;
      }
      const idle = now - lastActivity;
      log(progressMessage(bytes, now - started, idle));
      if (idle >= warnAfterMs && !warned) {
        warned = true;
        log(bytes
          ? "No new data is arriving. Export may be waiting on the database or connection. Ctrl+C safely cancels this download."
          : `No snapshot bytes received yet. SSH may be waiting for login or pg_dump may not have started. If no prompt is visible, cancel with Ctrl+C and test: ssh ${server}`);
      }
      if (idle >= idleTimeoutMs) abort("SSH export timed out after 10 minutes without new data; partial snapshot removed. Check SSH access and server export status. Existing local data was not changed.");
    }, progressIntervalMs);
    const result = await new Promise((resolve, reject) => {
      child.once("error", () => reject(new Error("Could not start SSH. Check that an SSH client is available; partial download removed.")));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (abortReason) throw new Error(abortReason);
    if (result.code !== 0 || result.signal || statSync(file).size === 0) {
      throw new Error("SSH export failed; partial download removed. Check the SSH messages above, server env access and pg_dump. Existing local data was not changed.");
    }
    succeeded = true;
    log(`Download complete: ${progressMessage(statSync(file).size, Date.now() - started, 0)}.`);
    return file;
  } finally {
    clearInterval(timer);
    clearTimeout(forceTimer);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    closeSync(fd);
    if (!succeeded) unlinkSync(file);
  }
}

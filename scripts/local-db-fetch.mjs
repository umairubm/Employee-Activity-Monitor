import { spawnSync } from "node:child_process";
import { openSync, closeSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { sshExecutable, privateDirectory } from "./local-platform.mjs";

// Runs on the Plesk server. Credentials stay in that server's private env file,
// never in the SSH arguments, downloaded archive metadata, or terminal output.
export const remoteExportScript = `
const {spawnSync}=require("node:child_process");
try {
  const u=new URL(process.env.DATABASE_URL);
  if(!["postgresql:","postgres:"].includes(u.protocol) ||
     !["localhost","127.0.0.1","[::1]"].includes(u.hostname) ||
     decodeURIComponent(u.pathname)!=="/activity_monitor")
    throw new Error("Unexpected production database target");
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

export function fetchSnapshot(directory, server = "ubm@2.28.204.252", execute = spawnSync) {
  const args = exportArguments(server);
  privateDirectory(directory);
  const file = join(directory, `production-${Date.now()}-${randomBytes(6).toString("hex")}.dump`);
  const fd = openSync(file, "wx", 0o600);
  let succeeded = false;
  try {
    console.log(`Exporting production via SSH (${server}). Enter your SSH password if prompted.`);
    const result = execute(sshExecutable(), args, {
      // Binary archive streams straight to disk, not a Node buffer or console.
      stdio: ["inherit", fd, "inherit"],
    });
    if (result.error || result.status !== 0 || statSync(file).size === 0) {
      throw new Error("SSH export failed; partial download removed. Check SSH access and the server's private env file. Existing local data was not changed.");
    }
    succeeded = true;
    return file;
  } finally {
    closeSync(fd);
    if (!succeeded) unlinkSync(file);
  }
}

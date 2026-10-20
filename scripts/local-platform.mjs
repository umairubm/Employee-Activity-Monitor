import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream, createReadStream, rmSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";

export const windowsPostgres = {
  url: "https://get.enterprisedb.com/postgresql/postgresql-17.11-1-windows-x64-binaries.zip",
  sha256: "6eabdf00d2893713b75db4336a23c3fdf505f056e217ec6e2e95d901750cfea3",
  folder: "postgresql-17.11-windows-x64",
};
export const windowsRuntime = {
  url: "https://download.microsoft.com/download/4/7/c/47c6134b-d61f-4024-83bd-b9c9ea951c25/Microsoft.VCLibs.x64.14.00.Desktop.appx",
  sha256: "b56a9101f706f9d95f815f5b7fa6efbac972e86573d378b96a07cff5540c5961",
};

export function postgresOptions(port, platform = process.platform) {
  return `-h 127.0.0.1 -p ${port}` + (platform === "win32" ? "" : " -k ''");
}

export function toolCandidates(name, home, platform = process.platform, env = process.env) {
  const binary = platform === "win32" ? `${name}.exe` : name;
  return [
    env.PG_BIN && join(env.PG_BIN, binary),
    platform === "win32" && join(home, "tools", windowsPostgres.folder, "pgsql", "bin", binary),
    platform === "win32" && join(env.ProgramFiles || "C:\\Program Files", "PostgreSQL", "17", "bin", binary),
    platform !== "win32" && `/opt/homebrew/opt/postgresql@17/bin/${name}`,
    platform !== "win32" && `/usr/local/opt/postgresql@17/bin/${name}`,
    platform !== "win32" && `/usr/lib/postgresql/17/bin/${name}`,
    binary,
  ].filter(Boolean);
}

export function npxInvocation(args, platform = process.platform, env = process.env, executable = process.execPath) {
  if (platform !== "win32") return { command: "npx", args };
  const candidates = [
    env.npm_execpath && join(dirname(env.npm_execpath), "npx-cli.js"),
    join(dirname(executable), "node_modules", "npm", "bin", "npx-cli.js"),
  ].filter(Boolean);
  const cli = candidates.find(existsSync);
  if (!cli) throw new Error("Cannot locate npm's npx-cli.js. Run setup using npm run setup with a complete Node.js installation.");
  // Execute JavaScript directly: spawning npx.cmd needs a shell and breaks paths
  // containing spaces or metacharacters when naively quoted.
  return { command: executable, args: [cli, ...args] };
}

export function sshExecutable(platform = process.platform, env = process.env) {
  if (platform !== "win32") return "ssh";
  const candidates = [
    join(env.SystemRoot || "C:\\Windows", "System32", "OpenSSH", "ssh.exe"),
    join(env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", "ssh.exe"),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Git", "usr", "bin", "ssh.exe"),
  ].filter(Boolean);
  return candidates.find(existsSync) || "ssh.exe";
}

export function privateDirectory(directory, platform = process.platform) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (platform !== "win32") return;
  const user = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
  const sid = user.stdout?.match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (user.status !== 0 || !sid) throw new Error("Cannot identify the Windows account to protect local employee data.");
  const acl = spawnSync("icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], { stdio: "ignore" });
  if (acl.status !== 0) throw new Error("Cannot restrict local file permissions. Use an NTFS folder owned by your Windows account.");
}

export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export const extractPostgresScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($env:LOCAL_PG_ARCHIVE)
try {
  $root = [System.IO.Path]::GetFullPath($env:LOCAL_PG_STAGE)
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName.Replace('\\','/')
    $runtime = $name -eq 'pgsql/pgAdmin 4/python/vcruntime140.dll' -or $name -eq 'pgsql/pgAdmin 4/python/vcruntime140_1.dll'
    if (-not ($name.StartsWith('pgsql/bin/') -or $name.StartsWith('pgsql/lib/') -or $name.StartsWith('pgsql/share/') -or $runtime)) { continue }
    if ($runtime) { $name = 'pgsql/bin/' + [System.IO.Path]::GetFileName($name) }
    $destination = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root, $name))
    if (-not $destination.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid archive path' }
    if ($entry.Name -eq '') { [System.IO.Directory]::CreateDirectory($destination) | Out-Null; continue }
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($destination)) | Out-Null
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
  }
} finally { $zip.Dispose() }
$runtimeZip = [System.IO.Compression.ZipFile]::OpenRead($env:LOCAL_PG_RUNTIME)
try {
  foreach ($entry in $runtimeZip.Entries) {
    if ($entry.FullName -match '^(msvcp140[^/]*|concrt140)\\.dll$') {
      $destination = [System.IO.Path]::Combine($env:LOCAL_PG_STAGE, 'pgsql', 'bin', $entry.Name)
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
    }
  }
} finally { $runtimeZip.Dispose() }
`;

export async function ensureWindowsPostgres(home) {
  if (process.platform !== "win32") return;
  if (process.arch !== "x64") throw new Error("Native setup currently supports Windows x64 with x64 Node.js.");
  const names = ["pg_ctl", "initdb", "postgres", "pg_restore"];
  const usable = name => toolCandidates(name, home).some(file =>
    spawnSync(file, ["--version"], { stdio: "ignore" }).status === 0);
  if (names.every(usable)) return;
  const tools = join(home, "tools");
  mkdirSync(tools, { recursive: true });
  const archive = join(tools, "postgresql-download.zip");
  const runtimeArchive = join(tools, "microsoft-runtime.appx");
  const stage = join(tools, "postgresql-extract");
  const target = join(tools, windowsPostgres.folder);
  console.log("Downloading portable PostgreSQL for Windows (about 325 MiB, first setup only)...");
  try {
    const response = await fetch(windowsPostgres.url);
    if (!response.ok || !response.body) throw new Error("PostgreSQL download failed.");
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { mode: 0o600 }));
    if (await sha256File(archive) !== windowsPostgres.sha256) throw new Error("PostgreSQL checksum mismatch; downloaded tools will not be executed.");
    const runtimeResponse = await fetch(windowsRuntime.url);
    if (!runtimeResponse.ok || !runtimeResponse.body) throw new Error("Microsoft runtime download failed.");
    await pipeline(Readable.fromWeb(runtimeResponse.body), createWriteStream(runtimeArchive, { mode: 0o600 }));
    if (await sha256File(runtimeArchive) !== windowsRuntime.sha256) throw new Error("Microsoft runtime checksum mismatch.");
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage);
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(extractPostgresScript, "utf16le").toString("base64"),
    ], { env: { ...process.env, LOCAL_PG_ARCHIVE: archive, LOCAL_PG_STAGE: stage, LOCAL_PG_RUNTIME: runtimeArchive }, stdio: "inherit" });
    if (result.status !== 0) throw new Error("PostgreSQL extraction failed.");
    // Never replace tools for a cluster that already exists.
    if (existsSync(target)) throw new Error("Existing portable tools are incomplete; refusing to replace them automatically.");
    renameSync(stage, target);
    if (!names.every(usable)) throw new Error("Portable PostgreSQL did not start. Check Windows Security protection history; do not disable antivirus.");
  } finally {
    rmSync(archive, { force: true });
    rmSync(runtimeArchive, { force: true });
    rmSync(stage, { recursive: true, force: true });
  }
}

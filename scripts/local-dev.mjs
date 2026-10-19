import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { databaseName, importSnapshot } from "./local-db-import.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = join(root, ".local", "development");
const data = join(home, "postgres");
const configFile = join(home, "credentials.json");
const port = 55432;

export function localEnvironment(config) {
  return {
    ...process.env,
    NODE_ENV: "development",
    DATABASE_URL: `postgresql://local_dev:${encodeURIComponent(config.password)}@127.0.0.1:${port}/${databaseName(config)}`,
    SESSION_SECRET: config.secret,
    HOST: "127.0.0.1",
    PORT: "3000",
    BASE_PATH: "/",
    ENABLE_SCREENSHOT_WORKER: "false",
    ENABLE_DEVICE_LOG_CLEANUP_WORKER: "false",
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed. Review the output above.`);
}

function pgTool(name) {
  const candidates = [
    process.env.PG_BIN && join(process.env.PG_BIN, name),
    `/opt/homebrew/opt/postgresql@17/bin/${name}`,
    `/usr/local/opt/postgresql@17/bin/${name}`,
    `/usr/lib/postgresql/17/bin/${name}`,
    name,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) return candidate;
  }
  throw new Error("PostgreSQL tools not found. On Mac run: brew install postgresql@17. On Linux install PostgreSQL or set PG_BIN to its bin directory.");
}

function pnpm(args, env) {
  // npm is only the entry point; the workspace still installs with pinned pnpm.
  run("npx", ["--yes", "pnpm@10.26.1", ...args], { env });
}

function credentials(create = false) {
  if (!existsSync(configFile)) {
    if (!create) throw new Error("Run npm run setup first.");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(configFile, JSON.stringify({
      password: randomBytes(32).toString("hex"),
      secret: randomBytes(32).toString("hex"),
    }, null, 2), { flag: "wx", mode: 0o600 });
  }
  chmodSync(configFile, 0o600);
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  for (const key of ["password", "secret"]) {
    if (typeof config[key] !== "string" || config[key].length < 20) throw new Error("Invalid local credentials file; refusing to reset existing data.");
  }
  return config;
}

function startDatabase(config) {
  const ctl = pgTool("pg_ctl");
  if (!existsSync(join(data, "PG_VERSION"))) {
    const passwordFile = join(home, "init-password");
    writeFileSync(passwordFile, config.password, { mode: 0o600 });
    try {
      run(pgTool("initdb"), ["-D", data, "-U", "local_dev", "--auth=scram-sha-256", `--pwfile=${passwordFile}`, "--encoding=UTF8", "--no-locale"]);
    } finally {
      unlinkSync(passwordFile);
    }
  }
  if (spawnSync(ctl, ["-D", data, "status"], { stdio: "ignore" }).status !== 0) {
    run(ctl, ["-D", data, "-l", join(home, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -k ''`, "-w", "start"]);
  }
}

async function setup() {
  pgTool("initdb");
  pgTool("pg_ctl");
  const config = credentials(true);
  const args = process.argv.slice(3);
  if (args.length && (args.length !== 2 || args[0] !== "--backup")) {
    throw new Error("Usage: npm run setup [-- --backup /private/path/production.dump]");
  }
  let backup = args[1];
  if (!backup && config.source !== "production-snapshot") {
    if (!process.stdin.isTTY) throw new Error("Provide a production backup: npm run setup -- --backup /private/path/production.dump");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      backup = (await prompt.question("Path to your production .dump backup (kept private): ")).trim();
    } finally {
      prompt.close();
    }
    if (!backup) throw new Error("No backup selected; setup stopped.");
  }
  if (backup) {
    backup = resolve(backup.startsWith("~/") ? join(homedir(), backup.slice(2)) : backup);
    if (!existsSync(backup)) throw new Error("Backup file not found. Nothing has been imported.");
    pgTool("pg_restore");
  }
  pnpm(["install", "--frozen-lockfile"]);
  startDatabase(config);
  if (backup) {
    const require = createRequire(join(root, "lib/db/package.json"));
    const { Client } = require("pg");
    console.log("Importing into a NEW private local database. Existing databases will be preserved.");
    const database = await importSnapshot({
      Client, config, dataDirectory: data, backup, restoreTool: pgTool("pg_restore"),
    });
    config.database = database;
    config.source = "production-snapshot";
    delete config.adminPassword;
    const temporary = `${configFile}.tmp`;
    writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
    renameSync(temporary, configFile);
    console.log("Production snapshot imported locally. Live production was not accessed or changed.");
  } else {
    console.log("Existing local production snapshot preserved; no automatic refresh or schema changes.");
  }
  const env = localEnvironment(config);
  pnpm(["run", "typecheck:libs"], env);
  pnpm(["--filter", "@workspace/api-server", "run", "build"], env);
  console.log("\nSetup complete. Run npm run dev, then open http://localhost:5173");
  console.log("Sign in with an account present in the backup. No test admin was created.");
}

async function dev() {
  const config = credentials();
  if (config.source !== "production-snapshot") throw new Error("Run npm run setup to import a production snapshot first.");
  startDatabase(config);
  const env = localEnvironment(config);
  pnpm(["run", "typecheck:libs"], env);
  pnpm(["--filter", "@workspace/api-server", "run", "build"], env);
  const children = [
    spawn(process.execPath, ["--enable-source-maps", "artifacts/api-server/dist/index.mjs"], { cwd: root, env, stdio: "inherit" }),
    spawn(process.execPath, ["artifacts/dashboard/node_modules/vite/bin/vite.js", "--config", "artifacts/dashboard/vite.config.ts", "--host", "127.0.0.1"], {
      cwd: root, stdio: "inherit",
      env: { ...env, PORT: "5173", LOCAL_API_PROXY_TARGET: "http://127.0.0.1:3000" },
    }),
  ];
  let stopping = false;
  function stop(code) {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    for (const child of children) child.kill("SIGTERM");
  }
  for (const child of children) {
    child.on("error", () => stop(1));
    child.on("exit", code => stop(code ?? 1));
  }
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));
  console.log("Local app: http://localhost:5173. Ctrl+C stops the app; npm run db:stop stops PostgreSQL.");
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Use Node.js 24 or newer.");
  if (process.platform === "win32") throw new Error("Use WSL2 on Windows. Native Windows setup is not supported.");
  const command = process.argv[2];
  if (command === "setup") await setup();
  else if (command === "dev") await dev();
  else if (command === "stop") {
    const ctl = pgTool("pg_ctl");
    if (existsSync(join(data, "PG_VERSION")) &&
        spawnSync(ctl, ["-D", data, "status"], { stdio: "ignore" }).status === 0) {
      run(ctl, ["-D", data, "-m", "fast", "-w", "stop"]);
    } else {
      console.log("Local database is already stopped.");
    }
  } else throw new Error("Use npm run setup, npm run dev, or npm run db:stop.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Do not print connection strings or driver errors containing credentials.
    console.error(error.code ? `Local setup failed (${error.code}). Check the local PostgreSQL log.` : error.message);
    process.exitCode = 1;
  });
}

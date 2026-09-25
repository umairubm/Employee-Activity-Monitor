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
 * uploaded as raw image bytes to our own authenticated API in a single request
 * (POST /sync/screenshots); the server stages them in the DB and a background
 * worker uploads them to Dropbox. Bytes never go to a third-party presigned URL
 * or get base64-stuffed into JSON.
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

import { exec, execFile, spawn } from "child_process";
import http from "http";
import https from "https";
import os from "os";
import readline from "readline";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { createWriteStream } from "fs";
import { Readable } from "stream";
import { fileURLToPath } from "url";
import { createCommandRunner } from "./command-runner.mjs";
import { verifyWindowsInstaller } from "./windows-installer-verification.mjs";
import { WindowsSessionMonitor } from "./win-session-monitor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

const AGENT_VERSION = "2.0.5-node";

// ── Where we persist credentials + offline data (per-user, stable across runs) ─
const CONFIG_DIR = path.join(os.homedir(), ".active-tracker");
const CREDS_FILE = path.join(CONFIG_DIR, "credentials.json");
const OFFLINE_DB_FILE = path.join(CONFIG_DIR, "offline-queue.json");
const REJECTED_DB_FILE = path.join(CONFIG_DIR, "rejected-queue.json");
const LOCAL_CONFIG_FILE = path.join(__dirname, "tracker.config.json");
const LOCK_FILE = path.join(CONFIG_DIR, "agent.lock");

fs.mkdirSync(CONFIG_DIR, { recursive: true });

// ── Single-instance lock ──────────────────────────────────────────────────────
// Two agents on one machine would each log the same foreground activity
// concurrently, producing overlapping intervals that double-count worked time in
// every report. We hold an exclusive lock so exactly one agent runs per PC.
// `wx` (O_EXCL create) fails if the file exists; a stale lock from a crashed
// process is detected via the recorded PID and reclaimed.
function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but not ours (still alive).
    return err.code === "EPERM";
  }
}

function acquireSingleInstanceLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      const release = () => {
        try {
          fs.unlinkSync(LOCK_FILE);
        } catch {
          /* ignore */
        }
      };
      process.on("exit", release);
      process.on("SIGINT", () => process.exit(0));
      process.on("SIGTERM", () => process.exit(0));
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Lock exists — reclaim it only if the owner process is gone.
      let stalePid = NaN;
      try {
        stalePid = parseInt(fs.readFileSync(LOCK_FILE, "utf-8").trim(), 10);
      } catch {
        /* unreadable — treat as stale below */
      }
      if (Number.isInteger(stalePid) && pidIsAlive(stalePid)) {
        return false; // another live agent owns the lock
      }
      try {
        fs.unlinkSync(LOCK_FILE); // stale; remove and retry once
      } catch {
        return false;
      }
    }
  }
  return false;
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
  usbBlockEnabled: false,
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
  activeUrl: null,
  isCurrentlyIdle: false,
  idleSecondsCounter: 0,
  lastMouseX: null,
  lastMouseY: null,
  lastSyncTime: Date.now(),
  serverClockOffset: 0,
  adminLockEnforced: false,
  osSessionLocked: false,
  lockedUntil: null,
  isOfflineSince: null,
  // Two os.cpus() samples, one heartbeat apart, give us a real CPU% reading.
  lastCpuSample: null,
  // Monotonic reference for sleep/gap detection.
  // We pair a Date.now() wall-clock reading with a process.hrtime.bigint()
  // monotonic reading so we can detect when the wall clock jumps more than
  // the monotonic elapsed time (clock change) or when the monotonic clock
  // jumps more than expected (sleep/suspend).
  _lastObserveWall: null,       // ms since epoch
  _lastObserveHrtime: null,     // BigInt nanoseconds
  // Current open segment (not yet persisted to the offline queue).
  _currentSegment: null,
  // Sequence counter for this session.
  _nextSequence: 1,
  _sequenceNamespace: null,
  // Whether we were locked on the previous heartbeat.
  _wasLocked: false,
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
// Each record includes a stable segmentId and sequence number so retries are
// idempotent and the server can deduplicate. Records are persisted to disk
// BEFORE any upload attempt and removed only after the server explicitly
// acknowledges them.  A separate rejected queue holds records the server
// rejected (e.g. 422 / bad schema) so one malformed record cannot block others.
const offlineQueue = {
  logs: [],
  _seqNs: null,       // sequence namespace UUID (stable across restarts)
  _nextSeq: 1,
  load() {
    try {
      if (fs.existsSync(OFFLINE_DB_FILE)) {
        const raw = JSON.parse(fs.readFileSync(OFFLINE_DB_FILE, "utf-8"));
        this.logs = Array.isArray(raw.logs) ? raw.logs : [];
        if (typeof raw.sequenceNamespace === "string") this._seqNs = raw.sequenceNamespace;
        if (typeof raw.nextSequence === "number") this._nextSeq = raw.nextSequence;
      }
    } catch {
      this.logs = [];
    }
    if (!this._seqNs) {
      this._seqNs = crypto.randomUUID();
    }
  },
  save() {
    // Atomic write: write to a temp file then rename so a crash during write
    // cannot corrupt the queue file.  fs.renameSync is atomic on Linux/macOS
    // when src and dst are on the same filesystem (which ~/.active-tracker is).
    const tmp = `${OFFLINE_DB_FILE}.tmp`;
    try {
      fs.writeFileSync(
        tmp,
        JSON.stringify({ logs: this.logs, sequenceNamespace: this._seqNs, nextSequence: this._nextSeq }, null, 2),
      );
      fs.renameSync(tmp, OFFLINE_DB_FILE);
    } catch (e) {
      console.error("❌ Failed to save offline queue:", e.message);
      try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    }
  },
  nextSeq() {
    const s = this._nextSeq++;
    return s;
  },
  seqNamespace() {
    return this._seqNs;
  },
  add(log) {
    this.logs.push(log);
    if (this.logs.length > 5000) this.logs = this.logs.slice(-5000);
    this.save();
  },
  acknowledge(segmentIds) {
    if (!segmentIds || !segmentIds.length) return;
    const idSet = new Set(segmentIds);
    this.logs = this.logs.filter((l) => !idSet.has(l.segmentId));
    this.save();
  },
  quarantine(segmentIds, reason = "") {
    if (!segmentIds || !segmentIds.length) return;
    const idSet = new Set(segmentIds);
    const rejected = [];
    this.logs = this.logs.filter((l) => {
      if (idSet.has(l.segmentId)) { rejected.push(l); return false; }
      return true;
    });
    if (rejected.length) {
      rejectedQueue.addAll(rejected, reason);
    }
    this.save();
  },
};
offlineQueue.load();

// Rejected segments — kept for operator diagnosis, never re-submitted.
const rejectedQueue = {
  logs: [],
  load() {
    try {
      if (fs.existsSync(REJECTED_DB_FILE)) {
        const raw = JSON.parse(fs.readFileSync(REJECTED_DB_FILE, "utf-8"));
        this.logs = Array.isArray(raw.logs) ? raw.logs : [];
      }
    } catch {
      this.logs = [];
    }
  },
  save() {
    try {
      fs.writeFileSync(REJECTED_DB_FILE, JSON.stringify({ logs: this.logs }, null, 2));
    } catch (e) {
      console.error("❌ Failed to save rejected queue:", e.message);
    }
  },
  addAll(items, reason) {
    const now = new Date().toISOString();
    for (const item of items) {
      this.logs.push({ ...item, _rejectionReason: reason, _rejectedAt: now });
    }
    if (this.logs.length > 2000) this.logs = this.logs.slice(-2000);
    this.save();
  },
};
rejectedQueue.load();

// Timer handles
let syncTimer = null;
let screenshotTimer = null;
let uploadTimer = null;

// ── Sleep / gap detection constants ──────────────────────────────────────────
// If the elapsed hrtime (monotonic) between two observations exceeds this
// threshold the process was almost certainly suspended (sleep/hibernate).  In
// that case we close the current segment at the LAST known wall-clock time
// so the gap is not labelled as active time.
const SLEEP_GAP_THRESHOLD_MS = 60_000;
// Periodically finalize segments even when nothing has changed (every ~45s).
const MAX_SEGMENT_MS = 45_000;

// ── Segment helpers ───────────────────────────────────────────────────────────
function _nowIso() {
  return new Date(Date.now() + (clientState.serverClockOffset || 0)).toISOString();
}

function _openSegment(wallMs) {
  const startedAt = new Date(wallMs + (clientState.serverClockOffset || 0)).toISOString();
  const sessionState = clientState.osSessionLocked ? "locked" : "unlocked";
  const idleSec = clientState.osSessionLocked ? 999999999 : clientState.idleSecondsCounter;
  const passiveThr = configState.idleThresholdSeconds * 0.5;
  let engagementState;
  if (sessionState !== "unlocked" || idleSec >= configState.idleThresholdSeconds) {
    engagementState = "idle";
  } else if (idleSec >= passiveThr) {
    engagementState = "passive";
  } else {
    engagementState = "active";
  }
  return {
    segmentId: crypto.randomUUID(),
    sequenceNamespace: offlineQueue.seqNamespace(),
    sequence: offlineQueue.nextSeq(),
    processName: clientState.activeApp || "System",
    windowTitle: clientState.windowTitle || "",
    url: clientState.activeUrl || undefined,
    engagementState,
    sessionState,
    connectivityState: "online",
    startedAt,
    endedAt: startedAt,
    elapsedMilliseconds: 0,
    durationSeconds: 0,
    idleSeconds: 0,
    _startWallMs: wallMs,
    _startHrtime: process.hrtime.bigint(),
  };
}

function _closeCurrentSegment(endWallMs, endHrtime) {
  const seg = clientState._currentSegment;
  if (!seg) return;
  clientState._currentSegment = null;

  let wallEnd = endWallMs ?? Date.now();
  let hrEnd = endHrtime ?? process.hrtime.bigint();

  // Safety rule: never extend a segment far beyond the last reliable observation
  if (clientState._lastObserveWall && (wallEnd - clientState._lastObserveWall > SLEEP_GAP_THRESHOLD_MS)) {
    wallEnd = clientState._lastObserveWall;
    if (clientState._lastObserveHrtime) hrEnd = clientState._lastObserveHrtime;
  }

  const idleSec = clientState.osSessionLocked ? 999999999 : clientState.idleSecondsCounter;
  const elapsedHr = hrEnd - seg._startHrtime;
  const elapsedMs = Math.max(0, Number(elapsedHr / 1_000_000n));
  const durationSeconds = Math.round(elapsedMs / 1000);
  const endedAt = new Date(wallEnd + (clientState.serverClockOffset || 0)).toISOString();
  const clampedIdle = Math.max(0, Math.min(idleSec ?? 0, durationSeconds));
  
  const { _startWallMs, _startHrtime, ...payload } = seg;
  const finalized = {
    ...payload,
    endedAt,
    elapsedMilliseconds: elapsedMs,
    durationSeconds,
    idleSeconds: clampedIdle,
  };

  if (finalized.elapsedMilliseconds > 0) {
    offlineQueue.add(finalized);
  }
}

function getSuspendInclusiveSeconds() {
  // On Linux, /proc/uptime provides seconds since boot, including suspend time.
  // This avoids false positives from NTP wall-clock jumps.
  if (os.platform() === "linux") {
    try {
      const parts = fs.readFileSync("/proc/uptime", "utf8").split(" ");
      return parseFloat(parts[0]);
    } catch (e) {
      // fallback if /proc/uptime is unavailable
    }
  }
  // On macOS/Windows, the wall clock is the best available suspend-inclusive clock.
  return Date.now() / 1000;
}

function getMonoSeconds() {
  return Number(process.hrtime.bigint() / 1_000_000n) / 1000;
}

function _observeSegment() {
  const wallMs = Date.now();
  const hrNow = process.hrtime.bigint();
  const bootSecs = getSuspendInclusiveSeconds();
  const monoSecs = getMonoSeconds();

  // ── Sleep/gap detection ────────────────────────────────────────────────
  if (clientState._currentSegment !== null &&
      clientState._lastObserveWall !== null &&
      clientState._lastBootSecs !== undefined &&
      clientState._lastMonoSecs !== undefined) {
    const prevDelta = clientState._lastBootSecs - clientState._lastMonoSecs;
    const nowDelta = bootSecs - monoSecs;
    const suspendSecs = Math.max(0, nowDelta - prevDelta);
    const wallGap = wallMs - clientState._lastObserveWall;
    const monoGap = monoSecs - clientState._lastMonoSecs;
    
    if (suspendSecs > SLEEP_GAP_THRESHOLD_MS / 1000 || wallGap >= SLEEP_GAP_THRESHOLD_MS || monoGap >= SLEEP_GAP_THRESHOLD_MS / 1000) {
      // The difference between suspend-inclusive (boot/wall) and suspend-exclusive (mono)
      // clocks grew by more than the threshold. The process was suspended.
      // Close the segment at the LAST known wall-clock time, not at wallMs.
      _closeCurrentSegment(clientState._lastObserveWall, clientState._lastObserveHrtime);
      console.warn(
        `⚠️ Sleep/suspension detected (${Math.round(suspendSecs)}s gap). ` +
        "Segment closed at last observation time."
      );
    } else {
      // ── Periodic segment rotation ──────────────────────────────────────
      const elapsedHr = hrNow - clientState._currentSegment._startHrtime;
      const elapsedMs = Number(elapsedHr / 1_000_000n);
      if (elapsedMs >= MAX_SEGMENT_MS) {
        _closeCurrentSegment(wallMs, hrNow);
        // Re-open a new segment immediately so observation is continuous.
      }
    }
  }

  clientState._lastObserveWall = wallMs;
  clientState._lastObserveHrtime = hrNow;
  clientState._lastBootSecs = bootSecs;
  clientState._lastMonoSecs = monoSecs;

  if (clientState.activeApp === null && !(clientState.isLocked || clientState.osSessionLocked)) {
    if (clientState._currentSegment) {
      _closeCurrentSegment(wallMs, hrNow);
    }
    return;
  }

  // ── Session / engagement classification ───────────────────────────────
  const sessionState = (clientState.isLocked || clientState.osSessionLocked) ? "locked" : "unlocked";
  const idleSec = clientState.osSessionLocked ? 999999999 : clientState.idleSecondsCounter;
  const passiveThr = configState.idleThresholdSeconds * 0.5;
  let engagementState;
  if (sessionState !== "unlocked" || idleSec >= configState.idleThresholdSeconds) {
    engagementState = "idle";
  } else if (idleSec >= passiveThr) {
    engagementState = "passive";
  } else {
    if (!clientState.activeApp || clientState.activeApp.includes("System Idle Process")) {
      engagementState = "idle";
    } else {
      engagementState = "active";
    }
  }

  const identity = [
    clientState.activeApp || "System",
    clientState.windowTitle || "",
    clientState.activeUrl || null,
    engagementState,
    sessionState,
  ].join("\x00");

  const cur = clientState._currentSegment;
  if (!cur || cur._identity !== identity) {
    // State changed — close old segment, open a new one.
    if (cur) _closeCurrentSegment(wallMs, hrNow);
    const seg = _openSegment(wallMs);
    seg._identity = identity;
    seg.engagementState = engagementState;
    seg.sessionState = sessionState;
    clientState._currentSegment = seg;
  }
  // Update running totals on the open segment.
  const elapsedHr = hrNow - clientState._currentSegment._startHrtime;
  const elapsedMs = Math.max(0, Number(elapsedHr / 1_000_000n));
  clientState._currentSegment.endedAt =
    new Date(wallMs + (clientState.serverClockOffset || 0)).toISOString();
  clientState._currentSegment.elapsedMilliseconds = elapsedMs;
  clientState._currentSegment.durationSeconds = Math.round(elapsedMs / 1000);
  clientState._currentSegment.idleSeconds = Math.max(
    0, Math.min(idleSec, Math.round(elapsedMs / 1000))
  );
}

// ── Low-level HTTP (JSON requests and raw image-byte POSTs to our API) ────────
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
          // Surface statusCode and response headers so callers can read
          // Retry-After and other metadata from error responses.
          resolve({ status: res.statusCode, text, headers: res.headers });
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
  const { status, text, headers: resHeaders } = await httpRequest("POST", `${SYNC_BASE}${syncPath}`, {
    headers,
    body,
  });
  if (status >= 200 && status < 300) {
    clientState.isOfflineSince = null;
    return text ? JSON.parse(text) : { ok: true };
  }
  // Throw a structured error so callers can inspect status and headers.
  const err = new Error(`POST ${syncPath} -> ${status}: ${text}`);
  err.statusCode = status;
  err.headers = resHeaders || {};
  throw err;
}

// POST raw image bytes to a sync endpoint. The server stages the bytes and
// enqueues them for upload to Dropbox, so image bytes go straight to our own
// API (authenticated) instead of a third-party presigned URL.
async function apiPostBytes(syncPath, buffer, { contentType, headers = {} } = {}) {
  const { status, text } = await httpRequest("POST", `${SYNC_BASE}${syncPath}`, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": buffer.length,
      ...authHeaders(),
      ...headers,
    },
    body: buffer,
  });
  if (status >= 200 && status < 300) {
    clientState.isOfflineSince = null;
    return text ? JSON.parse(text) : { ok: true };
  }
  throw new Error(`POST ${syncPath} (bytes) -> ${status}: ${text}`);
}

// ── System inventory (transparent hardware snapshot) ──────────────────────────
// Reports a best-effort hardware/system snapshot on each activity sync. The
// server diffs hardware-identity fields to raise change alerts. All values are
// real readings from the OS — no placeholders. Fields that can't be read are
// simply omitted. Cached for an hour so we don't spawn helper processes each
// cycle.
let systemInfoCache = { value: null, at: 0 };
const SYSTEM_INFO_TTL_MS = 60 * 60 * 1000;

function osName() {
  switch (os.platform()) {
    case "win32":
      return "Windows";
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return os.platform();
  }
}

function primaryIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return null;
}

function execText(cmd, timeoutMs = 5000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve(err ? "" : String(stdout || "").trim());
    });
  });
}

async function collectSystemInfo() {
  const cpus = os.cpus() || [];
  const info = {
    "Host Name": os.hostname(),
    "Operating System": osName(),
    "OS Version": os.release(),
    Processor: cpus[0]?.model?.trim() || null,
    CPU: cpus.length || null,
    Ram_Size: `${Math.round(os.totalmem() / 1024 ** 3)} GB`,
    Ip: primaryIPv4(),
  };

  try {
    if (os.platform() === "win32") {
      const ps = (c) =>
        execText(`powershell -NoProfile -Command "${c}"`, 6000);
      const [manu, model, serial, disk] = await Promise.all([
        ps("(Get-CimInstance Win32_ComputerSystem).Manufacturer"),
        ps("(Get-CimInstance Win32_ComputerSystem).Model"),
        ps("(Get-CimInstance Win32_BIOS).SerialNumber"),
        ps(
          "[math]::Round((Get-CimInstance Win32_DiskDrive | Select-Object -First 1).Size/1GB)",
        ),
      ]);
      if (manu) info.Manufacturer = manu;
      if (model) info.Model = model;
      if (serial) info.Serial_Number = serial;
      if (disk) info["HD Size"] = `${disk} GB`;
    } else if (os.platform() === "darwin") {
      const model = await execText("sysctl -n hw.model");
      if (model) info.Model = model;
      const serial = await execText(
        "system_profiler SPHardwareDataType | awk -F': ' '/Serial Number/{print $2}'",
      );
      if (serial) info.Serial_Number = serial;
      info.Manufacturer = "Apple";
    }
  } catch {
    // Augmentation is best-effort; the os.* fields above are always present.
  }

  for (const k of Object.keys(info)) {
    if (info[k] === null || info[k] === undefined || info[k] === "")
      delete info[k];
  }
  return info;
}

async function getSystemInfo() {
  const now = Date.now();
  if (systemInfoCache.value && now - systemInfoCache.at < SYSTEM_INFO_TTL_MS) {
    return systemInfoCache.value;
  }
  const value = await collectSystemInfo();
  systemInfoCache = { value, at: now };
  return value;
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
  if (typeof c.usbBlockEnabled === "boolean")
    configState.usbBlockEnabled = c.usbBlockEnabled;
}

// ── USB mass-storage block (Windows registry) ─────────────────────────────────
// Toggling HKLM\SYSTEM\CurrentControlSet\Services\USBSTOR "Start":
//   3 = allow (manual start), 4 = block (disabled). Requires admin rights.
// Returns true on success. Windows-only; other OSes are unsupported.
async function setUsbBlock(enabled) {
  if (!IS_WIN) return false;
  const value = enabled ? 4 : 3;
  const out = await runCmd("reg", [
    "add",
    "HKLM\\SYSTEM\\CurrentControlSet\\Services\\USBSTOR",
    "/v",
    "Start",
    "/t",
    "REG_DWORD",
    "/d",
    String(value),
    "/f",
  ]);
  // `reg add` prints "The operation completed successfully." on success. If it
  // failed (e.g. no admin), the value won't have been written — verify.
  const check = await runCmd("reg", [
    "query",
    "HKLM\\SYSTEM\\CurrentControlSet\\Services\\USBSTOR",
    "/v",
    "Start",
  ]);
  const m = check.match(/Start\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
  const applied = m ? parseInt(m[1], 16) : NaN;
  if (applied === value) return true;
  // Fall back to trusting the add output if the query couldn't be parsed.
  return /completed successfully/i.test(out) && Number.isNaN(applied);
}

// ── Windows password reset (no secret in argv) ────────────────────────────────
// Changes the given local user's password. The password is passed to PowerShell
// via a per-child environment variable (TRACKER_NEW_PW) — never as a command-
// line argument — so it can't be read from a process listing. The value is
// never logged. Returns { ok, message }.
function resetWindowsPassword(username, newPassword) {
  return new Promise((resolve) => {
    // Read the secret from the env var (not argv), build a SecureString, and
    // apply it. Prefer Set-LocalUser; fall back to the WMI/ADSI path on hosts
    // where the LocalAccounts module isn't available.
    const ps = [
      "$ErrorActionPreference = 'Stop'",
      "try {",
      "  $u = $env:TRACKER_PW_USER",
      "  $sec = ConvertTo-SecureString $env:TRACKER_NEW_PW -AsPlainText -Force",
      "  if (Get-Command Set-LocalUser -ErrorAction SilentlyContinue) {",
      "    Set-LocalUser -Name $u -Password $sec",
      "  } else {",
      "    $acct = [ADSI]\"WinNT://./$u,user\"",
      "    $acct.SetPassword($env:TRACKER_NEW_PW)",
      "  }",
      "  Write-Output 'OK'",
      "} catch {",
      "  Write-Output ('ERR:' + $_.Exception.Message)",
      "}",
    ].join("; ");

    let out = "";
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      {
        windowsHide: true,
        // Scope the secret to just this child's environment. argv above carries
        // only the script, which references $env:TRACKER_NEW_PW by name.
        env: {
          ...process.env,
          TRACKER_PW_USER: username,
          TRACKER_NEW_PW: newPassword,
        },
      }
    );
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("error", (e) =>
      resolve({ ok: false, message: `PowerShell failed: ${e.message}` })
    );
    child.on("close", () => {
      const text = out.trim();
      if (/(^|\n)OK\s*$/.test(text) || text === "OK") {
        resolve({ ok: true, message: null });
      } else {
        const m = text.match(/ERR:(.*)$/s);
        resolve({
          ok: false,
          message: m ? m[1].trim().slice(0, 200) : "Password change failed",
        });
      }
    });
  });
}

// Best-effort: converge USB policy to the server's config on each heartbeat, so
// a reinstalled/offline device applies the current policy. Swallow all errors.
async function applyUsbBlockFromConfig() {
  if (!IS_WIN) return;
  try {
    await setUsbBlock(configState.usbBlockEnabled === true);
  } catch {
    /* best effort */
  }
}

// ── Heartbeat metrics (best-effort; null anything unavailable) ────────────────
function cpuTotals() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus() || []) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

// CPU% requires two samples; the first heartbeat returns null and seeds the
// cache. Subsequent heartbeats diff against the previous sample.
function readCpuPercent() {
  const sample = cpuTotals();
  const prev = clientState.lastCpuSample;
  clientState.lastCpuSample = sample;
  if (!prev) return null;
  const totalDiff = sample.total - prev.total;
  const idleDiff = sample.idle - prev.idle;
  if (totalDiff <= 0) return null;
  const pct = (1 - idleDiff / totalDiff) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

function readRamPercent() {
  const total = os.totalmem();
  const free = os.freemem();
  if (!total || total <= 0) return null;
  const pct = ((total - free) / total) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

// Disk via fs.statfs (Node >= 18.15). Report the OS drive (C:\ on Windows, /
// elsewhere). Returns { free, total } in bytes, nulling anything unavailable.
function readDisk() {
  const result = { diskFreeBytes: null, diskTotalBytes: null };
  try {
    if (typeof fs.statfsSync !== "function") return result;
    const stat = fs.statfsSync(IS_WIN ? "C:\\" : "/");
    const bsize = Number(stat.bsize);
    const blocks = Number(stat.blocks);
    const bavail = Number(stat.bavail);
    if (bsize > 0 && blocks > 0) result.diskTotalBytes = bsize * blocks;
    if (bsize > 0 && bavail >= 0) result.diskFreeBytes = bsize * bavail;
  } catch {
    /* leave nulls */
  }
  return result;
}

function collectMetrics() {
  const disk = readDisk();
  return {
    cpuPercent: readCpuPercent(),
    ramPercent: readRamPercent(),
    diskFreeBytes: disk.diskFreeBytes,
    diskTotalBytes: disk.diskTotalBytes,
  };
}

// ── Screen lock (best-effort per-OS) ──────────────────────────────────────────
// The single OS lock action, reused by the lock_screen command AND by the
// per-heartbeat re-lock enforcement below. Returns true if a lock action was
// invoked (Linux is unsupported — same as today).
async function lockScreenOs() {
  if (IS_WIN) {
    await runCmd("rundll32.exe", ["user32.dll,LockWorkStation"]);
    return true;
  }
  if (IS_MAC) {
    await runCmd("pmset", ["displaysleepnow"]);
    return true;
  }
  return false;
}

// Timed-lock enforcement. When the server says a device is locked (isLocked),
// the admin picked a duration; the server holds lockedUntil and flips isLocked
// back to false when it elapses. We re-lock the screen once per poll cycle for
// as long as isLocked is true, so a user who unlocks locally is re-locked
// within one poll interval and can't wait out the duration logged in. When
// isLocked flips to false (or unlock_screen runs) we simply stop re-locking.
async function enforceLock() {
  if (!clientState.isLocked) return;
  try {
    await lockScreenOs();
  } catch (e) {
    console.error("⚠️ Re-lock enforcement failed:", e.message);
  }
}

// ── Authorized IT commands (with visible notice before execution) ─────────────
// The lifecycle contract (validate delivery → ack "acknowledged" BEFORE any OS
// action → redelivery dedup → truthful completed/failed with a safe reason)
// lives in command-runner.mjs so it can be unit-tested with mocked HTTP and
// OS calls (see agent-node/test/command-runner.test.mjs).

async function ackCommand(commandId, status, message) {
  const body = { commandId, status };
  // The ack endpoint tolerates an optional message field for failures; include
  // it when we have one so admins can see why a command failed.
  if (message) body.message = message;
  await apiPost("/commands/ack", body);
}

// Like runCmd, but resolves whether the OS actually accepted the command.
function runCmdStatus(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}

// Schedule restart/shutdown with an OS-side grace delay (60s on Windows) so
// the truthful completion ack can reach the server and an administrator can
// cancel the scheduled action before the machine goes down.
async function schedulePowerCommand(type) {
  if (type === "restart") {
    if (IS_WIN) return runCmdStatus("shutdown", ["/r", "/t", "60"]);
    if (IS_MAC)
      return runCmdStatus("osascript", [
        "-e",
        'tell application "System Events" to restart',
      ]);
    if (await runCmdStatus("systemctl", ["reboot"])) return true;
    return runCmdStatus("shutdown", ["-r", "now"]);
  }
  if (IS_WIN) return runCmdStatus("shutdown", ["/s", "/t", "60"]);
  if (IS_MAC)
    return runCmdStatus("osascript", [
      "-e",
      'tell application "System Events" to shut down',
    ]);
  if (await runCmdStatus("systemctl", ["poweroff"])) return true;
  return runCmdStatus("shutdown", ["-h", "now"]);
}

async function cancelScheduledPowerCommand(type) {
  if (type !== "restart" && type !== "shutdown") return false;
  if (IS_WIN) return runCmdStatus("shutdown", ["/a"]);
  if (IS_MAC) return false;
  return runCmdStatus("shutdown", ["-c"]);
}

async function logoutUserOs() {
  if (IS_WIN) return runCmdStatus("shutdown", ["/l"]);
  if (IS_MAC)
    return runCmdStatus("osascript", [
      "-e",
      'tell application "System Events" to log out',
    ]);
  return false;
}

// Download an update installer to a private temp file; resolves its path.
async function downloadInstaller(downloadUrl, fileName) {
  const tmpBase = path.join(
    os.tmpdir(),
    `tracker-update-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`
  );
  const installerPath = `${tmpBase}${path.extname(fileName) || ".exe"}`;
  const res = await fetch(downloadUrl, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed with status ${res.status}`);
  }
  await new Promise((resolve, reject) => {
    const out = createWriteStream(installerPath, { mode: 0o700 });
    const cleanup = (err) => {
      out.destroy();
      reject(err);
    };
    out.on("error", cleanup);
    out.on("finish", resolve);
    Readable.fromWeb(res.body).on("error", cleanup).pipe(out);
  });
  return installerPath;
}

// Launch the silent installer detached; the installer replaces this agent and
// the first heartbeat from the new build completes the update server-side.
async function launchInstaller(installerPath) {
  // Keep the launch boundary safe even if another caller reaches this helper
  // without going through command-runner's lifecycle verification.
  if (IS_WIN) await verifyWindowsInstaller(installerPath);
  const child = await new Promise((resolve, reject) => {
    const spawned = spawn(
      installerPath,
      ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"],
      {
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      },
    );
    spawned.once("error", reject);
    spawned.once("spawn", () => resolve(spawned));
  });
  child.unref();
}

function execFileResult(command, args) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: 120000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${command} validation failed`));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function containingMacApp(startPath) {
  let current = path.resolve(startPath);
  while (current !== path.dirname(current)) {
    if (current.endsWith(".app")) return current;
    current = path.dirname(current);
  }
  return null;
}

function cleanupMacUpdateBackup() {
  if (!IS_MAC) return;
  const currentApp = containingMacApp(process.execPath);
  if (!currentApp) return;
  const backup = `${currentApp}.updating-backup`;
  if (fs.existsSync(backup)) {
    fs.rmSync(backup, { recursive: true, force: true });
  }
}

async function signatureTeamId(appPath) {
  const result = await execFileResult("codesign", [
    "-dv",
    "--verbose=4",
    appPath,
  ]);
  const match = `${result.stdout}\n${result.stderr}`.match(
    /^TeamIdentifier=(.+)$/m,
  );
  if (!match) throw new Error("app code signature has no Team ID");
  return match[1].trim();
}

const MAC_REPLACER = `#!/bin/bash
PID="$1"; NEW="$2"; APP="$3"
BACKUP="\${APP}.updating-backup"
is_new_running() {
  ps -axo command= | grep -F -- "$APP/Contents/MacOS/WorkforceAgent" >/dev/null
}
for _ in $(seq 1 240); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$PID" 2>/dev/null; then rm -rf "$(dirname "$NEW")" "$0"; exit 1; fi
rm -rf "$BACKUP"
if ! mv "$APP" "$BACKUP"; then open "$APP"; exit 1; fi
if mv "$NEW" "$APP" 2>/dev/null || ditto "$NEW" "$APP"; then
  if ! open "$APP"; then
    rm -rf "$APP"; mv "$BACKUP" "$APP"; open "$APP"
  else
    sleep 5
    for _ in $(seq 1 110); do
      [ ! -d "$BACKUP" ] && break
      is_new_running || break
      sleep 0.5
    done
    if [ -d "$BACKUP" ] && ! is_new_running; then
      rm -rf "$APP"; mv "$BACKUP" "$APP"; open "$APP"
    fi
  fi
else
  rm -rf "$APP"; mv "$BACKUP" "$APP"; open "$APP"
fi
rm -rf "$(dirname "$NEW")" "$0"
`;

async function applyMacUpdate(archivePath, targetVersion) {
  const currentApp = containingMacApp(process.execPath);
  if (!currentApp) {
    throw new Error(
      "agent is not running from an installed app bundle; update this Mac manually",
    );
  }
  fs.accessSync(currentApp, fs.constants.W_OK);
  fs.accessSync(path.dirname(currentApp), fs.constants.W_OK);

  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfa-update-"));
  try {
    await execFileResult("ditto", ["-x", "-k", archivePath, extractDir]);
    const entries = fs.readdirSync(extractDir);
    if (
      entries.length !== 1 ||
      entries[0] !== "WorkforceAgent.app" ||
      fs.lstatSync(path.join(extractDir, entries[0])).isSymbolicLink()
    ) {
      throw new Error(
        "update archive must contain only WorkforceAgent.app at its root",
      );
    }
    const newApp = path.join(extractDir, "WorkforceAgent.app");
    const plist = path.join(newApp, "Contents", "Info.plist");
    const readPlist = async (key) =>
      (
        await execFileResult("plutil", [
          "-extract",
          key,
          "raw",
          "-o",
          "-",
          plist,
        ])
      ).stdout.trim();
    if ((await readPlist("CFBundleIdentifier")) !== "com.workforceanalytics.agent") {
      throw new Error("update app has an unexpected bundle identifier");
    }
    if ((await readPlist("CFBundleShortVersionString")) !== targetVersion) {
      throw new Error("update app version does not match the requested target");
    }
    const executableName = await readPlist("CFBundleExecutable");
    const executable = path.join(
      newApp,
      "Contents",
      "MacOS",
      executableName,
    );
    if (
      executableName !== "WorkforceAgent" ||
      fs.lstatSync(plist).isSymbolicLink() ||
      fs.lstatSync(executable).isSymbolicLink() ||
      !path.resolve(executable).startsWith(`${path.resolve(newApp)}${path.sep}`)
    ) {
      throw new Error("update app bundle contains an unsafe path");
    }
    await execFileResult("codesign", [
      "--verify",
      "--deep",
      "--strict",
      newApp,
    ]);
    if ((await signatureTeamId(newApp)) !== (await signatureTeamId(currentApp))) {
      throw new Error("update app was signed by an unexpected developer team");
    }
    await execFileResult("spctl", [
      "--assess",
      "--type",
      "execute",
      newApp,
    ]);

    const scriptPath = path.join(extractDir, "replace-agent.sh");
    fs.writeFileSync(scriptPath, MAC_REPLACER, { mode: 0o700 });
    const child = spawn(
      "/bin/bash",
      [scriptPath, String(process.pid), newApp, currentApp],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    fs.unlinkSync(archivePath);
  } catch (error) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    throw error;
  }
}

// Durable command-result journal: written BEFORE each final ack so a lost
// ack response (even one racing a shutdown) can never re-run a destructive
// command after the agent restarts — the recorded result is re-acked instead.
const COMMAND_RESULTS_FILE = path.join(CONFIG_DIR, "command-results.json");
function loadCommandResults() {
  try {
    const data = JSON.parse(fs.readFileSync(COMMAND_RESULTS_FILE, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}
const commandResults = loadCommandResults();
const commandResultStore = {
  get: (id) => commandResults[id] ?? null,
  set: (id, result) => {
    commandResults[id] = result;
    // Keep the journal bounded.
    const ids = Object.keys(commandResults);
    for (const old of ids.slice(0, Math.max(0, ids.length - 200))) {
      delete commandResults[old];
    }
    fs.writeFileSync(COMMAND_RESULTS_FILE, JSON.stringify(commandResults));
  },
};

const commandRunner = createCommandRunner({
  ackCommand,
  fetchDownloadUrl: (commandId) =>
    apiPost("/commands/download-url", { commandId }),
  showNotice,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  powerCommand: schedulePowerCommand,
  cancelPowerCommand: cancelScheduledPowerCommand,
  logoutUser: logoutUserOs,
  lockScreenOs,
  // NEVER log the password, and never place it in argv (world-readable via
  // tasklist/WMI) — resetWindowsPassword hands it to PowerShell through an
  // environment variable scoped to the child process only.
  resetPassword: (newPassword) =>
    resetWindowsPassword(os.userInfo().username, newPassword),
  setUsbBlock,
  downloadInstaller,
  verifyInstaller: (installerPath) => verifyWindowsInstaller(installerPath),
  launchInstaller,
  applyMacUpdate,
  removeFile: (p) => fs.unlinkSync(p),
  exitProcess: () => process.exit(0),
  isWin: IS_WIN,
  isMac: IS_MAC,
  clientState,
  configState,
  resultStore: commandResultStore,
  warn: (...args) => console.error("⚠️", ...args),
});

const executeCommand = (cmd) => commandRunner.executeCommand(cmd);


// ── Telemetry stream: foreground app + mouse/idle (cross-platform) ────────────
let psProcess = null;
let macTelemetryTimer = null;

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
    $uiaAvailable = $true;
    try {
        Add-Type -AssemblyName UIAutomationClient;
        Add-Type -AssemblyName UIAutomationTypes;
    } catch {
        $uiaAvailable = $false;
    }

    function Get-BrowserUrl($hwnd, $processName) {
        $browserNames = @('chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi');
        $baseName = $processName.ToLowerInvariant().Replace('.exe', '');
        if (-not $uiaAvailable -or $browserNames -notcontains $baseName) { return $null; }
        try {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd);
            $condition = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                [System.Windows.Automation.ControlType]::Edit
            );
            $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition);
            foreach ($edit in $edits) {
                try {
                    $pattern = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern);
                    $value = [string]$pattern.Current.Value;
                    if ($value -match '^https?://') { return $value.Trim(); }
                    if ($value -match '^(www\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d+)?(?:[/?#].*)?$') {
                        return ('https://' + $value.Trim());
                    }
                } catch { }
            }
        } catch { }
        return $null;
    }

    while ($true) {
        try {
            $hwnd = [Win32]::GetForegroundWindow();
            if ($hwnd -eq [IntPtr]::Zero) {
                $title = $null;
                $processName = $null;
                $url = $null;
            } else {
                $sb = New-Object System.Text.StringBuilder 256;
                [Win32]::GetWindowText($hwnd, $sb, 256) > $null;
                $title = $sb.ToString();

                $wpid = 0;
                [Win32]::GetWindowThreadProcessId($hwnd, [ref]$wpid) > $null;
                $process = Get-Process -Id $wpid -ErrorAction SilentlyContinue;
                $processName = if ($process) { $process.ProcessName } else { 'System' };
                $url = Get-BrowserUrl $hwnd $processName;
            }

            $pos = [System.Windows.Forms.Cursor]::Position;

            $out = @{ title = $title; process = $processName; url = $url; x = $pos.X; y = $pos.Y; };
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
        clientState.activeApp = data.process === null ? null : (data.process || "System");
        clientState.windowTitle = data.title === null ? null : (data.title || "Desktop");
        clientState.activeUrl = typeof data.url === "string" ? data.url : null;
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

function runMacCommand(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 2000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error ? "" : String(stdout).trim());
    });
  });
}

function normalizeMacBrowserUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value.length <= 2048 ? value : null;
  if (!/^(?:www\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d+)?(?:[/?#].*)?$/i.test(value)) {
    return null;
  }
  const normalized = `https://${value}`;
  return normalized.length <= 2048 ? normalized : null;
}

function macBrowserUrlScript(processName) {
  const scripts = {
    safari: 'tell application "Safari" to get URL of front document',
    "google chrome": 'tell application "Google Chrome" to get URL of active tab of front window',
    "microsoft edge": 'tell application "Microsoft Edge" to get URL of active tab of front window',
    "brave browser": 'tell application "Brave Browser" to get URL of active tab of front window',
    vivaldi: 'tell application "Vivaldi" to get URL of active tab of front window',
    opera: 'tell application "Opera" to get URL of active tab of front window',
  };
  const normalizedProcess = String(processName || "").trim().toLowerCase();
  if (scripts[normalizedProcess]) return scripts[normalizedProcess];
  if (normalizedProcess === "firefox") {
    return [
      'tell application "System Events" to tell process "Firefox"',
      "try",
      "get value of text field 1 of toolbar 1 of front window",
      "end try",
      "end tell",
    ].join("\n");
  }
  return null;
}

async function readMacBrowserUrl(processName) {
  const script = macBrowserUrlScript(processName);
  if (!script) return null;
  return normalizeMacBrowserUrl(await runMacCommand("osascript", ["-e", script]));
}

function startPersistentTelemetryStreamMac() {
  if (macTelemetryTimer) clearTimeout(macTelemetryTimer);

  const poll = async () => {
    const processName =
      (await runMacCommand("osascript", [
        "-e",
        'tell application "System Events" to get name of first process whose frontmost is true',
      ])) || "Unknown";
    const title =
      (await runMacCommand("osascript", [
        "-e",
        'tell application "System Events" to tell (first application process whose frontmost is true) to try\nget value of attribute "AXTitle" of front window\nend try',
      ])) || "Desktop";
    const idleOutput = await runMacCommand("ioreg", ["-c", "IOHIDSystem"]);
    const idleMatch = idleOutput.match(/HIDIdleTime"\s*=\s*(\d+)/);
    const idleSeconds = idleMatch ? Math.floor(Number(idleMatch[1]) / 1_000_000_000) : 0;
    const url = await readMacBrowserUrl(processName);

    clientState.activeApp = processName;
    clientState.windowTitle = title;
    clientState.activeUrl = url;
    clientState.idleSecondsCounter = idleSeconds;
    clientState.isCurrentlyIdle = idleSeconds >= configState.idleThresholdSeconds;

    macTelemetryTimer = setTimeout(poll, 2000);
  };

  void poll();
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

// ── Screenshot upload: POST raw bytes to our API (staged, then Dropbox) ───────
async function captureAndUploadScreenshot() {
  // Transparency: always show a visible notice BEFORE capturing.
  await showNotice(
    "Screenshot",
    "A screenshot of your screen is being captured for workforce analytics."
  );

  const shot = await captureScreenshot();
  if (!shot) return;

  try {
    // The image bytes go straight to our authenticated API. The server stages
    // them (viewable immediately) and later uploads them to Dropbox in the
    // background — the agent does not talk to Dropbox directly.
    const res = await apiPostBytes("/screenshots", shot.buffer, {
      contentType: shot.contentType,
      headers: { "x-captured-at": getSyncDate().toISOString() },
    });
    const note = res && res.duplicate ? " (duplicate, already stored)" : "";
    console.log(
      `✅ Screenshot sent (${Math.ceil(shot.buffer.length / 1024)} KB)${note}.`
    );
  } catch (err) {
    console.error("❌ Failed to upload screenshot:", err.message);
  }
}

// ── Upload worker: drain the offline queue independently of tracking ───────────
//
// Server response contract (batchId path):
//   { batchId, acceptedSegmentIds: string[], rejected: Array<{segmentId?, reason?}> }
//
// Error handling:
//   413  – batch too large; halve limit
//   429  – rate-limited; retain records, back off per Retry-After header
//   401/403 – auth failure; retain records, log and wait
//   Other 4xx – retain records and log (do NOT quarantine)
//   response.rejected entries – quarantine only those specific records
let _uploadBatchSize = 500;
let _uploadBackoffUntil = 0;  // epoch ms

async function drainUploadQueue() {
  if (!clientState.deviceId) return;
  if (!offlineQueue.logs.length) return;
  if (Date.now() < _uploadBackoffUntil) return;

  const batch = offlineQueue.logs.slice(0, _uploadBatchSize);
  const batchId = crypto.randomUUID();
  try {
    const systemInfo = await getSystemInfo();
    const res = await apiPost("/activity", { batchId, logs: batch, systemInfo });

    // ── Server response contract ───────────────────────────────────────
    // { batchId, acceptedSegmentIds: [str], rejected: [{segmentId?,reason?}] }
    // Acknowledge ONLY explicitly accepted IDs; do not assume the rest.
    const accepted = Array.isArray(res?.acceptedSegmentIds)
      ? res.acceptedSegmentIds.filter((id) => typeof id === "string")
      : [];
    if (accepted.length) offlineQueue.acknowledge(accepted);

    // Per-record rejections: quarantine only the explicitly rejected segments.
    const rawRejected = Array.isArray(res?.rejected) ? res.rejected : [];
    if (rawRejected.length) {
      const rejectedIds = [];
      for (const entry of rawRejected) {
        if (typeof entry === "string" && entry) {
          rejectedIds.push(entry);
        } else if (entry && typeof entry === "object") {
          const sid = entry.segmentId || entry.id;
          if (typeof sid === "string" && sid) {
            rejectedIds.push(sid);
            console.warn(
              `⚠️ Segment ${sid} rejected by server: ${entry.reason || "unknown"}`
            );
          }
        }
      }
      if (rejectedIds.length) offlineQueue.quarantine(rejectedIds, "server_rejected");
    }

    // If the server returned no ack lists (legacy path without batchId),
    // fall back to acknowledging the entire batch.
    if (!accepted.length && !rawRejected.length && (res?.accepted != null || res?.ok)) {
      offlineQueue.acknowledge(batch.map((l) => l.segmentId));
    }

    // Grow batch size on success.
    _uploadBatchSize = Math.min(500, _uploadBatchSize * 2);

    const queueSize = offlineQueue.logs.length;
    const oldest = offlineQueue.logs[0]?.startedAt ?? null;
    console.log(
      `📝 Activity upload: accepted=${accepted.length} rejected=${rawRejected.length} ` +
      `queue=${queueSize} oldest=${oldest ?? "none"}`
    );
    if (clientState.isOfflineSince) {
      console.log(`✅ Reconnected. Pending records remaining: ${queueSize}`);
      clientState.isOfflineSince = null;
    }
  } catch (err) {
    const status = err?.statusCode ?? err?.status;
    if (status === 413) {
      if (_uploadBatchSize <= 1) {
        // Already at minimum batch size; quarantine the stuck record so later
        // records can proceed rather than retrying this one forever.
        const stuck = offlineQueue.logs[0];
        if (stuck) {
          console.error(`❌ Single record still 413 at min batch size; quarantining ${stuck.segmentId}`);
          offlineQueue.quarantine([stuck.segmentId], "oversized_413");
        }
      } else {
        // Payload too large – split the batch.
        _uploadBatchSize = Math.max(1, Math.floor(_uploadBatchSize / 2));
        console.warn(`⚠️ Activity batch too large (413); retrying with ${_uploadBatchSize} records`);
      }
    } else if (status === 429) {
      // Rate limited – retain all records and back off.
      // Honour the server Retry-After header (delay-seconds or HTTP-date).
      const serverDelay = _parseRetryAfter(err?.headers);
      const backoff = serverDelay !== null ? Math.max(5, serverDelay) : 60;
      _uploadBackoffUntil = Date.now() + backoff * 1000;
      console.warn(`⏸️ Activity rate-limited (429); backing off ${backoff}s`);
    } else if (status === 401 || status === 403) {
      // Auth failure – the records are valid; the credential is not.
      // Retain everything and log for the operator to resolve.
      console.error(`❌ Activity upload auth failure (${status}); retaining records. Check device credentials.`);
    } else if (status != null) {
      // Other HTTP error – retain records and log.
      console.error(`❌ Activity sync HTTP ${status}; retaining ${batch.length} records.`);
    } else {
      // Network error.
      if (!clientState.isOfflineSince) {
        clientState.isOfflineSince = Date.now();
        console.warn("📉 Server unreachable. Activity cached locally. Queue:", offlineQueue.logs.length);
      } else {
        console.warn("⏸️ Activity upload failed; still offline. Queue:", offlineQueue.logs.length);
      }
    }
  }
}

// ── Sync cycle: heartbeat (+ config/commands) ─────────────────────────────────
async function syncTelemetry() {
  // 1. Heartbeat — liveness + config + lock state + pending commands.
  try {
    const tzOffsetMinutes =
      -new Date().getTimezoneOffset() -
      Math.round((clientState.serverClockOffset || 0) / 60000);
    const res = await apiPost("/heartbeat", {
      agentVersion: AGENT_VERSION,
      tzOffsetMinutes,
      metrics: collectMetrics(),
    });
    cleanupMacUpdateBackup();
    if (res?.serverTime) {
      clientState.serverClockOffset = new Date(res.serverTime).getTime() - Date.now();
    }
    const wasLocked = clientState.isLocked;
    if (typeof res?.isLocked === "boolean") clientState.isLocked = res.isLocked;
    if ("lockedUntil" in (res || {}))
      clientState.lockedUntil = res.lockedUntil || null;

    // If the server just flipped the lock ON, close the current open segment
    // so we don't leave an 'unlocked' interval open across a remote lock event.
    if (!wasLocked && clientState.isLocked) {
      _closeCurrentSegment(Date.now());
    }

    await enforceLock();
    applyConfig(res?.config);
    await applyUsbBlockFromConfig();
    if (Array.isArray(res?.commands)) {
      for (const cmd of res.commands) await executeCommand(cmd);
    }
    if (Array.isArray(res?.cancellations)) {
      for (const cancellation of res.cancellations) {
        await commandRunner.cancelPowerCommand(cancellation);
      }
    }
  } catch (err) {
    if (!clientState.isOfflineSince) {
      clientState.isOfflineSince = Date.now();
      console.warn("📉 Server unreachable. Caching activity locally...");
    }
  }

  // 2. Observe: update the current open segment (or open a new one).
  if (configState.monitoringEnabled) {
    _observeSegment();
  }
}

// ── Recursive loops ───────────────────────────────────────────────────────────
async function runSyncCycle() {
  await syncTelemetry();
  const nextMs = Math.max(30 * 1000, configState.syncIntervalSeconds * 1000);
  syncTimer = setTimeout(runSyncCycle, nextMs);
}

async function runUploadCycle() {
  try {
    await drainUploadQueue();
  } catch (err) {
    console.error("❌ Upload cycle error:", err.message);
  }
  uploadTimer = setTimeout(runUploadCycle, 30_000);
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

  // Enforce a single agent per machine; a second instance would log the same
  // activity concurrently and double-count worked time in every report.
  if (!acquireSingleInstanceLock()) {
    console.log(
      "⚠️  Another Active Tracker is already running on this computer; exiting."
    );
    process.exit(0);
    return;
  }

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
  
  if (IS_WIN) {
      const winSessionMonitor = new WindowsSessionMonitor();
      winSessionMonitor.on("lock", () => {
          if (clientState.osSessionLocked) return;
          clientState.osSessionLocked = true;
          _closeCurrentSegment(Date.now());
      });
      winSessionMonitor.on("unlock", () => {
          if (!clientState.osSessionLocked) return;
          clientState.osSessionLocked = false;
          _closeCurrentSegment(Date.now());
      });
      winSessionMonitor.on("suspend", () => {
          _closeCurrentSegment(Date.now());
      });
      winSessionMonitor.start();
      // Wait for it to become ready
      await new Promise(r => setTimeout(r, 500));
      clientState.osSessionLocked = winSessionMonitor.isLocked;
  }

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

  // Tracking loop: observe every 15s.
  setInterval(() => {
    if (configState.monitoringEnabled) {
      _observeSegment();
    }
  }, 15_000);

  // Heartbeat + config + commands: runs at syncIntervalSeconds.
  setTimeout(runSyncCycle, 1500);
  // Upload: runs independently every 30s so network latency never stalls tracking.
  setTimeout(runUploadCycle, 5000);
  setTimeout(runScreenshotCycle, 10000);

  // Best-effort flush on clean termination.  Durability does NOT depend on
  // these handlers: segments are checkpointed to disk every 45 s (rotation)
  // and the offline queue is written before every upload attempt.
  // Forced kills (SIGKILL, OOM) will bypass these; at most one 45s segment
  // may be lost, which is acceptable.
  const _flushBestEffort = () => {
    try { _closeCurrentSegment(Date.now()); } catch { /* best-effort */ }
  };
  process.on("SIGINT", () => { _flushBestEffort(); process.exit(0); });
  process.on("SIGTERM", () => { _flushBestEffort(); process.exit(0); });
}

main().catch((err) => {
  console.error("❌ Tracker client crashed:", err);
  process.exit(1);
});

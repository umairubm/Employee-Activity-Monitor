/**
 * Active Tracker – Local Telemetry Client
 * Runs in the background on Windows, gathers active application states,
 * tracks mouse movement, and captures periodic screenshots, sending them to the API server.
 */

import { exec, spawn } from "child_process";
import http from "http";
import os from "os";
import readline from "readline";
import fs from "fs";
import path from "path";

const SERVER_URL = "http://localhost:5000/api";
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

// ── Global Config State (dynamically controlled from backend Settings) ────────
const configState = {
  screenshotMin: 5,  // in minutes
  screenshotMax: 15, // in minutes
  idleThreshold: 2,  // in minutes
  syncInterval: 5,   // in minutes
};

// ── State Management ──────────────────────────────────────────────────────────
const clientState = {
  deviceId: `${os.hostname()}-agent`,
  deviceName: os.hostname(),
  user: os.userInfo().username || "Employee",
  email: `${os.userInfo().username || "employee"}@company.local`,
  os: process.platform === "win32" ? "windows" : (process.platform === "darwin" ? "macos" : process.platform),
  activeApp: "System",
  windowTitle: "Desktop",
  isCurrentlyIdle: false,
  idleSecondsCounter: 0,
  mouseDistancePx: 0,
  keyboardActivityScore: 0,
  lastMouseX: null,
  lastMouseY: null,
  lastSyncTime: Date.now(),
  isNodeOfflineSince: null,
  serverClockOffset: 0, // ms difference (serverTime - localTime)
};

/**
 * Returns a new Date object synchronized with the server's clock
 */
function getSyncDate() {
  return new Date(Date.now() + clientState.serverClockOffset);
}

const OFFLINE_DB_FILE = path.join(process.cwd(), "offline_queue.json");

// ── Persistent Offline Queue ──────────────────────────────────────────────────
const offlineQueue = {
  data: {
    activities: [],
    heartbeats: []
  },
  
  load() {
    try {
      if (fs.existsSync(OFFLINE_DB_FILE)) {
        const raw = fs.readFileSync(OFFLINE_DB_FILE, "utf-8");
        this.data = JSON.parse(raw);
      }
    } catch (e) {
      console.warn("⚠️ Could not load offline queue, starting fresh.");
    }
  },
  
  save() {
    try {
      fs.writeFileSync(OFFLINE_DB_FILE, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error("❌ Failed to save offline queue:", e.message);
    }
  },
  
  addActivity(log) {
    this.data.activities.push(log);
    this.save();
  },
  
  addHeartbeat(hb) {
    this.data.heartbeats.push(hb);
    this.save();
  },
  
  async flush() {
    if (this.data.activities.length === 0 && this.data.heartbeats.length === 0) return;
    
    console.log(`🔄 Attempting to sync offline data (${this.data.activities.length} logs, ${this.data.heartbeats.length} heartbeats)...`);
    
    try {
      // Sync heartbeats first
      while (this.data.heartbeats.length > 0) {
        const hb = this.data.heartbeats[0];
        await postJson("/sync/heartbeat", hb, true); // true = bypassQueue
        this.data.heartbeats.shift();
      }
      
      // Sync activities
      while (this.data.activities.length > 0) {
        const log = this.data.activities[0];
        await postJson("/activity", log, true); // true = bypassQueue
        this.data.activities.shift();
      }
      
      this.save();
      console.log("✅ Offline data synchronized successfully!");
    } catch (err) {
      console.log("⏸️ Network still unavailable, keeping data in offline queue.");
    }
  }
};

offlineQueue.load();

// Timer handles for recursive setTimeout
let syncTimer = null;
let screenshotTimer = null;

// ── Helper: Classify App Productivity ──────────────────────────────────────────
function getAppClassification(appName) {
  const name = (appName || "System").toLowerCase();
  
  const productiveApps = [
    "code", "idea64", "pycharm", "webstorm", "clion", "studio", "vscode", // IDEs
    "chrome", "firefox", "msedge", "brave", "opera", "safari", // Web browsers for research/development
    "powershell", "cmd", "wt", "bash", "git", // Terminals & tools
    "teams", "slack", "discord", "zoom", "skype", "ms-teams", // Collaboration
    "excel", "winword", "powerpnt", "outlook", "notepad", "notes", // Office / Productivity
    "antigravity", "cursor", "inno", "builder" // Development utilities
  ];

  const unproductiveApps = [
    "spotify", "netflix", "steam", "games", "epicgames", "origin", "play"
  ];

  if (productiveApps.some(app => name.includes(app))) {
    return { type: "productive", category: "Productive" };
  }
  if (unproductiveApps.some(app => name.includes(app))) {
    return { type: "unproductive", category: "Entertainment" };
  }
  return { type: "neutral", category: "General" };
}

// ── Helper: POST JSON to Server ───────────────────────────────────────────────
function postJson(path, data, bypassQueue = false) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request(
      `${SERVER_URL}${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 5000,
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            clientState.isNodeOfflineSince = null; // We are online!
            resolve(responseBody ? JSON.parse(responseBody) : { ok: true });
          } else {
            reject(new Error(`Server returned status ${res.statusCode}: ${responseBody}`));
          }
        });
      }
    );

    req.on("error", (err) => {
      // On network failure, queue the data if not already doing so
      if (!bypassQueue) {
        if (path === "/sync/heartbeat") offlineQueue.addHeartbeat(data);
        if (path === "/activity") offlineQueue.addActivity(data);
        
        if (!clientState.isNodeOfflineSince) {
          clientState.isNodeOfflineSince = Date.now();
          console.warn("📉 Server unreachable. Switching to OFFLINE mode (caching data locally)...");
        }
      }
      reject(err);
    });
    
    req.write(body);
    req.end();
  });
}

// ── Helper: GET JSON from Server ──────────────────────────────────────────────
function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${SERVER_URL}${path}`,
      {
        method: "GET",
        headers: {
          "Accept": "application/json",
        },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(responseBody ? JSON.parse(responseBody) : null);
          } else {
            reject(new Error(`Server returned status ${res.statusCode}: ${responseBody}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.end();
  });
}

// ── Helper: Update Dynamic Configuration State ───────────────────────────────
function updateConfig(s) {
  if (!s) return;
  
  const oldSyncInt = configState.syncInterval;
  const oldSShotMin = configState.screenshotMin;
  const oldSShotMax = configState.screenshotMax;
  
  // Handle Units (sec vs min)
  const normSShotMin = (s.screenshotUnit === "sec") ? Number(s.screenshotMin) / 60 : Number(s.screenshotMin);
  const normSShotMax = (s.screenshotUnit === "sec") ? Number(s.screenshotMax) / 60 : Number(s.screenshotMax);
  const normIdleThr = (s.activityUnit === "sec") ? Number(s.idleThreshold) / 60 : Number(s.idleThreshold);
  const normSyncInt = (s.activityUnit === "sec") ? Number(s.syncInterval) / 60 : Number(s.syncInterval);

  configState.screenshotMin = normSShotMin || 5;
  configState.screenshotMax = normSShotMax || 15;
  configState.idleThreshold = normIdleThr || 1; 
  configState.syncInterval = normSyncInt || 5;

  // Restart Sync Timer if interval changed
  if (configState.syncInterval !== oldSyncInt) {
    console.log(`⏱️ Sync interval updated to ${configState.syncInterval.toFixed(2)} minutes.`);
    if (syncTimer) {
      clearTimeout(syncTimer);
      // Lowered minimum from 10s to 2s to allow high-frequency testing/sync
      const nextSyncMs = Math.max(2000, configState.syncInterval * 60 * 1000);
      syncTimer = setTimeout(runSyncCycle, nextSyncMs);
    }
  }

  // Restart Screenshot Timer if settings changed
  if (configState.screenshotMin !== oldSShotMin || configState.screenshotMax !== oldSShotMax) {
    console.log(`📸 Screenshot interval updated: ${configState.screenshotMin.toFixed(2)}-${configState.screenshotMax.toFixed(2)} minutes.`);
    if (screenshotTimer) {
      clearTimeout(screenshotTimer);
      // Schedule next screenshot almost immediately to apply new interval
      screenshotTimer = setTimeout(runScreenshotCycle, 5000);
    }
  }
}

// ── Helper: Execute PowerShell Commands ────────────────────────────────────────
function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    exec(`powershell.exe -NoProfile -NonInteractive -Command "${command.replace(/"/g, '\\"')}"`, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

async function captureAndSendScreenshotMac() {
  console.log("📸 Capturing screenshot (macOS)...");
  const tmpImg = path.join(os.tmpdir(), `tracker_cap_${Date.now()}.jpg`);
  
  try {
    // Native macOS screencapture command
    await new Promise((resolve, reject) => {
      exec(`screencapture -x "${tmpImg}"`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    if (!fs.existsSync(tmpImg)) throw new Error("Screenshot file not created");

    const imgBuffer = fs.readFileSync(tmpImg);
    const dataUrl = `data:image/jpeg;base64,${imgBuffer.toString('base64')}`;
    
    fs.unlinkSync(tmpImg);

    const payload = {
      deviceId: clientState.deviceId,
      deviceName: clientState.deviceName,
      userName: clientState.user,
      capturedAt: getSyncDate().toISOString(),
      fileSizeKb: Math.ceil(imgBuffer.length / 1024),
      thumbnail: dataUrl
    };

    const res = await postJson("/sync/screenshots", payload);
    if (res && res.ok) {
      console.log("✅ Screenshot sent successfully (macOS).");
    }
  } catch (err) {
    console.error("❌ Failed to capture/send screenshot (macOS):", err.message);
  }
}

// ── Telemetry: Persistent Telemetry Stream (Cross-Platform) ───────────────────
let psProcess = null;

function startPersistentTelemetryStream() {
  if (IS_WIN) startPersistentTelemetryStreamWin();
  else if (IS_MAC) startPersistentTelemetryStreamMac();
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
            
            $out = @{
                title = $title;
                process = $processName;
                x = $pos.X;
                y = $pos.Y;
            };
            
            Write-Output ($out | ConvertTo-Json -Compress);
        } catch {
            # Fail silently
        }
        Start-Sleep -Seconds 2;
    }
  `;

  psProcess = spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    psScript
  ], { windowsHide: true });

  const rl = readline.createInterface({
    input: psProcess.stdout,
    terminal: false
  });

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
          const dist = Math.floor(Math.sqrt(dx * dx + dy * dy));
          
          if (dist > 0) {
            clientState.mouseDistancePx += dist;
            clientState.keyboardActivityScore += Math.min(5, Math.ceil(dist / 50));
            clientState.isCurrentlyIdle = false;
            clientState.idleSecondsCounter = 0; // Reset idle timer
          }
        }
        clientState.lastMouseX = x;
        clientState.lastMouseY = y;
      }
    } catch (err) {
      // Fail silently
    }
  });

  psProcess.stderr.on("data", (data) => {
    // Fail silently
  });

  psProcess.on("close", (code) => {
    if (code !== 0) {
      console.log(`⚠️ Telemetry stream closed with code ${code}. Restarting in 5s...`);
      setTimeout(startPersistentTelemetryStreamWin, 5000);
    }
  });
}

function startPersistentTelemetryStreamMac() {
  // macOS implementation using a shell loop and osascript/ioreg
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

  const rl = readline.createInterface({
    input: macProcess.stdout,
    terminal: false
  });

  rl.on("line", (line) => {
    try {
      const data = JSON.parse(line.trim());
      clientState.activeApp = data.process || "System";
      clientState.windowTitle = data.title || "Desktop";
      
      // On Mac, we get idle seconds directly from ioreg
      if (typeof data.idle === "number") {
        clientState.idleSecondsCounter = data.idle;
        clientState.isCurrentlyIdle = data.idle >= (configState.idleThreshold * 60);
        
        // Mock some activity metrics for consistency with dashboard
        if (data.idle === 0) {
           clientState.mouseDistancePx += 10;
           clientState.keyboardActivityScore += 1;
        }
      }
    } catch (err) {}
  });

  macProcess.on("close", () => {
    console.log("⚠️ macOS Telemetry stream closed. Restarting in 5s...");
    setTimeout(startPersistentTelemetryStreamMac, 5000);
  });
}

// ── Telemetry: Capture Screen and Send Screenshot (Cross-Platform) ────────────
async function captureAndSendScreenshot() {
  if (IS_WIN) await captureAndSendScreenshotWin();
  else if (IS_MAC) await captureAndSendScreenshotMac();
}

async function captureAndSendScreenshotWin() {
  console.log("📸 Capturing screenshot (Windows)...");
  
  const tmpImg = path.join(os.tmpdir(), "tracker_cap.jpg");
  const cscPath = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
  const exePath = path.join(os.tmpdir(), "tracker_screenshot.exe");

  // Compile the executable on the fly if it doesn't exist
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
      await new Promise((resolve, reject) => {
        exec(`"${cscPath}" /nologo /r:System.Drawing.dll,System.Windows.Forms.dll /out:"${exePath}" "${csPath}"`, { windowsHide: true }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      fs.unlinkSync(csPath); // cleanup
    } catch (err) {
      console.error("❌ Failed to compile screenshot tool:", err.message);
      return;
    }
  }

  try {
    await new Promise((resolve, reject) => {
      exec(`"${exePath}" "${tmpImg}"`, { windowsHide: true }, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    if (fs.existsSync(tmpImg)) {
      const imgBuffer = fs.readFileSync(tmpImg);
      const base64Data = imgBuffer.toString("base64");
      const dataUrl = `data:image/jpeg;base64,${base64Data}`;
      
      const payload = {
        deviceId: clientState.deviceId,
        deviceName: clientState.deviceName,
        userName: clientState.user,
        capturedAt: getSyncDate().toISOString(),
        fileSizeKb: Math.ceil(imgBuffer.length / 1024),
        thumbnail: dataUrl
      };

      console.log(`📤 Sending screenshot (${payload.fileSizeKb} KB)...`);
      await postJson("/screenshots", payload);
      console.log("✅ Screenshot sent successfully!");
      
      // Cleanup
      fs.unlinkSync(tmpImg);
    }
  } catch (err) {
    console.error("❌ Failed to capture screenshot:", err.message);
  }
}

// ── Telemetry: Send Heartbeat and Accumulated Logs ────────────────────────────
async function syncTelemetry() {
  try {
    const now = Date.now();
    const elapsedSeconds = Math.max(1, Math.floor((now - clientState.lastSyncTime) / 1000));
    const lastSyncTime = clientState.lastSyncTime;
    clientState.lastSyncTime = now;

    // Classify productivity based on active process
    const classification = getAppClassification(clientState.activeApp);
    const productivityScore = clientState.isCurrentlyIdle 
      ? 0 
      : (classification.type === "productive" ? 100 : (classification.type === "unproductive" ? 20 : 60));

    // 1. Send Heartbeat and fetch active settings from server
    const heartbeatPayload = {
      deviceId: clientState.deviceId,
      deviceName: clientState.deviceName,
      user: clientState.user,
      email: clientState.email,
      os: clientState.os,
      activeApp: clientState.activeApp,
      productivity: productivityScore
    };
    
    console.log("📡 Sending heartbeat...");
    const response = await postJson("/sync/heartbeat", heartbeatPayload);

    if (response && response.serverTime) {
      const serverMs = new Date(response.serverTime).getTime();
      const localMs = Date.now();
      clientState.serverClockOffset = serverMs - localMs;
      console.log(`🕒 Clock sync applied. Offset: ${clientState.serverClockOffset}ms`);
    }

    // Dynamic configuration sync from response
    if (response && response.settings) {
      updateConfig(response.settings);
    }

    // 2. Send Activity Log
    const currentLog = {
      deviceId: clientState.deviceId,
      processName: clientState.activeApp,
      windowTitle: clientState.windowTitle,
      startedAt: new Date(lastSyncTime + clientState.serverClockOffset).toISOString(),
      durationSeconds: elapsedSeconds,
      type: clientState.isCurrentlyIdle ? "idle" : classification.type,
      category: clientState.isCurrentlyIdle ? "Idle" : classification.category
    };

    console.log(`📝 Sending activity log: [${currentLog.category}] Process: ${currentLog.processName} (${elapsedSeconds}s)`);
    await postJson("/activity", currentLog);
    
    // Reset temporary activity variables
    clientState.mouseDistancePx = 0;
    clientState.keyboardActivityScore = 0;
    
  } catch (err) {
    console.error("❌ Sync failure:", err.message);
  }
}

// ── Helper: Periodically fetch and apply backend settings ──────────────────────
async function fetchAndApplySettings() {
  console.log("⚙️ Fetching latest settings from backend...");
  try {
    const s = await getJson(`/settings?deviceId=${clientState.deviceId}`);
    if (s) {
      updateConfig(s);
    }
  } catch (err) {
    console.error("❌ Failed to fetch settings:", err.message);
  }
}

// ── Recursive Loop Management ──────────────────────────────────────────────────
async function runSyncCycle() {
  // If we were offline, try to flush the queue first
  if (clientState.isNodeOfflineSince) {
    await offlineQueue.flush();
  }
  
  await syncTelemetry();
  // Lowered minimum from 10s to 2s
  const nextSyncMs = Math.max(2000, configState.syncInterval * 60 * 1000);
  syncTimer = setTimeout(runSyncCycle, nextSyncMs);
}

async function runScreenshotCycle() {
  if (!clientState.isCurrentlyIdle) {
    await captureAndSendScreenshot();
  } else {
    console.log("⏸️ System is idle. Skipping screenshot.");
  }
  
  // Pick random minutes between screenshotMin and screenshotMax
  const min = configState.screenshotMin;
  const max = configState.screenshotMax;
  const randMinutes = Math.random() * (max - min) + min;
  const nextScreenshotMs = Math.floor(randMinutes * 60 * 1000);
  
  console.log(`⏱️ Next screenshot scheduled randomly in ${randMinutes.toFixed(1)} minutes.`);
  screenshotTimer = setTimeout(runScreenshotCycle, nextScreenshotMs);
}

// ── Core Tracking Loop ────────────────────────────────────────────────────────
async function startTracking() {
  console.log("🚀 Active Tracker Client started successfully!");
  console.log(`🖥️ Tracking machine: ${clientState.deviceName} (User: ${clientState.user})`);
  console.log(`🔗 API Server targeted: ${SERVER_URL}`);

  // Start the persistent telemetry stream (efficient, keeps PowerShell process alive)
  startPersistentTelemetryStream();

  // Periodically increment idle counter and handle idle state checking
  setInterval(() => {
    clientState.idleSecondsCounter = (clientState.idleSecondsCounter || 0) + 2;
    if (clientState.idleSecondsCounter >= (configState.idleThreshold * 60)) {
      clientState.isCurrentlyIdle = true;
    }
  }, 2000);

  // Wait a moment for telemetry stream to gather first packet, then do initial sync
  setTimeout(async () => {
    await syncTelemetry();
  }, 1000);
  
  // Periodically fetch and apply updated settings from backend every 15 minutes
  setInterval(fetchAndApplySettings, 15 * 60 * 1000);

  // Start the recursive loops
  runSyncCycle();
  runScreenshotCycle();
}

startTracking().catch(err => {
  console.error("❌ Tracker client encountered critical error:", err);
});

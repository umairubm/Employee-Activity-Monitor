/**
 * Active Tracker – Local Telemetry Client
 * Runs in the background on Windows, gathers active application states,
 * tracks mouse movement, and captures periodic screenshots, sending them to the API server.
 */

import { exec } from "child_process";
import http from "http";
import os from "os";

const SERVER_URL = "http://localhost:5000/api";

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
  os: "windows",
  activeApp: "System",
  windowTitle: "Desktop",
  isCurrentlyIdle: false,
  idleSecondsCounter: 0,
  mouseDistancePx: 0,
  keyboardActivityScore: 0,
  lastMouseX: null,
  lastMouseY: null,
  lastSyncTime: Date.now()
};

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
function postJson(path, data) {
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
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(responseBody ? JSON.parse(responseBody) : { ok: true });
          } else {
            reject(new Error(`Server returned status ${res.statusCode}: ${responseBody}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Helper: Execute PowerShell Commands ────────────────────────────────────────
function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    exec(`powershell.exe -NoProfile -NonInteractive -Command "${command.replace(/"/g, '\\"')}"`, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

// ── Telemetry: Get Active Window Title & Process ──────────────────────────────
async function updateActiveWindow() {
  const psScript = "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Win32 { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId); }'; $hwnd = [Win32]::GetForegroundWindow(); $sb = New-Object System.Text.StringBuilder 256; [Win32]::GetWindowText($hwnd, $sb, 256) > $null; $title = $sb.ToString(); $pid = 0; [Win32]::GetWindowThreadProcessId($hwnd, [ref]$pid) > $null; $process = Get-Process -Id $pid -ErrorAction SilentlyContinue; $processName = if ($process) { $process.ProcessName } else { 'System' }; @{ title = $title; process = $processName } | ConvertTo-Json";

  try {
    const rawResult = await runPowerShell(psScript);
    if (rawResult) {
      const data = JSON.parse(rawResult);
      clientState.activeApp = data.process || "System";
      clientState.windowTitle = data.title || "Desktop";
    }
  } catch (err) {
    clientState.activeApp = "System";
    clientState.windowTitle = "Desktop";
  }
}

// ── Telemetry: Get Mouse Position and Calculate Movement ──────────────────────
async function updateMouseMovement() {
  const psScript = "Add-Type -AssemblyName System.Windows.Forms; $pos = [System.Windows.Forms.Cursor]::Position; @{ x = $pos.X; y = $pos.Y } | ConvertTo-Json";

  try {
    const rawResult = await runPowerShell(psScript);
    if (rawResult) {
      const coords = JSON.parse(rawResult);
      if (clientState.lastMouseX !== null && clientState.lastMouseY !== null) {
        const dx = coords.x - clientState.lastMouseX;
        const dy = coords.y - clientState.lastMouseY;
        const dist = Math.floor(Math.sqrt(dx * dx + dy * dy));
        
        if (dist > 0) {
          clientState.mouseDistancePx += dist;
          clientState.keyboardActivityScore += Math.min(5, Math.ceil(dist / 50));
          clientState.isCurrentlyIdle = false;
          clientState.idleSecondsCounter = 0; // Reset idle timer!
        }
      }
      clientState.lastMouseX = coords.x;
      clientState.lastMouseY = coords.y;
    }
  } catch (err) {
    // Fail silently
  }
}

// ── Telemetry: Capture Screen and Send Screenshot ──────────────────────────────
async function captureAndSendScreenshot() {
  console.log("📸 Capturing screenshot...");
  const psScript = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height; $graphics = [System.Drawing.Graphics]::FromImage($bmp); $graphics.CopyFromScreen($screen.X, $screen.Y, 0, 0, $bmp.Size); $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); $graphics.Dispose(); [Convert]::ToBase64String($ms.ToArray())";

  try {
    const base64Data = await runPowerShell(psScript);
    if (base64Data) {
      const dataUrl = `data:image/png;base64,${base64Data.trim()}`;
      
      const payload = {
        deviceId: clientState.deviceId,
        deviceName: clientState.deviceName,
        userName: clientState.user,
        capturedAt: new Date().toISOString(),
        fileSizeKb: Math.ceil((base64Data.length * 3) / 4 / 1024), // Approx size
        thumbnail: dataUrl
      };

      console.log(`📤 Sending screenshot (${payload.fileSizeKb} KB)...`);
      await postJson("/screenshots", payload);
      console.log("✅ Screenshot sent successfully!");
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

    // Dynamic configuration sync from response
    if (response && response.settings) {
      const s = response.settings;
      let hasChanges = false;
      if (s.screenshotMin !== configState.screenshotMin ||
          s.screenshotMax !== configState.screenshotMax ||
          s.idleThreshold !== configState.idleThreshold ||
          s.syncInterval !== configState.syncInterval) {
        hasChanges = true;
      }

      if (hasChanges) {
        console.log("⚙️ Loaded updated configuration from Settings server:", s);
        configState.screenshotMin = Number(s.screenshotMin);
        configState.screenshotMax = Number(s.screenshotMax);
        configState.idleThreshold = Number(s.idleThreshold);
        
        // If syncInterval changes, dynamically reschedule the timer
        if (Number(s.syncInterval) !== configState.syncInterval) {
          configState.syncInterval = Number(s.syncInterval);
          if (syncTimer) {
            clearTimeout(syncTimer);
            const nextSyncMs = configState.syncInterval * 60 * 1000;
            syncTimer = setTimeout(runSyncCycle, nextSyncMs);
          }
        }
      }
    }

    // 2. Send Activity Log
    const currentLog = {
      deviceId: clientState.deviceId,
      processName: clientState.activeApp,
      windowTitle: clientState.windowTitle,
      startedAt: new Date(lastSyncTime).toISOString(),
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

// ── Recursive Loop Management ──────────────────────────────────────────────────
async function runSyncCycle() {
  await syncTelemetry();
  const nextSyncMs = configState.syncInterval * 60 * 1000;
  console.log(`⏱️ Next heartbeat/sync scheduled in ${configState.syncInterval} minutes.`);
  syncTimer = setTimeout(runSyncCycle, nextSyncMs);
}

async function runScreenshotCycle() {
  await captureAndSendScreenshot();
  
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

  // Query active app and mouse coordinates continuously every 2 seconds
  setInterval(async () => {
    await updateActiveWindow();
    await updateMouseMovement();
    
    // Increment idle counter
    clientState.idleSecondsCounter = (clientState.idleSecondsCounter || 0) + 2;
    if (clientState.idleSecondsCounter >= (configState.idleThreshold * 60)) {
      clientState.isCurrentlyIdle = true;
    }
  }, 2000);

  // Do initial sync on startup
  await updateActiveWindow();
  await syncTelemetry();
  
  // Start the recursive loops
  runSyncCycle();
  runScreenshotCycle();
}

startTracking().catch(err => {
  console.error("❌ Tracker client encountered critical error:", err);
});

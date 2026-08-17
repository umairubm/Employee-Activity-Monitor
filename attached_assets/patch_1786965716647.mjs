import fs from "fs";
import path from "path";

const filepath = path.join(process.cwd(), "artifacts/api-server/tracker-client.mjs");
let content = fs.readFileSync(filepath, "utf-8");

// 1. Imports
content = content.replace('import path from "path";', 'import path from "path";\nimport crypto from "crypto";');

// 2. Hardware Hash & Credentials
const cred_code = `
function getSyncDate() {
  return new Date(Date.now() + clientState.serverClockOffset);
}

// ── Hardware Fingerprint & Credentials ─────────────────────────────────────────

async function getHardwareHash() {
  return new Promise((resolve) => {
    if (IS_WIN) {
      exec("wmic csproduct get uuid", { windowsHide: true }, (err, stdout) => {
        if (!err && stdout) {
          const lines = stdout.split('\\n');
          if (lines.length > 1 && lines[1].trim()) return resolve(lines[1].trim());
        }
        resolve(os.hostname());
      });
    } else if (IS_MAC) {
      exec(\`ioreg -rd1 -c IOPlatformExpertDevice | awk '/IOPlatformUUID/ { split($0, line, "\\\\\\""); printf("%s\\\\n", line[4]); }'\`, (err, stdout) => {
        if (!err && stdout && stdout.trim()) return resolve(stdout.trim());
        resolve(os.hostname());
      });
    } else {
      resolve(os.hostname());
    }
  });
}

const CREDENTIALS_FILE = path.join(process.cwd(), "credentials.json");

const CredentialManager = {
  data: null,
  hardwareHash: null,

  async init() {
    this.hardwareHash = await getHardwareHash();
    this.load();
  },

  getEncryptionKey() {
    return crypto.createHash("sha256").update(this.hardwareHash).digest();
  },

  encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.getEncryptionKey(), iv);
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    const authTag = cipher.getAuthTag().toString("hex");
    return \`\${iv.toString("hex")}:\${authTag}:\${encrypted}\`;
  },

  decrypt(encryptedText) {
    try {
      const [ivHex, authTagHex, encrypted] = encryptedText.split(":");
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.getEncryptionKey(), Buffer.from(ivHex, "hex"));
      decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
      let decrypted = decipher.update(encrypted, "hex", "utf8");
      decrypted += decipher.final("utf8");
      return decrypted;
    } catch (e) {
      return null;
    }
  },

  load() {
    try {
      if (fs.existsSync(CREDENTIALS_FILE)) {
        const raw = fs.readFileSync(CREDENTIALS_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed.deviceId && parsed.encryptedSecret) {
          const secret = this.decrypt(parsed.encryptedSecret);
          if (secret) {
            this.data = { deviceId: parsed.deviceId, deviceSecret: secret };
            return;
          }
        }
      }
    } catch (e) { }
    this.data = null;
  },

  save(deviceId, deviceSecret) {
    const encryptedSecret = this.encrypt(deviceSecret);
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify({ deviceId, encryptedSecret }, null, 2), { mode: 0o600 });
    this.data = { deviceId, deviceSecret };
  }
};
`;
content = content.replace('function getSyncDate() {\n  return new Date(Date.now() + clientState.serverClockOffset);\n}', cred_code);

// 3. Offline Flush
const old_flush = `      // Sync activities
      while (this.data.activities.length > 0) {
        const log = this.data.activities[0];
        await postJson("/activity", log, true); // true = bypassQueue
        this.data.activities.shift();
      }`;
const new_flush = `      // Sync activities
      if (this.data.activities.length > 0) {
        const batch = this.data.activities.splice(0, 500); // Send up to 500 at once
        await postJson("/sync/activity", { logs: batch }, true);
      }`;
content = content.replace(old_flush, new_flush);

// 4. postJson error handler
const old_err_handler = `        if (path === "/sync/heartbeat") offlineQueue.addHeartbeat(data);
        if (path === "/activity") offlineQueue.addActivity(data);`;
const new_err_handler = `        if (path === "/sync/heartbeat") offlineQueue.addHeartbeat(data);
        if (path === "/sync/activity") {
          data.logs.forEach(log => offlineQueue.addActivity(log));
        }`;
content = content.replace(old_err_handler, new_err_handler);

// 5. postJson headers
const old_post = `function postJson(path, data, bypassQueue = false) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request(
      \`\${SERVER_URL}\${path}\`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 5000,
      },`;
const new_post = `function postJson(path, data, bypassQueue = false, skipAuth = false) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    };
    if (!skipAuth && CredentialManager.data) {
      headers["x-device-id"] = CredentialManager.data.deviceId;
      headers["x-device-secret"] = CredentialManager.data.deviceSecret;
    }

    const req = https.request(
      \`\${SERVER_URL}\${path}\`,
      {
        method: "POST",
        headers,
        timeout: 5000,
      },`;
content = content.replace(old_post, new_post);

// 6. getJson headers
const old_get = `function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      \`\${SERVER_URL}\${path}\`,
      {
        method: "GET",
        headers: {
          "Accept": "application/json",
        },
      },`;
const new_get = `function getJson(path, skipAuth = false) {
  return new Promise((resolve, reject) => {
    const headers = { "Accept": "application/json" };
    if (!skipAuth && CredentialManager.data) {
      headers["x-device-id"] = CredentialManager.data.deviceId;
      headers["x-device-secret"] = CredentialManager.data.deviceSecret;
    }
    const req = https.request(
      \`\${SERVER_URL}\${path}\`,
      {
        method: "GET",
        headers,
      },`;
content = content.replace(old_get, new_get);

// 7. Screenshot 3-step helper
const upload_screenshot = `async function uploadScreenshot3Step(imgBuffer) {
  const uploadRes = await postJson("/sync/screenshots/request-url", {});
  if (!uploadRes || !uploadRes.uploadURL || !uploadRes.storageKey) throw new Error("Invalid request-url response");

  await new Promise((resolve, reject) => {
    const urlObj = new URL(uploadRes.uploadURL);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "PUT",
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": imgBuffer.length
      }
    }, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) resolve();
      else reject(new Error(\`Storage PUT returned \${res.statusCode}\`));
    });
    req.on("error", reject);
    req.write(imgBuffer);
    req.end();
  });

  const payload = {
    storageKey: uploadRes.storageKey,
    capturedAt: getSyncDate().toISOString(),
    fileSizeBytes: imgBuffer.length
  };
  await postJson("/sync/screenshots", payload);
}

// ── Telemetry: Persistent Telemetry Stream (Cross-Platform) ───────────────────`;
content = content.replace('// ── Telemetry: Persistent Telemetry Stream (Cross-Platform) ───────────────────', upload_screenshot);

// 8. Mac Screenshot
const old_mac_sshot = `    const dataUrl = \`data:image/jpeg;base64,\${imgBuffer.toString('base64')}\`;

    fs.unlinkSync(tmpImg);

    const payload = {
      deviceId: clientState.deviceId,
      deviceName: clientState.deviceName,
      userName: clientState.user,
      capturedAt: getSyncDate().toISOString(),
      fileSizeKb: Math.ceil(imgBuffer.length / 1024),
      thumbnail: dataUrl
    };

    const res = await postJson("/screenshots", payload);
    if (res && res.ok) {
      console.log("✅ Screenshot sent successfully (macOS).");
    }`;
const new_mac_sshot = `    await uploadScreenshot3Step(imgBuffer);
    fs.unlinkSync(tmpImg);
    console.log("✅ Screenshot sent successfully (macOS).");`;
content = content.replace(old_mac_sshot, new_mac_sshot);

// 9. Win Screenshot
const old_win_sshot = `      const base64Data = imgBuffer.toString("base64");
      const dataUrl = \`data:image/jpeg;base64,\${base64Data}\`;

      const payload = {
        deviceId: clientState.deviceId,
        deviceName: clientState.deviceName,
        userName: clientState.user,
        capturedAt: getSyncDate().toISOString(),
        fileSizeKb: Math.ceil(imgBuffer.length / 1024),
        thumbnail: dataUrl
      };

      console.log(\`📤 Sending screenshot (\${payload.fileSizeKb} KB)...\`);
      await postJson("/screenshots", payload);
      console.log("✅ Screenshot sent successfully!");

      // Cleanup
      fs.unlinkSync(tmpImg);`;
const new_win_sshot = `      console.log(\`📤 Sending screenshot (\${Math.ceil(imgBuffer.length / 1024)} KB)...\`);
      await uploadScreenshot3Step(imgBuffer);
      console.log("✅ Screenshot sent successfully!");

      // Cleanup
      fs.unlinkSync(tmpImg);`;
content = content.replace(old_win_sshot, new_win_sshot);

// 10. SyncTelemetry updates
const old_sync_start = `    // Classify productivity based on active process
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

    if (response) {
      // Mark as registered on first successful response
      if (!clientState.isRegistered) {
        clientState.isRegistered = true;
        console.log("✅ Device registered with server. Switching to normal sync interval.");
      }

      if (response.serverTime) {
        const serverMs = new Date(response.serverTime).getTime();
        const localMs = Date.now();
        clientState.serverClockOffset = serverMs - localMs;
        console.log(\`🕒 Clock sync applied. Offset: \${clientState.serverClockOffset}ms\`);
      }

      // Dynamic configuration sync from response
      if (response.settings) {
        updateConfig(response.settings);
      }
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

    console.log(\`📝 Sending activity log: [\${currentLog.category}] Process: \${currentLog.processName} (\${elapsedSeconds}s)\`);
    await postJson("/activity", currentLog);`;

const new_sync_start = `    // 1. Send Heartbeat and fetch active settings from server
    const heartbeatPayload = {
      agentVersion: "1.1.0"
    };

    console.log("📡 Sending heartbeat...");
    const response = await postJson("/sync/heartbeat", heartbeatPayload);

    if (response) {
      if (response.serverTime) {
        const serverMs = new Date(response.serverTime).getTime();
        const localMs = Date.now();
        clientState.serverClockOffset = serverMs - localMs;
      }
      if (response.config) {
        updateConfig(response.config);
      }
      if (response.commands && response.commands.length > 0) {
        for (const cmd of response.commands) {
          console.log(\`⚡ Received command: \${cmd.commandType}\`);
          await executeCommand(cmd);
        }
      }
    }

    // 2. Send Activity Log
    const currentLog = {
      processName: clientState.activeApp || "System",
      windowTitle: clientState.windowTitle || "Desktop",
      startedAt: new Date(lastSyncTime + clientState.serverClockOffset).toISOString(),
      endedAt: new Date(now + clientState.serverClockOffset).toISOString(),
      durationSeconds: elapsedSeconds,
      idleSeconds: clientState.isCurrentlyIdle ? elapsedSeconds : 0
    };

    console.log(\`📝 Sending activity log: Process: \${currentLog.processName} (\${elapsedSeconds}s)\`);
    await postJson("/sync/activity", { logs: [currentLog] });`;
content = content.replace(old_sync_start, new_sync_start);

// 11. executeCommand definition
const execute_command = `async function executeCommand(cmd) {
  let status = "failed";
  try {
    if (cmd.commandType === "lock_screen") {
      if (IS_WIN) {
        await runPowerShell("rundll32.exe user32.dll,LockWorkStation");
      } else if (IS_MAC) {
        await new Promise((res, rej) => exec("pmset displaysleepnow", (err) => err ? rej(err) : res()));
      }
      status = "completed";
    } else if (cmd.commandType === "logout_user") {
      if (IS_WIN) {
        await runPowerShell("logoff");
      } else if (IS_MAC) {
        await new Promise((res, rej) => exec("osascript -e 'tell application \\"System Events\\" to log out'", (err) => err ? rej(err) : res()));
      }
      status = "completed";
    }
  } catch (err) {
    console.error(\`❌ Failed to execute command \${cmd.commandType}:\`, err.message);
  }
  try {
    await postJson("/sync/commands/ack", { commandId: cmd.id, status });
  } catch (err) {
    console.error("❌ Failed to ack command:", err.message);
  }
}

// ── Helper: Periodically fetch and apply backend settings ──────────────────────`;
content = content.replace('// ── Helper: Periodically fetch and apply backend settings ──────────────────────', execute_command);

// 12. startTracking updates and enrollDevice
const enroll_device = `const ENROLLMENT_FILE = path.join(process.cwd(), "enrollment.json");

async function enrollDevice() {
  if (CredentialManager.data) return true; // Already enrolled

  if (fs.existsSync(ENROLLMENT_FILE)) {
    try {
      const raw = fs.readFileSync(ENROLLMENT_FILE, "utf-8");
      const { token, consentName } = JSON.parse(raw);

      console.log("📝 Found enrollment.json. Attempting registration...");
      const payload = {
        token,
        hardwareHash: CredentialManager.hardwareHash,
        systemName: os.hostname(),
        osType: IS_WIN ? "windows" : (IS_MAC ? "macos" : "linux"),
        agentVersion: "1.1.0",
        consentAcknowledged: true,
        consentName: consentName || os.userInfo().username || "Employee"
      };

      const res = await postJson("/sync/enroll", payload, true, true);
      if (res && res.deviceId && res.deviceSecret) {
        console.log("✅ Enrollment successful!");
        CredentialManager.save(res.deviceId, res.deviceSecret);
        if (res.config) updateConfig(res.config);
        
        try { fs.unlinkSync(ENROLLMENT_FILE); } catch(e){}
        return true;
      }
    } catch (err) {
      console.error("❌ Enrollment failed:", err.message);
    }
  } else {
    console.warn("⚠️ No credentials found and no enrollment.json present.");
  }
  return false;
}

// ── Core Tracking Loop ────────────────────────────────────────────────────────`;
content = content.replace('// ── Core Tracking Loop ────────────────────────────────────────────────────────', enroll_device);

const old_start = `async function startTracking() {
  console.log("🚀 Active Tracker Client started successfully!");

  console.log(\`🖥️ Tracking machine: \${clientState.deviceName} (User: \${clientState.user})\`);
  console.log(\`🔗 API Server targeted: \${SERVER_URL}\`);`;

const new_start = `async function startTracking() {
  console.log("🚀 Active Tracker Client started successfully!");

  await CredentialManager.init();
  await enrollDevice();

  if (!CredentialManager.data) {
    console.warn("❌ Cannot start tracking without valid credentials/enrollment. Retrying in 30s...");
    setTimeout(startTracking, 30000);
    return;
  }

  console.log(\`🖥️ Tracking machine: \${clientState.deviceName} (User: \${clientState.user})\`);
  console.log(\`🔗 API Server targeted: \${SERVER_URL}\`);`;
content = content.replace(old_start, new_start);

// 13. Fix "if (!clientState.isRegistered)" in runSyncCycle
const old_sync_cycle = `  let nextSyncMs;
  if (!clientState.isRegistered) {
    // Fast-poll every 10s until we get a successful response
    nextSyncMs = 10 * 1000;
    console.log("⏳ Not yet registered. Retrying in 10 seconds...");
  } else {
    // Use server-configured interval (minimum 30s)
    nextSyncMs = Math.max(30 * 1000, configState.syncInterval * 60 * 1000);
  }`;
const new_sync_cycle = `  // Use server-configured interval (minimum 30s)
  let nextSyncMs = Math.max(30 * 1000, configState.syncInterval * 60 * 1000);`;
content = content.replace(old_sync_cycle, new_sync_cycle);

fs.writeFileSync(filepath, content, "utf-8");
console.log("Done writing tracker-client.mjs");

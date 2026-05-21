/**
 * Active Tracker – Local Telemetry Simulator
 * Simulates a client employee workstation sending heartbeat and activity logs to the local SQLite server.
 */

import http from "http";
import screenshot from "modern-screenshot";
import { Buffer } from "buffer";

const SERVER_URL = "http://localhost:5000/api";

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
            resolve(JSON.parse(responseBody));
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

// No mock devices – the simulator will not register any devices
const mockDevices = [];

const mockActivities = [
  { processName: "Code.exe", windowTitle: "Visual Studio Code - Employee-Activity-Monitor", type: "productive", category: "Development" },
  { processName: "chrome.exe", windowTitle: "GitHub: Where the world builds software - Google Chrome", type: "productive", category: "Development" },
  { processName: "Photoshop.exe", windowTitle: "UI_Assets_v2.psd @ 50% (RGB/8) - Adobe Photoshop", type: "productive", category: "Design" },
  { processName: "slack.exe", windowTitle: "Slack - #engineering-updates", type: "neutral", category: "Communication" },
  { processName: "zoom.exe", windowTitle: "Daily Standup Meeting", type: "neutral", category: "Meeting" },
  { processName: "excel.exe", windowTitle: "Employee_Analytics_Q2.xlsx - Microsoft Excel", type: "productive", category: "Finance" }
];

async function runSimulation() {
  console.log("🚀 Starting Active Tracker Workstation Simulation...");

  try {
    for (const dev of mockDevices) {
      console.log(`\n📡 [${dev.deviceName}] Sending heartbeat registration...`);
      const hbResult = await postJson("/sync/heartbeat", dev);
      console.log(`✅ Heartbeat accepted! Device Lock Status: ${hbResult.isLocked ? "LOCKED 🔒" : "ACTIVE 🟢"}`);

      // Generate 3 random activity logs for each device
      for (let i = 0; i < 3; i++) {
        const randAct = mockActivities[Math.floor(Math.random() * mockActivities.length)];
        const log = {
          deviceId: dev.deviceId,
          processName: randAct.processName,
          windowTitle: randAct.windowTitle,
          startedAt: new Date(Date.now() - (i * 300000)).toISOString(),
          durationSeconds: Math.floor(Math.random() * 600) + 120,
          type: randAct.type,
          category: randAct.category
        };
        console.log(`   📝 Uploading activity log: ${log.processName} (${log.windowTitle})`);
        await postJson("/activity", log);
      }

      // Generate 30 mock screenshots for each device
      for (let j = 0; j < 30; j++) {
          // Capture real screenshot using modern-screenshot
          let imgBuffer;
          try {
            imgBuffer = await screenshot({ format: "png" }); // returns Buffer
          } catch (e) {
            console.error("Screenshot capture failed, using placeholder", e);
            imgBuffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64");
          }
          const base64Img = imgBuffer.toString("base64");
          const screenshotData = {
            deviceId: dev.deviceId,
            deviceName: dev.deviceName,
            userName: dev.user,
            capturedAt: new Date(Date.now() - (j * 60000)).toISOString(),
            thumbnail: `data:image/png;base64,${base64Img}`,
            fileSizeKb: Math.round(imgBuffer.length / 1024)
          };
          console.log(`   📸 Uploading screenshot ${j + 1}/30 for ${dev.deviceName}...`);
          await postJson("/screenshots", screenshotData);
        }
    }

    console.log("\n🎉 Simulation data successfully written to SQLite Database!");
    console.log("👉 Open your dashboard in the browser to view the active telemetry logs in real time!");
  } catch (error) {
    console.error("❌ Simulation failed:", error.message);
    console.log("💡 Make sure your local server is running on http://localhost:5000");
  }
}

runSimulation();

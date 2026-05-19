/**
 * Active Tracker – Local SQLite API Server
 * Uses native node sqlite3 module.
 * All data is persisted in a local SQLite file (tracker.db).
 */

import http from "http";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import sqlite3 from "sqlite3";

const baseDir = typeof process.pkg !== "undefined" 
  ? process.cwd() 
  : (typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.join(baseDir, "data");
const DB_FILE = path.join(DATA_DIR, "tracker.db");
const UPLOADS_DIR = path.join(baseDir, "uploads");
const PORT = process.env.PORT || 5000;

// ── Ensure directories exist ──────────────────────────────────────────────────
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Promisified SQLite Database Wrapper ───────────────────────────────────────
const dbConn = new sqlite3.Database(DB_FILE);

const dbQuery = {
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      dbConn.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  },
  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      dbConn.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  },
  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      dbConn.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }
};

// ── Schema Initialization ─────────────────────────────────────────────────────
async function initDb() {
  await dbQuery.run(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT,
      user TEXT,
      email TEXT,
      os TEXT,
      status TEXT,
      productivity INTEGER,
      lastSeen TEXT,
      isLocked INTEGER,
      automationDetected INTEGER,
      totalHoursToday REAL,
      activeApp TEXT
    )
  `);

  await dbQuery.run(`
    CREATE TABLE IF NOT EXISTS activityLogs (
      id TEXT PRIMARY KEY,
      deviceId TEXT,
      processName TEXT,
      windowTitle TEXT,
      startedAt TEXT,
      durationSeconds INTEGER,
      type TEXT,
      category TEXT
    )
  `);

  await dbQuery.run(`
    CREATE TABLE IF NOT EXISTS screenshots (
      id TEXT PRIMARY KEY,
      deviceId TEXT,
      deviceName TEXT,
      userName TEXT,
      capturedAt TEXT,
      thumbnail TEXT,
      fileSizeKb INTEGER,
      flagged INTEGER
    )
  `);

  await dbQuery.run(`
    CREATE TABLE IF NOT EXISTS heartbeats (
      id TEXT PRIMARY KEY,
      deviceId TEXT,
      receivedAt TEXT,
      deviceName TEXT,
      activeApp TEXT,
      productivity INTEGER
    )
  `);

  await dbQuery.run(`
    CREATE TABLE IF NOT EXISTS deviceSettings (
      deviceId TEXT PRIMARY KEY,
      screenshotMin INTEGER,
      screenshotMax INTEGER,
      idleThreshold INTEGER,
      syncInterval INTEGER,
      retentionDays INTEGER
    )
  `);

  // Seed default settings if empty
  const hasSettings = await dbQuery.get("SELECT * FROM deviceSettings WHERE deviceId = 'global'");
  if (!hasSettings) {
    await dbQuery.run(
      "INSERT INTO deviceSettings (deviceId, screenshotMin, screenshotMax, idleThreshold, syncInterval, retentionDays) VALUES ('global', 5, 15, 2, 5, 30)"
    );
  }
}

// Initialize tables immediately
initDb().catch(err => {
  console.error("❌ Failed to initialize SQLite database:", err);
});

// ── HTTP Helpers ──────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  });
  res.end(body);
}

function cors(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  });
  res.end();
}

function notFound(res) { json(res, { error: "Not found" }, 404); }

// ── Router ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method.toUpperCase();
  const segments = url.pathname.replace(/^\/api/, "").split("/").filter(Boolean);

  // CORS preflight
  if (method === "OPTIONS") return cors(res);

  try {
    // ── GET /api/settings ───────────────────────────────────────────────────
    if (method === "GET" && segments[0] === "settings" && !segments[1]) {
      const targetDeviceId = url.searchParams.get("deviceId") || "global";
      let config = await dbQuery.get("SELECT * FROM deviceSettings WHERE deviceId = ?", [targetDeviceId]);
      if (!config && targetDeviceId !== "global") {
        config = await dbQuery.get("SELECT * FROM deviceSettings WHERE deviceId = 'global'");
      }
      if (!config) {
        config = { deviceId: targetDeviceId, screenshotMin: 5, screenshotMax: 15, idleThreshold: 2, syncInterval: 5, retentionDays: 30 };
      }
      return json(res, config);
    }

    // ── POST /api/settings ──────────────────────────────────────────────────
    if (method === "POST" && segments[0] === "settings" && !segments[1]) {
      const body = await readBody(req);
      const targetDeviceId = body.deviceId || "global";
      const screenshotMin = body.screenshotMin !== undefined ? Number(body.screenshotMin) : 5;
      const screenshotMax = body.screenshotMax !== undefined ? Number(body.screenshotMax) : 15;
      const idleThreshold = body.idleThreshold !== undefined ? Number(body.idleThreshold) : 2;
      const syncInterval = body.syncInterval !== undefined ? Number(body.syncInterval) : 5;
      const retentionDays = body.retentionDays !== undefined ? Number(body.retentionDays) : 30;

      await dbQuery.run(
        "INSERT INTO deviceSettings (deviceId, screenshotMin, screenshotMax, idleThreshold, syncInterval, retentionDays) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(deviceId) DO UPDATE SET screenshotMin = excluded.screenshotMin, screenshotMax = excluded.screenshotMax, idleThreshold = excluded.idleThreshold, syncInterval = excluded.syncInterval, retentionDays = excluded.retentionDays",
        [targetDeviceId, screenshotMin, screenshotMax, idleThreshold, syncInterval, retentionDays]
      );
      
      return json(res, { ok: true, deviceId: targetDeviceId, screenshotMin, screenshotMax, idleThreshold, syncInterval, retentionDays });
    }

    // ── GET /api/devices ────────────────────────────────────────────────────
    if (method === "GET" && segments[0] === "devices" && !segments[1]) {
      const rows = await dbQuery.all("SELECT * FROM devices");
      const devices = rows.map(d => ({
        ...d,
        isLocked: Boolean(d.isLocked),
        automationDetected: Boolean(d.automationDetected)
      }));
      return json(res, devices);
    }

    // ── PATCH /api/devices/:id/lock ─────────────────────────────────────────
    if (method === "PATCH" && segments[0] === "devices" && segments[2] === "lock") {
      const deviceId = segments[1];
      await dbQuery.run("UPDATE devices SET isLocked = 1 WHERE id = ?", [deviceId]);
      const device = await dbQuery.get("SELECT * FROM devices WHERE id = ?", [deviceId]);
      if (!device) return notFound(res);
      return json(res, { 
        ...device, 
        isLocked: true, 
        automationDetected: Boolean(device.automationDetected) 
      });
    }

    // ── PATCH /api/devices/:id/unlock ───────────────────────────────────────
    if (method === "PATCH" && segments[0] === "devices" && segments[2] === "unlock") {
      const deviceId = segments[1];
      await dbQuery.run("UPDATE devices SET isLocked = 0 WHERE id = ?", [deviceId]);
      const device = await dbQuery.get("SELECT * FROM devices WHERE id = ?", [deviceId]);
      if (!device) return notFound(res);
      return json(res, { 
        ...device, 
        isLocked: false, 
        automationDetected: Boolean(device.automationDetected) 
      });
    }

    // ── GET /api/activity?deviceId=&limit= ─────────────────────────────────
    if (method === "GET" && segments[0] === "activity" && !segments[1]) {
      const deviceId = url.searchParams.get("deviceId");
      const limit = parseInt(url.searchParams.get("limit") || "100");
      let rows;
      if (deviceId) {
        rows = await dbQuery.all("SELECT * FROM activityLogs WHERE deviceId = ? ORDER BY startedAt DESC LIMIT ?", [deviceId, limit]);
      } else {
        rows = await dbQuery.all("SELECT * FROM activityLogs ORDER BY startedAt DESC LIMIT ?", [limit]);
      }
      return json(res, rows);
    }

    // ── GET /api/activity/timeline?deviceId= ───────────────────────────────
    if (method === "GET" && segments[0] === "activity" && segments[1] === "timeline") {
      const deviceId = url.searchParams.get("deviceId");
      let rows;
      if (deviceId) {
        rows = await dbQuery.all("SELECT * FROM activityLogs WHERE deviceId = ? ORDER BY startedAt DESC", [deviceId]);
      } else {
        rows = await dbQuery.all("SELECT * FROM activityLogs ORDER BY startedAt DESC");
      }
      return json(res, rows);
    }

    // ── POST /api/activity ──────────────────────────────────────────────────
    if (method === "POST" && segments[0] === "activity" && !segments[1]) {
      const body = await readBody(req);
      const log = {
        id: randomUUID(),
        deviceId: body.deviceId || "unknown",
        processName: body.processName || "Unknown",
        windowTitle: body.windowTitle || "",
        startedAt: body.startedAt || new Date().toISOString(),
        durationSeconds: body.durationSeconds || 0,
        type: body.type || "neutral",
        category: body.category || "Other",
      };
      await dbQuery.run(
        "INSERT INTO activityLogs (id, deviceId, processName, windowTitle, startedAt, durationSeconds, type, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [log.id, log.deviceId, log.processName, log.windowTitle, log.startedAt, log.durationSeconds, log.type, log.category]
      );
      // Keep last 1000 logs
      await dbQuery.run("DELETE FROM activityLogs WHERE id NOT IN (SELECT id FROM activityLogs ORDER BY startedAt DESC LIMIT 1000)");
      return json(res, log, 201);
    }

    // ── POST /api/sync/heartbeat ────────────────────────────────────────────
    if (method === "POST" && segments[0] === "sync" && segments[1] === "heartbeat") {
      const body = await readBody(req);
      const deviceId = body.deviceId;
      let device = await dbQuery.get("SELECT * FROM devices WHERE id = ? OR name = ?", [deviceId, body.deviceName]);
      
      const nowStr = new Date().toISOString();
      const activeApp = body.activeApp || "System";
      const productivity = body.productivity !== undefined ? body.productivity : 100;
      
      if (device) {
        await dbQuery.run(
          "UPDATE devices SET status = 'online', lastSeen = ?, activeApp = ?, productivity = ? WHERE id = ?",
          [nowStr, activeApp, productivity, device.id]
        );
        device.isLocked = Boolean(device.isLocked);
      } else {
        // Auto-register new devices dynamically!
        const newDevice = {
          id: deviceId || randomUUID(),
          name: body.deviceName || "Unknown PC",
          user: body.user || "Monitored Employee",
          email: body.email || "employee@company.local",
          os: body.os || "windows",
          status: "online",
          productivity: productivity,
          lastSeen: nowStr,
          isLocked: 0,
          automationDetected: 0,
          totalHoursToday: 0.1,
          activeApp: activeApp,
        };
        await dbQuery.run(
          "INSERT INTO devices (id, name, user, email, os, status, productivity, lastSeen, isLocked, automationDetected, totalHoursToday, activeApp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [newDevice.id, newDevice.name, newDevice.user, newDevice.email, newDevice.os, newDevice.status, newDevice.productivity, newDevice.lastSeen, newDevice.isLocked, newDevice.automationDetected, newDevice.totalHoursToday, newDevice.activeApp]
        );
        device = newDevice;
      }
      
      const hbId = randomUUID();
      await dbQuery.run(
        "INSERT INTO heartbeats (id, deviceId, receivedAt, deviceName, activeApp, productivity) VALUES (?, ?, ?, ?, ?, ?)",
        [hbId, device.id, nowStr, body.deviceName, activeApp, productivity]
      );
      
      // Keep last 500 heartbeats
      await dbQuery.run("DELETE FROM heartbeats WHERE id NOT IN (SELECT id FROM heartbeats ORDER BY receivedAt DESC LIMIT 500)");
      
      // Fetch dynamic settings to return to background agent client (specific or fallback to global)
      let settings = await dbQuery.get("SELECT * FROM deviceSettings WHERE deviceId = ?", [device.id]);
      if (!settings) {
        settings = await dbQuery.get("SELECT * FROM deviceSettings WHERE deviceId = 'global'");
      }
      if (!settings) {
        settings = { screenshotMin: 5, screenshotMax: 15, idleThreshold: 2, syncInterval: 5, retentionDays: 30 };
      }

      return json(res, { 
        ok: true, 
        isLocked: Boolean(device.isLocked),
        settings: {
          screenshotMin: Number(settings.screenshotMin),
          screenshotMax: Number(settings.screenshotMax),
          idleThreshold: Number(settings.idleThreshold),
          syncInterval: Number(settings.syncInterval),
          retentionDays: Number(settings.retentionDays)
        }
      });
    }

    // ── POST /api/screenshots ───────────────────────────────────────────────
    if (method === "POST" && segments[0] === "screenshots" && !segments[1]) {
      const body = await readBody(req);
      const id = randomUUID();
      const deviceId = body.deviceId || "unknown";
      const deviceName = body.deviceName || "Unknown PC";
      const userName = body.userName || "Monitored Employee";
      const capturedAt = body.capturedAt || new Date().toISOString();
      const fileSizeKb = body.fileSizeKb || 0;
      const thumbnail = body.thumbnail || "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="; // default 1x1 blank image

      await dbQuery.run(
        "INSERT INTO screenshots (id, deviceId, deviceName, userName, capturedAt, thumbnail, fileSizeKb, flagged) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
        [id, deviceId, deviceName, userName, capturedAt, thumbnail, fileSizeKb]
      );

      // Keep last 100 screenshots
      await dbQuery.run("DELETE FROM screenshots WHERE id NOT IN (SELECT id FROM screenshots ORDER BY capturedAt DESC LIMIT 100)");

      return json(res, { 
        id, 
        deviceId, 
        deviceName, 
        userName, 
        capturedAt, 
        thumbnail, 
        fileSizeKb, 
        flagged: false 
      }, 201);
    }

    // ── GET /api/screenshots ────────────────────────────────────────────────
    if (method === "GET" && segments[0] === "screenshots" && !segments[1]) {
      const deviceId = url.searchParams.get("deviceId");
      let rows;
      if (deviceId) {
        rows = await dbQuery.all("SELECT * FROM screenshots WHERE deviceId = ? ORDER BY capturedAt DESC", [deviceId]);
      } else {
        rows = await dbQuery.all("SELECT * FROM screenshots ORDER BY capturedAt DESC");
      }
      const screenshots = rows.map(s => ({
        ...s,
        flagged: Boolean(s.flagged)
      }));
      return json(res, screenshots);
    }

    // ── PATCH /api/screenshots/:id/flag ────────────────────────────────────
    if (method === "PATCH" && segments[0] === "screenshots" && segments[2] === "flag") {
      const shotId = segments[1];
      const shot = await dbQuery.get("SELECT * FROM screenshots WHERE id = ?", [shotId]);
      if (!shot) return notFound(res);
      const newFlagVal = shot.flagged ? 0 : 1;
      await dbQuery.run("UPDATE screenshots SET flagged = ? WHERE id = ?", [newFlagVal, shotId]);
      return json(res, { ...shot, flagged: Boolean(newFlagVal) });
    }

    // ── GET /api/health ─────────────────────────────────────────────────────
    if (method === "GET" && segments[0] === "health") {
      return json(res, { status: "ok", uptime: process.uptime(), db: DB_FILE });
    }

    return notFound(res);
  } catch (err) {
    console.error("Request error:", err);
    json(res, { error: err.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`\n✅ Active Tracker Local Server running on http://localhost:${PORT}`);
  console.log(`📁 Database file: ${DB_FILE}`);
  console.log(`🔑 API base: http://localhost:${PORT}/api\n`);
});

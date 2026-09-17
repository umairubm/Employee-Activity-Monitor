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
import sharp from "sharp";
import { networkInterfaces } from 'os';

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
      screenshotUnit TEXT DEFAULT 'min',
      activityUnit TEXT DEFAULT 'min'
    )
  `);

  // Migration: Add units columns if they don't exist
  const tableInfo = await dbQuery.all("PRAGMA table_info(deviceSettings)");
  const colNames = tableInfo.map(c => c.name);
  if (!colNames.includes("screenshotUnit")) {
    await dbQuery.run("ALTER TABLE deviceSettings ADD COLUMN screenshotUnit TEXT DEFAULT 'min'");
  }
  if (!colNames.includes("activityUnit")) {
    await dbQuery.run("ALTER TABLE deviceSettings ADD COLUMN activityUnit TEXT DEFAULT 'min'");
  }

  const devicesTableInfo = await dbQuery.all("PRAGMA table_info(devices)");
  const deviceColNames = devicesTableInfo.map(c => c.name);
  if (!deviceColNames.includes("deviceGroup")) {
    await dbQuery.run("ALTER TABLE devices ADD COLUMN deviceGroup TEXT DEFAULT 'Unassigned'");
  }

  await dbQuery.run(`
    CREATE TABLE IF NOT EXISTS attendanceSettings (
      deviceId TEXT PRIMARY KEY,
      startTime TEXT DEFAULT '08:00',
      halfDayStartThreshold TEXT DEFAULT '09:00',
      halfDayOffStart TEXT DEFAULT '12:00',
      halfDayOffEnd TEXT DEFAULT '15:00',
      requiredHoursNormal REAL DEFAULT 7.5,
      requiredHoursFriday REAL DEFAULT 7.0
    )
  `);

  const attendanceTableInfo = await dbQuery.all("PRAGMA table_info(attendanceSettings)");
  const attendanceColNames = attendanceTableInfo.map(c => c.name);
  if (!attendanceColNames.includes("requiredHoursNormal")) {
    await dbQuery.run("ALTER TABLE attendanceSettings ADD COLUMN requiredHoursNormal REAL DEFAULT 7.5");
  }
  if (!attendanceColNames.includes("requiredHoursFriday")) {
    await dbQuery.run("ALTER TABLE attendanceSettings ADD COLUMN requiredHoursFriday REAL DEFAULT 7.0");
  }

  // Seed default settings if empty
  const hasSettings = await dbQuery.get("SELECT * FROM deviceSettings WHERE deviceId = 'global'");
  if (!hasSettings) {
    await dbQuery.run(
      "INSERT INTO deviceSettings (deviceId, screenshotMin, screenshotMax, idleThreshold, syncInterval, screenshotUnit, activityUnit) VALUES ('global', 5, 15, 2, 5, 'min', 'min')"
    );
  }

  const hasAttendance = await dbQuery.get("SELECT * FROM attendanceSettings WHERE deviceId = 'global'");
  if (!hasAttendance) {
    await dbQuery.run(
      "INSERT INTO attendanceSettings (deviceId, startTime, halfDayStartThreshold, halfDayOffStart, halfDayOffEnd, requiredHoursNormal, requiredHoursFriday) VALUES ('global', '08:00', '09:00', '12:00', '15:00', 7.5, 7.0)"
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

// ── Router ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method.toUpperCase();
  const segments = url.pathname.replace(/^\/api/, "").split("/").filter(Boolean);
  const now = new Date();
  const nowStr = now.toISOString();

  // CORS preflight
  if (method === "OPTIONS") return cors(res);

  try {
    // ── GET /api/devices ────────────────────────────────────────────────────
    if (method === "GET" && segments[0] === "devices" && !segments[1]) {
      const dateStr = url.searchParams.get("date") || nowStr.split("T")[0];
      const rows = await dbQuery.all("SELECT * FROM devices");
      const devices = [];
      const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

      for (const d of rows) {
        // Dynamic status
        let currentStatus = d.status;
        if (d.lastSeen) {
          const lastSeenDate = new Date(d.lastSeen);
          if (now.getTime() - lastSeenDate.getTime() > OFFLINE_THRESHOLD_MS) {
            currentStatus = "offline";
          }
        } else {
          currentStatus = "offline";
        }

        const rawLogs = await dbQuery.all("SELECT durationSeconds, type, startedAt FROM activityLogs WHERE deviceId = ? AND startedAt LIKE ?", [d.id, `${dateStr}%`]);
        // Deduplicate
        const logsMap = {};
        for(const lg of rawLogs) logsMap[lg.startedAt] = lg;
        const logs = Object.values(logsMap);

        let prod = d.productivity;
        if (logs.length > 0) {
          const totalSecs = logs.filter(l => l.type !== "idle").reduce((sum, l) => sum + (l.durationSeconds || 0), 0);
          const prodSecs = logs.filter(l => l.type === "productive").reduce((sum, l) => sum + (l.durationSeconds || 0), 0);
          prod = totalSecs > 0 ? Math.round((prodSecs / totalSecs) * 100) : 0;
        } else {
          const isToday = dateStr === nowStr.split("T")[0];
          if (isToday && currentStatus !== "offline") {
            prod = d.productivity; // Use real-time heartbeat productivity
          } else {
            prod = 0; // Past day or offline with no logs = 0%
          }
        }
        devices.push({
          ...d,
          status: currentStatus,
          productivity: prod,
          isLocked: Boolean(d.isLocked),
          automationDetected: Boolean(d.automationDetected)
        });
      }
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
    // ── PATCH /api/devices/:id/group ─────────────────────────────────────────
    if (method === "PATCH" && segments[0] === "devices" && segments[2] === "group") {
      const deviceId = segments[1];
      const body = await readBody(req);
      const groupName = body.deviceGroup || "Unassigned";
      await dbQuery.run("UPDATE devices SET deviceGroup = ? WHERE id = ?", [groupName, deviceId]);
      const device = await dbQuery.get("SELECT * FROM devices WHERE id = ?", [deviceId]);
      if (!device) return notFound(res);
      return json(res, {
        ...device,
        isLocked: Boolean(device.isLocked),
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
      const dateStr = url.searchParams.get("date");
      let query = "SELECT * FROM activityLogs";
      const conditions = [];
      const params = [];
      if (deviceId) {
        conditions.push("deviceId = ?");
        params.push(deviceId);
      }
      if (dateStr) {
        conditions.push("startedAt LIKE ?");
        params.push(`${dateStr}%`);
      }
      if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
      }
      query += " ORDER BY startedAt DESC";
      const rows = await dbQuery.all(query, params);

      // Deduplicate
      const uniqueLogsMap = {};
      for(let l of rows) uniqueLogsMap[l.startedAt] = l;
      const uniqueRows = Object.values(uniqueLogsMap);
      
      return json(res, uniqueRows);
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
      // retention removed: keep all logs indefinitely
      return json(res, log, 201);
    }

    // ── POST /api/sync/heartbeat ────────────────────────────────────────────
    if (method === "POST" && segments[0] === "sync" && segments[1] === "heartbeat") {
      const body = await readBody(req);
      const deviceId = body.deviceId;
      let device = await dbQuery.get("SELECT * FROM devices WHERE id = ? OR name = ?", [deviceId, body.deviceName]);

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
          deviceGroup: "Unassigned",
        };
        await dbQuery.run(
          "INSERT INTO devices (id, name, user, email, os, status, productivity, lastSeen, isLocked, automationDetected, totalHoursToday, activeApp, deviceGroup) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [newDevice.id, newDevice.name, newDevice.user, newDevice.email, newDevice.os, newDevice.status, newDevice.productivity, newDevice.lastSeen, newDevice.isLocked, newDevice.automationDetected, newDevice.totalHoursToday, newDevice.activeApp, newDevice.deviceGroup]
        );
        device = newDevice;
      }

      const hbId = randomUUID();
      await dbQuery.run(
        "INSERT INTO heartbeats (id, deviceId, receivedAt, deviceName, activeApp, productivity) VALUES (?, ?, ?, ?, ?, ?)",
        [hbId, device.id, nowStr, body.deviceName, activeApp, productivity]
      );

      // retention removed: keep all heartbeats indefinitely
      console.log(`📡 Heartbeat from ${device.name} (${device.user}) at ${nowStr}`);

      // Fetch dynamic settings to return to background agent client (specific or fallback to global)
      let settings = await dbQuery.get("SELECT * FROM deviceSettings WHERE deviceId = ?", [device.id]);
      if (!settings) {
        settings = await dbQuery.get("SELECT * FROM deviceSettings WHERE deviceId = 'global'");
      }
      if (!settings) {
        settings = { screenshotMin: 5, screenshotMax: 15, idleThreshold: 2, syncInterval: 5, screenshotUnit: "min", activityUnit: "min" };
      }

      return json(res, {
        ok: true,
        serverTime: nowStr,
        isLocked: Boolean(device.isLocked),
        settings: {
          screenshotMin: Number(settings.screenshotMin),
          screenshotMax: Number(settings.screenshotMax),
          idleThreshold: Number(settings.idleThreshold),
          syncInterval: Number(settings.syncInterval),
          screenshotUnit: settings.screenshotUnit || "min",
          activityUnit: settings.activityUnit || "min"
        }
      });
    }

    // ── GET /api/settings ───────────────────────────────────────────────────
    if (method === "GET" && segments[0] === "settings") {
      const targetDeviceId = url.searchParams.get("deviceId") || "global";
      let config = await dbQuery.get("SELECT * FROM deviceSettings WHERE deviceId = ?", [targetDeviceId]);
      if (!config && targetDeviceId !== "global") {
        config = await dbQuery.get("SELECT * FROM deviceSettings WHERE deviceId = 'global'");
      }
      return json(res, config || {
        screenshotMin: 5,
        screenshotMax: 15,
        idleThreshold: 2,
        syncInterval: 5,
        screenshotUnit: "min",
        activityUnit: "min"
      });
    }

    // ── POST /api/settings ──────────────────────────────────────────────────
    if (method === "POST" && segments[0] === "settings") {
      const body = await readBody(req);
      const {
        deviceId,
        screenshotMin,
        screenshotMax,
        idleThreshold,
        syncInterval,
        screenshotUnit,
        activityUnit
      } = body;

      const exists = await dbQuery.get("SELECT deviceId FROM deviceSettings WHERE deviceId = ?", [deviceId]);
      if (exists) {
        await dbQuery.run(
          "UPDATE deviceSettings SET screenshotMin = ?, screenshotMax = ?, idleThreshold = ?, syncInterval = ?, screenshotUnit = ?, activityUnit = ? WHERE deviceId = ?",
          [screenshotMin, screenshotMax, idleThreshold, syncInterval, screenshotUnit, activityUnit, deviceId]
        );
      } else {
        await dbQuery.run(
          "INSERT INTO deviceSettings (deviceId, screenshotMin, screenshotMax, idleThreshold, syncInterval, screenshotUnit, activityUnit) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [deviceId, screenshotMin, screenshotMax, idleThreshold, syncInterval, screenshotUnit, activityUnit]
        );
      }
      return json(res, { ok: true });
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
      let thumbnail = body.thumbnail || "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="; // default 1x1 blank image
      let finalFileSizeKb = body.fileSizeKb || 0;

      // Image Optimization: Resize and convert to lossy WebP
      if (thumbnail.startsWith("data:image/")) {
        try {
          const match = thumbnail.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
          if (match && match[2]) {
            const buffer = Buffer.from(match[2], 'base64');
            // Aggressive compression: Resize to max 960px and compress to lossy WebP (quality 25)
            const webpBuffer = await sharp(buffer)
              .resize(960, 960, { fit: 'inside', withoutEnlargement: true })
              .webp({ quality: 25, effort: 6, smartSubsample: true })
              .toBuffer();

            thumbnail = `data:image/webp;base64,${webpBuffer.toString('base64')}`;
            finalFileSizeKb = Math.ceil(webpBuffer.length / 1024);
          }
        } catch (err) {
          console.error("Screenshot compression error:", err);
        }
      }

      await dbQuery.run(
        "INSERT INTO screenshots (id, deviceId, deviceName, userName, capturedAt, thumbnail, fileSizeKb, flagged) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
        [id, deviceId, deviceName, userName, capturedAt, thumbnail, finalFileSizeKb]
      );

      // No retention: keep all screenshots indefinitely

      return json(res, {
        id,
        deviceId,
        deviceName,
        userName,
        capturedAt,
        thumbnail,
        fileSizeKb: finalFileSizeKb,
        flagged: false
      }, 201);
    }

    // ── GET /api/screenshots ────────────────────────────────────────────────
    if (method === "GET" && segments[0] === "screenshots" && !segments[1]) {
      const deviceId = url.searchParams.get("deviceId");
      const pageParam = url.searchParams.get("page");
      const limitParam = url.searchParams.get("limit");
      const usePagination = pageParam !== null && limitParam !== null;
      const page = usePagination ? Math.max(1, parseInt(pageParam)) : 0;
      const limit = usePagination ? Math.max(1, Math.min(200, parseInt(limitParam))) : 0;

      let rows;
      if (usePagination) {
        // Count total
        const countSql = deviceId
          ? "SELECT COUNT(*) as total FROM screenshots WHERE deviceId = ?"
          : "SELECT COUNT(*) as total FROM screenshots";
        const countRow = await dbQuery.get(countSql, deviceId ? [deviceId] : []);
        const total = countRow ? countRow.total : 0;
        const totalPages = Math.ceil(total / limit);
        const offset = (page - 1) * limit;

        if (deviceId) {
          rows = await dbQuery.all("SELECT * FROM screenshots WHERE deviceId = ? ORDER BY capturedAt DESC LIMIT ? OFFSET ?", [deviceId, limit, offset]);
        } else {
          rows = await dbQuery.all("SELECT * FROM screenshots ORDER BY capturedAt DESC LIMIT ? OFFSET ?", [limit, offset]);
        }
        const screenshots = rows.map(s => ({ ...s, flagged: Boolean(s.flagged) }));
        return json(res, { data: screenshots, total, page, limit, totalPages });
      } else {
        // Legacy: return flat array (no pagination)
        if (deviceId) {
          rows = await dbQuery.all("SELECT * FROM screenshots WHERE deviceId = ? ORDER BY capturedAt DESC", [deviceId]);
        } else {
          rows = await dbQuery.all("SELECT * FROM screenshots ORDER BY capturedAt DESC");
        }
        const screenshots = rows.map(s => ({ ...s, flagged: Boolean(s.flagged) }));
        return json(res, screenshots);
      }
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

    // ── POST /api/attendance/settings ──────────────────────────────────────
    if (method === "POST" && segments[0] === "attendance" && segments[1] === "settings") {
      const body = await readBody(req);
      const {
        deviceId,
        startTime = "09:00",
        halfDayStartThreshold = "11:00",
        halfDayOffStart = "12:00",
        halfDayOffEnd = "15:00",
        requiredHoursNormal = 7.5,
        requiredHoursFriday = 7.0,
      } = body;

      await dbQuery.run(
        "INSERT INTO attendanceSettings (deviceId, startTime, halfDayStartThreshold, halfDayOffStart, halfDayOffEnd, requiredHoursNormal, requiredHoursFriday) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(deviceId) DO UPDATE SET startTime=excluded.startTime, halfDayStartThreshold=excluded.halfDayStartThreshold, halfDayOffStart=excluded.halfDayOffStart, halfDayOffEnd=excluded.halfDayOffEnd, requiredHoursNormal=excluded.requiredHoursNormal, requiredHoursFriday=excluded.requiredHoursFriday",
        [deviceId, startTime, halfDayStartThreshold, halfDayOffStart, halfDayOffEnd, requiredHoursNormal, requiredHoursFriday]
      );
      return json(res, { ok: true });
    }

    // ── GET /api/attendance ────────────────────────────────────────────────
    if (method === "GET" && segments[0] === "attendance" && !segments[1]) {
      const dateStr = url.searchParams.get("date") || new Date().toISOString().split("T")[0];
      const devices = await dbQuery.all("SELECT * FROM devices");
      const globalSets = await dbQuery.get("SELECT * FROM attendanceSettings WHERE deviceId = 'global'") || { startTime: "09:00", halfDayStartThreshold: "11:00", halfDayOffStart: "12:00", halfDayOffEnd: "15:00", requiredHoursNormal: 7.5, requiredHoursFriday: 7.0 };

      const dayOfWeek = new Date(dateStr).getDay(); // 0 is Sun, 1 is Mon, 5 is Fri
      const isFriday = dayOfWeek === 5;

      const report = [];
      for (const device of devices) {
        // Find specific settings for this device, fallback to global
        let nodeSets = await dbQuery.get("SELECT * FROM attendanceSettings WHERE deviceId = ?", [device.id]);
        if (!nodeSets) nodeSets = globalSets;
        const activeSets = {
          ...globalSets,
          ...Object.fromEntries(Object.entries(nodeSets).filter(([, value]) => value !== null && value !== undefined)),
        };

        const hoursRequired = isFriday ? activeSets.requiredHoursFriday : activeSets.requiredHoursNormal;

        // Find activity for this device on this date
        // Exclude idle and unproductive time from the active hours calculation
        const logs = await dbQuery.all("SELECT * FROM activityLogs WHERE deviceId = ? AND startedAt LIKE ?", [device.id, `${dateStr}%`]);
        
        // Deduplicate
        const uniqueLogsMap = {};
        for(let l of logs) uniqueLogsMap[l.startedAt] = l;
        const uniqueLogs = Object.values(uniqueLogsMap);

        const activeLogs = uniqueLogs.filter(l => l.type !== 'idle' && l.type !== 'unproductive');

        if (uniqueLogs.length === 0) {
          report.push({ deviceId: device.id, name: device.name, user: device.user, status: "Absent", totalHours: 0, firstSeen: "-", lastSeen: "-" });
          continue;
        }

        const sortedLogs = uniqueLogs.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
        const firstLog = sortedLogs[0];
        const lastLog = sortedLogs[sortedLogs.length - 1];

        const firstTime = new Date(firstLog.startedAt).toTimeString().slice(0, 5); // HH:mm
        const lastTime = new Date(lastLog.startedAt).toTimeString().slice(0, 5);

        let totalSeconds = activeLogs.reduce((acc, l) => acc + (l.durationSeconds || 0), 0);

        // Cap to real elapsed time (in case device slept and bypassed the check, or duplicates slipped past)
        const elapsedMs = new Date(lastLog.startedAt) - new Date(firstLog.startedAt);
        const maxRealSeconds = Math.max(0, elapsedMs / 1000) + (lastLog.durationSeconds || 0);
        
        if (totalSeconds > maxRealSeconds) {
          totalSeconds = maxRealSeconds;
        }

        const totalHours = parseFloat((totalSeconds / 3600).toFixed(2));

        let status = "Present";
        let reason = "";

        // Use either node-specific settings or global fallback
        // const activeSets = nodeSets;

        // Rule 1: Start Time Threshold
        // Rule 1: Late Start Threshold (If they start AFTER the threshold)
        if (firstTime > activeSets.halfDayStartThreshold) {
          status = "Half Day";
          reason = `Late start (${firstTime} > ${activeSets.halfDayStartThreshold})`;
        }

        // Rule 2: End Time Threshold (If they leave BEFORE the threshold)
        if (lastTime < activeSets.halfDayOffStart) {
          status = "Half Day";
          reason = `Early departure (${lastTime} < ${activeSets.halfDayOffStart})`;
        }

        // Rule 3: Total Hours Required (Only if day passed or they left early)
        const isToday = dateStr === nowStr.split('T')[0];
        const currentTimeStr = nowStr.split('T')[1].substring(0, 5); // "HH:MM"

        // Only count as departure if they stopped BEFORE the threshold AND the current time IS AFTER the threshold
        // OR if it's a previous day.
        const hasCheckedOutEarly = isToday
          ? (lastTime < activeSets.halfDayOffStart && currentTimeStr > activeSets.halfDayOffStart)
          : (lastTime < activeSets.halfDayOffStart);

        if (status === "Present" && totalHours < hoursRequired) {
          if (!isToday || hasCheckedOutEarly) {
            status = "Half Day";
            reason = `Insufficient hours (${totalHours}/${hoursRequired}h)`;
          }
        }

        // Final override for active shift within policy
        if (isToday && firstTime <= activeSets.halfDayStartThreshold && !hasCheckedOutEarly) {
          status = "Present";
          reason = "On shift (Policy compliant)";
        }

        report.push({
          deviceId: device.id,
          name: device.name,
          user: device.user,
          status,
          reason,
          totalHours,
          firstSeen: firstTime,
          lastSeen: lastTime,
          required: hoursRequired
        });
      }

      return json(res, report);
    }
    if (method === "GET" && segments[0] === "health") {
      return json(res, { status: "ok", uptime: process.uptime(), db: DB_FILE });
    }

    // ── DEBUG: GET /api/debug/:table ────────────────────────────────────────
    if (method === "GET" && segments[0] === "debug" && segments[1]) {
      const table = segments[1];
      // Simple whitelist to avoid SQL injection
      const allowed = ["devices", "activityLogs", "screenshots", "heartbeats", "deviceSettings", "attendanceSettings"];
      if (!allowed.includes(table)) return json(res, { error: "Table not allowed" }, 400);
      const rows = await dbQuery.all(`SELECT * FROM ${table}`);
      return json(res, rows);
    }
    // ── DELETE /api/devices/:id ────────────────────────────────────────
    // Removes a device and all its related records (activity, screenshots, heartbeats).
    if (method === "DELETE" && segments[0] === "devices" && segments[1]) {
      const deviceId = segments[1];
      // Delete device record
      await dbQuery.run("DELETE FROM devices WHERE id = ?", [deviceId]);
      // Clean up related tables
      await dbQuery.run("DELETE FROM activityLogs WHERE deviceId = ?", [deviceId]);
      await dbQuery.run("DELETE FROM screenshots WHERE deviceId = ?", [deviceId]);
      await dbQuery.run("DELETE FROM heartbeats WHERE deviceId = ?", [deviceId]);
      return json(res, { ok: true, deletedId: deviceId });
    }


    // ── PATCH /api/groups/rename ──────────────────────────────────────────
    if (method === "PATCH" && segments[0] === "groups" && segments[1] === "rename") {
      const body = await readBody(req);
      const { oldName, newName } = body;
      if (!oldName || !newName) return json(res, { error: "Missing oldName or newName" }, 400);
      
      await dbQuery.run("UPDATE devices SET deviceGroup = ? WHERE deviceGroup = ?", [newName, oldName]);
      console.log(`🏷️ Group renamed: "${oldName}" -> "${newName}"`);
      
      const updatedDevices = await dbQuery.all("SELECT * FROM devices");
      return json(res, { 
        ok: true, 
        oldName, 
        newName,
        devices: updatedDevices.map(d => ({
          ...d,
          isLocked: Boolean(d.isLocked),
          automationDetected: Boolean(d.automationDetected)
        }))
      });
    }

    return notFound(res);
  } catch (err) {
    console.error("Request error:", err);
    json(res, { error: err.message }, 500);
  }
});


function getLocalIp() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIp();
  console.log(`\n================================================`);
  console.log(`✅ Active Tracker Server is NOW AVAILABLE on your network!`);
  console.log(`================================================`);
  console.log(`🏠 Local Access:   http://localhost:${PORT}`);
  console.log(`🌐 Network Access: http://${localIp}:${PORT}`);
  console.log(`📁 Database:       ${DB_FILE}`);
  console.log(`\n👉 Point your client devices to: http://${localIp}:${PORT}/api`);
  console.log(`================================================\n`);
});

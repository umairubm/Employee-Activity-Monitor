import sqlite3 from "sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, "data", "tracker.db");

const db = new sqlite3.Database(DB_FILE);

db.serialize(() => {
  // Clear all dummy records
  db.run("DELETE FROM devices");
  db.run("DELETE FROM activityLogs");
  db.run("DELETE FROM screenshots");
  db.run("DELETE FROM heartbeats");
  
  console.log("🧹 Database successfully cleared!");
  console.log("All dummy/mock devices, logs, and screenshots have been removed.");
  console.log("Start your tracker client background task, and only your real device will register and show up!");
});

db.close();

/**
 * ─────────────────────────────────────────────────────────────
 *  API Service  –  Single source of truth for the backend URL
 *  Change API_BASE_URL once here; all pages pick it up.
 * ─────────────────────────────────────────────────────────────
 */

export const API_BASE_URL = "http://localhost:5000";

/** Full path to the /api root */
export const API_BASE = `${API_BASE_URL}/api`;

function normalizeAttendanceSettings(data: any) {
  const formatTime = (time: any, hour: any, minute: any, defaultValue: string) => {
    if (typeof time === "string" && /^\d{1,2}:\d{2}$/.test(time)) return time;
    const parsedHour = Number.isFinite(Number(hour)) ? Number(hour) : undefined;
    const parsedMinute = Number.isFinite(Number(minute)) ? Number(minute) : 0;
    if (parsedHour !== undefined) {
      return `${String(parsedHour).padStart(2, "0")}:${String(parsedMinute).padStart(2, "0")}`;
    }
    return defaultValue;
  };

  return {
    startTime: formatTime(data.startTime, data.shiftStartHour ?? data.startHour, data.shiftStartMinute ?? data.startMinute, "09:00"),
    halfDayStartThreshold: formatTime(data.halfDayStartThreshold, data.halfDayStartHour, data.halfDayStartMinute, "11:00"),
    halfDayOffStart: formatTime(data.halfDayOffStart, data.halfDayOffStartHour, data.halfDayOffStartMinute, "12:00"),
    halfDayOffEnd: formatTime(data.halfDayOffEnd, data.halfDayEndHour ?? data.halfDayOffEndHour, data.halfDayEndMinute ?? data.halfDayOffEndMinute, "15:00"),
    requiredHoursNormal: Number.isFinite(Number(data.requiredHoursNormal)) ? Number(data.requiredHoursNormal) : Number.isFinite(Number(data.requiredHours)) ? Number(data.requiredHours) : 7.5,
    requiredHoursFriday: Number.isFinite(Number(data.requiredHoursFriday)) ? Number(data.requiredHoursFriday) : 7.0,
  };
}

// ─── Generic fetch wrapper ────────────────────────────────────

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${path}`);
  return res.json() as Promise<T>;
}

// ─── Devices ─────────────────────────────────────────────────

export const devicesApi = {
  list: () => apiFetch<any[]>("/devices"),
  lock: (id: string) => apiFetch<any>(`/devices/${id}/lock`, { method: "PATCH" }),
  unlock: (id: string) => apiFetch<any>(`/devices/${id}/unlock`, { method: "PATCH" }),
  setGroup: (id: string, groupName: string) => apiFetch<any>(`/devices/${id}/group`, { 
    method: "PATCH", 
    body: JSON.stringify({ deviceGroup: groupName }) 
  }),
};

// ─── Activity Logs ────────────────────────────────────────────

export const activityApi = {
  list: (limit = 100) => apiFetch<any[]>(`/activity?limit=${limit}`),
  timeline: (deviceId?: string) => apiFetch<any[]>(`/activity/timeline${deviceId ? `?deviceId=${deviceId}` : ""}`),
};

// ─── Screenshots ─────────────────────────────────────────────

export const screenshotsApi = {
  list: () => apiFetch<any[]>("/screenshots"),
  flag: (id: string) => apiFetch<any>(`/screenshots/${id}/flag`, { method: "PATCH" }),
};

// ─── Node / Global Settings ──────────────────────────────────

export const settingsApi = {
  get: (deviceId: string) =>
    apiFetch<any>(`/settings?deviceId=${deviceId}`),

  save: (payload: {
    deviceId: string;
    screenshotMin: number;
    screenshotMax: number;
    idleThreshold: number;
    syncInterval: number;
    screenshotUnit: string;
    activityUnit: string;
  }) =>
    apiFetch<any>("/settings", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};

// ─── Attendance ───────────────────────────────────────────────

export const attendanceApi = {
  report: (date: string) =>
    apiFetch<any[]>(`/attendance?date=${date}`),

  getSettings: async (deviceId: string) => {
    const data = await apiFetch<any>(`/attendance/settings?deviceId=${deviceId}`);
    return normalizeAttendanceSettings(data);
  },

  saveSettings: (payload: {
    deviceId: string;
    startTime: string;
    halfDayStartThreshold: string;
    halfDayOffStart: string;
    halfDayOffEnd: string;
    requiredHoursNormal: number;
    requiredHoursFriday: number;
  }) =>
    apiFetch<any>("/attendance/settings", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};

// ─── Raw fetch helper (for one-off calls) ────────────────────
export { apiFetch };

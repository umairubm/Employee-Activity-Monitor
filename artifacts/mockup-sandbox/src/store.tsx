import * as React from "react";

export type DeviceStatus = "online" | "idle" | "offline";
export type OsType = "windows" | "macos";

export interface Device {
  id: string;
  name: string;
  user: string;
  email: string;
  os: OsType;
  status: DeviceStatus;
  productivity: number;
  lastSeen: string;
  isLocked: boolean;
  automationDetected: boolean;
  totalHoursToday: number;
  activeApp: string;
}

export interface ActivityLog {
  id: string;
  deviceId: string;
  processName: string;
  windowTitle: string;
  startedAt: string;
  durationSeconds: number;
  type: "productive" | "neutral" | "idle" | "media";
  category: string;
}

export interface Screenshot {
  id: string;
  deviceId: string;
  deviceName: string;
  userName: string;
  capturedAt: string;
  thumbnail?: string;
  fileSizeKb: number;
  flagged: boolean;
}

const API_BASE = "http://localhost:5000/api";

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${path}`);
  return res.json() as Promise<T>;
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface AppState {
  devices: Device[];
  logs: ActivityLog[];
  screenshots: Screenshot[];
  selectedDeviceId: string | null;
  loading: boolean;
  error: string | null;
  // Actions
  refresh: () => void;
  lockDevice: (id: string) => void;
  unlockDevice: (id: string) => void;
  selectDevice: (id: string | null) => void;
  toggleFlag: (screenshotId: string) => void;
}

const AppContext = React.createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [devices, setDevices] = React.useState<Device[]>([]);
  const [logs, setLogs] = React.useState<ActivityLog[]>([]);
  const [screenshots, setScreenshots] = React.useState<Screenshot[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const fetchAll = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [devs, acts, shots] = await Promise.all([
        apiFetch<Device[]>("/devices"),
        apiFetch<ActivityLog[]>("/activity"),
        apiFetch<Screenshot[]>("/screenshots"),
      ]);
      setDevices(devs);
      setLogs(acts);
      setScreenshots(shots);
      if (!selectedDeviceId && devs.length > 0) setSelectedDeviceId(devs[0].id);
    } catch (e: any) {
      setError(e.message || "Failed to connect to local server");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void fetchAll();
    // Auto-refresh every 15 seconds
    const timer = setInterval(() => void fetchAll(), 15000);
    return () => clearInterval(timer);
  }, [fetchAll]);

  const lockDevice = async (id: string) => {
    try {
      const updated = await apiFetch<Device>(`/devices/${id}/lock`, { method: "PATCH" });
      setDevices((prev) => prev.map((d) => (d.id === id ? updated : d)));
    } catch {
      setDevices((prev) => prev.map((d) => (d.id === id ? { ...d, isLocked: true } : d)));
    }
  };

  const unlockDevice = async (id: string) => {
    try {
      const updated = await apiFetch<Device>(`/devices/${id}/unlock`, { method: "PATCH" });
      setDevices((prev) => prev.map((d) => (d.id === id ? updated : d)));
    } catch {
      setDevices((prev) => prev.map((d) => (d.id === id ? { ...d, isLocked: false } : d)));
    }
  };

  const toggleFlag = async (screenshotId: string) => {
    try {
      const updated = await apiFetch<Screenshot>(`/screenshots/${screenshotId}/flag`, { method: "PATCH" });
      setScreenshots((prev) => prev.map((s) => (s.id === screenshotId ? updated : s)));
    } catch {
      setScreenshots((prev) =>
        prev.map((s) => (s.id === screenshotId ? { ...s, flagged: !s.flagged } : s))
      );
    }
  };

  return (
    <AppContext.Provider
      value={{
        devices, logs, screenshots, selectedDeviceId, loading, error,
        refresh: fetchAll,
        lockDevice, unlockDevice,
        selectDevice: setSelectedDeviceId,
        toggleFlag,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useAppStore(): AppState {
  const ctx = React.useContext(AppContext);
  if (!ctx) throw new Error("useAppStore must be used inside AppProvider");
  return ctx;
}

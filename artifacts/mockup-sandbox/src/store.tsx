import * as React from "react";
import { apiFetch, devicesApi } from "./lib/api";


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
  deviceGroup: string;
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


interface AppState {
  devices: Device[];
  selectedDeviceId: string | null;
  selectedDate: string;
  loading: boolean;
  error: string | null;
  // Actions
  refresh: (silent?: boolean) => void;
  lockDevice: (id: string) => void;
  unlockDevice: (id: string) => void;
  selectDevice: (id: string | null) => void;
  setDeviceGroup: (id: string, groupName: string) => void;
  renameGroup: (oldName: string, newName: string) => void;
  setSelectedDate: (date: string) => void;
}

const AppContext = React.createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [devices, setDevices] = React.useState<Device[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = React.useState<string | null>(null);
  const [selectedDate, setSelectedDate] = React.useState<string>(new Date().toLocaleDateString('en-CA'));
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const fetchAll = React.useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [devs] = await Promise.all([
        devicesApi.list(selectedDate),
      ]);
      setDevices(devs);
      if (!selectedDeviceId && devs.length > 0) setSelectedDeviceId(devs[0].id);
    } catch (e: any) {
      setError(e.message || "Failed to connect to local server");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [selectedDeviceId, selectedDate]);

  React.useEffect(() => {
    void fetchAll();
    // Auto-refresh every 15 seconds
    const timer = setInterval(() => void fetchAll(true), 15000);
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
      const updated = await devicesApi.unlock(id);
      setDevices((prev) => prev.map((d) => (d.id === id ? updated : d)));
    } catch {
      setDevices((prev) => prev.map((d) => (d.id === id ? { ...d, isLocked: false } : d)));
    }
  };

  const setDeviceGroup = async (id: string, groupName: string) => {
    try {
      const updated = await devicesApi.setGroup(id, groupName);
      setDevices((prev) => prev.map((d) => (d.id === id ? updated : d)));
    } catch {
      setDevices((prev) => prev.map((d) => (d.id === id ? { ...d, deviceGroup: groupName } : d)));
    }
  };

  const renameGroup = async (oldName: string, newName: string) => {
    try {
      const result: any = await devicesApi.renameGroup(oldName, newName);
      if (result.devices) {
        setDevices(result.devices);
      } else {
        setDevices((prev) => prev.map((d) => (d.deviceGroup === oldName ? { ...d, deviceGroup: newName } : d)));
      }
    } catch (e) {
      console.error("Failed to rename group:", e);
      // Fallback local update
      setDevices((prev) => prev.map((d) => (d.deviceGroup === oldName ? { ...d, deviceGroup: newName } : d)));
    }
  };

  return (
    <AppContext.Provider
      value={{
        devices, selectedDeviceId, selectedDate, loading, error,
        refresh: fetchAll,
        lockDevice, unlockDevice,
        selectDevice: setSelectedDeviceId,
        setDeviceGroup,
        renameGroup,
        setSelectedDate,
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

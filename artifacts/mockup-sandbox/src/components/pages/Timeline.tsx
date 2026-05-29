import * as React from "react";
import {
  Clock, Monitor, MousePointer, Keyboard, Search, Camera, X,
  ChevronDown, Check, Info, Shield, Calendar, RefreshCw, Eye, LayoutDashboard, TrendingUp
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useAppStore } from "../../store";
import type { ActivityLog, Screenshot, Device } from "../../store";
import { activityApi, screenshotsApi } from "../../lib/api";
// Helper: Rename powershell process name to beautiful application title
const getAppTitle = (processName: string, windowTitle: string) => {
  const processLower = processName.toLowerCase();
  if (processLower !== "powershell" && processLower !== "cmd" && processLower !== "wt") {
    return processName.replace(/\.exe$/i, "");
  }
  const title = windowTitle.trim();
  if (!title) return "Shell";
  if (title.includes("Google Chrome") || title.includes("Chrome")) return "Google Chrome";
  if (title.includes("Antigravity")) return "Antigravity";
  if (title.includes("Visual Studio Code") || title.includes("VS Code") || title.includes("vscode")) return "VS Code";
  if (title.includes("Cursor")) return "Cursor";
  if (title.includes("Slack")) return "Slack";
  if (title.includes("Discord")) return "Discord";
  if (title.includes("Spotify")) return "Spotify";
  if (title.includes("Notepad")) return "Notepad";
  if (title.includes("Teams")) return "Microsoft Teams";
  if (title.includes("Excel")) return "Microsoft Excel";
  if (title.includes("Word")) return "Microsoft Word";

  const delimiters = [" - ", " — ", " | "];
  for (const delim of delimiters) {
    if (title.includes(delim)) {
      const parts = title.split(delim).map(p => p.trim());
      const lastPart = parts[parts.length - 1];
      const isFile = lastPart.includes(".") || lastPart.toLowerCase().endsWith("toml") || lastPart.toLowerCase().endsWith("tsx") || lastPart.toLowerCase().endsWith("ts");
      if (!isFile && lastPart.length > 2) return lastPart;
      for (let i = parts.length - 2; i >= 0; i--) {
        const part = parts[i];
        const isFilePart = part.includes(".") || part.toLowerCase().endsWith("toml") || part.toLowerCase().endsWith("tsx") || part.toLowerCase().endsWith("ts");
        if (!isFilePart && part.length > 2) return part;
      }
    }
  }
  return "Shell";
};

// Helper: Format duration in seconds
const formatDuration = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
};

// Helper: Get seconds since midnight
const parseTimeToSeconds = (dateStr: string) => {
  const d = new Date(dateStr);
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
};

// Helper: Consistent mock mouse/keyboard input metrics for screenshots
const getMockActivity = (id: string) => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  const kbVal = Math.abs((hash % 70) + 15); // 15% to 85%
  const mouseVal = Math.abs(((hash >> 3) % 75) + 10); // 10% to 85%
  return { kbVal, mouseVal };
};

// Interface for 10-minute parsed timeline slots
export interface TimelineSlot {
  index: number;
  startMinutes: number;
  endMinutes: number;
  startTimeLabel: string;
  endTimeLabel: string;
  status: "productive" | "idle" | "neutral" | "media" | "offline";
  dominantLog: ActivityLog | null;
  logs: ActivityLog[];
}

// Function to divide 24-hour day into 144 slots of 10-minutes each
export const getTimelineSlots = (deviceLogs: ActivityLog[]): TimelineSlot[] => {
  const slots: TimelineSlot[] = [];

  for (let i = 0; i < 144; i++) {
    const slotStartSec = i * 600;
    const slotEndSec = (i + 1) * 600;

    const startHour = Math.floor(slotStartSec / 3600);
    const startMin = Math.floor((slotStartSec % 3600) / 60);
    const endHour = Math.floor(slotEndSec / 3600);
    const endMin = Math.floor((slotEndSec % 3600) / 60);

    const formatTimeLabel = (h: number, m: number) => {
      const ampm = h >= 12 ? "PM" : "AM";
      const displayHour = h % 12 === 0 ? 12 : h % 12;
      return `${displayHour}:${m.toString().padStart(2, "0")} ${ampm}`;
    };

    const startTimeLabel = formatTimeLabel(startHour, startMin);
    const endTimeLabel = formatTimeLabel(endHour, endMin);

    // Find all logs overlapping this slot
    const overlappingLogs: ActivityLog[] = [];
    const durations: Record<string, number> = { productive: 0, idle: 0, neutral: 0, media: 0 };

    for (const log of deviceLogs) {
      const logStart = parseTimeToSeconds(log.startedAt);
      const logEnd = logStart + log.durationSeconds;

      const overlapStart = Math.max(slotStartSec, logStart);
      const overlapEnd = Math.min(slotEndSec, logEnd);

      if (overlapStart < overlapEnd) {
        const overlapDuration = overlapEnd - overlapStart;
        overlappingLogs.push(log);

        const type = log.type || "neutral";
        durations[type] = (durations[type] || 0) + overlapDuration;
      }
    }

    // Find dominant status
    let dominantStatus: "productive" | "idle" | "neutral" | "media" | "offline" = "offline";
    let maxDuration = 0;

    for (const [type, dur] of Object.entries(durations)) {
      if (dur > maxDuration) {
        maxDuration = dur;
        dominantStatus = type as any;
      }
    }

    if (dominantStatus === "offline" && overlappingLogs.length > 0) {
      dominantStatus = (overlappingLogs[0].type || "neutral") as any;
    }

    slots.push({
      index: i,
      startMinutes: i * 10,
      endMinutes: (i + 1) * 10,
      startTimeLabel,
      endTimeLabel,
      status: dominantStatus,
      dominantLog: overlappingLogs.length > 0 ? overlappingLogs[0] : null,
      logs: overlappingLogs,
    });
  }

  return slots;
};

// Sub-component: Segmented 10-minute Visual Daily Timeline track
const VisualTimeline = ({
  deviceLogs,
  selectedSlotIndex,
  onSlotClick,
}: {
  deviceLogs: ActivityLog[];
  selectedSlotIndex?: number | null;
  onSlotClick?: (slot: TimelineSlot) => void;
}) => {
  const slots = React.useMemo(() => getTimelineSlots(deviceLogs), [deviceLogs]);

  return (
    <div className="relative w-full h-10 bg-slate-100 dark:bg-slate-800 rounded-md overflow-hidden border border-slate-200 dark:border-slate-700 flex gap-[1px] p-[2px]">
      {slots.map((slot) => {
        let colorClass = "bg-transparent hover:bg-slate-200/40 dark:hover:bg-slate-700/40";
        if (slot.status === "productive") colorClass = "bg-emerald-500 hover:bg-emerald-600";
        else if (slot.status === "idle") colorClass = "bg-amber-500 hover:bg-amber-600";
        else if (slot.status === "media") colorClass = "bg-purple-500 hover:bg-purple-600";
        else if (slot.status === "neutral") colorClass = "bg-indigo-400 hover:bg-indigo-500";

        const uniqueApps = Array.from(new Set(slot.logs.map(l => getAppTitle(l.processName, l.windowTitle)))).join(", ");
        const title = slot.status !== "offline"
          ? `${slot.startTimeLabel} — ${slot.endTimeLabel}\nApps: ${uniqueApps || "System"}\nStatus: ${slot.status}`
          : `${slot.startTimeLabel} — ${slot.endTimeLabel}\nStatus: Offline`;

        const isSelected = selectedSlotIndex === slot.index;

        return (
          <div
            key={slot.index}
            className={`flex-1 h-full cursor-pointer transition-all duration-75 rounded-[1px] ${colorClass} ${
              isSelected ? "ring-2 ring-indigo-600 dark:ring-indigo-400 ring-inset scale-y-125 z-20 opacity-100 shadow-xl" : "hover:scale-y-110"
            }`}
            title={title}
            onClick={(e) => {
              e.stopPropagation();
              onSlotClick?.(slot);
            }}
          />
        );
      })}

      {/* 2-hour Grid ticks overlay (vertical lines) */}
      {Array.from({ length: 12 }).map((_, i) => {
        const pct = ((i * 2) / 24) * 100;
        return (
          <div
            key={i}
            className="absolute top-0 bottom-0 w-[1px] bg-slate-300/40 dark:bg-slate-600/40 pointer-events-none"
            style={{ left: `${pct}%` }}
          />
        );
      })}
    </div>
  );
};

// Sub-component: Timeline Ticks corresponding to daily layout
const TimelineTicks = () => {
  const ticks = [
    { label: "2 AM", hour: 2 },
    { label: "4 AM", hour: 4 },
    { label: "6 AM", hour: 6 },
    { label: "8 AM", hour: 8 },
    { label: "10 AM", hour: 10 },
    { label: "12 PM", hour: 12 },
    { label: "2 PM", hour: 14 },
    { label: "4 PM", hour: 16 },
    { label: "6 PM", hour: 18 },
    { label: "8 PM", hour: 20 },
    { label: "10 PM", hour: 22 },
  ];
  return (
    <div className="relative w-full h-5 text-[10px] text-slate-500 font-extrabold mt-1.5 opacity-80 uppercase tracking-tighter">
      {ticks.map((t) => {
        const pct = (t.hour / 24) * 100;
        return (
          <span
            key={t.label}
            className="absolute transform -translate-x-1/2 select-none"
            style={{ left: `${pct}%` }}
          >
            {t.label}
          </span>
        );
      })}
    </div>
  );
};

// Structure for parsed timeline intervals
interface TimeInterval {
  start: Date;
  end: Date;
  type: "working" | "idle";
  durationSeconds: number;
  logs: ActivityLog[];
}

export default function Timeline() {
  const { devices, refresh: refreshDevices } = useAppStore();

  // State
  const [logs, setLogs] = React.useState<ActivityLog[]>([]);
  const [screenshots, setScreenshots] = React.useState<Screenshot[]>([]);
  
  const handleRefresh = React.useCallback(() => {
    refreshDevices(true);
    Promise.all([
      activityApi.timeline(),
      screenshotsApi.list()
    ]).then(([acts, shots]) => {
      setLogs(acts);
      setScreenshots(shots);
    }).catch(console.error);
  }, [refreshDevices]);

  React.useEffect(() => {
    handleRefresh();
    // Auto-refresh every 30 seconds for timeline data
    const timer = setInterval(handleRefresh, 30000);
    return () => clearInterval(timer);
  }, [handleRefresh]);
  const [selectedDevices, setSelectedDevices] = React.useState<Record<string, boolean>>({});
  const [selectedDate, setSelectedDate] = React.useState<Date>(new Date());
  const [showFilter, setShowFilter] = React.useState(false);
  const [filterSearch, setFilterSearch] = React.useState("");
  const [groupFilter, setGroupFilter] = React.useState<string>("all");
  const [activeDrawerDevice, setActiveDrawerDevice] = React.useState<Device | null>(null);
  const [drawerTab, setDrawerTab] = React.useState<"overview" | "screencasts">("overview");
  const [selectedInterval, setSelectedInterval] = React.useState<TimeInterval | null>(null);
  const [selectedSlotIndex, setSelectedSlotIndex] = React.useState<number | null>(null);
  const [lightbox, setLightbox] = React.useState<string | null>(null);

  // Initialize selected devices checklist
  React.useEffect(() => {
    if (devices.length > 0 && Object.keys(selectedDevices).length === 0) {
      const initial: Record<string, boolean> = {};
      devices.forEach((d) => {
        initial[d.id] = true;
      });
      setSelectedDevices(initial);
    }
  }, [devices, selectedDevices]);

  // Compute active filtered nodes
  const activeSelectedCount = Object.values(selectedDevices).filter(Boolean).length;
  const allGroups = React.useMemo(() => Array.from(new Set(devices.map(d => d.deviceGroup || "Unassigned"))).sort(), [devices]);
  const filteredDevices = devices.filter((d) => 
    selectedDevices[d.id] && (groupFilter === "all" || (d.deviceGroup || "Unassigned") === groupFilter)
  );

  // Calculate detailed stats for a device row
  const getDeviceStats = (deviceId: string) => {
    const targetDate = new Date(selectedDate);
    targetDate.setHours(0, 0, 0, 0);

    const logsForDevice = logs.filter((l) => {
      if (l.deviceId !== deviceId) return false;
      const logDate = new Date(l.startedAt);
      logDate.setHours(0, 0, 0, 0);
      return logDate.getTime() === targetDate.getTime();
    });

    if (logsForDevice.length === 0) {
      return {
        activeTime: "0m",
        totalTime: "0m",
        startTime: "—",
        endTime: "—",
        logs: [],
      };
    }

    // Merge intervals to prevent duplicate/overlapping logs from artificially inflating time
    const mergeIntervals = (logsToMerge: ActivityLog[]) => {
      const intervals = logsToMerge
        .map(l => ({
          start: new Date(l.startedAt).getTime(),
          end: new Date(l.startedAt).getTime() + l.durationSeconds * 1000
        }))
        .sort((a, b) => a.start - b.start);

      let totalSecs = 0;
      if (intervals.length > 0) {
        let currentStart = intervals[0].start;
        let currentEnd = intervals[0].end;
        for (let i = 1; i < intervals.length; i++) {
          if (intervals[i].start <= currentEnd) {
            currentEnd = Math.max(currentEnd, intervals[i].end);
          } else {
            totalSecs += (currentEnd - currentStart) / 1000;
            currentStart = intervals[i].start;
            currentEnd = intervals[i].end;
          }
        }
        totalSecs += (currentEnd - currentStart) / 1000;
      }
      return totalSecs;
    };

    const activeSeconds = Math.round(mergeIntervals(logsForDevice.filter((l) => l.type !== "idle")));
    const totalTrackedSeconds = Math.round(mergeIntervals(logsForDevice));

    const sorted = [...logsForDevice].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
    const formatTime = (dStr: string) => {
      const d = new Date(dStr);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    };

    const startLog = sorted[0];
    const lastLog = sorted[sorted.length - 1];
    const endTimeDate = new Date(new Date(lastLog.startedAt).getTime() + lastLog.durationSeconds * 1000);

    const formatDur = (s: number) => {
      const hours = Math.floor(s / 3600);
      const mins = Math.floor((s % 3600) / 60);
      return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    };

    return {
      activeTime: formatDur(activeSeconds),
      totalTime: formatDur(totalTrackedSeconds),
      startTime: formatTime(startLog.startedAt),
      endTime: formatTime(endTimeDate.toISOString()),
      logs: logsForDevice,
    };
  };

  const generate10MinSlots = (deviceLogs: ActivityLog[], targetDate: Date): TimeInterval[] => {
    if (deviceLogs.length === 0) return [];
    
    // Sort logs by time
    const sortedLogs = [...deviceLogs].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
    
    // Determine the working range for the day
    const dayStart = new Date(targetDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(23, 59, 59, 999);
    
    // We only show slots from the first activity until now (or end of day)
    const firstLogTime = new Date(sortedLogs[0].startedAt);
    
    // Round first log time down to nearest 10 min
    const startHour = firstLogTime.getHours();
    const startMin = Math.floor(firstLogTime.getMinutes() / 10) * 10;
    const startTime = new Date(dayStart);
    startTime.setHours(startHour, startMin, 0, 0);

    const intervals: TimeInterval[] = [];
    let current = new Date(startTime);
    
    // Stop at end of day or now
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const stopTime = dayStart.getTime() === today.getTime() ? new Date() : dayEnd;

    while (current.getTime() < stopTime.getTime()) {
      const slotEnd = new Date(current.getTime() + 10 * 60 * 1000);
      
      // Find logs falling into this 10-min slot
      const slotLogs = deviceLogs.filter(l => {
        const t = new Date(l.startedAt).getTime();
        return t >= current.getTime() && t < slotEnd.getTime();
      });
      
      const activeLogs = slotLogs.filter(l => l.type !== "idle");
      
      intervals.push({
        start: new Date(current),
        end: slotEnd,
        type: activeLogs.length > 0 ? "working" : "idle",
        durationSeconds: 600,
        logs: slotLogs
      });
      
      current = slotEnd;
    }
    
    return intervals.reverse(); // Show most recent first
  };

  // Group and parse activity logs into continuous blocks of computer vs idle segments
  const generateIntervals = (deviceLogs: ActivityLog[], targetDate: Date): TimeInterval[] => {
    if (deviceLogs.length === 0) return [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const checkDate = new Date(targetDate);
    checkDate.setHours(0, 0, 0, 0);
    
    let now = new Date();
    if (checkDate.getTime() < today.getTime()) {
       // It's a past day, "now" is the end of that day
       now = new Date(checkDate);
       now.setHours(23, 59, 59, 999);
    }

    const sorted = [...deviceLogs].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
    const intervals: TimeInterval[] = [];

    const firstLogDate = new Date(sorted[0].startedAt);
    const startOfDay = new Date(firstLogDate);
    startOfDay.setHours(0, 0, 0, 0);

    let currentStart = startOfDay;

    for (let i = 0; i < sorted.length; i++) {
      const log = sorted[i];
      const logStart = new Date(log.startedAt);
      const logEnd = new Date(logStart.getTime() + log.durationSeconds * 1000);

      const gapSeconds = (logStart.getTime() - currentStart.getTime()) / 1000;
      if (gapSeconds > 60) {
        intervals.push({
          start: currentStart,
          end: logStart,
          type: "idle",
          durationSeconds: gapSeconds,
          logs: [],
        });
      }

      let j = i;
      const mergeLogs: ActivityLog[] = [log];
      let workingEnd = logEnd;

      while (j + 1 < sorted.length) {
        const nextLog = sorted[j + 1];
        const nextStart = new Date(nextLog.startedAt);
        const nextEnd = new Date(nextStart.getTime() + nextLog.durationSeconds * 1000);

        const gapToNext = (nextStart.getTime() - workingEnd.getTime()) / 1000;
        if (gapToNext < 120 && log.type !== "idle" && nextLog.type !== "idle") {
          mergeLogs.push(nextLog);
          workingEnd = nextEnd;
          j++;
        } else {
          break;
        }
      }

      i = j;

      intervals.push({
        start: logStart,
        end: workingEnd,
        type: log.type === "idle" ? "idle" : "working",
        durationSeconds: (workingEnd.getTime() - logStart.getTime()) / 1000,
        logs: mergeLogs,
      });

      currentStart = workingEnd;
    }

    const gapToEnd = (now.getTime() - currentStart.getTime()) / 1000;
    if (gapToEnd > 60) {
      intervals.push({
        start: currentStart,
        end: now,
        type: "idle",
        durationSeconds: gapToEnd,
        logs: [],
      });
    }

    return intervals;
  };

  // Drawer-specific data
  const drawerStats = activeDrawerDevice ? getDeviceStats(activeDrawerDevice.id) : null;
  const drawerIntervals = React.useMemo(() => {
    return drawerStats ? generate10MinSlots(drawerStats.logs, selectedDate) : [];
  }, [drawerStats, selectedDate]);

  // Filter drawer screenshots (possibly by selected interval timeframe or 10-minute slot)
  const drawerScreenshots = React.useMemo(() => {
    if (!activeDrawerDevice) return [];
    
    const targetDate = new Date(selectedDate);
    targetDate.setHours(0, 0, 0, 0);

    let list = screenshots.filter((s) => {
      if (s.deviceId !== activeDrawerDevice.id) return false;
      const shotDate = new Date(s.capturedAt);
      shotDate.setHours(0, 0, 0, 0);
      return shotDate.getTime() === targetDate.getTime();
    });

    if (selectedSlotIndex !== null) {
      list = list.filter((s) => {
        const shotTime = new Date(s.capturedAt);
        const shotMinutes = shotTime.getHours() * 60 + shotTime.getMinutes();
        const shotSlotIndex = Math.floor(shotMinutes / 10);
        return shotSlotIndex === selectedSlotIndex;
      });
    } else if (selectedInterval) {
      const intervalStart = selectedInterval.start.getTime();
      const intervalEnd = selectedInterval.end.getTime();
      list = list.filter((s) => {
        const t = new Date(s.capturedAt).getTime();
        return t >= intervalStart && t <= intervalEnd;
      });
    }
    return list;
  }, [activeDrawerDevice, screenshots, selectedInterval, selectedSlotIndex]);

  const toggleAllDevices = () => {
    const allChecked = Object.values(selectedDevices).every(Boolean);
    const updated: Record<string, boolean> = {};
    devices.forEach((d) => {
      updated[d.id] = !allChecked;
    });
    setSelectedDevices(updated);
  };

  const handleDeviceCheck = (id: string) => {
    setSelectedDevices((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const openDrawer = (device: Device) => {
    setActiveDrawerDevice(device);
    setDrawerTab("overview");
    setSelectedInterval(null);
    setSelectedSlotIndex(null);
  };

  const handleIntervalClick = (interval: TimeInterval) => {
    if (interval.type === "working") {
      setSelectedInterval(interval);
      setSelectedSlotIndex(null);
      // Removed setDrawerTab("screencasts") to allow inline breakdown visibility
    }
  };

  const handleSlotClick = (slot: TimelineSlot) => {
    setSelectedSlotIndex(slot.index);
    setSelectedInterval(null);
    setDrawerTab("screencasts");
  };

  const formatHoursRange = (start: Date, end: Date) => {
    const fmt = (d: Date) =>
      d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
    return `${fmt(start)} — ${fmt(end)}`;
  };

  const formatSlotRangeLabel = (index: number) => {
    const slotStartSec = index * 600;
    const slotEndSec = (index + 1) * 600;
    const formatTimeLabel = (h: number, m: number) => {
      const ampm = h >= 12 ? "PM" : "AM";
      const displayHour = h % 12 === 0 ? 12 : h % 12;
      return `${displayHour}:${m.toString().padStart(2, "0")} ${ampm}`;
    };
    return `${formatTimeLabel(Math.floor(slotStartSec / 3600), Math.floor((slotStartSec % 3600) / 60))} — ${formatTimeLabel(Math.floor(slotEndSec / 3600), Math.floor((slotEndSec % 3600) / 60))}`;
  };

  const lightboxShot = lightbox ? screenshots.find((s) => s.id === lightbox) : null;

  return (
    <div className="space-y-6">
      {/* Premium Top Navigation Bar */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            Timeline
          </h1>

          {/* Date Picker Filter */}
          <div className="flex items-center gap-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-3 py-1.5 rounded-lg shadow-sm">
             <Calendar className="h-4 w-4 text-slate-400 ml-0.5" />
             <input 
               type="date" 
               className="bg-transparent border-none text-sm font-semibold focus:ring-0 text-slate-700 dark:text-slate-200 outline-none"
               value={selectedDate.toISOString().split('T')[0]}
               onChange={(e) => setSelectedDate(new Date(e.target.value))}
             />
          </div>

          {/* Group Dropdown Filter */}
          <div className="relative">
            <select
              className="text-xs font-semibold bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-3 py-2 rounded-lg text-slate-700 dark:text-slate-200 shadow-sm focus:outline-none"
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value)}
            >
              <option value="all">All Groups</option>
              {allGroups.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </div>
          
          {/* Custom Dropdown Filter trigger */}
          <div className="relative">
            <button
              onClick={() => setShowFilter(!showFilter)}
              className="flex items-center gap-2 text-xs font-semibold bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-3.5 py-2 rounded-lg text-slate-700 dark:text-slate-200 hover:bg-slate-50 transition-colors shadow-sm"
            >
              <span>{activeSelectedCount} Users Selected</span>
              <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
            </button>

            {/* Dropdown Menu Overlay */}
            {showFilter && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowFilter(false)} />
                <Card className="absolute left-0 mt-2 w-[280px] z-20 border border-slate-200 dark:border-slate-700 shadow-2xl bg-white dark:bg-slate-900 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-150">
                  <div className="p-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-800/30">
                    <span className="text-xs font-bold text-slate-500">Filter Nodes</span>
                    <button
                      className="text-[10px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                      onClick={toggleAllDevices}
                    >
                      Toggle All
                    </button>
                  </div>
                  <div className="p-2 border-b border-slate-100 dark:border-slate-800">
                    <div className="relative">
                      <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-slate-400" />
                      <Input
                        placeholder="Search users..."
                        className="pl-7 h-7.5 text-xs"
                        value={filterSearch}
                        onChange={(e) => setFilterSearch(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="max-h-[220px] overflow-y-auto p-1.5 space-y-0.5">
                    {devices
                      .filter((d) => d.user.toLowerCase().includes(filterSearch.toLowerCase()))
                      .map((d) => (
                        <label
                          key={d.id}
                          className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer transition-colors text-xs text-slate-700 dark:text-slate-200 font-medium"
                        >
                          <input
                            type="checkbox"
                            className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                            checked={!!selectedDevices[d.id]}
                            onChange={() => handleDeviceCheck(d.id)}
                          />
                          <div className="flex items-center gap-2 truncate">
                            <span className="w-5 h-5 rounded-full bg-indigo-50 dark:bg-indigo-950 flex items-center justify-center text-[10px] font-bold text-indigo-600 dark:text-indigo-400">
                              {d.user.charAt(0)}
                            </span>
                            <span className="truncate">{d.user}</span>
                          </div>
                        </label>
                      ))}
                  </div>
                </Card>
              </>
            )}
          </div>
        </div>

        {/* Sync Controls */}
        <div className="flex items-center gap-2">
          <Badge className="bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/20 dark:text-emerald-400 text-xs px-2.5 py-1 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping" />
            Live Syncing
          </Badge>
          <Button variant="outline" size="sm" onClick={() => handleRefresh()} className="h-8.5 gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Main Grid: Visual Hourly Timeline Table */}
      <Card className="border-none shadow-sm bg-white dark:bg-slate-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-slate-50/75 dark:bg-slate-900/40 border-b border-slate-100 dark:border-slate-700 text-left text-[11px] font-bold text-slate-500 uppercase tracking-wider select-none">
                <th className="py-3 px-4 w-12 text-center">Status</th>
                <th className="py-3 px-4 w-56">User</th>
                <th className="py-3 px-3 w-28 text-center">Active Time</th>
                <th className="py-3 px-3 w-28 text-center">Total Time</th>
                <th className="py-3 px-3 w-24 text-center">Start Time</th>
                <th className="py-3 px-3 w-24 text-center">End Time</th>
                <th className="py-3 px-4 min-w-[500px]">Daily Activity (Divided in 10 Min slots)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
              {filteredDevices.map((d) => {
                const stats = getDeviceStats(d.id);
                return (
                  <tr
                    key={d.id}
                    className="hover:bg-slate-50/50 dark:hover:bg-slate-800/20 transition-colors cursor-pointer group"
                    onClick={() => openDrawer(d)}
                  >
                    {/* Status check circle */}
                    <td className="py-4 px-4 text-center" onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-center">
                        <span
                          className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                            d.status === "online" ? "bg-emerald-500 shadow-sm shadow-emerald-500/50" :
                            d.status === "idle" ? "bg-amber-500" : "bg-slate-300"
                          }`}
                        />
                      </div>
                    </td>

                    {/* Node User profile details */}
                    <td className="py-4 px-4">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center font-bold text-slate-700 dark:text-slate-200 text-xs shadow-inner">
                          {d.user.split(" ").map((n) => n.charAt(0)).join("")}
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold text-slate-900 dark:text-white text-sm group-hover:text-indigo-600 transition-colors truncate">
                            {d.user}
                          </p>
                          <p className="text-[11px] text-slate-400 truncate flex items-center gap-1.5 mt-0.5">
                            {d.status === "online" ? (
                              <>
                                <span className="text-emerald-500 font-semibold uppercase text-[9px] tracking-wider">Tracking</span>
                                <span className="text-slate-300">|</span>
                                <span className="truncate">Using {d.activeApp === "powershell" ? "Shell" : d.activeApp}</span>
                              </>
                            ) : (
                              <span className="uppercase text-[9px] tracking-wider text-slate-400">Offline</span>
                            )}
                          </p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {(() => {
                              const uniqueApps = Array.from(new Set(stats.logs.filter(l => l.type !== "idle").map(l => getAppTitle(l.processName, l.windowTitle))));
                              const allAppsStr = uniqueApps.join(", ");
                              return uniqueApps.slice(0, 3).map((app) => (
                                <span 
                                  key={app} 
                                  title={`Applications used today: ${allAppsStr}`}
                                  className="px-1.5 py-0.5 rounded bg-slate-50 dark:bg-slate-800 text-[9px] font-bold text-slate-500 uppercase tracking-tight border border-slate-100 dark:border-slate-800/50 cursor-help"
                                >
                                  {app}
                                </span>
                              ));
                            })()}
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Dynamic parsed values */}
                    <td className="py-4 px-3 text-center text-sm font-bold text-slate-800 dark:text-slate-200">
                      {stats.activeTime}
                    </td>
                    <td className="py-4 px-3 text-center text-sm font-medium text-slate-500 dark:text-slate-400">
                      {stats.totalTime}
                    </td>
                    <td className="py-4 px-3 text-center text-xs text-slate-500">
                      {stats.startTime}
                    </td>
                    <td className="py-4 px-3 text-center text-xs text-slate-500">
                      {stats.endTime}
                    </td>

                    {/* Horizontally rendered 10-min slot timeline */}
                    <td className="py-4 px-4">
                      <div className="space-y-1 select-none">
                        <VisualTimeline deviceLogs={stats.logs} />
                        <TimelineTicks />
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filteredDevices.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-16 text-center text-slate-400">
                    <Clock className="h-10 w-10 mx-auto mb-3 opacity-30 text-indigo-500" />
                    <h3 className="font-semibold text-slate-700 dark:text-slate-200 mb-1">No Nodes Selected</h3>
                    <p className="text-xs max-w-xs mx-auto">Select nodes from the top dropdown to visualize active timelines.</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Slide-in Overlay Drawer Detail Panel (Right hand side drawer) */}
      {activeDrawerDevice && drawerStats && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/45 backdrop-blur-sm animate-in fade-in duration-200">
          {/* Backdrop closer click */}
          <div className="flex-1" onClick={() => setActiveDrawerDevice(null)} />

          {/* Panel */}
          <div className="w-full max-w-[620px] h-full bg-white dark:bg-slate-900 shadow-2xl flex flex-col animate-in slide-in-from-right duration-200 overflow-hidden">
            {/* Drawer Header */}
            <div className="p-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="w-10 h-10 rounded-full bg-indigo-50 dark:bg-indigo-950/60 flex items-center justify-center font-extrabold text-indigo-600 dark:text-indigo-400 text-sm border border-indigo-100 dark:border-indigo-900/60 shadow-sm">
                  {activeDrawerDevice.user.split(" ").map((n) => n.charAt(0)).join("")}
                </span>
                <div>
                  <h3 className="font-bold text-slate-900 dark:text-white text-base">
                    {activeDrawerDevice.user}
                  </h3>
                  <div className="flex items-center gap-1.5 mt-0.5 text-xs">
                    <span className={`w-2.5 h-2.5 rounded-full ${activeDrawerDevice.status === "online" ? "bg-emerald-500 animate-pulse" : "bg-slate-400"}`} />
                    <span className="text-slate-500 font-medium capitalize">
                      {activeDrawerDevice.status === "online" ? "Tracking" : "Offline"}
                    </span>
                  </div>
                </div>
              </div>
              <button
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
                onClick={() => setActiveDrawerDevice(null)}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Inner scroll container */}
            <div className="flex-1 overflow-y-auto p-5 space-y-6">
              {/* Giant Timeline View */}
              <div className="space-y-2 select-none bg-slate-50 dark:bg-slate-800/20 p-4.5 rounded-xl border border-slate-100 dark:border-slate-800/80">
                <h4 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider flex items-center gap-1.5 mb-2">
                  <Clock className="h-3.5 w-3.5 text-indigo-500" /> Focus Activity Spectrum (Click any 10m block to filter screencasts)
                </h4>
                <VisualTimeline
                  deviceLogs={drawerStats.logs}
                  selectedSlotIndex={selectedSlotIndex}
                  onSlotClick={handleSlotClick}
                />
                <TimelineTicks />
              </div>

              {/* Metric stats card */}
              <div className="grid grid-cols-4 gap-2">
                <Card className="border border-slate-100 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-800/10 p-2.5 text-center">
                  <p className="text-[9px] font-bold text-slate-400 uppercase">Active</p>
                  <p className="text-sm font-extrabold text-slate-900 dark:text-white mt-0.5">
                    {drawerStats.activeTime}
                  </p>
                </Card>
                <Card className="border border-slate-100 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-800/10 p-2.5 text-center">
                  <p className="text-[9px] font-bold text-slate-400 uppercase">Total</p>
                  <p className="text-sm font-extrabold text-slate-900 dark:text-white mt-0.5">
                    {drawerStats.totalTime}
                  </p>
                </Card>
                <Card className="border border-slate-100 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-800/10 p-2.5 text-center">
                  <p className="text-[9px] font-bold text-slate-400 uppercase">Start</p>
                  <p className="text-sm font-extrabold text-slate-900 dark:text-white mt-0.5">
                    {drawerStats.startTime}
                  </p>
                </Card>
                <Card className="border border-slate-100 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-800/10 p-2.5 text-center">
                  <p className="text-[9px] font-bold text-slate-400 uppercase">End</p>
                  <p className="text-sm font-extrabold text-slate-900 dark:text-white mt-0.5">
                    {drawerStats.endTime}
                  </p>
                </Card>
              </div>

              {/* Tab Switcher Tabs */}
              <div className="flex border-b border-slate-200 dark:border-slate-800">
                <button
                  className={`flex-1 py-2.5 font-bold text-sm border-b-2 transition-all ${
                    drawerTab === "overview"
                      ? "border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400"
                      : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                  }`}
                  onClick={() => setDrawerTab("overview")}
                >
                  Overview
                </button>
                <button
                  className={`flex-1 py-2.5 font-bold text-sm border-b-2 transition-all flex items-center justify-center gap-1.5 ${
                    drawerTab === "screencasts"
                      ? "border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400"
                      : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                  }`}
                  onClick={() => setDrawerTab("screencasts")}
                >
                  Screencasts
                  <span className="bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded text-[10px] text-slate-500 font-semibold border border-slate-200/50 dark:border-slate-700/50">
                    {drawerScreenshots.length}
                  </span>
                </button>
              </div>

              {/* Tab Content 1: Overview */}
              {drawerTab === "overview" && (
                <div className="space-y-3">
                  {selectedInterval && (
                    <div className="flex items-center justify-between bg-indigo-50 border border-indigo-100 rounded-lg p-2.5 text-xs text-indigo-800 dark:bg-indigo-950/20 dark:border-indigo-900 dark:text-indigo-400">
                      <span className="font-semibold">Filtered to interval: {formatHoursRange(selectedInterval.start, selectedInterval.end)}</span>
                      <button
                        className="text-[10px] hover:underline font-bold text-indigo-600 dark:text-indigo-400"
                        onClick={() => setSelectedInterval(null)}
                      >
                        Reset Filter
                      </button>
                    </div>
                  )}

                  <div className="space-y-3">
                    <h5 className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest flex items-center gap-1.5 px-1">
                      <Monitor className="h-3.5 w-3.5 text-indigo-500" /> Daily Application Breakdown
                    </h5>
                    <div className="grid grid-cols-1 gap-1 px-1">
                      {(() => {
                        const appStats = drawerStats.logs
                          .filter(l => l.type !== "idle")
                          .reduce((acc, log) => {
                            const app = getAppTitle(log.processName, log.windowTitle);
                            acc[app] = (acc[app] || 0) + log.durationSeconds;
                            return acc;
                          }, {} as Record<string, number>);

                        return Object.entries(appStats)
                          .sort((a, b) => b[1] - a[1])
                          .slice(0, 10)
                          .map(([app, seconds]) => (
                            <div key={app} className="flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-slate-100/50 dark:border-slate-700/30 group hover:border-indigo-200 dark:hover:border-indigo-900 transition-all">
                              <div className="flex items-center gap-2">
                                <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 opacity-60 group-hover:opacity-100" />
                                <span className="text-xs font-bold text-slate-700 dark:text-slate-300 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">{app}</span>
                              </div>
                              <span className="text-xs font-extrabold text-slate-900 dark:text-white font-mono bg-white dark:bg-slate-900 px-2 py-0.5 rounded shadow-sm border border-slate-100 dark:border-slate-800">
                                {formatDuration(seconds)}
                              </span>
                            </div>
                          ));
                      })()}
                    </div>
                  </div>

                  <div className="border border-slate-100 dark:border-slate-800 rounded-xl overflow-hidden divide-y divide-slate-100 dark:divide-slate-800 bg-white dark:bg-slate-900 shadow-sm">
                    {drawerIntervals.map((interval, idx) => (
                      <React.Fragment key={idx}>
                        <div
                          onClick={() => {
                            setSelectedInterval(interval);
                            setSelectedSlotIndex(null);
                            if (interval.type === "working") {
                              setDrawerTab("screencasts");
                            }
                          }}
                          className={`p-4 transition-colors flex items-center justify-between ${
                            interval.type === "working"
                              ? "hover:bg-slate-50/50 dark:hover:bg-slate-800/10 cursor-pointer"
                              : "bg-slate-50/30 dark:bg-slate-900/10"
                          } ${selectedInterval?.start.getTime() === interval.start.getTime() ? "bg-indigo-50/50 dark:bg-indigo-950/10" : ""}`}
                        >
                          <div className="flex items-center gap-3">
                            <span
                              className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                                interval.type === "working" ? "bg-emerald-500" : "bg-slate-300"
                              }`}
                            />
                            <div>
                              <p className="font-semibold text-slate-800 dark:text-slate-200 text-sm">
                                {formatHoursRange(interval.start, interval.end)}
                              </p>
                              <div className="flex items-center gap-2 mt-0.5">
                                <p className="text-xs text-slate-400">
                                  Duration: {formatDuration(interval.durationSeconds)}
                                </p>
                                {interval.type === "working" && interval.logs.length > 0 && (
                                  <>
                                    <span className="w-1 h-1 rounded-full bg-slate-200 dark:bg-slate-700" />
                                    <p 
                                      className="text-[10px] font-bold text-indigo-500/80 dark:text-indigo-400/80 truncate max-w-[200px] cursor-help"
                                      title={Array.from(new Set(interval.logs.map(l => getAppTitle(l.processName, l.windowTitle)))).join(", ")}
                                    >
                                      {Array.from(new Set(interval.logs.map(l => getAppTitle(l.processName, l.windowTitle)))).slice(0, 3).join(", ")}
                                      {new Set(interval.logs.map(l => getAppTitle(l.processName, l.windowTitle))).size > 3 && " ..."}
                                    </p>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-3">
                            <div className="flex items-center gap-2">
                              <Badge
                                className={`text-xs px-2 py-0.5 rounded-md font-semibold select-none capitalize ${
                                  interval.type === "working"
                                    ? "bg-emerald-50 text-emerald-700 border border-emerald-100 dark:bg-emerald-950/20 dark:text-emerald-400 dark:border-transparent"
                                    : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                                }`}
                              >
                                {interval.type === "working" ? "On computer" : "Not working"}
                              </Badge>
                            {interval.type === "working" && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (selectedInterval?.start.getTime() === interval.start.getTime()) {
                                    setSelectedInterval(null);
                                  } else {
                                    setSelectedInterval(interval);
                                    setSelectedSlotIndex(null);
                                  }
                                }}
                                className={`p-1.5 rounded-md transition-all ${
                                  selectedInterval?.start.getTime() === interval.start.getTime() 
                                    ? "bg-indigo-600 text-white shadow-md shadow-indigo-500/20" 
                                    : "bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/50"
                                }`}
                                title="View detailed breakdown"
                              >
                                <LayoutDashboard className="h-3.5 w-3.5" />
                              </button>
                            )}
                            <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform ${selectedInterval?.start.getTime() === interval.start.getTime() ? "rotate-180" : "-rotate-90"}`} />
                            </div>
                          </div>
                        </div>

                        {selectedInterval?.start.getTime() === interval.start.getTime() && interval.type === "working" && (
                          <div className="p-4 bg-slate-50/30 dark:bg-slate-900/10 border-t border-slate-100 dark:border-slate-800 animate-in slide-in-from-top-2 duration-200">
                            <Card className="border-slate-200 dark:border-slate-800 shadow-xl shadow-slate-200/50 dark:shadow-none bg-white dark:bg-slate-900 overflow-hidden relative">
                              <button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedInterval(null);
                                }}
                                className="absolute top-3 right-3 p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition-all z-10"
                              >
                                <X className="h-4 w-4" />
                              </button>
                              
                              <CardHeader className="p-4 pb-2 bg-slate-50/50 dark:bg-slate-800/40">
                                <CardTitle className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest flex items-center gap-2">
                                  <TrendingUp className="h-3 w-3 text-indigo-500" /> Session Detail Activity
                                </CardTitle>
                              </CardHeader>

                              <CardContent className="p-4 pt-2 space-y-5">
                                {/* Page breakdown */}
                                <div className="space-y-2">
                                  {Object.entries(
                                    interval.logs.reduce((acc, log) => {
                                      const name = log.windowTitle || log.processName || "System";
                                      acc[name] = (acc[name] || 0) + log.durationSeconds;
                                      return acc;
                                    }, {} as Record<string, number>)
                                  )
                                    .sort((a, b) => b[1] - a[1])
                                    .slice(0, 10)
                                    .map(([name, seconds]) => (
                                      <div key={name} className="flex items-start justify-between gap-3 text-[11px] group">
                                        <div className="flex gap-2 min-w-0">
                                          <div className="w-1 h-1 rounded-full bg-indigo-500 mt-1.5 shrink-0 opacity-40 group-hover:opacity-100" />
                                          <span className="text-slate-600 dark:text-slate-300 truncate font-medium group-hover:text-slate-900 dark:group-hover:text-white transition-colors" title={name}>
                                            {name}
                                          </span>
                                        </div>
                                        <span className="font-bold text-indigo-600 dark:text-indigo-400 shrink-0 font-mono">
                                          {formatDuration(seconds)}
                                        </span>
                                      </div>
                                    ))}
                                </div>

                                <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-between items-center bg-slate-50/30 -mx-4 -mb-4 p-3 px-4">
                                  <span className="text-[10px] font-bold text-slate-400 uppercase">Total Logged Time</span>
                                  <span className="text-xs font-black text-slate-900 dark:text-white">{formatDuration(interval.durationSeconds)}</span>
                                </div>
                              </CardContent>
                            </Card>
                          </div>
                        )}
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              )}

              {/* Tab Content 2: Screencasts */}
              {drawerTab === "screencasts" && (
                <div className="space-y-4">
                  {selectedSlotIndex !== null && (
                    <div className="flex items-center justify-between bg-indigo-50 border border-indigo-100 rounded-lg p-2.5 text-xs text-indigo-800 dark:bg-indigo-950/20 dark:border-indigo-900 dark:text-indigo-400 shadow-sm">
                      <span className="font-bold flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-ping" />
                        Viewing 10-Minute block: {formatSlotRangeLabel(selectedSlotIndex)}
                      </span>
                      <button
                        className="text-[10px] hover:underline font-bold text-indigo-600 dark:text-indigo-400"
                        onClick={() => setSelectedSlotIndex(null)}
                      >
                        Show All Screencasts
                      </button>
                    </div>
                  )}

                  {selectedInterval && (
                    <div className="flex items-center justify-between bg-indigo-50 border border-indigo-100 rounded-lg p-2.5 text-xs text-indigo-800 dark:bg-indigo-950/20 dark:border-indigo-900 dark:text-indigo-400 shadow-sm">
                      <span className="font-bold flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-ping" />
                        Viewing {formatHoursRange(selectedInterval.start, selectedInterval.end)}
                      </span>
                      <button
                        className="text-[10px] hover:underline font-bold text-indigo-600 dark:text-indigo-400"
                        onClick={() => setSelectedInterval(null)}
                      >
                        Show All Screencasts
                      </button>
                    </div>
                  )}

                  {drawerScreenshots.length === 0 ? (
                    <div className="text-center py-16 text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded-2xl">
                      <Camera className="h-10 w-10 mx-auto mb-3 opacity-30 text-indigo-500" />
                      <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">No Captures Registered</p>
                      <p className="text-xs max-w-xs mx-auto text-slate-400 mt-1">There are no screenshots for this specific timeframe.</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-4.5">
                      {drawerScreenshots.map((shot) => {
                        const { kbVal, mouseVal } = getMockActivity(shot.id);
                        return (
                          <Card
                            key={shot.id}
                            className="border-none shadow-sm rounded-xl overflow-hidden hover:shadow-md cursor-pointer group bg-slate-50 dark:bg-slate-800/30 border border-slate-100 dark:border-slate-800"
                            onClick={() => setLightbox(shot.id)}
                          >
                            <div className="relative aspect-video bg-slate-950 overflow-hidden">
                              <img
                                src={shot.thumbnail}
                                alt="Screencast"
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                              />
                              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                <span className="bg-white text-slate-900 text-[10px] font-bold px-3 py-1.5 rounded-md flex items-center gap-1 shadow">
                                  <Eye className="h-3 w-3" /> View Large
                                </span>
                              </div>
                            </div>

                            {/* Screenshot Footer details containing mouse and keyboard indicators */}
                            <div className="p-3 bg-white dark:bg-slate-900 space-y-2 border-t border-slate-50 dark:border-slate-800/40">
                              <div className="flex justify-between items-center text-xs text-slate-500 select-none">
                                <span className="font-semibold text-slate-800 dark:text-slate-300">
                                  {new Date(shot.capturedAt).toLocaleTimeString([], {
                                    hour: "numeric",
                                    minute: "2-digit",
                                  })}
                                </span>
                                <span className="text-[10px] font-medium text-slate-400">
                                  {shot.fileSizeKb} KB
                                </span>
                              </div>

                              {/* Keyboard activity mini-graph bar */}
                              <div className="space-y-1">
                                <div className="flex items-center justify-between text-[9px] text-slate-400 font-semibold">
                                  <span className="flex items-center gap-1"><Keyboard className="h-2.5 w-2.5" /> Key Inputs</span>
                                  <span>{kbVal}%</span>
                                </div>
                                <div className="w-full bg-slate-100 dark:bg-slate-800 h-1.5 rounded-full overflow-hidden">
                                  <div className="bg-emerald-500 h-full rounded-full" style={{ width: `${kbVal}%` }} />
                                </div>
                              </div>

                              {/* Mouse activity mini-graph bar */}
                              <div className="space-y-1">
                                <div className="flex items-center justify-between text-[9px] text-slate-400 font-semibold">
                                  <span className="flex items-center gap-1"><MousePointer className="h-2.5 w-2.5" /> Mouse Clicks</span>
                                  <span>{mouseVal}%</span>
                                </div>
                                <div className="w-full bg-slate-100 dark:bg-slate-800 h-1.5 rounded-full overflow-hidden">
                                  <div className="bg-indigo-500 h-full rounded-full" style={{ width: `${mouseVal}%` }} />
                                </div>
                              </div>
                            </div>
                          </Card>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Lightbox full-size Viewer */}
      {lightboxShot && (
        <div
          className="fixed inset-0 bg-black/85 z-50 flex items-center justify-center p-4 cursor-zoom-out animate-in fade-in duration-200"
          onClick={() => setLightbox(null)}
        >
          <div
            className="bg-white dark:bg-slate-950 rounded-2xl shadow-2xl max-w-4xl w-full overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4.5 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900">
              <div>
                <h3 className="font-bold text-slate-900 dark:text-white">{lightboxShot.deviceName}</h3>
                <p className="text-xs text-slate-500">{lightboxShot.userName} · {new Date(lightboxShot.capturedAt).toLocaleString()}</p>
              </div>
              <button
                className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
                onClick={() => setLightbox(null)}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="bg-slate-950 p-2 flex items-center justify-center min-h-[50vh] max-h-[70vh]">
              <img
                src={lightboxShot.thumbnail}
                alt="Screencast large"
                className="w-full h-full object-contain max-h-[68vh]"
              />
            </div>
            <div className="p-4 flex justify-between items-center text-xs text-slate-500 bg-slate-50/50 dark:bg-slate-900">
              <span>File size: {lightboxShot.fileSizeKb} KB</span>
              <Badge variant="outline" className="border-indigo-200 dark:border-indigo-900 text-indigo-600 dark:text-indigo-400 font-semibold bg-indigo-50 dark:bg-indigo-950/20">
                Verified Capture
              </Badge>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

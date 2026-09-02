import React, { useMemo, useState } from "react";
import {
  useGetActivityRange,
  getGetActivityRangeQueryKey,
  useListScreenshots,
  getListScreenshotsQueryKey,
  useListDevices,
  useListCategories,
  type DeviceItem,
  type ActivityLogRecord,
  type CategoryItem,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { format } from "date-fns";
import {
  Search,
  MonitorSmartphone,
  LayoutGrid,
  Camera,
  ChevronRight,
  ExternalLink,
} from "lucide-react";
import { useGroupFilter, ALL_GROUPS as ALL } from "@/hooks/use-group-filter";
import { useOrgTimezone } from "@/hooks/use-org-timezone";
import { useDateRange, rangeBoundsIso, todayStr } from "@/hooks/use-date-filter";
import { DateRangeFilter } from "@/components/DateFilter";
import { ScreenshotLightbox } from "@/components/ScreenshotLightbox";
import { deviceWallDate, formatDeviceTime, resolveDeviceOffset } from "@/lib/device-time";
import { ViewToggle, useViewMode } from "@/components/ViewToggle";

/* ----------------------------- types & helpers ---------------------------- */

type Classification = "productive" | "unproductive" | "neutral" | "undefined";

const SLOT_MINUTES = 10;
const SLOTS_PER_DAY = (24 * 60) / SLOT_MINUTES; // 144

interface DeviceAgg {
  activeSeconds: number;
  totalSeconds: number;
  startedAt: Date | null;
  endedAt: Date | null;
  currentApp: string | null;
  currentAppAt: number;
  appTotals: Map<string, number>;
  appClass: Map<string, Classification>;
  slots: Uint8Array; // 0 none, 1 productive, 2 unproductive, 3 neutral, 4 undefined
  slotActiveSeconds: Uint16Array;
  slotBreakSeconds: Uint16Array;
}

function emptyAgg(): DeviceAgg {
  return {
    activeSeconds: 0,
    totalSeconds: 0,
    startedAt: null,
    endedAt: null,
    currentApp: null,
    currentAppAt: 0,
    appTotals: new Map(),
    appClass: new Map(),
    slots: new Uint8Array(SLOTS_PER_DAY),
    slotActiveSeconds: new Uint16Array(SLOTS_PER_DAY),
    slotBreakSeconds: new Uint16Array(SLOTS_PER_DAY),
  };
}

function classCode(c: Classification): number {
  if (c === "productive") return 1;
  if (c === "unproductive") return 2;
  if (c === "neutral") return 3;
  return 4;
}

/** Tailwind bg for a daily-activity slot. */
function slotColor(code: number): string {
  switch (code) {
    case 1:
      return "bg-emerald-500";
    case 2:
      return "bg-amber-500";
    case 3:
      return "bg-sky-400";
    case 4:
      return "bg-slate-400";
    case 5:
      return "bg-slate-400 dark:bg-slate-500";
    default:
      return "bg-slate-100 dark:bg-slate-800";
  }
}

/** Dot color for the per-app breakdown / classification. */
function classDot(c: Classification): string {
  switch (c) {
    case "productive":
      return "bg-emerald-500";
    case "unproductive":
      return "bg-amber-500";
    case "neutral":
      return "bg-sky-400";
    default:
      return "bg-slate-400";
  }
}

/** Hours+minutes, seconds dropped (e.g. 2h 7m, 36m, 0m). */
function formatHm(seconds: number): string {
  if (!seconds || seconds < 0) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Full duration with seconds when under an hour (e.g. 1h 19m, 14m 22s, 6s). */
function formatHms(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${sec}s`;
}

/**
 * Display name for the "User" column: the device's assigned Label (from its
 * enrollment token — same as the Devices table's Label column), falling back
 * to the system hostname when no label is configured.
 */
function userNameOf(device: { tokenLabel?: string | null; systemName: string }): string {
  return device.tokenLabel?.trim() || device.systemName;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function minutesIntoDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Wall-clock seconds covered by the UNION of [start, end] intervals. When more
 * than one agent instance runs on a PC they log the same time concurrently, so a
 * naive sum of durations double-counts; merging the intervals yields the real
 * covered time. Mirrors the server-side `coveredSecondsByKey`.
 */
function mergedCoveredSeconds(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i]!;
    if (s > curEnd) {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  total += curEnd - curStart;
  return Math.round(total / 1000);
}

/**
 * Aggregate one device's day of logs. When the device has reported its
 * wall-clock offset (`tzOffsetMinutes`), all day bucketing, slot placement and
 * the start/end display dates use the *device's* wall time instead of the
 * viewer's browser timezone (durations are unaffected by the constant shift).
 */
function aggregateLogs(
  logs: ActivityLogRecord[],
  classOf: (log: ActivityLogRecord) => Classification,
  tzOffsetMinutes?: number | null,
  fallbackZone?: string | null,
): DeviceAgg {
  const agg = emptyAgg();
  // Naive sums; corrected for overlapping duplicate-agent logs after the loop.
  let naiveTotal = 0;
  let naiveActive = 0;
  const intervals: Array<[number, number]> = [];
  // First→last span is keyed per local day so multi-day ranges sum daily spans
  // instead of one giant span across overnight gaps (mirrors the server, which
  // keys span by device+day). day -> [minStartMs, maxEndMs].
  const dayBounds = new Map<string, [number, number]>();
  for (const log of logs) {
    // Resolve the offset per instant (org-tz fallback is DST-sensitive).
    const startedRaw = new Date(log.startedAt);
    const startOff = resolveDeviceOffset(startedRaw, tzOffsetMinutes, fallbackZone);
    const started = startOff == null ? startedRaw : deviceWallDate(startedRaw, startOff);
    const endedRaw = new Date(log.endedAt);
    const endOff = resolveDeviceOffset(endedRaw, tzOffsetMinutes, fallbackZone);
    const ended = endOff == null ? endedRaw : deviceWallDate(endedRaw, endOff);
    const cls = classOf(log);
    const duration = log.durationSeconds ?? 0;
    const idle = log.idleSeconds ?? 0;
    const active = Math.max(0, duration - idle);

    naiveTotal += duration;
    naiveActive += active;
    intervals.push([started.getTime(), ended.getTime()]);

    const dayKey = `${started.getFullYear()}-${started.getMonth()}-${started.getDate()}`;
    const bounds = dayBounds.get(dayKey);
    if (!bounds) {
      dayBounds.set(dayKey, [started.getTime(), ended.getTime()]);
    } else {
      if (started.getTime() < bounds[0]) bounds[0] = started.getTime();
      if (ended.getTime() > bounds[1]) bounds[1] = ended.getTime();
    }

    if (!agg.startedAt || started < agg.startedAt) agg.startedAt = started;
    if (!agg.endedAt || ended > agg.endedAt) agg.endedAt = ended;

    const startedMs = started.getTime();
    const endedMs = ended.getTime();
    if (startedMs >= agg.currentAppAt) {
      agg.currentAppAt = startedMs;
      agg.currentApp = log.processName;
    }

    agg.appTotals.set(
      log.processName,
      (agg.appTotals.get(log.processName) ?? 0) + duration,
    );
    // Record the most "important" classification we've seen for this app.
    const prev = agg.appClass.get(log.processName);
    if (!prev || classCode(cls) < classCode(prev)) {
      agg.appClass.set(log.processName, cls);
    }

    // Fill the 10-minute slots this log spans, treating [start, end) as a
    // half-open interval so a log ending exactly on a boundary doesn't bleed
    // into the next slot. Logs that run past local midnight fill through the
    // end of the day (the query only returns logs that *start* today).
    const sameDay =
      started.getFullYear() === ended.getFullYear() &&
      started.getMonth() === ended.getMonth() &&
      started.getDate() === ended.getDate();
    const startMin = minutesIntoDay(started);
    const endMin = sameDay ? minutesIntoDay(ended) : 24 * 60;
    const startSlot = Math.min(
      SLOTS_PER_DAY - 1,
      Math.max(0, Math.floor(startMin / SLOT_MINUTES)),
    );
    let endSlot = Math.ceil(endMin / SLOT_MINUTES) - 1;
    if (endSlot < startSlot) endSlot = startSlot; // zero-length log -> its slot
    endSlot = Math.min(SLOTS_PER_DAY - 1, endSlot);
    const code = classCode(cls);
    const idleRatio = duration > 0 ? Math.min(1, idle / duration) : 0;
    const localDayStart = new Date(started);
    localDayStart.setHours(0, 0, 0, 0);
    const localDayStartMs = localDayStart.getTime();
    for (let i = startSlot; i <= endSlot; i++) {
      const cur = agg.slots[i];
      // Lower code = higher precedence (productive wins), 0 = empty.
      if (cur === 0 || code < cur) agg.slots[i] = code;

      // idleSeconds is reported for the whole activity record, not as a list
      // of timestamps. Paint it proportionally within the record's covered
      // wall-clock slots so breaks remain visible without inventing positions.
      const slotStartMs = localDayStartMs + i * SLOT_MINUTES * 60 * 1000;
      const slotEndMs = slotStartMs + SLOT_MINUTES * 60 * 1000;
      const overlapSeconds = Math.max(
        0,
        Math.min(endedMs, slotEndMs) - Math.max(startedMs, slotStartMs),
      ) / 1000;
      if (overlapSeconds > 0) {
        const breakSeconds = overlapSeconds * idleRatio;
        const activeSeconds = overlapSeconds - breakSeconds;
        agg.slotBreakSeconds[i] = Math.min(
          SLOT_MINUTES * 60,
          agg.slotBreakSeconds[i]! + Math.round(breakSeconds),
        );
        agg.slotActiveSeconds[i] = Math.min(
          SLOT_MINUTES * 60,
          agg.slotActiveSeconds[i]! + Math.round(activeSeconds),
        );
      }
    }
  }

  // Mark gaps between the first and last recorded session as breaks. A log only
  // stores its total idleSeconds, not timestamps for each idle interval, so the
  // exact position of within-session idle cannot be reconstructed. The explicit
  // break metric below remains authoritative for the complete idle duration.
  for (const [minStart, maxEnd] of dayBounds.values()) {
    const start = new Date(minStart);
    const end = new Date(maxEnd);
    const startSlot = Math.min(
      SLOTS_PER_DAY - 1,
      Math.max(0, Math.floor(minutesIntoDay(start) / SLOT_MINUTES)),
    );
    const endSlot = Math.min(
      SLOTS_PER_DAY - 1,
      Math.max(0, Math.ceil(minutesIntoDay(end) / SLOT_MINUTES) - 1),
    );
    for (let i = startSlot; i <= endSlot; i++) {
      if (agg.slots[i] === 0) {
        agg.slots[i] = 5;
        agg.slotBreakSeconds[i] = SLOT_MINUTES * 60;
      }
    }
  }

  // Total time is the first→last span of the day (first push to last upload),
  // so it includes the gaps between sessions. Active time is the overlap-merged
  // foreground coverage (duplicate-agent overlap removed), scaled by the same
  // ratio. With no overlap and no gaps, covered === naiveTotal === span and both
  // values are unchanged.
  const covered = mergedCoveredSeconds(intervals);
  const cappedCovered = naiveTotal > 0 ? Math.min(covered, naiveTotal) : 0;
  let span = 0;
  for (const [minStart, maxEnd] of dayBounds.values()) {
    span += Math.max(0, Math.round((maxEnd - minStart) / 1000));
  }
  const ratio = naiveTotal > 0 ? cappedCovered / naiveTotal : 0;
  agg.totalSeconds = Math.max(span, cappedCovered);
  agg.activeSeconds = Math.min(cappedCovered, Math.round(naiveActive * ratio));
  return agg;
}

/* ------------------------------ slot bar --------------------------------- */

// Anchored to the full local day so the labels line up with the slot positions
// (justify-between spreads N labels across the bar: 0h→left edge, 24h→right edge).
const HOUR_TICKS = [0, 6, 12, 18, 24];

function tickLabel(hour: number): string {
  const h = hour % 24; // 24 -> 0 (midnight)
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${h < 12 ? "AM" : "PM"}`;
}

function ActivitySlots({
  slots,
  activeSeconds,
  breakSeconds,
}: {
  slots: Uint8Array;
  activeSeconds: Uint16Array;
  breakSeconds: Uint16Array;
}) {
  return (
    <div className="min-w-[260px]">
      <div
        className="flex h-7 items-stretch overflow-hidden rounded-md bg-slate-100 p-px dark:bg-slate-800"
        title="Green shows active time. Gray shows reported idle time or gaps between sessions."
      >
        {Array.from(slots).map((code, i) => (
          (() => {
            const active = activeSeconds[i] ?? 0;
            const reportedBreak = breakSeconds[i] ?? 0;
            const fullSlotSeconds = SLOT_MINUTES * 60;
            const paintedSeconds = active + reportedBreak;
            const scale =
              paintedSeconds > fullSlotSeconds
                ? fullSlotSeconds / paintedSeconds
                : 1;
            const activeWidth = active * scale;
            const breakWidth = reportedBreak * scale;
            const isGap = code === 5 && activeWidth === 0 && breakWidth === 0;
            const visibleBreakWidth = isGap ? fullSlotSeconds : breakWidth;
            const label =
              activeWidth > 0 && visibleBreakWidth > 0
                ? `${Math.round(activeWidth)}s active, ${Math.round(visibleBreakWidth)}s break`
                : visibleBreakWidth > 0
                  ? `${Math.round(visibleBreakWidth)}s break`
                  : activeWidth > 0
                    ? `${Math.round(activeWidth)}s active`
                    : "No activity";
            return (
              <div
                key={i}
                className="flex min-w-0 flex-1"
                title={`${label} · ${tickLabel(Math.floor((i * SLOT_MINUTES) / 60))}`}
                aria-label={label}
              >
                {activeWidth > 0 && (
                  <div
                    className={`h-full ${slotColor(code)}`}
                    style={{ width: `${(activeWidth / fullSlotSeconds) * 100}%` }}
                  />
                )}
                {visibleBreakWidth > 0 && (
                  <div
                    className="h-full bg-slate-400 dark:bg-slate-500"
                    style={{ width: `${(visibleBreakWidth / fullSlotSeconds) * 100}%` }}
                  />
                )}
              </div>
            );
          })()
        ))}
      </div>
      <div className="mt-1 flex justify-between px-px text-[10px] text-muted-foreground">
        {HOUR_TICKS.map((h) => (
          <span key={h}>{tickLabel(h)}</span>
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-3 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-emerald-500" />
          Active
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-slate-300 dark:bg-slate-600" />
          Break
        </span>
      </div>
    </div>
  );
}

/* ------------------------ session screenshot viewer ---------------------- */

/**
 * Screenshots are captured on a randomized cadence (up to 15 minutes between
 * captures per device settings), while activity sessions are often only
 * seconds or minutes long — an exact [startedAt, endedAt) window would
 * legitimately be empty for most sessions. Pad the query window by the max
 * capture interval so the modal always shows the captures taken around the
 * session whenever the agent was running; each thumbnail is labeled with its
 * capture time so admins can tell exact-window shots apart.
 */
const SESSION_SCREENSHOT_PAD_MS = 15 * 60 * 1000;

/**
 * Screenshots captured during (and around) one session's window for a given
 * device. The hook only runs while the dialog is open (Radix mounts
 * DialogContent children lazily), so we don't fetch for every session row.
 */
function SessionScreenshots({
  deviceId,
  from,
  to,
  tzOffsetMinutes,
  fallbackZone,
}: {
  deviceId: string;
  from: string;
  to: string;
  tzOffsetMinutes?: number | null;
  fallbackZone?: string | null;
}) {
  const params = { deviceId, from, to, limit: 100 };
  const { data: screenshots, isLoading } = useListScreenshots(params, {
    query: { queryKey: getListScreenshotsQueryKey(params) },
  });
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="aspect-video animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    );
  }

  if (!screenshots || screenshots.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
        <Camera className="mb-2 h-8 w-8 opacity-20" />
        No screenshots were captured around this session.
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {screenshots.map((shot, i) => (
          <button
            key={shot.id}
            type="button"
            onClick={() => setViewerIndex(i)}
            aria-label={`View screenshot from ${formatDeviceTime(shot.capturedAt, tzOffsetMinutes, "PPpp", fallbackZone)}`}
            className={`group cursor-pointer overflow-hidden rounded-lg border bg-card text-left shadow-sm transition-all hover:shadow-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
              shot.flagged
                ? "border-amber-500 ring-1 ring-amber-500/40"
                : "border-border"
            }`}
          >
            <div className="relative aspect-video overflow-hidden bg-secondary">
              <img
                src={shot.imageUrl}
                alt="Screenshot"
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                loading="lazy"
              />
              {shot.flagged && (
                <div className="absolute left-2 top-2 rounded-md bg-amber-500 px-2 py-0.5 text-[10px] font-medium text-white">
                  Flagged
                </div>
              )}
            </div>
            <div className="border-t px-3 py-2 text-xs text-muted-foreground">
              {formatDeviceTime(shot.capturedAt, tzOffsetMinutes, "h:mm:ss a", fallbackZone)}
            </div>
          </button>
        ))}
      </div>
      <ScreenshotLightbox
        screenshots={screenshots}
        tzOffsetFor={() => tzOffsetMinutes}
        fallbackZone={fallbackZone}
        index={viewerIndex ?? 0}
        onIndexChange={setViewerIndex}
        open={viewerIndex !== null}
        onOpenChange={(o) => {
          if (!o) setViewerIndex(null);
        }}
      />
    </>
  );
}

/* --------------------------- detail slide-over --------------------------- */

function DeviceActivityPanel({
  device,
  logs,
  classOf,
}: {
  device: DeviceItem;
  logs: ActivityLogRecord[];
  classOf: (log: ActivityLogRecord) => Classification;
}) {
  const orgZone = useOrgTimezone();
  const tzOffset = device.tzOffsetMinutes ?? null;
  const { appBreakdown, sessions } = useMemo(() => {
    const totals = new Map<string, { seconds: number; cls: Classification }>();
    for (const log of logs) {
      const cls = classOf(log);
      const existing = totals.get(log.processName);
      if (existing) {
        existing.seconds += log.durationSeconds ?? 0;
        if (classCode(cls) < classCode(existing.cls)) existing.cls = cls;
      } else {
        totals.set(log.processName, {
          seconds: log.durationSeconds ?? 0,
          cls,
        });
      }
    }
    const breakdown = Array.from(totals.entries())
      .map(([processName, v]) => ({ processName, ...v }))
      .sort((a, b) => b.seconds - a.seconds);

    // Most recent first for the session timeline.
    const ordered = [...logs].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
    return { appBreakdown: breakdown, sessions: ordered };
  }, [logs, classOf]);

  function isWorking(log: ActivityLogRecord): boolean {
    const active = (log.durationSeconds ?? 0) - (log.idleSeconds ?? 0);
    return active > 0 && classOf(log) !== "unproductive";
  }

  return (
    <>
      <SheetHeader className="border-b pb-4">
        <div className="flex items-center gap-3">
          <Avatar className="h-10 w-10">
            <AvatarFallback className="bg-primary/10 text-primary font-semibold">
              {initialsOf(userNameOf(device))}
            </AvatarFallback>
          </Avatar>
          <div>
            <SheetTitle className="text-lg leading-tight">
              {userNameOf(device)}
            </SheetTitle>
            <div className="mt-0.5 flex items-center gap-1.5 text-sm">
              <span
                className={`h-2 w-2 rounded-full ${
                  device.online ? "bg-emerald-500" : "bg-muted-foreground/40"
                }`}
              />
              <span
                className={
                  device.online
                    ? "text-emerald-600 dark:text-emerald-500 font-medium"
                    : "text-muted-foreground"
                }
              >
                {device.online ? "Tracking" : "Offline"}
              </span>
            </div>
          </div>
        </div>
      </SheetHeader>

      <ScrollArea className="min-h-0 min-w-0 flex-1 overflow-x-hidden">
        <div className="py-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <LayoutGrid className="h-3.5 w-3.5" />
            Daily Application Breakdown
          </div>
          {appBreakdown.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              No application activity recorded.
            </p>
          ) : (
            <div className="mt-3 space-y-0.5">
              {appBreakdown.map((app) => (
                <div
                  key={app.processName}
                  className="flex items-center justify-between rounded-md px-2 py-2 text-sm hover:bg-accent/40"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${classDot(app.cls)}`}
                    />
                    <span className="truncate">{app.processName}</span>
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {formatHms(app.seconds)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="pb-6">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Session Timeline
          </div>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sessions recorded.</p>
          ) : (
            <div className="space-y-2">
              {sessions.map((log) => {
                const working = isWorking(log);
                return (
                  <Dialog key={log.id}>
                    <div className="overflow-hidden rounded-lg border bg-card transition-colors hover:bg-accent/40">
                    <DialogTrigger asChild>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-2 p-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 text-sm">
                            <span className="font-medium">
                              {formatDeviceTime(log.startedAt, tzOffset, "h:mm a", orgZone)}
                            </span>
                            <span className="text-muted-foreground">—</span>
                            <span className="font-medium">
                              {formatDeviceTime(log.endedAt, tzOffset, "h:mm a", orgZone)}
                            </span>
                          </div>
                          <div className="mt-0.5 truncate text-xs text-muted-foreground">
                            {log.processName}
                            {log.windowTitle ? ` · ${log.windowTitle}` : ""}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                            <span>
                              Duration: {formatHms(log.durationSeconds ?? 0)}
                            </span>
                            <span className="text-muted-foreground/50">·</span>
                            <span className="inline-flex items-center gap-1 text-primary">
                              <Camera className="h-3 w-3" />
                              View screenshots
                            </span>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Badge
                            variant="secondary"
                            className={
                              working
                                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                : "bg-muted text-muted-foreground"
                            }
                          >
                            {working ? "Working" : "Not Working"}
                          </Badge>
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </div>
                      </button>
                    </DialogTrigger>
                    {log.url && (
                      <div className="flex min-w-0 items-center gap-1 px-3 pb-3 text-xs">
                        <ExternalLink className="h-3 w-3 shrink-0 text-primary" />
                        <a
                          href={log.url}
                          target="_blank"
                          rel="noreferrer"
                          title={log.url}
                          aria-label={`Open ${log.url}`}
                          className="min-w-0 truncate text-primary hover:underline"
                        >
                          {log.url}
                        </a>
                      </div>
                    )}
                    </div>
                    <DialogContent className="max-w-4xl">
                      <DialogHeader>
                        <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
                          <Camera className="h-4 w-4" />
                          Screenshots ·{" "}
                          {formatDeviceTime(log.startedAt, tzOffset, "h:mm a", orgZone)} –{" "}
                          {formatDeviceTime(log.endedAt, tzOffset, "h:mm a", orgZone)}
                          <span className="text-sm font-normal text-muted-foreground">
                            {log.processName}
                          </span>
                        </DialogTitle>
                      </DialogHeader>
                      <ScrollArea className="max-h-[70vh] pr-2">
                        <SessionScreenshots
                          deviceId={log.deviceId}
                          from={new Date(new Date(log.startedAt).getTime() - SESSION_SCREENSHOT_PAD_MS).toISOString()}
                          to={new Date(new Date(log.endedAt).getTime() + SESSION_SCREENSHOT_PAD_MS).toISOString()}
                          tzOffsetMinutes={tzOffset}
                          fallbackZone={orgZone}
                        />
                      </ScrollArea>
                    </DialogContent>
                  </Dialog>
                );
              })}
            </div>
          )}
        </div>
      </ScrollArea>
    </>
  );
}

/* ------------------------------- page ------------------------------------ */

export default function ActivityLogs() {
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useViewMode("activity-logs");
  const [groupFilter, setGroupFilter] = useGroupFilter();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Shared, persisted date-range filter (browser-local). The query window is
  // the [start of `from` 00:00, start of day after `to` 00:00) interval.
  const [dateRange] = useDateRange();
  const { from, to } = useMemo(() => rangeBoundsIso(dateRange), [dateRange]);
  const isSingleDay = dateRange.from === dateRange.to;

  const { data: devices, isLoading: devicesLoading } = useListDevices();
  const orgZone = useOrgTimezone();
  const { data: categories } = useListCategories();
  const rangeParams = {
    from,
    to,
    group: groupFilter === ALL ? undefined : groupFilter,
  };
  const { data: logs, isLoading: logsLoading } = useGetActivityRange(rangeParams, {
    query: { queryKey: getGetActivityRangeQueryKey(rangeParams), refetchInterval: 30000 },
  });

  const classById = useMemo(() => {
    const map = new Map<string, Classification>();
    (categories as CategoryItem[] | undefined)?.forEach((c) =>
      map.set(c.id, c.classification as Classification),
    );
    return map;
  }, [categories]);

  const classOf = useMemo(() => {
    return (log: ActivityLogRecord): Classification =>
      (log.categoryId && classById.get(log.categoryId)) || "undefined";
  }, [classById]);

  const logsByDevice = useMemo(() => {
    const map = new Map<string, ActivityLogRecord[]>();
    logs?.forEach((log) => {
      const arr = map.get(log.deviceId);
      if (arr) arr.push(log);
      else map.set(log.deviceId, [log]);
    });
    return map;
  }, [logs]);

  const tzByDevice = useMemo(() => {
    const map = new Map<string, number | null>();
    devices?.forEach((d) => map.set(d.id, d.tzOffsetMinutes ?? null));
    return map;
  }, [devices]);

  const aggByDevice = useMemo(() => {
    const map = new Map<string, DeviceAgg>();
    logsByDevice.forEach((deviceLogs, deviceId) => {
      map.set(
        deviceId,
        aggregateLogs(deviceLogs, classOf, tzByDevice.get(deviceId), orgZone),
      );
    });
    return map;
  }, [logsByDevice, classOf, tzByDevice, orgZone]);

  const groups = useMemo(() => {
    const set = new Set<string>();
    devices?.forEach((d) => set.add(d.deviceGroup));
    return Array.from(set).sort();
  }, [devices]);

  const filteredDevices = useMemo(() => {
    return devices?.filter((d) => {
      const q = search.trim().toLocaleLowerCase();
      const searchableValues = [
        d.systemName,
        d.hardwareHash,
        d.assignedUsername,
        d.tokenEmployeeId,
        d.tokenLabel,
        d.deviceGroup,
        d.tokenRegion,
        d.osType,
      ];
      const matchesSearch =
        q === "" ||
        searchableValues.some((value) =>
          value?.toLocaleLowerCase().includes(q),
        );
      const matchesGroup = groupFilter === ALL || d.deviceGroup === groupFilter;
      return matchesSearch && matchesGroup;
    });
  }, [devices, search, groupFilter]);

  const selectedDevice = devices?.find((d) => d.id === selectedId) ?? null;
  const isLoading = devicesLoading || logsLoading;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Activity Logs</h1>
          <p className="mt-1 text-muted-foreground">
            {isSingleDay
              ? dateRange.to === todayStr()
                ? "Today's"
                : "Selected day's"
              : "Selected range's"}{" "}
            activity per user. Select a row for the full breakdown.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-end">
          <DateRangeFilter />
          <Select value={groupFilter} onValueChange={setGroupFilter}>
            <SelectTrigger className="w-full sm:w-44">
              <SelectValue placeholder="All groups" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All groups</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g} value={g}>
                  {g}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search user, device, label..."
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <ViewToggle mode={viewMode} onChange={setViewMode} />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-4 p-8 animate-pulse">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-14 rounded-md bg-muted" />
              ))}
            </div>
          ) : viewMode === "table" ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12 text-center">Status</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead className="text-right">Active Time</TableHead>
                  <TableHead className="text-right">Total Time</TableHead>
                  <TableHead className="text-right">Break Time</TableHead>
                  <TableHead className="text-center">Start</TableHead>
                  <TableHead className="text-center">End</TableHead>
                  <TableHead className="min-w-[280px]">
                    Daily Activity{" "}
                    <span className="font-normal text-muted-foreground">
                      {isSingleDay
                        ? "(10-min slots)"
                        : "(10-min slots, range overlaid on a 24h day)"}
                    </span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!filteredDevices || filteredDevices.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="h-32 text-center text-muted-foreground"
                    >
                      <div className="flex flex-col items-center justify-center">
                        <MonitorSmartphone className="mb-2 h-8 w-8 opacity-20" />
                        No users found.
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredDevices.map((device) => {
                    const agg = aggByDevice.get(device.id) ?? emptyAgg();
                    const topApps = Array.from(agg.appTotals.entries())
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 3)
                      .map(([name]) => name);
                    return (
                      <TableRow
                        key={device.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`View activity for ${userNameOf(device)}`}
                        className="cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        onClick={() => setSelectedId(device.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelectedId(device.id);
                          }
                        }}
                      >
                        <TableCell className="text-center">
                          <span
                            className={`inline-block h-2.5 w-2.5 rounded-full ${
                              device.online
                                ? "bg-emerald-500"
                                : "bg-muted-foreground/40"
                            }`}
                            aria-label={device.online ? "Online" : "Offline"}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <Avatar className="h-9 w-9">
                              <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                                {initialsOf(userNameOf(device))}
                              </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5 font-medium">
                                {userNameOf(device)}
                                {device.isLocked && (
                                  <Badge
                                    variant="destructive"
                                    className="text-[10px]"
                                  >
                                    Locked
                                  </Badge>
                                )}
                              </div>
                              <div className="mt-0.5 text-xs">
                                {device.online ? (
                                  <span className="text-emerald-600 dark:text-emerald-500">
                                    <span className="font-semibold">Tracking</span>
                                    {agg.currentApp ? (
                                      <span className="text-muted-foreground">
                                        {" "}
                                        · Using {agg.currentApp}
                                      </span>
                                    ) : null}
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground">
                                    Offline
                                  </span>
                                )}
                              </div>
                              {topApps.length > 0 && (
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {topApps.map((app) => (
                                    <Badge
                                      key={app}
                                      variant="secondary"
                                      className="px-1.5 py-0 text-[10px] font-normal uppercase"
                                    >
                                      {app}
                                    </Badge>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {formatHm(agg.activeSeconds)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {formatHm(agg.totalSeconds)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-amber-700 dark:text-amber-400">
                          {formatHm(Math.max(0, agg.totalSeconds - agg.activeSeconds))}
                        </TableCell>
                        <TableCell className="text-center tabular-nums text-muted-foreground">
                          {agg.startedAt ? format(agg.startedAt, "h:mm a") : "—"}
                        </TableCell>
                        <TableCell className="text-center tabular-nums text-muted-foreground">
                          {agg.endedAt ? format(agg.endedAt, "h:mm a") : "—"}
                        </TableCell>
                        <TableCell>
                          <ActivitySlots
                            slots={agg.slots}
                            activeSeconds={agg.slotActiveSeconds}
                            breakSeconds={agg.slotBreakSeconds}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          ) : !filteredDevices || filteredDevices.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center text-muted-foreground">
              <MonitorSmartphone className="mb-2 h-8 w-8 opacity-20" />
              No users found.
            </div>
          ) : (
            <div className="grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3">
              {filteredDevices.map((device) => {
                const agg = aggByDevice.get(device.id) ?? emptyAgg();
                const topApps = Array.from(agg.appTotals.entries())
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 3)
                  .map(([name]) => name);
                return (
                  <Card
                    key={device.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`View activity for ${userNameOf(device)}`}
                    className="cursor-pointer transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={() => setSelectedId(device.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedId(device.id);
                      }
                    }}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        <Avatar className="h-10 w-10">
                          <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                            {initialsOf(userNameOf(device))}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate font-semibold">{userNameOf(device)}</p>
                            {device.isLocked && <Badge variant="destructive" className="text-[10px]">Locked</Badge>}
                          </div>
                          <p className={`mt-0.5 text-xs ${device.online ? "text-emerald-600 dark:text-emerald-500" : "text-muted-foreground"}`}>
                            {device.online ? `Tracking${agg.currentApp ? ` · Using ${agg.currentApp}` : ""}` : "Offline"}
                          </p>
                        </div>
                        <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${device.online ? "bg-emerald-500" : "bg-muted-foreground/40"}`} aria-label={device.online ? "Online" : "Offline"} />
                      </div>
                      {topApps.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1">
                          {topApps.map((app) => <Badge key={app} variant="secondary" className="px-1.5 py-0 text-[10px] font-normal uppercase">{app}</Badge>)}
                        </div>
                      )}
                      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                        <div><p className="text-xs text-muted-foreground">Active time</p><p className="font-semibold tabular-nums">{formatHm(agg.activeSeconds)}</p></div>
                        <div><p className="text-xs text-muted-foreground">Total time</p><p className="tabular-nums text-muted-foreground">{formatHm(agg.totalSeconds)}</p></div>
                        <div><p className="text-xs text-muted-foreground">Break time</p><p className="tabular-nums text-amber-700 dark:text-amber-400">{formatHm(Math.max(0, agg.totalSeconds - agg.activeSeconds))}</p></div>
                        <div><p className="text-xs text-muted-foreground">Start</p><p className="tabular-nums">{agg.startedAt ? format(agg.startedAt, "h:mm a") : "—"}</p></div>
                        <div><p className="text-xs text-muted-foreground">End</p><p className="tabular-nums">{agg.endedAt ? format(agg.endedAt, "h:mm a") : "—"}</p></div>
                      </div>
                      <div className="mt-4">
                        <p className="mb-1 text-xs text-muted-foreground">Daily Activity {isSingleDay ? "(10-min slots)" : "(range overlaid on a 24h day)"}</p>
                        <ActivitySlots
                          slots={agg.slots}
                          activeSeconds={agg.slotActiveSeconds}
                          breakSeconds={agg.slotBreakSeconds}
                        />
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Sheet
        open={!!selectedDevice}
        onOpenChange={(open) => !open && setSelectedId(null)}
      >
        <SheetContent className="flex min-w-0 w-[min(100vw,720px)] max-w-none flex-col gap-0 overflow-hidden">
          {selectedDevice && (
            <DeviceActivityPanel
              device={selectedDevice}
              logs={logsByDevice.get(selectedDevice.id) ?? []}
              classOf={classOf}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

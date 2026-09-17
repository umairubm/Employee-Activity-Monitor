import type { ActivityLog, ProductivityClass } from "@workspace/db";

const SLOT_MINUTES = 10;
const SLOTS_PER_DAY = 144;

export interface ActivitySummary {
  deviceId: string;
  activeSeconds: number;
  passiveSeconds: number;
  idleStateSeconds: number;
  productiveSeconds: number;
  totalSeconds: number;
  startedAt: string | null;
  endedAt: string | null;
  currentApp: string | null;
  topApps: string[];
  slots: number[];
}

export type SummaryActivityLog = Pick<
  ActivityLog,
  | "deviceId"
  | "segmentId"
  | "processName"
  | "categoryId"
  | "engagementState"
  | "sessionState"
  | "startedAt"
  | "endedAt"
  | "durationSeconds"
  | "idleSeconds"
>;

function zoneOffsetMinutes(zone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const wallAsUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour") % 24,
      get("minute"),
      get("second"),
    );
    return Math.round((wallAsUtc - at.getTime()) / 60_000);
  } catch {
    return 0;
  }
}

function wallDate(at: Date, offset: number | null | undefined, fallbackZone: string): Date {
  const minutes = offset ?? zoneOffsetMinutes(fallbackZone, at);
  return new Date(at.getTime() + minutes * 60_000);
}

function mergedCoveredSeconds(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [start, end] = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const [nextStart, nextEnd] = sorted[i]!;
    if (nextStart > end) {
      total += Math.max(0, end - start);
      start = nextStart;
      end = nextEnd;
    } else {
      end = Math.max(end, nextEnd);
    }
  }
  return Math.round((total + Math.max(0, end - start)) / 1000);
}

function classCode(value: ProductivityClass): number {
  if (value === "productive") return 1;
  if (value === "unproductive") return 2;
  if (value === "neutral") return 3;
  return 4;
}

/** Slot code for a gap between recorded sessions (matches the dashboard legend). */
const BREAK_CODE = 5;

export function summarizeActivity(
  logs: SummaryActivityLog[],
  offsetByDevice: Map<string, number | null>,
  classById: Map<string, ProductivityClass>,
  fallbackZone: string,
): ActivitySummary[] {
  const byDevice = new Map<string, SummaryActivityLog[]>();
  for (const log of logs) {
    const rows = byDevice.get(log.deviceId);
    if (rows) rows.push(log);
    else byDevice.set(log.deviceId, [log]);
  }

  return Array.from(byDevice, ([deviceId, rows]) => {
    let naiveTotal = 0;
    let naiveActive = 0;
    let naivePassive = 0;
    let naiveIdle = 0;
    let naiveProductive = 0;
    let startedAt: Date | null = null;
    let endedAt: Date | null = null;
    let currentApp: string | null = null;
    let currentAppAt = 0;
    const intervals: Array<[number, number]> = [];
    const dayBounds = new Map<string, [number, number]>();
    // Wall-clock minute-of-day bounds per device-local day, used to shade the
    // gaps between the first and last recorded session as breaks.
    const dayWallBounds = new Map<string, [number, number]>();
    const appTotals = new Map<string, number>();
    const slots = new Array<number>(SLOTS_PER_DAY).fill(0);
    const offset = offsetByDevice.get(deviceId);

    for (const log of rows) {
      const startRaw = new Date(log.startedAt);
      const endRaw = new Date(log.endedAt);
      const startWall = wallDate(startRaw, offset, fallbackZone);
      const endWall = wallDate(endRaw, offset, fallbackZone);
      const duration = Math.max(0, log.durationSeconds ?? 0);
      const isInterval = Boolean(log.segmentId);
      const unlocked = (log.sessionState ?? "unlocked") === "unlocked";
      const engagement = log.engagementState ?? "active";
      const active = isInterval
        ? unlocked && engagement === "active" ? duration : 0
        : Math.max(0, duration - (log.idleSeconds ?? 0));
      const passive = isInterval && unlocked && engagement === "passive" ? duration : 0;
      const idle = isInterval
        ? !unlocked || engagement === "idle" ? duration : 0
        : Math.min(duration, log.idleSeconds ?? 0);
      const classification =
        (log.categoryId && classById.get(log.categoryId)) || "undefined";

      naiveTotal += duration;
      naiveActive += active;
      naivePassive += passive;
      naiveIdle += idle;
      if (classification === "productive") naiveProductive += active;
      intervals.push([startRaw.getTime(), endRaw.getTime()]);

      const dayKey = `${startWall.getUTCFullYear()}-${startWall.getUTCMonth()}-${startWall.getUTCDate()}`;
      const bounds = dayBounds.get(dayKey);
      if (bounds) {
        bounds[0] = Math.min(bounds[0], startRaw.getTime());
        bounds[1] = Math.max(bounds[1], endRaw.getTime());
      } else {
        dayBounds.set(dayKey, [startRaw.getTime(), endRaw.getTime()]);
      }

      if (!startedAt || startRaw < startedAt) startedAt = startRaw;
      if (!endedAt || endRaw > endedAt) endedAt = endRaw;
      if (startRaw.getTime() >= currentAppAt) {
        currentAppAt = startRaw.getTime();
        currentApp = log.processName;
      }
      appTotals.set(log.processName, (appTotals.get(log.processName) ?? 0) + duration);

      const startMinute = startWall.getUTCHours() * 60 + startWall.getUTCMinutes();
      const sameDay =
        startWall.getUTCFullYear() === endWall.getUTCFullYear() &&
        startWall.getUTCMonth() === endWall.getUTCMonth() &&
        startWall.getUTCDate() === endWall.getUTCDate();
      const endMinute = sameDay
        ? endWall.getUTCHours() * 60 + endWall.getUTCMinutes()
        : 24 * 60;
      const wallBounds = dayWallBounds.get(dayKey);
      if (wallBounds) {
        wallBounds[0] = Math.min(wallBounds[0], startMinute);
        wallBounds[1] = Math.max(wallBounds[1], endMinute);
      } else {
        dayWallBounds.set(dayKey, [startMinute, endMinute]);
      }
      const firstSlot = Math.min(143, Math.max(0, Math.floor(startMinute / SLOT_MINUTES)));
      const lastSlot = Math.min(
        143,
        Math.max(firstSlot, Math.ceil(endMinute / SLOT_MINUTES) - 1),
      );
      const code = classCode(classification);
      for (let slot = firstSlot; slot <= lastSlot; slot++) {
        if (slots[slot] === 0 || code < slots[slot]!) slots[slot] = code;
      }
    }

    for (const [minMinute, maxMinute] of dayWallBounds.values()) {
      const startSlot = Math.min(143, Math.max(0, Math.floor(minMinute / SLOT_MINUTES)));
      const endSlot = Math.min(143, Math.max(0, Math.ceil(maxMinute / SLOT_MINUTES) - 1));
      for (let slot = startSlot; slot <= endSlot; slot++) {
        if (slots[slot] === 0) slots[slot] = BREAK_CODE;
      }
    }

    let span = 0;
    for (const [minStart, maxEnd] of dayBounds.values()) {
      span += Math.max(0, Math.round((maxEnd - minStart) / 1000));
    }
    const covered = Math.min(mergedCoveredSeconds(intervals), naiveTotal);
    const ratio = naiveTotal > 0 ? covered / naiveTotal : 0;
    const activeSeconds = Math.min(covered, Math.round(naiveActive * ratio));
    const passiveSeconds = Math.min(
      Math.max(0, covered - activeSeconds),
      Math.round(naivePassive * ratio),
    );

    return {
      deviceId,
      activeSeconds,
      passiveSeconds,
      idleStateSeconds: Math.min(
        Math.max(0, covered - activeSeconds - passiveSeconds),
        Math.round(naiveIdle * ratio),
      ),
      productiveSeconds: Math.min(activeSeconds, Math.round(naiveProductive * ratio)),
      totalSeconds: Math.max(span, covered),
      startedAt: startedAt?.toISOString() ?? null,
      endedAt: endedAt?.toISOString() ?? null,
      currentApp,
      topApps: Array.from(appTotals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name]) => name),
      slots,
    };
  });
}
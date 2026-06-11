import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "dashboard.dateRange";
const EVENT_NAME = "date-range-change";

export interface DateRange {
  /** Inclusive start day, local "YYYY-MM-DD". */
  from: string;
  /** Inclusive end day, local "YYYY-MM-DD". */
  to: string;
}

/** Local "YYYY-MM-DD" string for today, in the browser's timezone. */
export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** Local "YYYY-MM-DD" string for `n` days before today. */
export function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function isValidDateStr(s: string): boolean {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  // Reject impossible calendar dates (e.g. 2026-02-30) via a round-trip check.
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** Normalize a candidate range: validate both ends and enforce from <= to. */
function normalize(range: Partial<DateRange> | null | undefined): DateRange {
  const today = todayStr();
  let from = range && isValidDateStr(range.from ?? "") ? range.from! : today;
  let to = range && isValidDateStr(range.to ?? "") ? range.to! : today;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

function readStored(): DateRange {
  if (typeof window === "undefined") return normalize(null);
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return normalize(null);
    return normalize(JSON.parse(raw) as Partial<DateRange>);
  } catch {
    return normalize(null);
  }
}

/**
 * Shared, persisted date-*range* filter for the date-aware dashboard pages.
 *
 * Mirrors {@link useGroupFilter}: the selected range (two local "YYYY-MM-DD"
 * strings, defaulting to today→today) is stored in localStorage so it survives
 * refreshes and stays in sync as the user moves between pages. A custom window
 * event keeps any mounted consumers in sync within the same tab; the native
 * `storage` event syncs across tabs.
 */
export function useDateRange(): [DateRange, (value: Partial<DateRange>) => void] {
  const [range, setRangeState] = useState<DateRange>(readStored);

  useEffect(() => {
    const sync = () => setRangeState(readStored());
    window.addEventListener(EVENT_NAME, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT_NAME, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const setRange = useCallback((value: Partial<DateRange>) => {
    setRangeState((prev) => {
      const next = normalize({ ...prev, ...value });
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage failures (e.g. private mode); in-memory state still works.
      }
      window.dispatchEvent(new Event(EVENT_NAME));
      return next;
    });
  }, []);

  return [range, setRange];
}

/**
 * Browser-local ISO instant bounds for a day range, as a half-open interval:
 * `[start of `from` 00:00, start of the day after `to` 00:00)`.
 */
export function rangeBoundsIso(range: DateRange): { from: string; to: string } {
  const [fy, fm, fd] = range.from.split("-").map(Number);
  const [ty, tm, td] = range.to.split("-").map(Number);
  const start = new Date(fy, fm - 1, fd, 0, 0, 0, 0);
  const end = new Date(ty, tm - 1, td + 1, 0, 0, 0, 0);
  return { from: start.toISOString(), to: end.toISOString() };
}

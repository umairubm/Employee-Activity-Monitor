import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "dashboard.dateFilter";
const EVENT_NAME = "date-filter-change";

/** Local "YYYY-MM-DD" string for today, in the browser's timezone. */
export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function isValidDateStr(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  // Reject impossible calendar dates (e.g. 2026-02-30) via a round-trip check.
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function readStored(): string {
  if (typeof window === "undefined") return todayStr();
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v && isValidDateStr(v) ? v : todayStr();
  } catch {
    return todayStr();
  }
}

/**
 * Shared, persisted single-day filter for the day-based dashboard pages.
 *
 * Mirrors {@link useGroupFilter}: the selected date (a local "YYYY-MM-DD"
 * string, defaulting to today) is stored in localStorage so it survives
 * refreshes and stays in sync as the user moves between pages. A custom window
 * event keeps any mounted consumers in sync within the same tab; the native
 * `storage` event syncs across tabs.
 */
export function useDateFilter(): [string, (value: string) => void] {
  const [date, setDateState] = useState<string>(readStored);

  useEffect(() => {
    const sync = () => setDateState(readStored());
    window.addEventListener(EVENT_NAME, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT_NAME, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const setDate = useCallback((value: string) => {
    const next = isValidDateStr(value) ? value : todayStr();
    setDateState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore storage failures (e.g. private mode); in-memory state still works.
    }
    window.dispatchEvent(new Event(EVENT_NAME));
  }, []);

  return [date, setDate];
}

/** Browser-local [from, to) ISO bounds for the given "YYYY-MM-DD" day. */
export function dayBoundsIso(dateStr: string): { from: string; to: string } {
  const [y, m, d] = dateStr.split("-").map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** Shift a "YYYY-MM-DD" day string by a number of days (can be negative). */
export function shiftDay(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(
    dt.getDate(),
  ).padStart(2, "0")}`;
}

import { useCallback, useEffect, useState } from "react";

export const ALL_GROUPS = "__all__";

const STORAGE_KEY = "dashboard.groupFilter";
const EVENT_NAME = "group-filter-change";

function readStored(): string {
  if (typeof window === "undefined") return ALL_GROUPS;
  try {
    return window.localStorage.getItem(STORAGE_KEY) || ALL_GROUPS;
  } catch {
    return ALL_GROUPS;
  }
}

/**
 * Shared, persisted "active team" filter for the group-aware dashboard pages.
 *
 * The selection is stored in localStorage so it survives page refreshes and is
 * shared across pages: navigating between Overview, Activity Logs, Screenshots
 * and Devices keeps the same team selected. A custom window event keeps any
 * mounted consumers in sync within the same tab.
 */
export function useGroupFilter(): [string, (value: string) => void] {
  const [groupFilter, setGroupFilterState] = useState<string>(readStored);

  useEffect(() => {
    const sync = () => setGroupFilterState(readStored());
    window.addEventListener(EVENT_NAME, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT_NAME, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const setGroupFilter = useCallback((value: string) => {
    setGroupFilterState(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Ignore storage failures (e.g. private mode); in-memory state still works.
    }
    window.dispatchEvent(new Event(EVENT_NAME));
  }, []);

  return [groupFilter, setGroupFilter];
}

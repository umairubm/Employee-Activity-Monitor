import React from "react";
import { Button } from "@/components/ui/button";
import { LayoutGrid, Table2 } from "lucide-react";

export type ViewMode = "table" | "cards";

/**
 * Per-table view preference persisted in localStorage, keyed by a stable
 * table id (e.g. "devices", "timesheets"). Table is always the default.
 */
export function useViewMode(tableId: string): [ViewMode, (v: ViewMode) => void] {
  const storageKey = `viewMode:${tableId}`;
  const [mode, setMode] = React.useState<ViewMode>(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      return stored === "cards" ? "cards" : "table";
    } catch {
      return "table";
    }
  });
  const set = React.useCallback(
    (v: ViewMode) => {
      setMode(v);
      try {
        window.localStorage.setItem(storageKey, v);
      } catch {
        // Ignore quota/privacy-mode failures; the toggle still works in-session.
      }
    },
    [storageKey],
  );
  return [mode, set];
}

/**
 * Accessible Table/Cards switcher used beside every data table's filters.
 */
export function ViewToggle({
  mode,
  onChange,
  label = "View",
}: {
  mode: ViewMode;
  onChange: (v: ViewMode) => void;
  label?: string;
}) {
  return (
    <div className="flex items-center self-end rounded-md border bg-background p-1" role="group" aria-label={label}>
      <Button
        type="button"
        size="sm"
        variant={mode === "table" ? "secondary" : "ghost"}
        className="h-8 gap-1.5 px-2.5"
        aria-pressed={mode === "table"}
        onClick={() => onChange("table")}
      >
        <Table2 className="h-4 w-4" />
        <span className="sr-only sm:not-sr-only">Table</span>
      </Button>
      <Button
        type="button"
        size="sm"
        variant={mode === "cards" ? "secondary" : "ghost"}
        className="h-8 gap-1.5 px-2.5"
        aria-pressed={mode === "cards"}
        onClick={() => onChange("cards")}
      >
        <LayoutGrid className="h-4 w-4" />
        <span className="sr-only sm:not-sr-only">Cards</span>
      </Button>
    </div>
  );
}

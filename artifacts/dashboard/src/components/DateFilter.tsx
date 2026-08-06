import { useState } from "react";
import { CalendarIcon, X } from "lucide-react";
import type { DateRange as DayPickerRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  useDateRange,
  todayStr,
  daysAgoStr,
  type DateRange,
} from "@/hooks/use-date-filter";

const PRESETS: { label: string; build: () => DateRange }[] = [
  { label: "Today", build: () => ({ from: todayStr(), to: todayStr() }) },
  {
    label: "Yesterday",
    build: () => ({ from: daysAgoStr(1), to: daysAgoStr(1) }),
  },
  { label: "7d", build: () => ({ from: daysAgoStr(6), to: todayStr() }) },
  { label: "30d", build: () => ({ from: daysAgoStr(29), to: todayStr() }) },
];

const PANEL_PRESETS: { label: string; build: () => DateRange }[] = [
  {
    label: "Today so far",
    build: () => ({ from: todayStr(), to: todayStr() }),
  },
  {
    label: "Yesterday",
    build: () => ({ from: daysAgoStr(1), to: daysAgoStr(1) }),
  },
  { label: "Last 7 days", build: () => ({ from: daysAgoStr(6), to: todayStr() }) },
  {
    label: "Last 30 days",
    build: () => ({ from: daysAgoStr(29), to: todayStr() }),
  },
  {
    label: "This month so far",
    build: () => {
      const today = fromDateStr(todayStr());
      return {
        from: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`,
        to: todayStr(),
      };
    },
  },
  {
    label: "Last month",
    build: () => {
      const today = fromDateStr(todayStr());
      const firstOfLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const lastOfLastMonth = new Date(
        today.getFullYear(),
        today.getMonth(),
        0,
      );
      return {
        from: toDateStr(firstOfLastMonth),
        to: toDateStr(lastOfLastMonth),
      };
    },
  },
  {
    label: "All time",
    build: () => ({ from: "1970-01-01", to: todayStr() }),
  },
];

/** Local "YYYY-MM-DD" for a Date (browser timezone). */
function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** Parse a local "YYYY-MM-DD" into a Date at local midnight. */
function fromDateStr(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatDisplay(s: string): string {
  return fromDateStr(s).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Shared date-*range* filter control used across the date-aware pages. Reads
 * and writes the persisted selection via {@link useDateRange}, so changing the
 * range on one page carries over to the others (and across tabs).
 *
 * The custom range is picked in a calendar popover with a draft selection:
 * nothing is applied (and no data refetches) until the user clicks Apply.
 * Quick presets apply immediately.
 */
export function DateRangeFilter() {
  const [range, setRange] = useDateRange();
  const [open, setOpen] = useState(false);
  // Draft selection inside the popover; committed only on Apply.
  const [draft, setDraft] = useState<DayPickerRange | undefined>(undefined);
  const [panelTab, setPanelTab] = useState("Custom");

  const today = fromDateStr(todayStr());

  const openPopover = (next: boolean) => {
    if (next) {
      // Seed the draft from the applied range each time the popover opens.
      setDraft({ from: fromDateStr(range.from), to: fromDateStr(range.to) });
      const matchingPreset = PANEL_PRESETS.find((preset) => {
        const target = preset.build();
        return target.from === range.from && target.to === range.to;
      });
      setPanelTab(matchingPreset?.label ?? "Custom");
    }
    setOpen(next);
  };

  const apply = () => {
    if (!draft?.from) return;
    const from = toDateStr(draft.from);
    const to = toDateStr(draft.to ?? draft.from);
    setRange({ from, to });
    setOpen(false);
  };

  const handleCalendarSelect = (next: DayPickerRange | undefined) => {
    setDraft(next);
    if (!next?.from) {
      setPanelTab("Custom");
      return;
    }
    const nextRange = {
      from: toDateStr(next.from),
      to: toDateStr(next.to ?? next.from),
    };
    const matchingPreset = PANEL_PRESETS.find((preset) => {
      const target = preset.build();
      return target.from === nextRange.from && target.to === nextRange.to;
    });
    setPanelTab(matchingPreset?.label ?? "Custom");
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex gap-1">
        {PRESETS.map((preset) => {
          const target = preset.build();
          const active = range.from === target.from && range.to === target.to;
          return (
            <button
              key={preset.label}
              type="button"
              onClick={() => setRange(target)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-background hover:bg-muted"
              }`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      <Popover open={open} onOpenChange={openPopover}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="h-9 justify-start gap-2 px-3 font-normal"
            aria-label="Select date range"
          >
            <CalendarIcon className="h-4 w-4 text-muted-foreground" />
            {range.from === range.to
              ? formatDisplay(range.from)
              : `${formatDisplay(range.from)} – ${formatDisplay(range.to)}`}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="flex max-h-[calc(100vh-1rem)] w-[calc(100vw-1rem)] max-w-[580px] flex-col overflow-hidden rounded-xl border-slate-200 bg-white p-0 shadow-xl dark:border-slate-800 dark:bg-slate-950"
          align="end"
          sideOffset={8}
        >
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <div>
              <div className="text-base font-medium tracking-tight text-slate-900 dark:text-slate-100">
                Date range
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                Choose a start date and an end date
              </div>
            </div>
            <button
              type="button"
              aria-label="Close date range picker"
              onClick={() => setOpen(false)}
              className="rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="flex min-h-0 flex-col overflow-hidden sm:flex-row">
            <aside className="w-full shrink-0 border-b border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-950 sm:w-40 sm:border-b-0 sm:border-r">
              <button
                type="button"
                onClick={() => {
                  setPanelTab("Custom");
                  setDraft({
                    from: fromDateStr(range.from),
                    to: fromDateStr(range.to),
                  });
                }}
                className={`mb-1 w-full rounded-r-md px-3 py-1.5 text-left text-xs font-medium transition-colors ${
                  panelTab === "Custom"
                    ? "bg-[#e8f0fe] text-slate-900 dark:bg-blue-950/60 dark:text-blue-100"
                    : "text-slate-700 hover:bg-blue-50 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-blue-950/40"
                }`}
              >
                Custom
              </button>
              <div className="space-y-0.5">
                {PANEL_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => {
                      setPanelTab(preset.label);
                      setRange(preset.build());
                      setOpen(false);
                    }}
                    className={`w-full rounded-r-md px-3 py-1.5 text-left text-xs transition-colors ${
                      panelTab === preset.label
                        ? "bg-[#e8f0fe] font-medium text-slate-900 dark:bg-blue-950/60 dark:text-blue-100"
                        : "text-slate-700 hover:bg-blue-50 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-blue-950/40"
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </aside>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-4 dark:border-slate-800 sm:flex-row sm:items-center">
                <div className="relative min-w-0 flex-1">
                  <label className="absolute -top-2 left-3 z-10 bg-white px-1 text-xs font-medium text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                    Start date*
                  </label>
                  <Input
                    readOnly
                    aria-label="Start date"
                    value={
                      draft?.from
                        ? formatDisplay(toDateStr(draft.from))
                        : "Select date"
                    }
                    className="h-10 border-slate-400 bg-white px-3 text-sm font-medium text-slate-900 shadow-none focus-visible:border-blue-600 focus-visible:ring-1 focus-visible:ring-blue-600 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                  />
                </div>
                <div className="hidden text-sm text-slate-500 sm:block">–</div>
                <div className="relative min-w-0 flex-1">
                  <label className="absolute -top-2 left-3 z-10 bg-white px-1 text-xs font-medium text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                    End date*
                  </label>
                  <Input
                    readOnly
                    aria-label="End date"
                    value={
                      draft?.to
                        ? formatDisplay(toDateStr(draft.to))
                        : "Select date"
                    }
                    className="h-10 border-slate-400 bg-white px-3 text-sm font-medium text-slate-900 shadow-none focus-visible:border-blue-600 focus-visible:ring-1 focus-visible:ring-blue-600 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto overflow-x-auto px-4 py-4">
                <Calendar
                  mode="range"
                  numberOfMonths={1}
                  selected={draft}
                  onSelect={handleCalendarSelect}
                  defaultMonth={fromDateStr(range.from)}
                  disabled={{ after: today }}
                  captionLayout="dropdown"
                  fromYear={1970}
                  toYear={today.getFullYear()}
                  className="relative mx-auto w-full max-w-none bg-transparent p-0 pt-11 text-slate-900 dark:text-slate-100"
                  formatters={{
                    formatWeekdayName: (date) =>
                      date.toLocaleDateString(undefined, { weekday: "narrow" }),
                  }}
                  classNames={{
                    root: "!w-full",
                    months: "flex w-full",
                    month: "w-full space-y-2",
                    month_caption:
                      "flex h-9 items-center justify-center gap-2 px-0",
                    caption_label:
                      "flex h-10 items-center gap-1 rounded-md px-2 text-lg font-semibold uppercase tracking-tight text-slate-900 hover:bg-blue-50 dark:text-slate-100 dark:hover:bg-blue-950/50 [&>svg]:h-4 [&>svg]:w-4",
                    nav: "absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-2 px-0",
                    button_previous:
                      "h-9 w-9 rounded-md border border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-blue-50 hover:text-blue-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-blue-950",
                    button_next:
                      "h-9 w-9 rounded-md border border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-blue-50 hover:text-blue-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-blue-950",
                    weekdays: "flex w-full",
                    weekday:
                      "flex-1 select-none py-1 text-center text-xs font-semibold uppercase text-slate-700 dark:text-slate-300",
                    week: "mt-1 flex w-full",
                    day: "relative flex-1 p-0 text-center",
                    table: "w-full",
                    range_start: "rounded-l-full bg-blue-100 dark:bg-blue-950/60",
                    range_middle:
                      "rounded-none bg-[#e0e7ff] text-slate-900 dark:bg-blue-950/60 dark:text-blue-100",
                    range_end: "rounded-r-full bg-blue-100 dark:bg-blue-950/60",
                    today: "rounded-full bg-transparent",
                    outside: "text-slate-400 dark:text-slate-600",
                    disabled: "text-slate-400 opacity-60 dark:text-slate-600",
                  }}
                />
              </div>
              <div className="flex shrink-0 items-center justify-end gap-1 border-t border-slate-200 bg-white px-8 py-4 pb-5 dark:border-slate-800 dark:bg-slate-950">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setOpen(false)}
                  className="text-slate-600 hover:bg-slate-200/70 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={apply}
                  disabled={!draft?.from}
                  variant="ghost"
                  className="font-semibold text-blue-600 hover:bg-blue-50 hover:text-blue-700 dark:text-blue-400 dark:hover:bg-blue-950/50"
                >
                  Apply
                </Button>
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

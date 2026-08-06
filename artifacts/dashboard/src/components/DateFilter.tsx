import { useState } from "react";
import { CalendarIcon, X } from "lucide-react";
import type { DateRange as DayPickerRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
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
  { label: "Today so far", build: () => ({ from: todayStr(), to: todayStr() }) },
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

  const today = fromDateStr(todayStr());

  const openPopover = (next: boolean) => {
    if (next) {
      // Seed the draft from the applied range each time the popover opens.
      setDraft({ from: fromDateStr(range.from), to: fromDateStr(range.to) });
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
          className="w-[calc(100vw-1rem)] max-w-[52rem] overflow-hidden rounded-xl border-slate-200 bg-white p-0 shadow-xl dark:border-slate-800 dark:bg-slate-950"
          align="end"
          sideOffset={8}
        >
          <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-slate-800">
            <div>
              <div className="text-lg font-medium tracking-tight text-slate-900 dark:text-slate-100">
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
          <div className="flex min-h-[31rem] flex-col sm:flex-row">
            <aside className="w-full shrink-0 border-b border-slate-200 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-900/40 sm:w-48 sm:border-b-0 sm:border-r">
              <button
                type="button"
                onClick={() =>
                  setDraft({ from: fromDateStr(range.from), to: fromDateStr(range.to) })
                }
                className="mb-2 w-full rounded-md bg-teal-100 px-3 py-2.5 text-left text-sm font-medium text-teal-900 dark:bg-teal-950/70 dark:text-teal-100"
              >
                Custom
              </button>
              <div className="space-y-0.5">
                {PANEL_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => {
                      setRange(preset.build());
                      setOpen(false);
                    }}
                    className="w-full rounded-md px-3 py-2.5 text-left text-sm text-slate-700 transition-colors hover:bg-teal-50 hover:text-teal-900 dark:text-slate-300 dark:hover:bg-teal-950/60 dark:hover:text-teal-100"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex flex-col gap-3 border-b border-slate-200 px-6 py-5 dark:border-slate-800 sm:flex-row">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 text-xs font-medium text-slate-500">
                    Start date
                  </div>
                  <div className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
                    {draft?.from ? formatDisplay(toDateStr(draft.from)) : "Select date"}
                  </div>
                </div>
                <div className="hidden items-end pb-2 text-slate-400 sm:flex">–</div>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 text-xs font-medium text-slate-500">
                    End date
                  </div>
                  <div className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
                    {draft?.to ? formatDisplay(toDateStr(draft.to)) : "Select date"}
                  </div>
                </div>
              </div>
              <div className="overflow-x-auto px-6 py-5">
                <Calendar
                  mode="range"
                  numberOfMonths={1}
                  selected={draft}
                  onSelect={setDraft}
                  defaultMonth={fromDateStr(range.from)}
                  disabled={{ after: today }}
                  className="relative mx-auto w-full min-w-[20rem] max-w-[25rem] bg-transparent p-0 pt-10 text-slate-900 dark:text-slate-100"
                  classNames={{
                    months: "flex",
                    month: "w-full space-y-4",
                    month_caption: "flex h-9 items-center justify-start px-0",
                    caption_label:
                      "text-lg font-semibold uppercase tracking-tight text-slate-900 dark:text-slate-100",
                    nav: "absolute inset-x-0 top-0 z-10 flex items-center justify-end gap-2",
                    button_previous:
                      "h-9 w-9 rounded-md border border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-teal-50 hover:text-teal-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-teal-950",
                    button_next:
                      "h-9 w-9 rounded-md border border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-teal-50 hover:text-teal-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-teal-950",
                    weekdays: "flex w-full",
                    weekday:
                      "flex-1 select-none py-1 text-center text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300",
                    week: "mt-2 flex w-full",
                    day: "relative flex-1 p-0 text-center",
                    range_start: "rounded-l-md bg-transparent",
                    range_middle:
                      "rounded-none bg-teal-100 text-teal-900 dark:bg-teal-950/60 dark:text-teal-100",
                    range_end: "rounded-r-md bg-transparent",
                    today: "rounded-md bg-slate-100 dark:bg-slate-800",
                    outside: "text-slate-400 dark:text-slate-600",
                    disabled: "text-slate-400 opacity-60 dark:text-slate-600",
                  }}
                />
              </div>
              <div className="mt-auto flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50/70 px-6 py-4 dark:border-slate-800 dark:bg-slate-900/50">
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
                  className="bg-teal-600 text-white hover:bg-teal-700"
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

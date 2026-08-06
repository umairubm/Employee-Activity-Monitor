import { useState } from "react";
import { CalendarIcon } from "lucide-react";
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
          className="w-[calc(100vw-1rem)] max-w-[42rem] overflow-hidden rounded-xl border-slate-200 bg-white p-0 shadow-xl dark:border-slate-800 dark:bg-slate-950"
          align="end"
          sideOffset={8}
        >
          <div className="border-b border-slate-200 px-6 py-4 dark:border-slate-800">
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Select date range
            </div>
            <div className="mt-1 text-xs text-slate-500">
              Choose a start date and an end date
            </div>
          </div>
          <div className="overflow-x-auto px-5 py-5 sm:px-6">
            <Calendar
              mode="range"
              numberOfMonths={2}
              selected={draft}
              onSelect={setDraft}
              defaultMonth={fromDateStr(range.from)}
              disabled={{ after: today }}
              className="mx-auto w-full min-w-[36rem] bg-transparent p-0"
              classNames={{
                months: "flex flex-col gap-8 sm:flex-row sm:gap-10",
                month: "w-full space-y-4 sm:w-[17rem]",
                month_caption:
                  "flex h-9 items-center justify-center px-10",
                caption_label:
                  "text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100",
                nav: "absolute inset-x-0 top-0 z-10 flex items-center justify-between px-1",
                button_previous:
                  "h-8 w-8 rounded-lg border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800",
                button_next:
                  "h-8 w-8 rounded-lg border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800",
                weekdays: "flex w-full",
                weekday:
                  "flex-1 select-none py-1 text-center text-[0.68rem] font-semibold uppercase tracking-wide text-slate-400",
                week: "mt-2 flex w-full",
                day: "relative flex-1 p-0 text-center",
                range_start: "rounded-l-md bg-transparent",
                range_middle:
                  "rounded-none bg-teal-50 dark:bg-teal-950/35",
                range_end: "rounded-r-md bg-transparent",
                today: "rounded-md bg-slate-100 dark:bg-slate-800",
                outside: "text-slate-300 dark:text-slate-700",
                disabled: "text-slate-300 opacity-50 dark:text-slate-700",
              }}
            />
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50/70 px-6 py-3.5 dark:border-slate-800 dark:bg-slate-900/50">
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
              className="bg-[#0D9488] text-white hover:bg-[#0f766e]"
            >
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

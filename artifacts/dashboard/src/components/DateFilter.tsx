import { useState } from "react";
import { CalendarIcon, ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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

type DraftCalendarRange = {
  from?: Date;
  to?: Date;
};

function sameDay(a: Date | undefined, b: Date | undefined): boolean {
  return Boolean(
    a &&
      b &&
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate(),
  );
}

function monthLabel(date: Date): string {
  return date
    .toLocaleDateString(undefined, { month: "short", year: "numeric" })
    .toUpperCase();
}

function calendarWeeks(month: Date, today: Date): (Date | null)[][] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const weeks: (Date | null)[][] = [];
  let cursor = 1 - first.getDay();
  const currentMonth = month.getFullYear() === today.getFullYear() && month.getMonth() === today.getMonth();

  while (cursor <= last.getDate()) {
    const week = Array.from({ length: 7 }, (_, index) => {
      const day = cursor + index;
      return day >= 1 && day <= last.getDate()
        ? new Date(month.getFullYear(), month.getMonth(), day)
        : null;
    });
    weeks.push(week);
    cursor += 7;
    if (currentMonth && week.some((day) => sameDay(day ?? undefined, today))) break;
  }
  return weeks;
}

function DatePickerCalendar({
  month,
  range,
  today,
  onMonthChange,
  onSelect,
}: {
  month: Date;
  range: DraftCalendarRange | undefined;
  today: Date;
  onMonthChange: (month: Date) => void;
  onSelect: (date: Date) => void;
}) {
  const months = [month, new Date(month.getFullYear(), month.getMonth() + 1, 1)];
  const weekdays = ["S", "M", "T", "W", "T", "F", "S"];
  const fromTime = range?.from?.getTime();
  const toTime = range?.to?.getTime();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-between">
        <button
          type="button"
          aria-label={`Viewing ${monthLabel(month)}`}
          onClick={() =>
            onMonthChange(new Date(month.getFullYear(), month.getMonth() + 1, 1))
          }
          className="flex items-center gap-1.5 text-sm font-normal tracking-tight text-slate-700 dark:text-slate-200"
        >
          {monthLabel(month)}
          <ChevronDown className="h-4 w-4 text-slate-700 dark:text-slate-200" />
        </button>
        <div className="flex items-center gap-4 pr-1">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => onMonthChange(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
            className="text-slate-500 transition-colors hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
          >
            <ChevronLeft className="h-5 w-5 stroke-[1.5]" />
          </button>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => onMonthChange(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
            className="text-slate-500 transition-colors hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
          >
            <ChevronRight className="h-5 w-5 stroke-[1.5]" />
          </button>
        </div>
      </div>
      <div className="grid h-7 shrink-0 grid-cols-7 items-center border-b border-slate-300 text-xs font-normal text-slate-600 dark:border-slate-700 dark:text-slate-400">
        {weekdays.map((weekday, index) => (
          <div key={`${weekday}-${index}`} className="text-center">
            {weekday}
          </div>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pt-1">
        <div className="space-y-2">
          {months.map((visibleMonth) => {
            const weeks = calendarWeeks(visibleMonth, today);
            const firstDay = new Date(
              visibleMonth.getFullYear(),
              visibleMonth.getMonth(),
              1,
            ).getDay();
            return (
              <div key={`${visibleMonth.getFullYear()}-${visibleMonth.getMonth()}`} className="space-y-2">
                {weeks.map((week, weekIndex) => (
                  <div key={weekIndex} className="grid h-8 grid-cols-7">
                    {weekIndex === 0 && firstDay > 0 && (
                      <div
                        style={{ gridColumn: `span ${firstDay} / span ${firstDay}` }}
                        className="flex items-center px-2 text-sm font-bold text-slate-800 dark:text-slate-200"
                      >
                        {monthLabel(visibleMonth)}
                      </div>
                    )}
                    {week.map((date, dayIndex) => {
                      if (weekIndex === 0 && dayIndex < firstDay) return null;
                      if (!date) {
                        return <div key={dayIndex} aria-hidden="true" />;
                      }
                      const time = date.getTime();
                      const isStart = time === fromTime;
                      const isEnd = time === toTime;
                      const isSelected = isStart || isEnd;
                      const inRange = Boolean(fromTime && toTime && time >= fromTime && time <= toTime);
                      const disabled = time > today.getTime();
                      const isToday = sameDay(date, today);
                      return (
                        <div
                          key={dayIndex}
                          className={`flex h-8 items-center justify-center ${
                            inRange ? "bg-[#e7eeff]" : ""
                          }`}
                        >
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => onSelect(date)}
                            className={`flex h-8 w-full items-center justify-center text-sm font-normal text-[#374151] transition-colors dark:text-slate-200 ${
                              disabled
                                ? "cursor-default !text-[#c5c8cc] dark:!text-slate-600"
                                : "hover:bg-blue-50 dark:hover:bg-blue-950/40"
                            } ${
                              isSelected
                                ? "h-8 w-8 rounded-full !bg-[#1976e8] !text-white"
                                : isToday
                                  ? "h-8 w-8 rounded-full border-2 border-slate-200"
                                  : ""
                            } ${isEnd && !isStart ? "rounded-full" : ""}`}
                          >
                            {date.getDate()}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
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
  const [draft, setDraft] = useState<DraftCalendarRange | undefined>(undefined);
  const [panelTab, setPanelTab] = useState("Custom");
  const [viewMonth, setViewMonth] = useState(() => fromDateStr(todayStr()));
  const [compare, setCompare] = useState(false);

  const today = fromDateStr(todayStr());

  const openPopover = (next: boolean) => {
    if (next) {
      // Seed the draft from the applied range each time the popover opens.
      setDraft({ from: fromDateStr(range.from), to: fromDateStr(range.to) });
      setViewMonth(new Date(fromDateStr(range.from).getFullYear(), fromDateStr(range.from).getMonth(), 1));
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

  const handleCalendarSelect = (date: Date) => {
    const next = !draft?.from || draft.to
      ? { from: date, to: undefined }
      : date < draft.from
        ? { from: date, to: draft.from }
        : { from: draft.from, to: date };
    setDraft(next);
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
          className="flex max-h-[min(440px,calc(100vh-1rem))] w-[560px] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl border-slate-200 bg-white p-0 shadow-xl dark:border-slate-800 dark:bg-slate-950"
          align="end"
          sideOffset={8}
        >
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-slate-200 px-4 dark:border-slate-800">
            <div className="text-lg font-normal tracking-tight text-slate-900 dark:text-slate-100">
              Date range
            </div>
            <button
              type="button"
              aria-label="Close date range picker"
              onClick={() => setOpen(false)}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-900 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              <X className="h-4 w-4 stroke-[1.5]" />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <aside className="flex w-[170px] shrink-0 flex-col border-r border-slate-300 bg-white dark:border-slate-800 dark:bg-slate-950">
              <div className="border-b border-slate-300 pb-1 pt-1 dark:border-slate-800">
              <button
                type="button"
                onClick={() => {
                  setPanelTab("Custom");
                  setDraft({
                    from: fromDateStr(range.from),
                    to: fromDateStr(range.to),
                  });
                }}
                className={`w-full px-4 py-1 text-left text-sm font-normal transition-colors ${
                  panelTab === "Custom"
                    ? "bg-[#e5edff] text-slate-900 dark:bg-blue-950/60 dark:text-blue-100"
                    : "text-slate-800 hover:bg-blue-50 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-blue-950/40"
                }`}
              >
                Custom
              </button>
              </div>
              <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pt-1.5">
                {PANEL_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => {
                      setPanelTab(preset.label);
                      setRange(preset.build());
                      setOpen(false);
                    }}
                    className={`w-full px-4 py-1 text-left text-sm font-normal transition-colors ${
                      panelTab === preset.label
                        ? "bg-[#e5edff] text-slate-900 dark:bg-blue-950/60 dark:text-blue-100"
                        : "text-slate-800 hover:bg-blue-50 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-blue-950/40"
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <div className="flex h-9 shrink-0 items-center gap-3 border-t border-slate-300 px-4 text-sm text-slate-700 dark:border-slate-800 dark:text-slate-300">
                <span>Compare</span>
                <button
                  type="button"
                  aria-label="Compare date ranges"
                  aria-pressed={compare}
                  onClick={() => setCompare((value) => !value)}
                  className={`relative h-5 w-9 rounded-full transition-colors ${
                    compare ? "bg-blue-500" : "bg-slate-300 dark:bg-slate-700"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-md transition-transform ${
                      compare ? "translate-x-[18px]" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
            </aside>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="flex shrink-0 flex-col gap-3 border-b border-slate-200 px-4 py-2.5 dark:border-slate-800 sm:flex-row sm:items-center">
                <div className="relative min-w-0 flex-1">
                  <label className="absolute -top-2 left-3 z-10 bg-white px-1 text-xs font-normal text-slate-600 dark:bg-slate-950 dark:text-slate-300">
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
                    className="h-10 border-2 border-slate-500 bg-white px-3 text-sm font-normal text-slate-900 shadow-none focus-visible:border-blue-600 focus-visible:ring-1 focus-visible:ring-blue-600 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                  />
                </div>
                <div className="hidden text-base text-slate-700 sm:block">–</div>
                <div className="relative min-w-0 flex-1">
                  <label className="absolute -top-2 left-3 z-10 bg-white px-1 text-xs font-normal text-slate-600 dark:bg-slate-950 dark:text-slate-300">
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
                    className="h-10 border-2 border-slate-500 bg-white px-3 text-sm font-normal text-slate-900 shadow-none focus-visible:border-blue-600 focus-visible:ring-1 focus-visible:ring-blue-600 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4">
                <DatePickerCalendar
                  month={viewMonth}
                  range={draft}
                  today={today}
                  onMonthChange={setViewMonth}
                  onSelect={handleCalendarSelect}
                />
              </div>
              <div className="flex h-10 shrink-0 items-center justify-end border-t border-slate-200 bg-white px-4 dark:border-slate-800 dark:bg-slate-950">
                <Button
                  size="default"
                  onClick={apply}
                  disabled={!draft?.from}
                  variant="ghost"
                  className="px-0 text-sm font-semibold text-blue-600 hover:bg-transparent hover:text-blue-700 dark:text-blue-400"
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

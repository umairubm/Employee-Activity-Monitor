import { Input } from "@/components/ui/input";
import {
  useDateRange,
  todayStr,
  daysAgoStr,
  type DateRange,
} from "@/hooks/use-date-filter";

const PRESETS: { label: string; build: () => DateRange }[] = [
  { label: "Today", build: () => ({ from: todayStr(), to: todayStr() }) },
  { label: "7d", build: () => ({ from: daysAgoStr(6), to: todayStr() }) },
  { label: "30d", build: () => ({ from: daysAgoStr(29), to: todayStr() }) },
];

/**
 * Shared date-*range* filter control used across the date-aware pages. Reads
 * and writes the persisted selection via {@link useDateRange}, so changing the
 * range on one page carries over to the others (and across tabs).
 */
export function DateRangeFilter() {
  const [range, setRange] = useDateRange();
  const today = todayStr();

  return (
    <div className="flex flex-wrap items-end gap-2">
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
      <Input
        type="date"
        aria-label="From date"
        className="h-9 w-[9.5rem]"
        value={range.from}
        max={range.to}
        onChange={(e) => setRange({ from: e.target.value || range.to })}
      />
      <span className="pb-2 text-muted-foreground">–</span>
      <Input
        type="date"
        aria-label="To date"
        className="h-9 w-[9.5rem]"
        value={range.to}
        min={range.from}
        max={today}
        onChange={(e) => setRange({ to: e.target.value || range.from })}
      />
    </div>
  );
}

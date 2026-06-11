import { ChevronLeft, ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useDateFilter, todayStr, shiftDay } from "@/hooks/use-date-filter";

/**
 * Shared single-day date filter control used across the day-based pages.
 * Reads/writes the persisted selection via {@link useDateFilter}, so changing
 * the day on one page carries over to the others.
 */
export function DateFilter() {
  const [date, setDate] = useDateFilter();
  const today = todayStr();
  const isToday = date === today;

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="outline"
        size="icon"
        className="h-9 w-9 flex-shrink-0"
        onClick={() => setDate(shiftDay(date, -1))}
        title="Previous day"
        aria-label="Previous day"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <Input
        type="date"
        aria-label="Filter by date"
        className="h-9 w-[9.5rem]"
        value={date}
        max={today}
        onChange={(e) => setDate(e.target.value || today)}
      />
      <Button
        variant="outline"
        size="icon"
        className="h-9 w-9 flex-shrink-0"
        onClick={() => setDate(shiftDay(date, 1))}
        disabled={isToday}
        title="Next day"
        aria-label="Next day"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
      <Button
        variant={isToday ? "default" : "outline"}
        className="h-9"
        onClick={() => setDate(today)}
        disabled={isToday}
      >
        Today
      </Button>
    </div>
  );
}

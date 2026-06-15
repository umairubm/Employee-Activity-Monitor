import { eachDayUTC } from "./attendance";

/**
 * Count business days (Mon–Fri) in the inclusive range [start, end]. Weekends
 * are excluded. Company holidays are intentionally NOT subtracted here: they
 * vary per device/group, whereas leave balances are per-user, so a stable
 * weekday-based count keeps balance accounting deterministic.
 */
export function businessDaysBetween(start: string, end: string): number {
  let count = 0;
  for (const day of eachDayUTC(start, end)) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

/**
 * Count business days (Mon–Fri) in [start, end] split per calendar year, so a
 * leave that spans a year boundary (e.g. Dec→Jan) is charged to each year's
 * balance separately. Returns a map of year → business-day count (years with
 * zero business days are omitted).
 */
export function businessDaysByYear(
  start: string,
  end: string,
): Map<number, number> {
  const byYear = new Map<number, number>();
  for (const day of eachDayUTC(start, end)) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const year = Number(day.slice(0, 4));
    byYear.set(year, (byYear.get(year) ?? 0) + 1);
  }
  return byYear;
}

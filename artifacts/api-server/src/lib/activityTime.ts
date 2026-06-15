import { db, activityLogsTable } from "@workspace/db";
import { and, gte, lt, sql, type SQL } from "drizzle-orm";

/**
 * Wall-clock seconds actually covered by a set of activity logs, computed as the
 * UNION of their [startedAt, endedAt] intervals (overlapping intervals merged).
 *
 * The desktop agent records one segment per foreground window; a single agent
 * never overlaps itself. When more than one agent instance runs on the same PC,
 * each independently reports the same wall-clock time, producing overlapping
 * segments. Naively summing `durationSeconds` then double-counts that time, so
 * totals can exceed the real first→last window. Merging intervals per partition
 * key yields the true covered time.
 *
 * IMPORTANT: callers MUST key by device (or device+day). Merging across devices
 * would wrongly collapse legitimate concurrent work by different people.
 *
 * @returns Map of partition key (text) -> covered seconds.
 */
export async function coveredSecondsByKey(opts: {
  rangeStart: Date;
  rangeEnd: Date;
  /** SQL expression producing the (text) partition key, e.g. device id. */
  keyExpr: SQL;
  /** Optional extra WHERE (e.g. a device/group filter). */
  extraWhere?: SQL;
}): Promise<Map<string, number>> {
  const { rangeStart, rangeEnd, keyExpr, extraWhere } = opts;
  const base = and(
    gte(activityLogsTable.startedAt, rangeStart),
    lt(activityLogsTable.startedAt, rangeEnd),
  );
  const whereClause = extraWhere ? and(base, extraWhere) : base;

  // Classic "gaps and islands": a new island starts when a row's start is past
  // the running max end of all prior rows in the same partition; the covered
  // time is the sum of each merged island's (max end - min start).
  const result = await db.execute(sql`
    WITH logs AS (
      SELECT ${keyExpr} AS k,
             ${activityLogsTable.startedAt} AS s,
             ${activityLogsTable.endedAt} AS e
      FROM ${activityLogsTable}
      WHERE ${whereClause}
    ),
    ordered AS (
      SELECT k, s, e,
             max(e) OVER (
               PARTITION BY k ORDER BY s, e
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
             ) AS prev_end
      FROM logs
    ),
    islands AS (
      SELECT k, s, e,
             sum(CASE WHEN prev_end IS NULL OR s > prev_end THEN 1 ELSE 0 END)
               OVER (
                 PARTITION BY k ORDER BY s, e
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
               ) AS island
      FROM ordered
    ),
    merged AS (
      SELECT k, island, min(s) AS s, max(e) AS e
      FROM islands
      GROUP BY k, island
    )
    SELECT k::text AS k,
           coalesce(sum(extract(epoch FROM (e - s))), 0)::int AS covered
    FROM merged
    GROUP BY k
  `);

  const map = new Map<string, number>();
  for (const row of result.rows as Array<{ k: string; covered: number | string }>) {
    map.set(String(row.k), Number(row.covered));
  }
  return map;
}

/**
 * Wall-clock SPAN per partition key: the difference between the last upload
 * (max endedAt) and the first push (min startedAt). Unlike the covered UNION,
 * the span INCLUDES the gaps between sessions (breaks, lunch, idle stretches),
 * so it represents the full "first activity → last activity" window of the day.
 *
 * IMPORTANT: callers MUST key by device+DAY. A device-only key over a multi-day
 * range would span overnight gaps and wildly overstate the duration; sum the
 * per-day spans instead to get a range total.
 *
 * @returns Map of partition key (text) -> span seconds.
 */
export async function spanSecondsByKey(opts: {
  rangeStart: Date;
  rangeEnd: Date;
  /** SQL expression producing the (text) partition key, e.g. device+day. */
  keyExpr: SQL;
  /** Optional extra WHERE (e.g. a device/group filter). */
  extraWhere?: SQL;
}): Promise<Map<string, number>> {
  const { rangeStart, rangeEnd, keyExpr, extraWhere } = opts;
  const base = and(
    gte(activityLogsTable.startedAt, rangeStart),
    lt(activityLogsTable.startedAt, rangeEnd),
  );
  const whereClause = extraWhere ? and(base, extraWhere) : base;

  const result = await db.execute(sql`
    SELECT ${keyExpr}::text AS k,
           coalesce(
             extract(epoch FROM (max(${activityLogsTable.endedAt}) - min(${activityLogsTable.startedAt}))),
             0
           )::int AS span
    FROM ${activityLogsTable}
    WHERE ${whereClause}
    GROUP BY 1
  `);

  const map = new Map<string, number>();
  for (const row of result.rows as Array<{ k: string; span: number | string }>) {
    map.set(String(row.k), Number(row.span));
  }
  return map;
}

/**
 * First-activity and last-activity minute-of-day (UTC) per partition key. Used by
 * attendance to detect late arrival (first activity after the threshold) and
 * early leave (no activity at/after the midday cutoff). Minutes are measured from
 * UTC midnight so they line up with the UTC day buckets the attendance routes use.
 *
 * @returns Map of partition key (text) -> { firstMinutes, lastMinutes }.
 */
export async function dayTimeBoundsByKey(opts: {
  rangeStart: Date;
  rangeEnd: Date;
  /** SQL expression producing the (text) partition key, e.g. device+day. */
  keyExpr: SQL;
  /** Optional extra WHERE (e.g. a device/group filter). */
  extraWhere?: SQL;
  /**
   * IANA timezone the minute-of-day is measured in (minutes since local midnight
   * in this zone). Defaults to "UTC" to preserve prior behavior. Must align with
   * the timezone used to bucket `keyExpr` by day.
   */
  tz?: string;
}): Promise<Map<string, { firstMinutes: number; lastMinutes: number }>> {
  const { rangeStart, rangeEnd, keyExpr, extraWhere, tz = "UTC" } = opts;
  const base = and(
    gte(activityLogsTable.startedAt, rangeStart),
    lt(activityLogsTable.startedAt, rangeEnd),
  );
  const whereClause = extraWhere ? and(base, extraWhere) : base;

  const result = await db.execute(sql`
    SELECT ${keyExpr}::text AS k,
           (extract(epoch FROM (min(${activityLogsTable.startedAt}) AT TIME ZONE ${tz})::time) / 60)::int AS first_min,
           (extract(epoch FROM (max(${activityLogsTable.endedAt}) AT TIME ZONE ${tz})::time) / 60)::int AS last_min
    FROM ${activityLogsTable}
    WHERE ${whereClause}
    GROUP BY 1
  `);

  const map = new Map<string, { firstMinutes: number; lastMinutes: number }>();
  for (const row of result.rows as Array<{
    k: string;
    first_min: number | string | null;
    last_min: number | string | null;
  }>) {
    map.set(String(row.k), {
      firstMinutes: row.first_min === null ? 0 : Number(row.first_min),
      lastMinutes: row.last_min === null ? 0 : Number(row.last_min),
    });
  }
  return map;
}

export interface NaiveTime {
  workedSeconds: number;
  idleSeconds: number;
  productiveSeconds: number;
  unproductiveSeconds: number;
  neutralSeconds: number;
  undefinedSeconds: number;
}

export interface CorrectedTime {
  totalSeconds: number;
  activeSeconds: number;
  idleSeconds: number;
  productiveSeconds: number;
  unproductiveSeconds: number;
  neutralSeconds: number;
  undefinedSeconds: number;
}

/**
 * Scale naive per-key component sums down to the real wall-clock coverage so
 * overlapping (duplicate-agent) logs don't double-count time, and report the
 * day's total DURATION as the first→last span.
 *
 * - `coveredSeconds` is the UNION of the activity intervals (overlap removed);
 *   it drives the productivity breakdown and the active/idle split.
 * - `spanSeconds` (optional) is the first-push→last-upload window for the day.
 *   When provided, it becomes `totalSeconds` (duration), so the headline figure
 *   includes the gaps between sessions. `idleSeconds` then absorbs those gaps:
 *   active = covered - micro-idle, idle = total - active. When omitted, total
 *   falls back to the covered union (legacy behaviour).
 *
 * Category ratios are preserved and the four classes sum exactly to the covered
 * union. When there are no overlaps and no span gap, every value is unchanged.
 */
export function correctOverlap(
  naive: NaiveTime,
  coveredSeconds: number,
  spanSeconds?: number,
): CorrectedTime {
  const worked = naive.workedSeconds;
  // Union can never exceed the sum of durations and can never be negative; clamp
  // to guard against the tiny duration_seconds vs (ended-started) drift in
  // stored rows and any malformed/negative covered value.
  const safeCovered = Math.max(0, coveredSeconds);
  const covered = worked > 0 ? Math.min(safeCovered, worked) : 0;
  const ratio = worked > 0 ? covered / worked : 0;

  // Total duration is the first→last span when supplied (it can never be smaller
  // than the covered activity it bounds); otherwise it is the covered union.
  const total =
    spanSeconds != null ? Math.max(Math.round(spanSeconds), covered) : covered;

  // Scale each class by the overlap ratio, then round while preserving the
  // scaled SUM (largest-remainder). Each class keeps its own proportion of
  // worked time, so callers that only populate `productiveSeconds` (leaderboard,
  // group-comparison) get exactly round(productive * ratio). For fully-classified
  // data the four classes scaled-sum to the covered union exactly — unlike
  // independent per-component rounding, which can overshoot when several classes
  // round up.
  const [productiveSeconds, unproductiveSeconds, neutralSeconds, undefinedSeconds] =
    roundPreservingSum([
      naive.productiveSeconds * ratio,
      naive.unproductiveSeconds * ratio,
      naive.neutralSeconds * ratio,
      naive.undefinedSeconds * ratio,
    ]);

  // Active time is the covered foreground activity minus reported micro-idle;
  // idle absorbs the remainder of the span (between-session gaps + micro-idle),
  // so active + idle === total.
  const microIdle = Math.min(covered, Math.round(naive.idleSeconds * ratio));
  const activeSeconds = Math.max(0, covered - microIdle);
  const idleSeconds = Math.max(0, total - activeSeconds);

  return {
    totalSeconds: total,
    activeSeconds,
    idleSeconds,
    productiveSeconds,
    unproductiveSeconds,
    neutralSeconds,
    undefinedSeconds,
  };
}

/**
 * Round an array of non-negative floats to integers whose sum equals the rounded
 * sum of the inputs (largest-remainder / Hamilton method). Distributing the
 * rounding error this way keeps per-class totals consistent with their combined
 * total instead of letting independent rounding drift above or below it.
 */
function roundPreservingSum(values: number[]): number[] {
  const floors = values.map((v) => Math.floor(v));
  const target = Math.round(values.reduce((a, v) => a + v, 0));
  let remainder = target - floors.reduce((a, v) => a + v, 0);

  const order = values
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const result = floors.slice();
  for (let j = 0; j < order.length && remainder > 0; j++, remainder--) {
    result[order[j].i] += 1;
  }
  return result;
}

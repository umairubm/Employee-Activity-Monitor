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
 * overlapping (duplicate-agent) logs don't double-count time.
 *
 * Preserves category ratios; guarantees the four classes sum exactly to total
 * and active = total - idle. When there are no overlaps, covered === worked and
 * every value is returned unchanged.
 */
export function correctOverlap(
  naive: NaiveTime,
  coveredSeconds: number,
): CorrectedTime {
  const worked = naive.workedSeconds;
  // Union can never exceed the sum of durations and can never be negative; clamp
  // to guard against the tiny duration_seconds vs (ended-started) drift in
  // stored rows and any malformed/negative covered value.
  const safeCovered = Math.max(0, coveredSeconds);
  const total = worked > 0 ? Math.min(safeCovered, worked) : 0;
  const ratio = worked > 0 ? total / worked : 0;

  // Scale each class by the overlap ratio, then round while preserving the
  // scaled SUM (largest-remainder). Each class keeps its own proportion of
  // worked time, so callers that only populate `productiveSeconds` (leaderboard,
  // group-comparison) get exactly round(productive * ratio). For fully-classified
  // data the four classes scaled-sum to `total`, so they sum to total exactly —
  // unlike independent per-component rounding, which can overshoot when several
  // classes round up.
  const [productiveSeconds, unproductiveSeconds, neutralSeconds, undefinedSeconds] =
    roundPreservingSum([
      naive.productiveSeconds * ratio,
      naive.unproductiveSeconds * ratio,
      naive.neutralSeconds * ratio,
      naive.undefinedSeconds * ratio,
    ]);

  const idleSeconds = Math.min(total, Math.round(naive.idleSeconds * ratio));
  const activeSeconds = Math.max(0, total - idleSeconds);

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

import { randomBytes, createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { and, eq, like, sql } from "drizzle-orm";
import {
  db,
  pool,
  companiesTable,
  devicesTable,
  enrollmentTokensTable,
  appCategoriesTable,
  activityLogsTable,
} from "@workspace/db";

/**
 * DEV-ONLY dummy data seeder for the Devices / Tokens / Timesheets tables.
 *
 * Inserts a handful of fake enrollment tokens + enrolled devices, plus a couple
 * of app categories and several days of activity logs per device, so the
 * dashboard tables (Devices, Tokens, Timesheets, Activity Logs, reports) have
 * something to look at during local testing. Every row it creates is tagged
 * with the `demo-seed-` marker (token string, hardware hash, category pattern)
 * so `--clean` removes ALL of them again without touching real data. Activity
 * logs cascade-delete with their demo devices.
 *
 * This must NEVER run against production. It hard-refuses when it detects a
 * Replit deployment environment.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run seed-dummy         # seed
 *   pnpm --filter @workspace/scripts run seed-dummy -- --clean   # remove
 *   pnpm --filter @workspace/scripts run seed-dummy -- --company-id <uuid>
 */

// Shared marker so seeded rows are always identifiable and removable.
const MARKER = "demo-seed-";

// How many recent days (working days only) of activity to generate per device.
const ACTIVITY_DAYS = 14;

function assertNotProduction(): void {
  const isDeployment =
    process.env.REPLIT_DEPLOYMENT === "1" ||
    process.env.REPLIT_DEPLOYMENT === "true" ||
    process.env.NODE_ENV === "production";
  if (isDeployment) {
    throw new Error(
      "Refusing to run: this dummy-data seeder is DEV-ONLY and will not run in a production/deployment environment.",
    );
  }
}

// Pick the real tenant to attach demo rows to: the first company whose name
// isn't a throwaway test-co-* row (those come from the automated test suite).
async function resolveCompanyId(explicit?: string): Promise<string> {
  if (explicit) {
    const [row] = await db
      .select({ id: companiesTable.id })
      .from(companiesTable)
      .where(eq(companiesTable.id, explicit));
    if (!row) throw new Error(`No company found with id ${explicit}`);
    return row.id;
  }
  const [real] = await db
    .select({ id: companiesTable.id, name: companiesTable.name })
    .from(companiesTable)
    .where(sql`${companiesTable.name} NOT LIKE 'test-co-%'`)
    .orderBy(companiesTable.createdAt)
    .limit(1);
  if (real) return real.id;
  const [any] = await db
    .select({ id: companiesTable.id })
    .from(companiesTable)
    .orderBy(companiesTable.createdAt)
    .limit(1);
  if (!any) throw new Error("No companies exist to attach demo data to.");
  return any.id;
}

type DemoSpec = {
  systemName: string;
  osType: "windows" | "macos" | "linux";
  employeeId: string;
  deviceGroup: string;
  region: string;
  label: string;
  online: boolean;
  consented: boolean;
};

const DEMO_ROWS: DemoSpec[] = [
  { systemName: "DEMO-Ava-Laptop", osType: "windows", employeeId: "EMP-1001", deviceGroup: "Engineering", region: "North", label: "Eng Batch 1", online: true, consented: true },
  { systemName: "DEMO-Bilal-PC", osType: "windows", employeeId: "EMP-1002", deviceGroup: "Engineering", region: "North", label: "Eng Batch 1", online: false, consented: true },
  { systemName: "DEMO-Chen-MacBook", osType: "macos", employeeId: "EMP-1003", deviceGroup: "Design", region: "APAC", label: "Design Q3", online: true, consented: true },
  { systemName: "DEMO-Diana-Desktop", osType: "linux", employeeId: "EMP-1004", deviceGroup: "Data", region: "East", label: "Analytics", online: true, consented: false },
  { systemName: "DEMO-Omar-Laptop", osType: "windows", employeeId: "EMP-1005", deviceGroup: "Sales", region: "South", label: "Sales West", online: false, consented: true },
  { systemName: "DEMO-Priya-PC", osType: "windows", employeeId: "EMP-1006", deviceGroup: "Support", region: "APAC", label: "Support Tier 2", online: true, consented: true },
  { systemName: "DEMO-Sara-MacBook", osType: "macos", employeeId: "EMP-1007", deviceGroup: "Design", region: "West", label: "Design Q3", online: false, consented: false },
  { systemName: "DEMO-Yusuf-Desktop", osType: "linux", employeeId: "EMP-1008", deviceGroup: "Data", region: "East", label: "Analytics", online: true, consented: true },
];

async function clean(companyId: string): Promise<void> {
  const devs = await db
    .delete(devicesTable)
    .where(
      and(
        eq(devicesTable.companyId, companyId),
        like(devicesTable.hardwareHash, `${MARKER}%`),
      ),
    )
    .returning({ id: devicesTable.id });
  const toks = await db
    .delete(enrollmentTokensTable)
    .where(
      and(
        eq(enrollmentTokensTable.companyId, companyId),
        like(enrollmentTokensTable.token, `${MARKER}%`),
      ),
    )
    .returning({ id: enrollmentTokensTable.id });
  // Activity logs cascade-delete with their demo devices; demo categories are
  // removed by their marker pattern.
  const cats = await db
    .delete(appCategoriesTable)
    .where(
      and(
        eq(appCategoriesTable.companyId, companyId),
        like(appCategoriesTable.pattern, `${MARKER}%`),
      ),
    )
    .returning({ id: appCategoriesTable.id });
  console.log(
    `Removed ${devs.length} demo device(s), ${toks.length} demo token(s), and ${cats.length} demo category(ies) (activity logs cascaded).`,
  );
}

// One day of realistic, non-overlapping activity blocks for a device, starting
// at `startHour` UTC. Alternates productive / unproductive / uncategorized work.
function buildDayLogs(
  companyId: string,
  deviceId: string,
  day: Date,
  startHour: number,
  productiveId: string,
  unproductiveId: string,
): (typeof activityLogsTable.$inferInsert)[] {
  // minutes of work, and the category for each block (null = undefined bucket).
  const blocks: { min: number; process: string; categoryId: string | null }[] = [
    { min: 95, process: "Visual Studio Code", categoryId: productiveId },
    { min: 20, process: "Slack", categoryId: null },
    { min: 130, process: "Google Chrome — Docs", categoryId: productiveId },
    { min: 40, process: "YouTube", categoryId: unproductiveId },
    { min: 105, process: "Excel", categoryId: productiveId },
    { min: 25, process: "File Explorer", categoryId: null },
  ];
  const rows: (typeof activityLogsTable.$inferInsert)[] = [];
  let cursor = new Date(day);
  cursor.setUTCHours(startHour, 0, 0, 0);
  for (const b of blocks) {
    const startedAt = new Date(cursor);
    const endedAt = new Date(cursor.getTime() + b.min * 60 * 1000);
    rows.push({
      companyId,
      deviceId,
      processName: b.process,
      windowTitle: b.process,
      categoryId: b.categoryId,
      startedAt,
      endedAt,
      durationSeconds: b.min * 60,
      idleSeconds: Math.round(b.min * 60 * 0.08),
    });
    cursor = endedAt;
  }
  return rows;
}

async function seed(companyId: string): Promise<void> {
  // Idempotent: clear any prior demo rows first so re-running doesn't pile up.
  await clean(companyId);

  const now = Date.now();

  // Two categories drive the productive / unproductive split on the timesheet;
  // blocks with a null category fall into the "undefined" bucket.
  const [productiveCat] = await db
    .insert(appCategoriesTable)
    .values({
      companyId,
      pattern: `${MARKER}productive`,
      displayName: "Productive Work (demo)",
      classification: "productive",
    })
    .returning();
  const [unproductiveCat] = await db
    .insert(appCategoriesTable)
    .values({
      companyId,
      pattern: `${MARKER}social`,
      displayName: "Social Media (demo)",
      classification: "unproductive",
    })
    .returning();

  // Build the list of recent working days (skip Sat/Sun), newest-inclusive.
  const days: Date[] = [];
  for (let i = 0; days.length < ACTIVITY_DAYS && i < ACTIVITY_DAYS * 2; i++) {
    const d = new Date(now - i * 24 * 60 * 60 * 1000);
    d.setUTCHours(0, 0, 0, 0);
    const weekday = d.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(d);
  }

  let devicesCreated = 0;
  let logsCreated = 0;
  for (const [idx, spec] of DEMO_ROWS.entries()) {
    const tag = randomBytes(6).toString("hex");
    const [token] = await db
      .insert(enrollmentTokensTable)
      .values({
        companyId,
        token: `${MARKER}${tag}`,
        label: spec.label,
        employeeId: spec.employeeId,
        deviceGroup: spec.deviceGroup,
        region: spec.region,
        maxUses: 1,
        useCount: 1,
      })
      .returning();

    const lastSeenAt = spec.online
      ? new Date(now - 30 * 1000)
      : new Date(now - 3 * 24 * 60 * 60 * 1000);

    const [device] = await db
      .insert(devicesTable)
      .values({
        companyId,
        hardwareHash: `${MARKER}${tag}`,
        systemName: spec.systemName,
        osType: spec.osType,
        secretHash: createHash("sha256").update(tag).digest("hex"),
        deviceGroup: spec.deviceGroup,
        enrolledViaTokenId: token.id,
        enrolledAt: new Date(now - 7 * 24 * 60 * 60 * 1000),
        lastSeenAt,
        consentAcknowledgedAt: spec.consented ? new Date(now - 7 * 24 * 60 * 60 * 1000) : null,
        consentName: spec.consented ? spec.employeeId : null,
        agentVersion: "1.0.0-demo",
      })
      .returning();
    devicesCreated += 1;

    // Vary the clock-in hour so some devices read as late arrivals (9 vs 10).
    const startHour = idx % 3 === 0 ? 10 : 9;
    const logRows: (typeof activityLogsTable.$inferInsert)[] = [];
    for (const day of days) {
      logRows.push(
        ...buildDayLogs(
          companyId,
          device.id,
          day,
          startHour,
          productiveCat.id,
          unproductiveCat.id,
        ),
      );
    }
    if (logRows.length > 0) {
      await db.insert(activityLogsTable).values(logRows);
      logsCreated += logRows.length;
    }
  }
  console.log(
    `Seeded ${devicesCreated} demo device(s) + token(s), 2 categories, and ${logsCreated} activity log(s) across ${days.length} working days into company ${companyId}.`,
  );
  console.log(`All rows are tagged "${MARKER}" — remove them with:  pnpm --filter @workspace/scripts run seed-dummy -- --clean`);
}

async function main(): Promise<void> {
  assertNotProduction();
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args: argv,
    options: {
      clean: { type: "boolean", default: false },
      "company-id": { type: "string" },
    },
  });

  const companyId = await resolveCompanyId(values["company-id"]);
  if (values.clean) {
    await clean(companyId);
  } else {
    await seed(companyId);
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await pool.end();
    process.exit(1);
  });

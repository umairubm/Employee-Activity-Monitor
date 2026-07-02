import { randomBytes, createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { and, eq, like, sql } from "drizzle-orm";
import {
  db,
  pool,
  companiesTable,
  devicesTable,
  enrollmentTokensTable,
} from "@workspace/db";

/**
 * DEV-ONLY dummy data seeder for the Devices / Tokens tables.
 *
 * Inserts a handful of fake enrollment tokens + enrolled devices so the
 * dashboard tables have something to look at during local testing. Every row
 * it creates is tagged with the `demo-seed-` marker (token string, hardware
 * hash) so `--clean` can remove ALL of them again without touching real data.
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
  console.log(
    `Removed ${devs.length} demo device(s) and ${toks.length} demo token(s).`,
  );
}

async function seed(companyId: string): Promise<void> {
  // Idempotent: clear any prior demo rows first so re-running doesn't pile up.
  await clean(companyId);

  const now = Date.now();
  let created = 0;
  for (const spec of DEMO_ROWS) {
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

    await db.insert(devicesTable).values({
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
    });
    created += 1;
  }
  console.log(`Seeded ${created} demo device(s) + token(s) into company ${companyId}.`);
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

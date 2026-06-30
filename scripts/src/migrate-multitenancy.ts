import { pool } from "@workspace/db";

/**
 * Idempotent, repeatable migration that retrofits the multi-tenant company
 * layer onto an existing single-tenant deployment.
 *
 * What it does (all guarded, safe to re-run):
 *   1. Role enum: rename legacy `admin` -> `company_admin`, add `manager`.
 *   2. Create the default tenant "UBM Technologies" (+ its security settings).
 *   3. Backfill `company_id` on every tenant-owned row to the default company.
 *      Super Users keep a NULL company_id (they live above all tenants).
 *
 * IMPORTANT: run the Drizzle schema push FIRST so the `companies` /
 * `company_security_settings` tables and every `company_id` column exist:
 *   pnpm --filter @workspace/db run push
 * then:
 *   pnpm --filter @workspace/scripts run migrate-multitenancy
 */

const DEFAULT_COMPANY_NAME = "UBM Technologies";

// Every tenant-owned table that carries a company_id and should be backfilled
// to the default company. `users` and `sessions` are handled separately because
// Super Users must keep a NULL company_id.
const BACKFILL_TABLES = [
  "devices",
  "enrollment_tokens",
  "activity_logs",
  "screenshots",
  "daily_summaries",
  "device_alerts",
  "device_commands",
  "app_categories",
  "attendance_settings",
  "projects",
  "tasks",
  "shifts",
  "leave_requests",
  "leave_balances",
] as const;

async function migrateEnum(): Promise<void> {
  // Rename admin -> company_admin only if the old label still exists and the
  // new one does not. This auto-migrates any existing `admin` user rows.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'user_role' AND e.enumlabel = 'admin'
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'user_role' AND e.enumlabel = 'company_admin'
      ) THEN
        ALTER TYPE user_role RENAME VALUE 'admin' TO 'company_admin';
      END IF;
    END $$;
  `);
  await pool.query(`ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'manager';`);
}

async function ensureDefaultCompany(): Promise<string> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM companies WHERE name = $1 LIMIT 1`,
    [DEFAULT_COMPANY_NAME],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO companies (name, status) VALUES ($1, 'active') RETURNING id`,
    [DEFAULT_COMPANY_NAME],
  );
  return inserted.rows[0].id;
}

async function ensureSecuritySettings(companyId: string): Promise<void> {
  await pool.query(
    `INSERT INTO company_security_settings (company_id)
     VALUES ($1)
     ON CONFLICT (company_id) DO NOTHING`,
    [companyId],
  );
}

async function backfill(companyId: string): Promise<void> {
  // Users: every non-super_user with no company belongs to the default tenant.
  const users = await pool.query(
    `UPDATE users SET company_id = $1
     WHERE company_id IS NULL AND role <> 'super_user'`,
    [companyId],
  );
  console.log(`  users: ${users.rowCount} rows`);

  for (const table of BACKFILL_TABLES) {
    const res = await pool.query(
      `UPDATE ${table} SET company_id = $1 WHERE company_id IS NULL`,
      [companyId],
    );
    console.log(`  ${table}: ${res.rowCount} rows`);
  }

  // Sessions inherit their owner's company (Super User sessions stay NULL).
  const sessions = await pool.query(
    `UPDATE sessions s SET company_id = u.company_id
     FROM users u
     WHERE s.user_id = u.id AND s.company_id IS NULL AND u.company_id IS NOT NULL`,
  );
  console.log(`  sessions: ${sessions.rowCount} rows`);
}

async function main(): Promise<void> {
  console.log("Migrating role enum...");
  await migrateEnum();

  console.log(`Ensuring default company "${DEFAULT_COMPANY_NAME}"...`);
  const companyId = await ensureDefaultCompany();
  await ensureSecuritySettings(companyId);
  console.log(`  company id: ${companyId}`);

  console.log("Backfilling company_id...");
  await backfill(companyId);

  console.log("Done.");
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    return pool.end().finally(() => process.exit(1));
  });

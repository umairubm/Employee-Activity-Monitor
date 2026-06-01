import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { db, enrollmentTokensTable, pool } from "@workspace/db";

/**
 * Mint an enrollment token an admin hands to a device operator. The agent uses
 * it once (or up to --max-uses times) at first run to enroll. This stands in for
 * an admin UI until user auth + an admin portal exist.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run mint-token -- \
 *     --label "Reception PC" --max-uses 1 --expires-days 7
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args: argv,
    options: {
      label: { type: "string" },
      "max-uses": { type: "string", default: "1" },
      "expires-days": { type: "string" },
    },
  });

  const maxUses = Number.parseInt(values["max-uses"] ?? "1", 10);
  if (!Number.isFinite(maxUses) || maxUses < 1) {
    throw new Error("--max-uses must be a positive integer");
  }

  let expiresAt: Date | null = null;
  if (values["expires-days"] !== undefined) {
    const days = Number.parseInt(values["expires-days"], 10);
    if (!Number.isFinite(days) || days < 1) {
      throw new Error("--expires-days must be a positive integer");
    }
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  const token = randomBytes(18).toString("base64url");

  const [row] = await db
    .insert(enrollmentTokensTable)
    .values({
      token,
      label: values.label ?? null,
      maxUses,
      expiresAt,
    })
    .returning();

  console.log("Enrollment token created:\n");
  console.log(`  token:      ${row.token}`);
  console.log(`  label:      ${row.label ?? "(none)"}`);
  console.log(`  maxUses:    ${row.maxUses}`);
  console.log(`  expiresAt:  ${row.expiresAt?.toISOString() ?? "(never)"}`);
  console.log("\nHand this token to the device operator for first-run enrollment.");
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await pool.end();
    process.exit(1);
  });

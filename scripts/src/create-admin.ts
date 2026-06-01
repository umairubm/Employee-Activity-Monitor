import { randomBytes, scryptSync } from "node:crypto";
import { parseArgs } from "node:util";
import { db, usersTable, pool } from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * Bootstrap an admin (super_user) account for the web dashboard. Until an
 * in-app user-management UI exists, this is how the first login is created.
 *
 * Password hashing must match artifacts/api-server/src/lib/passwords.ts:
 *   scrypt$<saltHex>$<hashHex>  (keylen 64)
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run create-admin -- \
 *     --username admin --email admin@example.com --password "S3cret!"
 */
function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args: argv,
    options: {
      username: { type: "string" },
      email: { type: "string" },
      password: { type: "string" },
      role: { type: "string", default: "super_user" },
    },
  });

  const username = values.username?.trim();
  const email = values.email?.trim();
  const password = values.password;
  const role = values.role ?? "super_user";

  if (!username || !email || !password) {
    throw new Error(
      "--username, --email and --password are all required",
    );
  }
  if (password.length < 8) {
    throw new Error("--password must be at least 8 characters");
  }
  if (!["super_user", "admin", "team_member"].includes(role)) {
    throw new Error("--role must be super_user, admin or team_member");
  }

  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.username, username));
  if (existing) {
    throw new Error(`A user named "${username}" already exists`);
  }

  const [row] = await db
    .insert(usersTable)
    .values({
      username,
      email,
      passwordHash: hashPassword(password),
      role: role as "super_user" | "admin" | "team_member",
    })
    .returning();

  console.log("Admin account created:\n");
  console.log(`  username: ${row.username}`);
  console.log(`  email:    ${row.email}`);
  console.log(`  role:     ${row.role}`);
  console.log("\nSign in at the dashboard with this username and password.");
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await pool.end();
    process.exit(1);
  });

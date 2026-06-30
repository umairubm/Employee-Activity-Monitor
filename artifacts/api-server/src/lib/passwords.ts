import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { db, companySecuritySettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const KEYLEN = 64;

/** Thrown when a candidate password fails its tenant's password policy. */
export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordPolicyError";
  }
}

/**
 * Enforce a tenant's configured password policy (min length + character-class
 * requirements from `company_security_settings`). Throws `PasswordPolicyError`
 * with a human-readable message when the password does not comply. Tenants
 * without a settings row fall back to a sane default (min length 8).
 */
export async function validatePasswordPolicy(
  companyId: string,
  password: string,
): Promise<void> {
  const [settings] = await db
    .select()
    .from(companySecuritySettingsTable)
    .where(eq(companySecuritySettingsTable.companyId, companyId));

  const minLength = settings?.passwordMinLength ?? 8;
  const requireUppercase = settings?.passwordRequireUppercase ?? false;
  const requireNumber = settings?.passwordRequireNumber ?? false;
  const requireSymbol = settings?.passwordRequireSymbol ?? false;

  const failures: string[] = [];
  if (password.length < minLength) {
    failures.push(`be at least ${minLength} characters long`);
  }
  if (requireUppercase && !/[A-Z]/.test(password)) {
    failures.push("contain an uppercase letter");
  }
  if (requireNumber && !/[0-9]/.test(password)) {
    failures.push("contain a number");
  }
  if (requireSymbol && !/[^A-Za-z0-9]/.test(password)) {
    failures.push("contain a symbol");
  }
  if (failures.length > 0) {
    throw new PasswordPolicyError(`Password must ${failures.join(", ")}.`);
  }
}

/** Hash a plaintext password as `scrypt$<saltHex>$<hashHex>`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEYLEN);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/** Constant-time verification of a plaintext password against a stored hash. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const derived = scryptSync(password, salt, expected.length);
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

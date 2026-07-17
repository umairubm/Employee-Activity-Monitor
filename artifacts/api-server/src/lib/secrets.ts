import { createHash, randomBytes, randomInt, timingSafeEqual } from "crypto";

/**
 * Human-readable one-time password-reset code (e.g. "K7FQ-2MXR"), from an
 * unambiguous alphabet (no 0/O/1/I/L). Handed to the user out-of-band by an
 * admin; only its SHA-256 hash is stored.
 */
export function generateResetCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const pick = () => alphabet[randomInt(alphabet.length)];
  const block = (n: number) => Array.from({ length: n }, pick).join("");
  return `${block(4)}-${block(4)}`;
}

/** High-entropy device API secret, shown to the agent once at enrollment. */
export function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

/** Human-distributable enrollment token an admin hands to a device. */
export function generateEnrollmentToken(): string {
  return randomBytes(18).toString("base64url");
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Constant-time comparison of two hex-encoded digests. */
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

import { createHash, randomBytes, timingSafeEqual } from "crypto";

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

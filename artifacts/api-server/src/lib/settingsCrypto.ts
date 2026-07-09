import crypto from "node:crypto";

/**
 * At-rest encryption for operator-entered credentials stored in the DB
 * (e.g. Dropbox app secret / refresh token on `storage_settings`).
 *
 * AES-256-GCM with a key derived from SESSION_SECRET. This is not an HSM, but
 * it keeps raw secrets out of DB dumps/backups: an attacker needs BOTH the
 * database and the runtime environment to recover them.
 *
 * Format: base64(iv) + ":" + base64(authTag) + ":" + base64(ciphertext)
 */

function key(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is required to encrypt stored credentials");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptSetting(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${data.toString("base64")}`;
}

export function decryptSetting(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed encrypted setting payload");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, devicesTable, type Device } from "@workspace/db";
import { hashSecret, safeEqualHex } from "../lib/secrets";

export interface DeviceRequest extends Request {
  device: Device;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Authenticates an agent request using the per-device id + secret issued at
 * enrollment. The secret is compared against its stored SHA-256 hash.
 */
export async function deviceAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const deviceId = req.header("x-device-id");
  const deviceSecret = req.header("x-device-secret");

  if (!deviceId || !deviceSecret || !UUID_RE.test(deviceId)) {
    res.status(401).json({ error: "Missing or malformed device credentials" });
    return;
  }

  const [device] = await db
    .select()
    .from(devicesTable)
    .where(eq(devicesTable.id, deviceId));

  if (!device || !safeEqualHex(device.secretHash, hashSecret(deviceSecret))) {
    res.status(401).json({ error: "Invalid device credentials" });
    return;
  }

  // Transparency invariant: no monitoring traffic is accepted from a device that
  // has not recorded user consent, even with otherwise-valid credentials.
  if (device.consentAcknowledgedAt === null) {
    res.status(403).json({ error: "Device consent not recorded" });
    return;
  }

  (req as DeviceRequest).device = device;
  next();
}

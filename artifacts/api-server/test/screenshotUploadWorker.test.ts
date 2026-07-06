import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, devicesTable, screenshotsTable, pool } from "@workspace/db";
import {
  finalizeUploaded,
  finalizeFailed,
} from "../src/lib/screenshotUploadWorker";
import { createDeviceWithSecret } from "./helpers";

const createdDeviceIds: string[] = [];

afterAll(async () => {
  if (createdDeviceIds.length) {
    // Screenshots cascade-delete with their device.
    await db
      .delete(devicesTable)
      .where(inArray(devicesTable.id, createdDeviceIds));
  }
  await pool.end();
});

async function stagePendingScreenshot(deviceId: string, leaseUntil: Date) {
  const [row] = await db
    .insert(screenshotsTable)
    .values({
      deviceId,
      status: "pending",
      pendingData: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
      contentType: "image/jpeg",
      contentHash: `hash-${crypto.randomUUID()}`,
      fileSizeBytes: 7,
      capturedAt: new Date(),
      // Simulate a claim by pre-setting the lease timestamp the worker would write.
      nextAttemptAt: leaseUntil,
    })
    .returning({ id: screenshotsTable.id });
  return row.id;
}

describe("upload worker lease safety (no stale-worker corruption)", () => {
  it("a stale worker cannot revert an already-uploaded row to failed", async () => {
    const { device } = await createDeviceWithSecret();
    createdDeviceIds.push(device.id);

    const leaseA = new Date(Date.now() + 120_000);
    const id = await stagePendingScreenshot(device.id, leaseA);

    // The lease-holding worker finishes the upload successfully.
    const uploaded = await finalizeUploaded(id, leaseA, "/AgentImages/x.jpg");
    expect(uploaded).toBe(1);

    // A stale worker (whose Dropbox call overran the lease) now tries to record
    // a failure with the SAME lease it originally held. next_attempt_at is now
    // null (cleared on success), so the guarded update must no-op.
    const reverted = await finalizeFailed(id, leaseA, "late failure");
    expect(reverted).toBe(0);

    const [shot] = await db
      .select()
      .from(screenshotsTable)
      .where(eq(screenshotsTable.id, id));
    expect(shot.status).toBe("uploaded");
    expect(shot.dropboxPath).toBe("/AgentImages/x.jpg");
    expect(shot.pendingData).toBeNull();
  });

  it("only the current lease-holder can finalize a re-claimed row", async () => {
    const { device } = await createDeviceWithSecret();
    createdDeviceIds.push(device.id);

    const leaseA = new Date(Date.now() + 120_000);
    const id = await stagePendingScreenshot(device.id, leaseA);

    // The lease expires and another worker re-claims the row (new lease B).
    const leaseB = new Date(Date.now() + 240_000);
    await db
      .update(screenshotsTable)
      .set({ nextAttemptAt: leaseB })
      .where(eq(screenshotsTable.id, id));

    // The original (now stale) worker's write is rejected...
    const stale = await finalizeUploaded(id, leaseA, "/AgentImages/stale.jpg");
    expect(stale).toBe(0);

    // ...while the current lease-holder's write is applied.
    const current = await finalizeUploaded(id, leaseB, "/AgentImages/current.jpg");
    expect(current).toBe(1);

    const [shot] = await db
      .select()
      .from(screenshotsTable)
      .where(eq(screenshotsTable.id, id));
    expect(shot.status).toBe("uploaded");
    expect(shot.dropboxPath).toBe("/AgentImages/current.jpg");
  });
});

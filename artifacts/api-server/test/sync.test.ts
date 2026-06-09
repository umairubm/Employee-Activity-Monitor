import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  devicesTable,
  enrollmentTokensTable,
  activityLogsTable,
  screenshotsTable,
  deviceCommandsTable,
  pool,
} from "@workspace/db";
import {
  createDevice,
  createDeviceWithSecret,
  createDeviceCommand,
  createEnrollmentToken,
  makeSyncApp,
} from "./helpers";

const app = makeSyncApp();
const createdDeviceIds: string[] = [];
const createdTokenIds: string[] = [];

function trackDevice(id: string): string {
  createdDeviceIds.push(id);
  return id;
}

afterAll(async () => {
  if (createdDeviceIds.length) {
    // Activity logs + screenshots cascade-delete with their device.
    await db
      .delete(devicesTable)
      .where(inArray(devicesTable.id, createdDeviceIds));
  }
  if (createdTokenIds.length) {
    await db
      .delete(enrollmentTokensTable)
      .where(inArray(enrollmentTokensTable.id, createdTokenIds));
  }
  await pool.end();
});

/** A minimal, valid enrollment body for a brand-new machine. */
function enrollBody(token: string) {
  return {
    token,
    hardwareHash: `hw-${randomUUID()}`,
    systemName: "Test PC",
    osType: "linux" as const,
    agentVersion: "1.0.0",
    consentAcknowledged: true as const,
    consentName: "Jane Operator",
  };
}

describe("POST /sync/enroll", () => {
  it("issues a device + one-time secret and records consent for a valid token", async () => {
    const token = await createEnrollmentToken();
    createdTokenIds.push(token.id);

    const res = await request(app).post("/sync/enroll").send(enrollBody(token.token));

    expect(res.status).toBe(201);
    expect(res.body.deviceId).toBeTruthy();
    // The plaintext secret is high-entropy and returned exactly once here.
    expect(typeof res.body.deviceSecret).toBe("string");
    expect(res.body.deviceSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.config).toMatchObject({ monitoringEnabled: true });

    const deviceId = trackDevice(res.body.deviceId);

    // The secret is persisted only as a hash, never in plaintext.
    const [row] = await db
      .select()
      .from(devicesTable)
      .where(eq(devicesTable.id, deviceId));
    expect(row.secretHash).not.toBe(res.body.deviceSecret);
    expect(row.consentAcknowledgedAt).not.toBeNull();
    expect(row.consentName).toBe("Jane Operator");

    // The token use was claimed.
    const [tk] = await db
      .select()
      .from(enrollmentTokensTable)
      .where(eq(enrollmentTokensTable.id, token.id));
    expect(tk.useCount).toBe(1);
  });

  it("rejects an unknown token with 403 and creates no device", async () => {
    const before = await db.select().from(devicesTable);
    const res = await request(app)
      .post("/sync/enroll")
      .send(enrollBody(`missing-${randomUUID()}`));

    expect(res.status).toBe(403);
    const after = await db.select().from(devicesTable);
    expect(after.length).toBe(before.length);
  });

  it("rejects an expired token with 403", async () => {
    const token = await createEnrollmentToken({
      expiresAt: new Date(Date.now() - 60_000),
    });
    createdTokenIds.push(token.id);

    const res = await request(app).post("/sync/enroll").send(enrollBody(token.token));
    expect(res.status).toBe(403);
  });

  it("rejects a revoked token with 403", async () => {
    const token = await createEnrollmentToken({ revokedAt: new Date() });
    createdTokenIds.push(token.id);

    const res = await request(app).post("/sync/enroll").send(enrollBody(token.token));
    expect(res.status).toBe(403);
  });

  it("rejects an over-used token with 403", async () => {
    const token = await createEnrollmentToken({ maxUses: 1, useCount: 1 });
    createdTokenIds.push(token.id);

    const res = await request(app).post("/sync/enroll").send(enrollBody(token.token));
    expect(res.status).toBe(403);
  });

  it("rejects enrollment without an explicit consent acknowledgement (400)", async () => {
    const token = await createEnrollmentToken();
    createdTokenIds.push(token.id);

    const body = enrollBody(token.token);
    const res = await request(app)
      .post("/sync/enroll")
      .send({ ...body, consentAcknowledged: false });

    expect(res.status).toBe(400);
    // The token use must not be claimed by a rejected enrollment.
    const [tk] = await db
      .select()
      .from(enrollmentTokensTable)
      .where(eq(enrollmentTokensTable.id, token.id));
    expect(tk.useCount).toBe(0);
  });

  it("only allows the token to be used up to maxUses across enrollments", async () => {
    const token = await createEnrollmentToken({ maxUses: 1 });
    createdTokenIds.push(token.id);

    const first = await request(app).post("/sync/enroll").send(enrollBody(token.token));
    expect(first.status).toBe(201);
    trackDevice(first.body.deviceId);

    const second = await request(app)
      .post("/sync/enroll")
      .send(enrollBody(token.token));
    expect(second.status).toBe(403);
  });

  it("lets only one of two concurrent new enrollments claim a single-use token", async () => {
    // Two *different* machines race to claim the same maxUses:1 token at the
    // exact same time. The atomic "claim one use" UPDATE in the enroll
    // transaction must let exactly one win — the other must be rejected — so the
    // token can never be over-claimed.
    const token = await createEnrollmentToken({ maxUses: 1 });
    createdTokenIds.push(token.id);

    const [a, b] = await Promise.all([
      request(app).post("/sync/enroll").send(enrollBody(token.token)),
      request(app).post("/sync/enroll").send(enrollBody(token.token)),
    ]);

    // Track any device rows that were created so cleanup removes them.
    for (const res of [a, b]) {
      if (res.status === 201) trackDevice(res.body.deviceId);
    }

    // Exactly one 201 and one 403 — never two winners, never two losers.
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 403]);

    const winner = a.status === 201 ? a : b;
    expect(winner.body.deviceId).toBeTruthy();
    expect(winner.body.deviceSecret).toMatch(/^[0-9a-f]{64}$/);

    const loser = a.status === 201 ? b : a;
    expect(loser.body).toMatchObject({
      error: "Enrollment token invalid or exhausted",
    });

    // The token use is claimed exactly once despite two concurrent attempts.
    const [tk] = await db
      .select()
      .from(enrollmentTokensTable)
      .where(eq(enrollmentTokensTable.id, token.id));
    expect(tk.useCount).toBe(1);

    // Only one device row was actually created from this token race.
    const created = await db
      .select()
      .from(devicesTable)
      .where(eq(devicesTable.id, winner.body.deviceId));
    expect(created.length).toBe(1);
  });

  it("lets exactly maxUses of N concurrent new enrollments claim a multi-use token", async () => {
    // The general case of the single-use race: N *different* machines race to
    // claim the same maxUses:M token at the exact same time (N > M). The atomic
    // "claim one use" UPDATE — gated on useCount < maxUses — must let exactly M
    // win and reject the rest, so the token can never be over-claimed.
    const N = 5;
    const M = 2;
    const token = await createEnrollmentToken({ maxUses: M });
    createdTokenIds.push(token.id);

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        request(app).post("/sync/enroll").send(enrollBody(token.token)),
      ),
    );

    // Track any device rows that were created so cleanup removes them.
    for (const res of results) {
      if (res.status === 201) trackDevice(res.body.deviceId);
    }

    const winners = results.filter((r) => r.status === 201);
    const losers = results.filter((r) => r.status === 403);

    // Exactly M winners and N - M losers — never an over-claim.
    expect(winners).toHaveLength(M);
    expect(losers).toHaveLength(N - M);

    for (const res of winners) {
      expect(res.body.deviceId).toBeTruthy();
      expect(res.body.deviceSecret).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const res of losers) {
      expect(res.body).toMatchObject({
        error: "Enrollment token invalid or exhausted",
      });
    }

    // The token's use count lands at exactly M despite N concurrent attempts.
    const [tk] = await db
      .select()
      .from(enrollmentTokensTable)
      .where(eq(enrollmentTokensTable.id, token.id));
    expect(tk.useCount).toBe(M);

    // Exactly M device rows were created from this token race.
    const winnerIds = winners.map((r) => r.body.deviceId as string);
    const created = await db
      .select()
      .from(devicesTable)
      .where(inArray(devicesTable.id, winnerIds));
    expect(created.length).toBe(M);
  });

  it("lets a known machine re-enroll concurrently without burning extra uses", async () => {
    // Re-enrollment (same hardwareHash) must be unaffected by the single-use
    // race protection: it never consumes a token use, so even two simultaneous
    // re-enrollments of an already-enrolled device both succeed and leave
    // useCount at its first-enrollment value.
    const token = await createEnrollmentToken({ maxUses: 1 });
    createdTokenIds.push(token.id);
    const hardwareHash = `hw-${randomUUID()}`;

    // First establish the device row (claims the one and only use).
    const first = await request(app)
      .post("/sync/enroll")
      .send({ ...enrollBody(token.token), hardwareHash });
    expect(first.status).toBe(201);
    trackDevice(first.body.deviceId);

    const [a, b] = await Promise.all([
      request(app)
        .post("/sync/enroll")
        .send({ ...enrollBody(token.token), hardwareHash }),
      request(app)
        .post("/sync/enroll")
        .send({ ...enrollBody(token.token), hardwareHash }),
    ]);

    // Both concurrent re-enrollments succeed against the same device row.
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.deviceId).toBe(first.body.deviceId);
    expect(b.body.deviceId).toBe(first.body.deviceId);

    // No extra token uses were burned by re-enrollment.
    const [tk] = await db
      .select()
      .from(enrollmentTokensTable)
      .where(eq(enrollmentTokensTable.id, token.id));
    expect(tk.useCount).toBe(1);

    // Still exactly one device row for this hardwareHash.
    const rows = await db
      .select()
      .from(devicesTable)
      .where(eq(devicesTable.hardwareHash, hardwareHash));
    expect(rows.length).toBe(1);
  });
});

describe("POST /sync/enroll (re-enrollment of a known machine)", () => {
  it("reuses the same device row and rotates the secret for a known hardwareHash", async () => {
    // A single-use token: the first enrollment exhausts it, yet the same
    // machine must still be able to re-enroll without burning a (non-existent)
    // additional use.
    const token = await createEnrollmentToken({ maxUses: 1 });
    createdTokenIds.push(token.id);

    // First enrollment establishes the device row + its original secret.
    const hardwareHash = `hw-${randomUUID()}`;
    const first = await request(app)
      .post("/sync/enroll")
      .send({ ...enrollBody(token.token), hardwareHash });
    expect(first.status).toBe(201);
    const deviceId = trackDevice(first.body.deviceId);
    const firstSecret = first.body.deviceSecret as string;

    // The first (and only) token use was claimed.
    const [tkAfterFirst] = await db
      .select()
      .from(enrollmentTokensTable)
      .where(eq(enrollmentTokensTable.id, token.id));
    expect(tkAfterFirst.useCount).toBe(1);

    const [before] = await db
      .select()
      .from(devicesTable)
      .where(eq(devicesTable.id, deviceId));

    // Re-enroll the same machine (same hardwareHash) with a fresh consent name.
    const second = await request(app)
      .post("/sync/enroll")
      .send({
        ...enrollBody(token.token),
        hardwareHash,
        consentName: "Second Operator",
      });
    expect(second.status).toBe(201);
    const secondSecret = second.body.deviceSecret as string;

    // Re-enrollment of a known machine must NOT consume another token use.
    const [tkAfterSecond] = await db
      .select()
      .from(enrollmentTokensTable)
      .where(eq(enrollmentTokensTable.id, token.id));
    expect(tkAfterSecond.useCount).toBe(1);

    // Same device row is returned, not a new one.
    expect(second.body.deviceId).toBe(deviceId);

    // A genuinely new secret is issued.
    expect(secondSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(secondSecret).not.toBe(firstSecret);

    // No duplicate device row was created for this hardwareHash.
    const rows = await db
      .select()
      .from(devicesTable)
      .where(eq(devicesTable.hardwareHash, hardwareHash));
    expect(rows.length).toBe(1);

    // The new secret authenticates; the old one no longer does.
    const withNew = await request(app)
      .post("/sync/heartbeat")
      .set("x-device-id", deviceId)
      .set("x-device-secret", secondSecret)
      .send({});
    expect(withNew.status).toBe(200);

    const withOld = await request(app)
      .post("/sync/heartbeat")
      .set("x-device-id", deviceId)
      .set("x-device-secret", firstSecret)
      .send({});
    expect(withOld.status).toBe(401);

    // Consent name/timestamp are refreshed; the original enrolledAt is preserved.
    const [after] = await db
      .select()
      .from(devicesTable)
      .where(eq(devicesTable.id, deviceId));
    expect(after.consentName).toBe("Second Operator");
    expect(after.consentAcknowledgedAt).not.toBeNull();
    expect(after.consentAcknowledgedAt!.getTime()).toBeGreaterThanOrEqual(
      before.consentAcknowledgedAt!.getTime(),
    );
    expect(after.enrolledAt!.getTime()).toBe(before.enrolledAt!.getTime());
  });
});

describe("device authentication on /sync (deviceAuth)", () => {
  it("rejects sync calls with no credentials (401)", async () => {
    const res = await request(app).post("/sync/heartbeat").send({});
    expect(res.status).toBe(401);
  });

  it("rejects a malformed device id (401)", async () => {
    const res = await request(app)
      .post("/sync/heartbeat")
      .set("x-device-id", "not-a-uuid")
      .set("x-device-secret", "whatever")
      .send({});
    expect(res.status).toBe(401);
  });

  it("rejects a valid device id with the wrong secret (401)", async () => {
    const { device } = await createDeviceWithSecret();
    trackDevice(device.id);

    const res = await request(app)
      .post("/sync/heartbeat")
      .set("x-device-id", device.id)
      .set("x-device-secret", "0".repeat(64))
      .send({});
    expect(res.status).toBe(401);
  });

  it("rejects an unknown device id with a well-formed secret (401)", async () => {
    const res = await request(app)
      .post("/sync/heartbeat")
      .set("x-device-id", randomUUID())
      .set("x-device-secret", "0".repeat(64))
      .send({});
    expect(res.status).toBe(401);
  });

  it("accepts a heartbeat with valid credentials and recorded consent", async () => {
    const { device, secret } = await createDeviceWithSecret();
    trackDevice(device.id);

    const res = await request(app)
      .post("/sync/heartbeat")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.config).toMatchObject({ monitoringEnabled: true });
  });
});

describe("server-side consent enforcement", () => {
  it("rejects activity from a credentialed device that has not consented (403)", async () => {
    const { device, secret } = await createDeviceWithSecret({ consent: false });
    trackDevice(device.id);

    const res = await request(app)
      .post("/sync/activity")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({
        logs: [
          {
            processName: "code",
            windowTitle: "editor",
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            durationSeconds: 60,
          },
        ],
      });
    expect(res.status).toBe(403);

    // Nothing was written for the unconsented device.
    const rows = await db
      .select()
      .from(activityLogsTable)
      .where(eq(activityLogsTable.deviceId, device.id));
    expect(rows.length).toBe(0);
  });

  it("rejects screenshot metadata from an unconsented device (403)", async () => {
    const { device, secret } = await createDeviceWithSecret({ consent: false });
    trackDevice(device.id);

    const res = await request(app)
      .post("/sync/screenshots")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({
        storageKey: `/objects/uploads/${randomUUID()}`,
        capturedAt: new Date().toISOString(),
        fileSizeBytes: 1000,
      });
    expect(res.status).toBe(403);
  });

  it("accepts activity once consent is recorded (201)", async () => {
    const { device, secret } = await createDeviceWithSecret({ consent: true });
    trackDevice(device.id);

    const res = await request(app)
      .post("/sync/activity")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({
        logs: [
          {
            processName: "code",
            windowTitle: "editor",
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            durationSeconds: 60,
          },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.accepted).toBe(1);
  });
});

describe("screenshot upload uses the presigned-URL + storageKey path", () => {
  it("returns a presigned upload URL and a normalized storage key", async () => {
    const { device, secret } = await createDeviceWithSecret();
    trackDevice(device.id);

    const res = await request(app)
      .post("/sync/screenshots/request-url")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({});
    expect(res.status).toBe(200);
    expect(typeof res.body.uploadURL).toBe("string");
    expect(res.body.uploadURL).toMatch(/^https?:\/\//);
    // The agent reports back this key; the API never receives image bytes.
    expect(res.body.storageKey).toMatch(/^\/objects\/uploads\/[0-9a-fA-F-]{36}$/);
  });

  it("records only metadata for a well-formed storage key (201, no bytes)", async () => {
    const { device, secret } = await createDeviceWithSecret();
    trackDevice(device.id);

    const storageKey = `/objects/uploads/${randomUUID()}`;
    const res = await request(app)
      .post("/sync/screenshots")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({
        storageKey,
        capturedAt: new Date().toISOString(),
        fileSizeBytes: 2048,
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();

    const [shot] = await db
      .select()
      .from(screenshotsTable)
      .where(eq(screenshotsTable.id, res.body.id));
    expect(shot.deviceId).toBe(device.id);
    expect(shot.storageKey).toBe(storageKey);
    expect(shot.fileSizeBytes).toBe(2048);
  });

  it("rejects an arbitrary storage key not issued by request-url (400)", async () => {
    const { device, secret } = await createDeviceWithSecret();
    trackDevice(device.id);

    const res = await request(app)
      .post("/sync/screenshots")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({
        storageKey: "/etc/passwd",
        capturedAt: new Date().toISOString(),
        fileSizeBytes: 10,
      });
    expect(res.status).toBe(400);
  });
});

describe("IT command dispatch via heartbeat", () => {
  it("returns this device's pending commands and not other devices' commands", async () => {
    const { device, secret } = await createDeviceWithSecret();
    trackDevice(device.id);
    const other = await createDeviceWithSecret();
    trackDevice(other.device.id);

    const lock = await createDeviceCommand(device.id, {
      commandType: "lock_screen",
      payload: "now",
      reason: "policy violation",
    });
    const logout = await createDeviceCommand(device.id, {
      commandType: "logout_user",
    });
    // A command for another device must never leak into this heartbeat.
    await createDeviceCommand(other.device.id, { commandType: "lock_screen" });

    const res = await request(app)
      .post("/sync/heartbeat")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({});

    expect(res.status).toBe(200);
    const ids = (res.body.commands as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(lock.id);
    expect(ids).toContain(logout.id);

    const lockCmd = (
      res.body.commands as Array<{
        id: string;
        commandType: string;
        payload: string | null;
        reason: string | null;
      }>
    ).find((c) => c.id === lock.id);
    expect(lockCmd).toMatchObject({
      commandType: "lock_screen",
      payload: "now",
      reason: "policy violation",
    });
  });

  it("excludes commands that are not pending", async () => {
    const { device, secret } = await createDeviceWithSecret();
    trackDevice(device.id);

    const pending = await createDeviceCommand(device.id);
    // Already-acknowledged / completed / failed work must not be re-dispatched.
    await createDeviceCommand(device.id, { status: "acknowledged" });
    await createDeviceCommand(device.id, { status: "completed" });
    await createDeviceCommand(device.id, { status: "failed" });

    const res = await request(app)
      .post("/sync/heartbeat")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({});

    expect(res.status).toBe(200);
    const ids = (res.body.commands as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toEqual([pending.id]);
  });
});

describe("POST /sync/commands/ack", () => {
  it("moves a command pending -> acknowledged and stamps acknowledgedAt", async () => {
    const { device, secret } = await createDeviceWithSecret();
    trackDevice(device.id);
    const command = await createDeviceCommand(device.id);

    const res = await request(app)
      .post("/sync/commands/ack")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({ commandId: command.id, status: "acknowledged" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: command.id, status: "acknowledged" });

    const [row] = await db
      .select()
      .from(deviceCommandsTable)
      .where(eq(deviceCommandsTable.id, command.id));
    expect(row.status).toBe("acknowledged");
    expect(row.acknowledgedAt).not.toBeNull();
    // Terminal timestamp is only set once the command reaches a terminal state.
    expect(row.completedAt).toBeNull();
  });

  it("moves an acknowledged command -> completed and stamps completedAt", async () => {
    const { device, secret } = await createDeviceWithSecret();
    trackDevice(device.id);
    const acknowledgedAt = new Date(Date.now() - 60_000);
    const command = await createDeviceCommand(device.id, {
      status: "acknowledged",
      acknowledgedAt,
    });

    const res = await request(app)
      .post("/sync/commands/ack")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({ commandId: command.id, status: "completed" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: command.id, status: "completed" });

    const [row] = await db
      .select()
      .from(deviceCommandsTable)
      .where(eq(deviceCommandsTable.id, command.id));
    expect(row.status).toBe("completed");
    expect(row.completedAt).not.toBeNull();
    // The earlier acknowledgement timestamp is preserved.
    expect(row.acknowledgedAt?.getTime()).toBe(acknowledgedAt.getTime());
  });

  it("moves a command -> failed and stamps completedAt", async () => {
    const { device, secret } = await createDeviceWithSecret();
    trackDevice(device.id);
    const command = await createDeviceCommand(device.id, {
      commandType: "logout_user",
    });

    const res = await request(app)
      .post("/sync/commands/ack")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({ commandId: command.id, status: "failed" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: command.id, status: "failed" });

    const [row] = await db
      .select()
      .from(deviceCommandsTable)
      .where(eq(deviceCommandsTable.id, command.id));
    expect(row.status).toBe("failed");
    expect(row.completedAt).not.toBeNull();
  });

  it("returns 404 and changes nothing when acking another device's command", async () => {
    const { device, secret } = await createDeviceWithSecret();
    trackDevice(device.id);
    const victim = await createDeviceWithSecret();
    trackDevice(victim.device.id);

    // A command that belongs to the victim device, not the caller.
    const command = await createDeviceCommand(victim.device.id);

    const res = await request(app)
      .post("/sync/commands/ack")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({ commandId: command.id, status: "completed" });

    expect(res.status).toBe(404);

    // The victim's command is untouched: still pending, no timestamps stamped.
    const [row] = await db
      .select()
      .from(deviceCommandsTable)
      .where(eq(deviceCommandsTable.id, command.id));
    expect(row.status).toBe("pending");
    expect(row.acknowledgedAt).toBeNull();
    expect(row.completedAt).toBeNull();
  });

  it("returns 404 for a command id that does not exist", async () => {
    const { device, secret } = await createDeviceWithSecret();
    trackDevice(device.id);

    const res = await request(app)
      .post("/sync/commands/ack")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({ commandId: randomUUID(), status: "completed" });

    expect(res.status).toBe(404);
  });
});

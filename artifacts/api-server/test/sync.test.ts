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

/**
 * A minimal buffer that begins with the JPEG magic bytes (0xFF 0xD8 0xFF), so
 * the server's magic-byte sniff accepts it. The trailing bytes make each call
 * unique enough for size assertions; pass a seed to vary the content hash.
 */
function jpegBytes(seed = 0): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from([seed & 0xff]),
    Buffer.alloc(32, seed & 0xff),
  ]);
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

describe("POST /sync/validate-token", () => {
  it("validates a usable token without consuming it", async () => {
    const token = await createEnrollmentToken({ maxUses: 2 });
    createdTokenIds.push(token.id);

    const res = await request(app)
      .post("/sync/validate-token")
      .send({ token: token.token });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true });

    const [stored] = await db
      .select()
      .from(enrollmentTokensTable)
      .where(eq(enrollmentTokensTable.id, token.id));
    expect(stored.useCount).toBe(token.useCount);
  });

  it.each([
    ["unknown", { token: `missing-${randomUUID()}` }],
    ["missing", {}],
  ])("rejects a %s token", async (_case, body) => {
    const res = await request(app).post("/sync/validate-token").send(body);

    expect([400, 403]).toContain(res.status);
    expect(res.body.valid).toBe(false);
  });

  it("rejects an exhausted token", async () => {
    const token = await createEnrollmentToken({ maxUses: 1, useCount: 1 });
    createdTokenIds.push(token.id);

    const res = await request(app)
      .post("/sync/validate-token")
      .send({ token: token.token });

    expect(res.status).toBe(403);
    expect(res.body.valid).toBe(false);
  });
});

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
    // The device records which token it enrolled with so admins can trace it.
    expect(row.enrolledViaTokenId).toBe(token.id);

    // The token use was claimed.
    const [tk] = await db
      .select()
      .from(enrollmentTokensTable)
      .where(eq(enrollmentTokensTable.id, token.id));
    expect(tk.useCount).toBe(1);
  });

  it("inherits the token's deviceGroup on first enrollment", async () => {
    const token = await createEnrollmentToken({ deviceGroup: "Engineering" });
    createdTokenIds.push(token.id);

    const res = await request(app).post("/sync/enroll").send(enrollBody(token.token));
    expect(res.status).toBe(201);
    const deviceId = trackDevice(res.body.deviceId);

    const [row] = await db
      .select()
      .from(devicesTable)
      .where(eq(devicesTable.id, deviceId));
    expect(row.deviceGroup).toBe("Engineering");
  });

  it("re-enrolling with a token that carries a group moves the device into it", async () => {
    const hardwareHash = `hw-${randomUUID()}`;

    const first = await createEnrollmentToken({ maxUses: 5, deviceGroup: "Sales" });
    createdTokenIds.push(first.id);
    const firstRes = await request(app)
      .post("/sync/enroll")
      .send({ ...enrollBody(first.token), hardwareHash });
    expect(firstRes.status).toBe(201);
    const deviceId = trackDevice(firstRes.body.deviceId);

    const second = await createEnrollmentToken({ maxUses: 5, deviceGroup: "Support" });
    createdTokenIds.push(second.id);
    const secondRes = await request(app)
      .post("/sync/enroll")
      .send({ ...enrollBody(second.token), hardwareHash });
    expect(secondRes.status).toBe(201);
    expect(secondRes.body.deviceId).toBe(deviceId);

    const [row] = await db
      .select()
      .from(devicesTable)
      .where(eq(devicesTable.id, deviceId));
    expect(row.deviceGroup).toBe("Support");
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

  it("persists the reported wall-clock offset and keeps it when omitted", async () => {
    const { device, secret } = await createDeviceWithSecret();
    trackDevice(device.id);

    const res = await request(app)
      .post("/sync/heartbeat")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({ tzOffsetMinutes: 720 });
    expect(res.status).toBe(200);

    let [row] = await db
      .select()
      .from(devicesTable)
      .where(eq(devicesTable.id, device.id));
    expect(row.tzOffsetMinutes).toBe(720);

    // A later heartbeat without the field must not clear the stored offset.
    const res2 = await request(app)
      .post("/sync/heartbeat")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({});
    expect(res2.status).toBe(200);
    [row] = await db
      .select()
      .from(devicesTable)
      .where(eq(devicesTable.id, device.id));
    expect(row.tzOffsetMinutes).toBe(720);
  });

  it("rejects an out-of-range wall-clock offset (400)", async () => {
    const { device, secret } = await createDeviceWithSecret();
    trackDevice(device.id);

    const res = await request(app)
      .post("/sync/heartbeat")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({ tzOffsetMinutes: 5000 });
    expect(res.status).toBe(400);
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

  it("rejects a screenshot upload from an unconsented device (403)", async () => {
    const { device, secret } = await createDeviceWithSecret({ consent: false });
    trackDevice(device.id);

    const res = await request(app)
      .post("/sync/screenshots")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .set("Content-Type", "image/jpeg")
      .set("x-captured-at", new Date().toISOString())
      .send(jpegBytes());
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
            url: "https://example.com/work-item/123",
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            durationSeconds: 60,
          },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.accepted).toBe(1);

    const [stored] = await db
      .select({ url: activityLogsTable.url })
      .from(activityLogsTable)
      .where(eq(activityLogsTable.deviceId, device.id));
    expect(stored.url).toBe("https://example.com/work-item/123");

    const [activeDevice] = await db
      .select({ lastSeenAt: devicesTable.lastSeenAt })
      .from(devicesTable)
      .where(eq(devicesTable.id, device.id));
    expect(activeDevice.lastSeenAt).not.toBeNull();
    expect(Date.now() - activeDevice.lastSeenAt!.getTime()).toBeLessThan(5_000);
  });

  it("accepts and acknowledges interval telemetry from agent 1.1.83", async () => {
    const { device, secret } = await createDeviceWithSecret({ consent: true });
    trackDevice(device.id);
    const batchId = randomUUID();
    const segmentId = randomUUID();
    const now = Date.now();

    const payload = {
      batchId,
      logs: [
        {
          segmentId,
          sequenceNamespace: randomUUID(),
          sequence: 1,
          processName: "chrome.exe",
          windowTitle: "Work item",
          url: "https://example.com/work-item/456",
          startedAt: new Date(now - 90_000).toISOString(),
          endedAt: new Date(now).toISOString(),
          elapsedMilliseconds: 90_000,
          engagementState: "active",
          sessionState: "unlocked",
          connectivityState: "online",
          transitionReason: "foreground_changed",
          policyVersion: "default",
        },
      ],
      hardwareChanges: { "Host Name": "Interval-PC" },
    };

    const first = await request(app)
      .post("/sync/activity")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send(payload);

    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      batchId,
      acceptedSegmentIds: [segmentId],
      rejected: [],
    });

    // Retrying the same durable segment is acknowledged but never duplicated.
    const retry = await request(app)
      .post("/sync/activity")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send(payload);
    expect(retry.status).toBe(201);
    expect(retry.body.acceptedSegmentIds).toEqual([segmentId]);

    const rows = await db
      .select()
      .from(activityLogsTable)
      .where(eq(activityLogsTable.deviceId, device.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      segmentId,
      processName: "chrome.exe",
      engagementState: "active",
      sessionState: "unlocked",
      connectivityState: "online",
      elapsedMilliseconds: 90_000,
      durationSeconds: 90,
      idleSeconds: 0,
    });
  });

  it("syncs devices.systemName with the reported Host Name (trimmed) and ignores blanks", async () => {
    const { device, secret } = await createDeviceWithSecret({ consent: true });
    trackDevice(device.id);

    const log = {
      processName: "code",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationSeconds: 60,
    };

    // A snapshot with a new hostname updates the device's display name.
    let res = await request(app)
      .post("/sync/activity")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({ logs: [log], systemInfo: { "Host Name": "  Dell-67  " } });
    expect(res.status).toBe(201);
    let [row] = await db.select().from(devicesTable).where(eq(devicesTable.id, device.id));
    expect(row.systemName).toBe("Dell-67");

    // A blank/whitespace hostname never overwrites the current name.
    res = await request(app)
      .post("/sync/activity")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({ logs: [log], systemInfo: { "Host Name": "   " } });
    expect(res.status).toBe(201);
    [row] = await db.select().from(devicesTable).where(eq(devicesTable.id, device.id));
    expect(row.systemName).toBe("Dell-67");

    // Activity without a snapshot leaves the name untouched.
    res = await request(app)
      .post("/sync/activity")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({ logs: [log] });
    expect(res.status).toBe(201);
    [row] = await db.select().from(devicesTable).where(eq(devicesTable.id, device.id));
    expect(row.systemName).toBe("Dell-67");
  });
});

describe("screenshot upload stages bytes and enqueues them for Dropbox", () => {
  it("accepts raw image bytes and enqueues them pending (202)", async () => {
    const { device, secret } = await createDeviceWithSecret();
    trackDevice(device.id);

    const bytes = jpegBytes();
    const res = await request(app)
      .post("/sync/screenshots")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .set("Content-Type", "image/jpeg")
      .set("x-captured-at", new Date().toISOString())
      .send(bytes);
    expect(res.status).toBe(202);
    expect(res.body.id).toBeTruthy();
    expect(res.body.status).toBe("pending");

    const [shot] = await db
      .select()
      .from(screenshotsTable)
      .where(eq(screenshotsTable.id, res.body.id));
    expect(shot.deviceId).toBe(device.id);
    expect(shot.status).toBe("pending");
    expect(shot.contentType).toBe("image/jpeg");
    expect(shot.fileSizeBytes).toBe(bytes.length);
    // Bytes are staged in the DB so the screenshot is viewable before upload.
    expect(shot.pendingData).toBeTruthy();
    expect(shot.dropboxPath).toBeNull();

    const [activeDevice] = await db
      .select({ lastSeenAt: devicesTable.lastSeenAt })
      .from(devicesTable)
      .where(eq(devicesTable.id, device.id));
    expect(activeDevice.lastSeenAt).not.toBeNull();
    expect(Date.now() - activeDevice.lastSeenAt!.getTime()).toBeLessThan(5_000);
  });

  it("rejects a body whose bytes are not a supported image (400)", async () => {
    const { device, secret } = await createDeviceWithSecret();
    trackDevice(device.id);

    const res = await request(app)
      .post("/sync/screenshots")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .set("Content-Type", "image/png")
      .set("x-captured-at", new Date().toISOString())
      .send(Buffer.from("not really a png"));
    expect(res.status).toBe(400);
  });

  it("rejects an upload with no x-captured-at header (400)", async () => {
    const { device, secret } = await createDeviceWithSecret();
    trackDevice(device.id);

    const res = await request(app)
      .post("/sync/screenshots")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .set("Content-Type", "image/jpeg")
      .send(jpegBytes());
    expect(res.status).toBe(400);
  });

  it("dedupes identical bytes from the same device (202, single row)", async () => {
    const { device, secret } = await createDeviceWithSecret();
    trackDevice(device.id);

    const bytes = jpegBytes();
    const capturedAt = new Date().toISOString();
    const send = () =>
      request(app)
        .post("/sync/screenshots")
        .set("x-device-id", device.id)
        .set("x-device-secret", secret)
        .set("Content-Type", "image/jpeg")
        .set("x-captured-at", capturedAt)
        .send(bytes);

    const first = await send();
    const second = await send();
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.id).toBe(first.body.id);

    const rows = await db
      .select()
      .from(screenshotsTable)
      .where(eq(screenshotsTable.deviceId, device.id));
    expect(rows.length).toBe(1);
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
    // Freshly-acknowledged / completed / failed work must not be re-dispatched.
    // (STALE acknowledged commands ARE redelivered — see commandRedelivery.test.ts.)
    await createDeviceCommand(device.id, {
      status: "acknowledged",
      acknowledgedAt: new Date(),
    });
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

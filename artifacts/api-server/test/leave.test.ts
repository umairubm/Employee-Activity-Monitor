import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import {
  db,
  shiftsTable,
  leaveRequestsTable,
  leaveBalancesTable,
  usersTable,
  pool,
} from "@workspace/db";
import type { Express } from "express";
import { createUser, makeApp } from "./helpers";

/**
 * Tests for the Shift + Leave management surface (S3). Leave requests and
 * balances are FK'd to users, so the suite seeds its own users and cleans up
 * the rows it creates. Approving leave consumes balance (business days); the
 * balance assertions below pin that accounting behaviour.
 */

let featureApp: Express;
let seededUserId: string;
let reviewerId: string;
const createdShiftIds: string[] = [];

beforeAll(async () => {
  const { user } = await createUser({ role: "team_member" });
  const { user: reviewer } = await createUser({ role: "admin" });
  seededUserId = user.id;
  reviewerId = reviewer.id;
  featureApp = makeApp({ role: "admin", userId: reviewer.id });
});

afterAll(async () => {
  if (createdShiftIds.length) {
    await db.delete(shiftsTable).where(inArray(shiftsTable.id, createdShiftIds));
  }
  // leave_requests + leave_balances cascade from the user delete.
  for (const id of [seededUserId, reviewerId]) {
    if (id) await db.delete(usersTable).where(eq(usersTable.id, id));
  }
  await pool.end();
});

describe("Shifts API", () => {
  it("creates, lists, updates and deletes a shift", async () => {
    const created = await request(featureApp)
      .post("/shifts")
      .send({ name: "Night Crew", shiftType: "night", startTime: "22:00", endTime: "06:00" });
    expect(created.status).toBe(201);
    expect(created.body.shiftType).toBe("night");
    expect(created.body.startTime).toBe("22:00");
    createdShiftIds.push(created.body.id);

    const list = await request(featureApp).get("/shifts");
    expect(list.status).toBe(200);
    expect(list.body.some((s: { id: string }) => s.id === created.body.id)).toBe(true);

    const updated = await request(featureApp)
      .patch(`/shifts/${created.body.id}`)
      .send({ startTime: "23:00" });
    expect(updated.status).toBe(200);
    expect(updated.body.startTime).toBe("23:00");

    const del = await request(featureApp).delete(`/shifts/${created.body.id}`);
    expect(del.status).toBe(204);
  });

  it("defaults shiftType to morning and validates time format", async () => {
    const created = await request(featureApp)
      .post("/shifts")
      .send({ name: "Default Shift", startTime: "09:00", endTime: "17:00" });
    expect(created.status).toBe(201);
    expect(created.body.shiftType).toBe("morning");
    createdShiftIds.push(created.body.id);

    const bad = await request(featureApp)
      .post("/shifts")
      .send({ name: "Bad", startTime: "9am", endTime: "17:00" });
    expect(bad.status).toBe(400);
  });

  it("404s on an unknown shift and 400s on a malformed id", async () => {
    const missing = await request(featureApp)
      .patch("/shifts/00000000-0000-0000-0000-000000000000")
      .send({ name: "x" });
    expect(missing.status).toBe(404);

    const bad = await request(featureApp).delete("/shifts/not-a-uuid");
    expect(bad.status).toBe(400);
  });
});

describe("Leave requests + balances API", () => {
  it("rejects a request whose start is after its end", async () => {
    const res = await request(featureApp)
      .post("/leave-requests")
      .send({
        userId: seededUserId,
        leaveType: "annual",
        startDate: "2026-03-10",
        endDate: "2026-03-05",
      });
    expect(res.status).toBe(400);
  });

  it("rejects a request for a non-existent user", async () => {
    const res = await request(featureApp)
      .post("/leave-requests")
      .send({
        userId: "00000000-0000-0000-0000-000000000000",
        startDate: "2026-03-02",
        endDate: "2026-03-03",
      });
    expect(res.status).toBe(400);
  });

  it("approving leave consumes business days from the balance", async () => {
    // Allocate 20 annual days for 2026.
    const alloc = await request(featureApp)
      .post("/leave-balances")
      .send({ userId: seededUserId, year: 2026, leaveType: "annual", allocatedDays: 20 });
    expect(alloc.status).toBe(200);
    expect(alloc.body.allocatedDays).toBe(20);
    expect(alloc.body.remainingDays).toBe(20);

    // Mon 2026-03-02 .. Fri 2026-03-06 = 5 business days.
    const created = await request(featureApp)
      .post("/leave-requests")
      .send({
        userId: seededUserId,
        leaveType: "annual",
        startDate: "2026-03-02",
        endDate: "2026-03-06",
      });
    expect(created.status).toBe(201);
    expect(created.body.days).toBe(5);
    expect(created.body.status).toBe("pending");
    const requestId = created.body.id as string;

    const review = await request(featureApp)
      .post(`/leave-requests/${requestId}/review`)
      .send({ status: "approved", reviewNote: "ok" });
    expect(review.status).toBe(200);
    expect(review.body.status).toBe("approved");
    expect(review.body.reviewerUsername).toBeTruthy();

    const afterApprove = await request(featureApp)
      .get("/leave-balances")
      .query({ userId: seededUserId, year: 2026 });
    const annual = afterApprove.body.find(
      (b: { leaveType: string }) => b.leaveType === "annual",
    );
    expect(annual.usedDays).toBe(5);
    expect(annual.remainingDays).toBe(15);

    // Re-reviewing an already-reviewed request is a conflict.
    const reReview = await request(featureApp)
      .post(`/leave-requests/${requestId}/review`)
      .send({ status: "rejected" });
    expect(reReview.status).toBe(409);

    // Deleting an approved request refunds the balance.
    const del = await request(featureApp).delete(`/leave-requests/${requestId}`);
    expect(del.status).toBe(204);

    const afterDelete = await request(featureApp)
      .get("/leave-balances")
      .query({ userId: seededUserId, year: 2026 });
    const refunded = afterDelete.body.find(
      (b: { leaveType: string }) => b.leaveType === "annual",
    );
    expect(refunded.usedDays).toBe(0);
    expect(refunded.remainingDays).toBe(20);
  });

  it("filters leave requests by status and userId", async () => {
    const created = await request(featureApp)
      .post("/leave-requests")
      .send({
        userId: seededUserId,
        leaveType: "sick",
        startDate: "2026-04-06",
        endDate: "2026-04-07",
      });
    expect(created.status).toBe(201);

    const pending = await request(featureApp)
      .get("/leave-requests")
      .query({ status: "pending", userId: seededUserId });
    expect(pending.status).toBe(200);
    expect(
      pending.body.every((r: { status: string }) => r.status === "pending"),
    ).toBe(true);
    expect(
      pending.body.some((r: { id: string }) => r.id === created.body.id),
    ).toBe(true);

    // cleanup this leftover request
    await db
      .delete(leaveRequestsTable)
      .where(eq(leaveRequestsTable.id, created.body.id));

    const badFilter = await request(featureApp)
      .get("/leave-requests")
      .query({ status: "bogus" });
    expect(badFilter.status).toBe(400);
  });

  it("splits a year-spanning leave across each calendar year's balance", async () => {
    await db
      .delete(leaveBalancesTable)
      .where(eq(leaveBalancesTable.userId, seededUserId));

    // Wed 2026-12-30 .. Mon 2027-01-04 inclusive.
    // 2026 business days: Wed 12-30, Thu 12-31 = 2.
    // 2027 business days: Fri 01-01, Mon 01-04 = 2 (Sat/Sun excluded).
    const created = await request(featureApp)
      .post("/leave-requests")
      .send({
        userId: seededUserId,
        leaveType: "annual",
        startDate: "2026-12-30",
        endDate: "2027-01-04",
      });
    expect(created.status).toBe(201);
    expect(created.body.days).toBe(4);

    const review = await request(featureApp)
      .post(`/leave-requests/${created.body.id}/review`)
      .send({ status: "approved" });
    expect(review.status).toBe(200);

    const balances2026 = await request(featureApp)
      .get("/leave-balances")
      .query({ userId: seededUserId, year: 2026 });
    const annual2026 = balances2026.body.find(
      (b: { leaveType: string }) => b.leaveType === "annual",
    );
    expect(annual2026.usedDays).toBe(2);

    const balances2027 = await request(featureApp)
      .get("/leave-balances")
      .query({ userId: seededUserId, year: 2027 });
    const annual2027 = balances2027.body.find(
      (b: { leaveType: string }) => b.leaveType === "annual",
    );
    expect(annual2027.usedDays).toBe(2);

    // Deleting refunds each year independently.
    const del = await request(featureApp).delete(`/leave-requests/${created.body.id}`);
    expect(del.status).toBe(204);

    const refunded2026 = await request(featureApp)
      .get("/leave-balances")
      .query({ userId: seededUserId, year: 2026 });
    expect(
      refunded2026.body.find((b: { leaveType: string }) => b.leaveType === "annual")
        .usedDays,
    ).toBe(0);
    const refunded2027 = await request(featureApp)
      .get("/leave-balances")
      .query({ userId: seededUserId, year: 2027 });
    expect(
      refunded2027.body.find((b: { leaveType: string }) => b.leaveType === "annual")
        .usedDays,
    ).toBe(0);
  });

  it("upsert preserves usedDays while updating allocation", async () => {
    await db
      .delete(leaveBalancesTable)
      .where(eq(leaveBalancesTable.userId, seededUserId));

    const first = await request(featureApp)
      .post("/leave-balances")
      .send({ userId: seededUserId, year: 2027, leaveType: "casual", allocatedDays: 5 });
    expect(first.status).toBe(200);

    // Consume some via an approved request, then re-allocate.
    const created = await request(featureApp)
      .post("/leave-requests")
      .send({
        userId: seededUserId,
        leaveType: "casual",
        startDate: "2027-03-01",
        endDate: "2027-03-02",
      });
    // 2027-03-01 is a Monday, 03-02 Tuesday = 2 business days.
    expect(created.body.days).toBe(2);
    await request(featureApp)
      .post(`/leave-requests/${created.body.id}/review`)
      .send({ status: "approved" });

    const reAlloc = await request(featureApp)
      .post("/leave-balances")
      .send({ userId: seededUserId, year: 2027, leaveType: "casual", allocatedDays: 10 });
    expect(reAlloc.status).toBe(200);
    expect(reAlloc.body.allocatedDays).toBe(10);
    expect(reAlloc.body.usedDays).toBe(2);
    expect(reAlloc.body.remainingDays).toBe(8);
  });
});

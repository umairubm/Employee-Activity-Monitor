import { describe, expect, it } from "vitest";
import { correctOverlap, type NaiveTime } from "../src/lib/activityTime";

/**
 * Pure unit tests for correctOverlap. No DB — these lock down the numeric
 * invariants that the interval-merge overlap correction must always hold:
 *  - no overlap (covered === worked) is a passthrough,
 *  - overlap scales every component by total/worked,
 *  - the four classes ALWAYS sum to total (even when rounding would overshoot),
 *  - callers that only populate productive get round(productive * ratio),
 *  - active === total - idle, idle never exceeds total,
 *  - zero/negative inputs are guarded.
 */

const naive = (over: Partial<NaiveTime> = {}): NaiveTime => ({
  workedSeconds: 0,
  idleSeconds: 0,
  productiveSeconds: 0,
  unproductiveSeconds: 0,
  neutralSeconds: 0,
  undefinedSeconds: 0,
  ...over,
});

describe("correctOverlap", () => {
  it("is a passthrough when covered === worked (no overlap)", () => {
    const n = naive({
      workedSeconds: 4800,
      idleSeconds: 600,
      productiveSeconds: 3600,
      unproductiveSeconds: 1200,
    });
    const t = correctOverlap(n, 4800);
    expect(t.totalSeconds).toBe(4800);
    expect(t.idleSeconds).toBe(600);
    expect(t.activeSeconds).toBe(4200);
    expect(t.productiveSeconds).toBe(3600);
    expect(t.unproductiveSeconds).toBe(1200);
  });

  it("scales every component by total/worked on overlap", () => {
    // worked 14400, real covered 5400 => ratio 0.375.
    const n = naive({
      workedSeconds: 14400,
      idleSeconds: 600,
      productiveSeconds: 14400,
    });
    const t = correctOverlap(n, 5400);
    expect(t.totalSeconds).toBe(5400);
    expect(t.productiveSeconds).toBe(5400);
    expect(t.idleSeconds).toBe(225); // round(600 * 0.375)
    expect(t.activeSeconds).toBe(5175);
  });

  it("keeps the four classes summing to total even when rounding overshoots", () => {
    // Three equal classes, ratio 2/3: each exact = 0.667, naive rounding would
    // give 1+1+1 = 3 > total 2. Largest-remainder must keep the sum at total.
    const n = naive({
      workedSeconds: 3,
      productiveSeconds: 1,
      unproductiveSeconds: 1,
      neutralSeconds: 1,
    });
    const t = correctOverlap(n, 2);
    expect(t.totalSeconds).toBe(2);
    const classSum =
      t.productiveSeconds +
      t.unproductiveSeconds +
      t.neutralSeconds +
      t.undefinedSeconds;
    expect(classSum).toBe(2);
  });

  it("only scales the populated class (leaderboard/group-comparison style)", () => {
    // Caller fills productive + worked only; unproductive/neutral/undefined left
    // 0. Productive must be round(productive * ratio), NOT inflated to total.
    const n = naive({ workedSeconds: 4800, productiveSeconds: 3600 });
    const t = correctOverlap(n, 4800); // ratio 1
    expect(t.totalSeconds).toBe(4800);
    expect(t.productiveSeconds).toBe(3600);
    expect(t.unproductiveSeconds).toBe(0);
    expect(t.neutralSeconds).toBe(0);
    expect(t.undefinedSeconds).toBe(0);
  });

  it("returns all zeros when worked is 0", () => {
    const t = correctOverlap(naive(), 0);
    expect(t).toEqual({
      totalSeconds: 0,
      activeSeconds: 0,
      idleSeconds: 0,
      productiveSeconds: 0,
      unproductiveSeconds: 0,
      neutralSeconds: 0,
      undefinedSeconds: 0,
    });
  });

  it("guards against negative covered and clamps covered to worked", () => {
    const n = naive({ workedSeconds: 100, productiveSeconds: 100 });
    expect(correctOverlap(n, -50).totalSeconds).toBe(0);
    // Covered above worked is impossible; clamp down to worked.
    expect(correctOverlap(n, 250).totalSeconds).toBe(100);
  });

  it("never lets idle exceed total", () => {
    const n = naive({
      workedSeconds: 1000,
      idleSeconds: 1000,
      productiveSeconds: 1000,
    });
    const t = correctOverlap(n, 400); // ratio 0.4 => idle 400, capped at total
    expect(t.totalSeconds).toBe(400);
    expect(t.idleSeconds).toBe(400);
    expect(t.activeSeconds).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import { proportionPValue, poissonRatePValue, computeMultiArmStats } from "./stats";

describe("proportionPValue", () => {
  it("returns null when sample too small", () => {
    expect(proportionPValue(5, 0.1, 100, 0.2)).toBeNull();
  });

  it("returns small p for clearly different proportions", () => {
    const p = proportionPValue(1000, 0.08, 1000, 0.12);
    expect(p).not.toBeNull();
    expect(p!).toBeLessThan(0.05);
  });

  it("returns large p for similar proportions", () => {
    const p = proportionPValue(100, 0.10, 100, 0.11);
    expect(p).not.toBeNull();
    expect(p!).toBeGreaterThan(0.2);
  });

  it("returns null when pooled proportion is 0 or 1", () => {
    expect(proportionPValue(100, 0, 100, 0)).toBeNull();
  });
});

describe("poissonRatePValue", () => {
  it("returns null when sample too small", () => {
    expect(poissonRatePValue(5, 1.5, 5, 2.0)).toBeNull();
  });

  it("returns small p for clearly different rates", () => {
    const p = poissonRatePValue(1000, 1.0, 1000, 2.0);
    expect(p).not.toBeNull();
    expect(p!).toBeLessThan(0.05);
  });

  it("returns large p for similar rates", () => {
    const p = poissonRatePValue(100, 2.0, 100, 2.1);
    expect(p).not.toBeNull();
    expect(p!).toBeGreaterThan(0.2);
  });
});

describe("computeMultiArmStats", () => {
  it("identifies a single clear winner among two treatments", () => {
    // control 8%, t1 12% (winner), t2 8% — large samples so MC is decisive
    const r = computeMultiArmStats(
      { visitors: 4000, conversions: 320 },
      [
        { visitors: 4000, conversions: 480 }, // t1 = 12%
        { visitors: 4000, conversions: 320 }, // t2 = 8%
      ],
    );
    expect(r.arms).toHaveLength(3); // control + 2 treatments
    expect(r.bestArmIndex).toBe(1); // arms[1] = t1
    expect(r.winningArmIndex).toBe(1);
    expect(r.isSignificant).toBe(true);
    // t1 beats control decisively; t2 does not
    expect(r.arms[1].probToBeatControl!).toBeGreaterThan(0.95);
    expect(r.arms[1].probBestArm).toBeGreaterThan(0.95);
    expect(r.arms[2].probBestArm).toBeLessThan(0.1);
  });

  it("respects treatment ordering (winner is the 2nd treatment)", () => {
    const r = computeMultiArmStats(
      { visitors: 4000, conversions: 200 }, // 5%
      [
        { visitors: 4000, conversions: 240 }, // t1 = 6%
        { visitors: 4000, conversions: 400 }, // t2 = 10% (winner)
      ],
    );
    expect(r.bestArmIndex).toBe(2);
    expect(r.winningArmIndex).toBe(2);
    expect(r.isSignificant).toBe(true);
  });

  it("declares no winner when all arms are similar", () => {
    const r = computeMultiArmStats(
      { visitors: 3000, conversions: 300 },
      [
        { visitors: 3000, conversions: 306 },
        { visitors: 3000, conversions: 294 },
      ],
    );
    expect(r.isSignificant).toBe(false);
    expect(r.winningArmIndex).toBeNull();
    // probBestArm is spread across the three arms, none dominant
    for (const a of r.arms) expect(a.probBestArm).toBeLessThan(0.95);
  });

  it("does not crown a treatment when control is best", () => {
    const r = computeMultiArmStats(
      { visitors: 4000, conversions: 480 }, // control 12%
      [
        { visitors: 4000, conversions: 320 }, // t1 8%
        { visitors: 4000, conversions: 280 }, // t2 7%
      ],
    );
    expect(r.bestArmIndex).toBe(0); // control wins
    expect(r.winningArmIndex).toBeNull();
    expect(r.isSignificant).toBe(false);
  });

  it("probBestArm across all arms sums to ~1", () => {
    const r = computeMultiArmStats(
      { visitors: 2000, conversions: 200 },
      [
        { visitors: 2000, conversions: 240 },
        { visitors: 2000, conversions: 220 },
      ],
    );
    const sum = r.arms.reduce((s, a) => s + a.probBestArm, 0);
    expect(sum).toBeGreaterThan(0.98);
    expect(sum).toBeLessThan(1.02);
  });

  it("returns a degenerate result when any arm has no visitors", () => {
    const r = computeMultiArmStats(
      { visitors: 1000, conversions: 100 },
      [
        { visitors: 0, conversions: 0 },
        { visitors: 1000, conversions: 150 },
      ],
    );
    expect(r.isSignificant).toBe(false);
    expect(r.winningArmIndex).toBeNull();
    for (const a of r.arms) expect(a.probToBeatControl).toBeNull();
  });

  it("matches pairwise intuition for a single treatment", () => {
    // One strong treatment → probToBeatControl ~ 1
    const r = computeMultiArmStats(
      { visitors: 2000, conversions: 160 }, // 8%
      [{ visitors: 2000, conversions: 240 }], // 12%
    );
    expect(r.arms).toHaveLength(2);
    expect(r.arms[1].probToBeatControl!).toBeGreaterThan(0.95);
    expect(r.winningArmIndex).toBe(1);
  });
});

import { describe, it, expect } from "vitest";
import { proportionPValue, poissonRatePValue } from "./stats";

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

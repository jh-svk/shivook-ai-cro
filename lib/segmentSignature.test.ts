import { describe, it, expect } from "vitest";
import { segmentSignature } from "./segmentSignature.server";

describe("segmentSignature", () => {
  it("returns pipe-separated canonical string", () => {
    expect(segmentSignature("product", { deviceType: "mobile", trafficSource: "organic", visitorType: "new", geoCountry: [] }))
      .toBe("product|mobile|organic|new|any");
  });

  it("sorts geoCountry alphabetically", () => {
    expect(segmentSignature("product", { deviceType: "mobile", trafficSource: null, visitorType: null, geoCountry: ["US", "CA"] }))
      .toBe("product|mobile|any|any|CA,US");
  });

  it("falls back to 'any' for null/undefined segment", () => {
    expect(segmentSignature("homepage", null))
      .toBe("homepage|any|any|any|any");
  });

  it("falls back to 'any' for undefined fields", () => {
    expect(segmentSignature("cart", {}))
      .toBe("cart|any|any|any|any");
  });
});

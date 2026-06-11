import { describe, it, expect } from "vitest";
import { formatNonViableTests } from "./hypothesisGenerator";

describe("formatNonViableTests", () => {
  it("returns a 'none yet' sentinel for an empty list", () => {
    expect(formatNonViableTests([])).toBe("None yet.");
  });

  it("formats each entry as a pageType/elementType bullet with the title", () => {
    const out = formatNonViableTests([
      { pageType: "homepage", elementType: "cta", title: "Mobile Homepage CTA Button Text Change" },
    ]);
    expect(out).toBe('- homepage/cta: "Mobile Homepage CTA Button Text Change"');
  });

  it("collapses exact-duplicate (pageType + elementType + title) entries", () => {
    const out = formatNonViableTests([
      { pageType: "cart", elementType: "trust", title: "Trust Badge Row Above Cart Checkout Button" },
      { pageType: "cart", elementType: "trust", title: "Trust Badge Row Above Cart Checkout Button" },
    ]);
    expect(out.split("\n")).toHaveLength(1);
  });

  it("keeps distinct titles on the same page/element", () => {
    const out = formatNonViableTests([
      { pageType: "homepage", elementType: "trust", title: "Trust Badges Below ATC Button on Homepage" },
      { pageType: "homepage", elementType: "cta", title: "Mobile Homepage CTA Button Text Change" },
    ]);
    expect(out.split("\n")).toHaveLength(2);
  });
});

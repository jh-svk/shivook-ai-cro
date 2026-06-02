import { describe, it, expect } from "vitest";
import { validateVariantSelectors } from "./autoBuild";

const VOCAB = {
  classes: ["banner__heading", "header__heading", "button", "price-item--regular"],
  ids: ["MainContent"],
  dataAttrs: ["data-section-id"],
};

describe("validateVariantSelectors", () => {
  it("rejects an invented selector that doesn't exist on the store", () => {
    const js = `document.querySelector('[data-shivook-hero-headline]');`;
    const res = validateVariantSelectors(js, null, VOCAB);
    expect(res.ok).toBe(false);
    expect(res.invalid[0].selector).toContain("data-shivook-hero-headline");
  });

  it("accepts a real selector present in the store vocabulary", () => {
    const js = `var el = document.querySelector('h2.banner__heading'); el.textContent = 'Hi';`;
    expect(validateVariantSelectors(js, null, VOCAB).ok).toBe(true);
  });

  it("rejects an invented class even when mixed with a real one", () => {
    const js = `document.querySelector('.banner__heading .totally-made-up');`;
    const res = validateVariantSelectors(js, null, VOCAB);
    expect(res.ok).toBe(false);
    expect(res.invalid[0].unknown).toContain(".totally-made-up");
  });

  it("accepts selectors for elements the variant itself creates", () => {
    const html = `<span id="cro-new-headline"></span>`;
    const js = `document.getElementById('cro-new-headline');`;
    expect(validateVariantSelectors(js, html, VOCAB).ok).toBe(true);
  });

  it("accepts class created in JS via className", () => {
    const js = `var s=document.createElement('span'); s.className='cro-foo'; document.querySelector('.cro-foo');`;
    expect(validateVariantSelectors(js, null, VOCAB).ok).toBe(true);
  });

  it("ignores attribute selectors other than data-* (e.g. [name=add])", () => {
    const js = `document.querySelector('button[name="add"]');`;
    expect(validateVariantSelectors(js, null, VOCAB).ok).toBe(true);
  });

  it("no-ops (passes) when no vocabulary is available — never falsely rejects", () => {
    const js = `document.querySelector('[data-anything]');`;
    expect(validateVariantSelectors(js, null, undefined).ok).toBe(true);
    expect(validateVariantSelectors(js, null, { classes: [], ids: [] }).ok).toBe(true);
  });

  it("passes when there is no JS patch", () => {
    expect(validateVariantSelectors(null, "<div></div>", VOCAB).ok).toBe(true);
  });
});

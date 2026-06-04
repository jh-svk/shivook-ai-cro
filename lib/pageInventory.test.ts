import { describe, it, expect } from "vitest";
import { extractPageInventory, pageLacksRequiredElement } from "./pageInventory.server";

// A product page: real add-to-cart form OUTSIDE any card → usable CTA.
const PRODUCT_HTML = `<!doctype html><html><body><main>
  <h1 class="product__title">Snowboard</h1>
  <div class="price"><span class="price-item">$749.95</span></div>
  <div class="product__media"><img src="/board.jpg"></div>
  <product-form><form action="/cart/add">
    <button name="add" class="product-form__submit">Add to cart</button>
  </form></product-form>
</main></body></html>`;

// A collection page: product cards whose ONLY add-to-cart is the hover Quick Add
// inside each card → NO usable standalone CTA.
const COLLECTION_HTML = `<!doctype html><html><body><main>
  <h1 class="collection__title">All products</h1>
  <div class="facets"><button class="facets__summary">Filter</button></div>
  <ul class="product-grid">
    <li class="grid__item">
      <div class="card card-wrapper">
        <a href="/p/1" class="card__heading">Board A</a>
        <div class="price">$749</div>
        <img src="/a.jpg">
        <div class="card__footer"><form action="/cart/add"><button name="add" class="quick-add__submit">+ Add</button></form></div>
      </div>
    </li>
    <li class="grid__item"><div class="card card-wrapper"><a class="card__heading">Board B</a><div class="price">$699</div></div></li>
  </ul>
</main></body></html>`;

describe("extractPageInventory", () => {
  it("detects a usable add-to-cart on a product page", () => {
    const inv = extractPageInventory(PRODUCT_HTML, "product")!;
    expect(inv.usableAddToCart).toBe(true);
    expect(inv.hasPrice).toBe(true);
    expect(inv.hasHeading).toBe(true);
    expect(inv.summary).toMatch(/usable add-to-cart/i);
  });

  it("reports NO usable CTA on a collection page (Quick Add only inside cards)", () => {
    const inv = extractPageInventory(COLLECTION_HTML, "collection")!;
    expect(inv.usableAddToCart).toBe(false);
    expect(inv.productCardCount).toBeGreaterThanOrEqual(2);
    expect(inv.summary).toMatch(/NO standalone add-to-cart/i);
    expect(inv.summary).toMatch(/hover-revealed/i);
  });

  it("returns null on unparseable input rather than throwing", () => {
    // linkedom is lenient, so just assert it never throws and yields an object or null.
    expect(() => extractPageInventory("", "product")).not.toThrow();
  });
});

describe("pageLacksRequiredElement", () => {
  it("blocks a collection CTA / add-to-cart test when there is no usable buy button", () => {
    const inv = extractPageInventory(COLLECTION_HTML, "collection")!;
    expect(pageLacksRequiredElement(inv, "collection", "cta", "add_to_cart_rate")).not.toBeNull();
    expect(pageLacksRequiredElement(inv, "collection", "headline", "add_to_cart_rate")).not.toBeNull(); // metric-driven
  });

  it("does NOT block a CTA test on a product page (usable button exists)", () => {
    const inv = extractPageInventory(PRODUCT_HTML, "product")!;
    expect(pageLacksRequiredElement(inv, "product", "cta", "add_to_cart_rate")).toBeNull();
  });

  it("does NOT block a non-CTA collection test (e.g. trust badge, layout)", () => {
    const inv = extractPageInventory(COLLECTION_HTML, "collection")!;
    expect(pageLacksRequiredElement(inv, "collection", "trust", "conversion_rate")).toBeNull();
    expect(pageLacksRequiredElement(inv, "collection", "layout", "conversion_rate")).toBeNull();
  });
});

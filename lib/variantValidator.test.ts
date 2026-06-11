import { describe, it, expect } from "vitest";
import { validateVariantAgainstHtml, detectHiddenTarget, isEmptyPatchSet } from "./variantValidator.server";

const PRODUCT_HTML = `<!doctype html><html><body>
  <main>
    <div class="product__info">
      <h1 class="product__title">Snowboard</h1>
      <div class="price"><span class="price-item price-item--regular">$749.95</span></div>
    </div>
    <!-- Dawn renders the ATC button OUTSIDE form[action*="/cart/add"] -->
    <form action="/cart/add" id="cart-drawer-form"></form>
    <product-form>
      <form action="/cart/add" id="product-form">
        <button name="add" class="product-form__submit">Add to cart</button>
      </form>
    </product-form>
  </main>
</body></html>`;

describe("validateVariantAgainstHtml", () => {
  it("passes a variant that adds a visible element to a real selector", () => {
    const js = `(function(){var h=document.querySelector('.product__title');if(!h)return;var p=document.createElement('p');p.textContent='Free returns';h.parentNode.insertBefore(p,h.nextSibling);})();`;
    expect(validateVariantAgainstHtml({ htmlPatch: null, cssPatch: null, jsPatch: js, pageType: "product", pageHtml: PRODUCT_HTML }).ok).toBe(true);
  });

  it("fails a variant whose only effect is gated on missing data (no-op)", () => {
    const js = `(function(){var m=document.querySelector('meta[name="description"]');if(!m)return;var p=document.createElement('p');p.textContent=m.content;document.body.appendChild(p);})();`;
    const r = validateVariantAgainstHtml({ htmlPatch: null, cssPatch: null, jsPatch: js, pageType: "product", pageHtml: PRODUCT_HTML });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_visible_change");
  });

  it("fails a variant that scopes a button lookup inside the wrong form (real Dawn bug)", () => {
    // The ATC button is NOT inside the first form[action*="/cart/add"], so this no-ops.
    const js = `(function(){var f=document.querySelector('form[action*="/cart/add"]');if(!f)return;var b=f.querySelector('[name="add"]');if(!b)return;var bar=document.createElement('div');bar.id='sticky';document.body.appendChild(bar);})();`;
    const r = validateVariantAgainstHtml({ htmlPatch: null, cssPatch: null, jsPatch: js, pageType: "product", pageHtml: PRODUCT_HTML });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_visible_change");
  });

  it("passes a CSS-only restyle (can't be measured, trusted)", () => {
    expect(validateVariantAgainstHtml({ htmlPatch: null, cssPatch: ".product__title{font-size:3rem}", jsPatch: null, pageType: "product", pageHtml: PRODUCT_HTML }).ok).toBe(true);
  });

  it("passes an HTML-patch variant", () => {
    expect(validateVariantAgainstHtml({ htmlPatch: '<div class="cro">Sale</div>', cssPatch: null, jsPatch: null, pageType: "product", pageHtml: PRODUCT_HTML }).ok).toBe(true);
  });

  it("validates a desktop-gated variant at desktop width (no false-fail)", () => {
    const desktopJs = `(function(){ if(window.innerWidth < 990) return; var h=document.querySelector('.product__title'); if(!h) return; var bar=document.createElement('div'); bar.id='cro-bar'; bar.textContent='Trust'; h.parentNode.appendChild(bar); })();`;
    // As mobile → bails (no change). As desktop → runs and changes the page.
    expect(validateVariantAgainstHtml({ htmlPatch: null, cssPatch: null, jsPatch: desktopJs, pageType: "product", deviceType: "mobile", pageHtml: PRODUCT_HTML }).ok).toBe(false);
    expect(validateVariantAgainstHtml({ htmlPatch: null, cssPatch: null, jsPatch: desktopJs, pageType: "product", deviceType: "desktop", pageHtml: PRODUCT_HTML }).ok).toBe(true);
  });

  it("fails a completely empty variant", () => {
    const r = validateVariantAgainstHtml({ htmlPatch: null, cssPatch: null, jsPatch: null, pageType: "product", pageHtml: PRODUCT_HTML });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("empty_variant");
  });

  it("unwraps a <script>-wrapped jsPatch and still validates the inner code", () => {
    const js = `<script>(function(){var h=document.querySelector('.product__title');var p=document.createElement('p');p.textContent='Hi';h.parentNode.appendChild(p);})();</script>`;
    expect(validateVariantAgainstHtml({ htmlPatch: null, cssPatch: null, jsPatch: js, pageType: "product", pageHtml: PRODUCT_HTML }).ok).toBe(true);
  });
});

describe("detectHiddenTarget (hover-only Quick Add no-op)", () => {
  // Regression: the exact pattern of the wasted "High-Contrast ATC Button on
  // Collection Mobile" test — mobile-gated JS restyling hover-only card buttons.
  const wastedJs = `(function(){ if (window.innerWidth > 749) return;
    document.querySelectorAll('.card__footer button.button, [class*="card"] button.button').forEach(function(b){ b.style.minHeight='52px'; });
  })();`;

  it("flags a mobile-gated collection variant targeting card__footer Quick-Add buttons", () => {
    const r = detectHiddenTarget({ jsPatch: wastedJs, htmlPatch: null, pageType: "collection", deviceType: null });
    expect(r).not.toBeNull();
    expect(r).toMatch(/hover-only/i);
  });

  it("flags when the segment device is mobile even without an innerWidth gate", () => {
    const js = `document.querySelectorAll('.quick-add__submit').forEach(function(b){ b.style.background='red'; });`;
    expect(detectHiddenTarget({ jsPatch: js, htmlPatch: null, pageType: "collection", deviceType: "mobile" })).not.toBeNull();
  });

  it("does NOT flag a desktop collection variant (hover works on desktop)", () => {
    // No mobile gate + desktop segment → hover reveals Quick Add, so it's a real change.
    const desktopJs = `document.querySelectorAll('.quick-add__submit').forEach(function(b){ b.style.background='red'; });`;
    expect(detectHiddenTarget({ jsPatch: desktopJs, htmlPatch: null, pageType: "collection", deviceType: "desktop" })).toBeNull();
  });

  it("does NOT flag a collection variant targeting always-visible elements", () => {
    const js = `document.querySelectorAll('.card__heading a, .price').forEach(function(e){ e.style.fontWeight='700'; });`;
    expect(detectHiddenTarget({ jsPatch: js, htmlPatch: null, pageType: "collection", deviceType: "mobile" })).toBeNull();
  });

  it("does NOT flag Quick-Add targeting on a product page (out of scope)", () => {
    expect(detectHiddenTarget({ jsPatch: wastedJs, htmlPatch: null, pageType: "product", deviceType: "mobile" })).toBeNull();
  });
});

describe("isEmptyPatchSet", () => {
  it("is true when all three patches are null (the model declined)", () => {
    expect(isEmptyPatchSet({ htmlPatch: null, cssPatch: null, jsPatch: null })).toBe(true);
  });

  it("is true when all three patches are empty or whitespace-only strings", () => {
    expect(isEmptyPatchSet({ htmlPatch: "", cssPatch: "   ", jsPatch: "\n\t" })).toBe(true);
  });

  it("is false for a CSS-only restyle (a valid variant we must not skip)", () => {
    expect(isEmptyPatchSet({ htmlPatch: null, cssPatch: ".price{color:red}", jsPatch: null })).toBe(false);
  });

  it("is false when only the HTML patch is present", () => {
    expect(isEmptyPatchSet({ htmlPatch: "<div>x</div>", cssPatch: null, jsPatch: null })).toBe(false);
  });

  it("is false when only the JS patch is present", () => {
    expect(isEmptyPatchSet({ htmlPatch: null, cssPatch: null, jsPatch: "document.title='x'" })).toBe(false);
  });
});

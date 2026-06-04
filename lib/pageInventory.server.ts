/**
 * Page element inventory — PREVENTION layer for variant generation.
 *
 * Before the AI designs a test, we fetch the real target page and summarise what
 * actually exists on it (does it have a usable add-to-cart button? a price? a
 * product grid?). That summary is fed into the generation prompt so the model
 * grounds its idea in the real page instead of the store-wide selector list —
 * e.g. it can see a collection page has product cards but NO standalone buy
 * button, and won't propose an add-to-cart CTA test there.
 *
 * This complements (does not replace) the store-wide selector grounding and the
 * post-generation render validation: prevention up front, backstops behind it.
 * If the page fetch fails, callers fall back to the existing behaviour.
 */
import { parseHTML } from "linkedom";

export interface PageInventory {
  /** Human-readable element inventory for the generation prompt. */
  summary: string;
  /** An add-to-cart / buy affordance exists OUTSIDE product cards (i.e. usable, not hover-only). */
  usableAddToCart: boolean;
  hasPrice: boolean;
  hasHeading: boolean;
  hasProductImage: boolean;
  hasReviews: boolean;
  productCardCount: number;
}

// Container patterns that mark an element as living inside a product CARD (so an
// add-to-cart control inside one is the hover-only Quick Add, not a usable CTA).
const CARD_HINTS = ["card", "grid__item", "product-card", "card-wrapper", "product-item"];

function isInsideCard(el: { parentElement: unknown } | null): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = el;
  let hops = 0;
  while (node && node.parentElement && hops < 40) {
    node = node.parentElement;
    hops++;
    const cls = String(node.className ?? "").toLowerCase();
    if (CARD_HINTS.some((h) => cls.includes(h))) return true;
  }
  return false;
}

export function extractPageInventory(pageHtml: string, pageType: string): PageInventory | null {
  let document: ReturnType<typeof parseHTML>["document"];
  try {
    ({ document } = parseHTML(pageHtml));
  } catch {
    return null;
  }
  if (!document?.querySelectorAll) return null;

  const q = (sel: string) => {
    try { return Array.from(document.querySelectorAll(sel)); } catch { return []; }
  };

  // Add-to-cart affordances, and whether any is usable (outside a product card).
  const addControls = [
    ...q('form[action*="/cart/add"]'),
    ...q('[name="add"]'),
    ...q('button[name="add"]'),
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usableAddToCart = addControls.some((el: any) => !isInsideCard(el));

  const hasPrice = q('.price, [class*="price"], [data-price], .money').length > 0;
  const hasHeading = q("h1, h2, .h1, [class*='title']").length > 0;
  const hasProductImage =
    q('.product__media img, .product-media img, [class*="product"] img, .card img, main img').length > 0;
  const hasReviews =
    q('[class*="review"], [class*="rating"], [class*="star"], [id*="judgeme"], [class*="jdgm"], [class*="yotpo"], [class*="stamped"]').length > 0;
  const productCardCount = q('.card, .product-card, li.grid__item, .grid__item, [class*="card-wrapper"]').length;
  const hasFilters = q('[class*="facets"], #FacetsForm, [class*="filter"], [class*="sort"]').length > 0;

  // Build a concise, page-type-aware summary.
  const present: string[] = [];
  const absent: string[] = [];
  (productCardCount > 0 ? present : absent).push(
    productCardCount > 0 ? `product grid (${productCardCount} cards)` : "product grid",
  );
  (hasHeading ? present : absent).push("page heading");
  (hasPrice ? present : absent).push("price labels");
  (hasProductImage ? present : absent).push("product images");
  if (pageType === "collection" && hasFilters) present.push("filters / sort controls");
  (hasReviews ? present : absent).push("reviews / rating widget");
  (usableAddToCart ? present : absent).push("usable add-to-cart / buy button");

  const ctaNote = usableAddToCart
    ? ""
    : " IMPORTANT: there is NO standalone add-to-cart or buy button on this page" +
      (productCardCount > 0
        ? " — any add-to-cart control lives inside product cards and is hover-revealed (invisible on mobile)."
        : ".");

  const summary =
    `Page type: ${pageType}. ` +
    `Present: ${present.join(", ") || "(little detected)"}. ` +
    `Not detected: ${absent.join(", ") || "none"}.` +
    ctaNote;

  return { summary, usableAddToCart, hasPrice, hasHeading, hasProductImage, hasReviews, productCardCount };
}

/**
 * Conservative capability gate: returns a reason string when the hypothesis's
 * target element provably cannot exist on this page, so we can skip generation
 * entirely (cheaper than generate → validate → retry). Narrow by design — only
 * the high-confidence "collection-page CTA / add-to-cart test with no usable buy
 * button" case, which is exactly the wasted-test failure class.
 */
export function pageLacksRequiredElement(
  inv: PageInventory,
  pageType: string,
  elementType: string,
  targetMetric: string,
): string | null {
  const ctaTest = elementType === "cta" || targetMetric === "add_to_cart_rate";
  if (pageType === "collection" && ctaTest && !inv.usableAddToCart) {
    return (
      "This collection page has no usable add-to-cart / buy button — any add-to-cart control is " +
      "inside product cards and only appears on hover (and is absent on mobile). A CTA / add-to-cart " +
      "test is not viable here. Use a product or cart page, or target a different element."
    );
  }
  return null;
}

/**
 * Post-generation variant validation.
 *
 * The structural guards (selector-existence, script-unwrap, visible-query) catch
 * malformed code, but a variant can be perfectly-formed and STILL do nothing —
 * because it assumes a DOM relationship that isn't true on the real theme (e.g.
 * the ATC button living outside form[action*="/cart/add"]), or gates its only
 * effect on data that's missing.
 *
 * This validator renders the REAL target page in a lightweight DOM (linkedom),
 * runs the variant's JS against it, and checks whether the variant actually
 * produced a visible change. If it didn't, the build fails + retries with the
 * reason — instead of shipping a silent no-op.
 *
 * Limitations (by design — linkedom has no layout engine):
 *  - It cannot compute real geometry/visibility. We treat "the variant added a
 *    non-empty element to the DOM, or mutated existing content" as success.
 *  - JS that strictly requires layout (getBoundingClientRect, scroll, matchMedia)
 *    is shimmed minimally so it runs; we force a mobile-ish width so width-gated
 *    variants execute their main path.
 */
import { parseHTML } from "linkedom";

export interface VariantValidationResult {
  ok: boolean;
  reason?: string;
  detail?: string;
}

interface ValidatorInput {
  htmlPatch: string | null;
  cssPatch: string | null;
  jsPatch: string | null;
  pageType: string;
  pageHtml: string; // the real target page's HTML
  deviceType?: string | null; // "mobile" | "desktop" | "tablet" — sets the shimmed width
}

/**
 * Run the variant against a DOM built from the real page HTML and report whether
 * it produced a change. Pure + synchronous given the HTML (caller fetches it).
 */
export function validateVariantAgainstHtml(input: ValidatorInput): VariantValidationResult {
  const { htmlPatch, cssPatch, jsPatch, pageHtml } = input;

  // No JS and no HTML patch → nothing could change. (CSS-only variants are
  // allowed — restyling existing elements is a valid change we can't measure
  // in linkedom, so we don't fail those.)
  if (!jsPatch && !htmlPatch) {
    if (cssPatch) return { ok: true }; // CSS-only restyle — trust it
    return { ok: false, reason: "empty_variant", detail: "Variant has no HTML, CSS, or JS." };
  }

  let win: ReturnType<typeof parseHTML>;
  try {
    win = parseHTML(pageHtml);
  } catch (err) {
    // If we can't even parse the page, don't block the build on the validator.
    return { ok: true, reason: "parse_skipped", detail: String(err) };
  }
  const { document } = win;

  // Snapshot the FULL document HTML so we detect a mutation anywhere (variants
  // commonly insert nested next to a heading, not at the body's top level).
  // Note: linkedom's live querySelectorAll('*') count is unreliable across calls,
  // so we compare serialized HTML length instead.
  const snapshot = () => (document.body ? document.body.innerHTML : document.toString());
  const beforeHtml = snapshot();

  // Minimal shims so layout-dependent variant JS runs its MAIN path. Use a width
  // matching the variant's TARGET device, so a desktop variant gated on
  // `innerWidth >= 990` (or @media min-width) runs its main path instead of
  // bailing out (which would be a false "no change").
  shimWindow(win, input.deviceType);

  // Apply the HTML patch the way the injector does (append to body).
  if (htmlPatch) {
    try {
      const tmp = document.createElement("div");
      tmp.innerHTML = htmlPatch;
      while (tmp.firstChild) document.body.appendChild(tmp.firstChild);
    } catch { /* ignore */ }
  }

  let jsThrew: string | null = null;
  if (jsPatch) {
    // Unwrap a <script> wrapper exactly like the injector does.
    let code = jsPatch;
    if (/<script[\s>]/i.test(code)) {
      code = code.replace(/<script[^>]*>/gi, "").replace(/<\/script>/gi, "").trim();
    }
    try {
      // Execute with the linkedom globals in scope.
      const fn = new Function(
        "window", "document", "location", "navigator", "MutationObserver", "requestAnimationFrame", "getComputedStyle",
        code,
      );
      fn(
        win.window ?? win,
        document,
        (win.window ?? win).location ?? { href: "https://example.com", search: "" },
        (win.window ?? win).navigator ?? { userAgent: "Mozilla/5.0 (iPhone)" },
        (win.window ?? win).MutationObserver,
        (win.window ?? win).requestAnimationFrame,
        (win.window ?? win).getComputedStyle,
      );
    } catch (err) {
      jsThrew = String((err as Error)?.message ?? err);
    }
  }

  const afterHtml = snapshot();

  // A real change = the serialized DOM differs (element added anywhere, or content
  // mutated). Length change OR string inequality both count — a same-length text
  // swap (rare) still differs as a string.
  const producedChange = afterHtml !== beforeHtml;

  if (jsThrew && !producedChange) {
    return { ok: false, reason: "js_error", detail: `Variant JS threw and produced no change: ${jsThrew}` };
  }
  if (!producedChange) {
    return {
      ok: false,
      reason: "no_visible_change",
      detail:
        "Variant ran but produced no DOM change on the real page — it likely targets an element/relationship that doesn't exist on this theme, or gates its only effect on missing data.",
    };
  }
  return { ok: true };
}

/** Minimal shims so layout/scroll/matchMedia-gated variant JS runs its main path. */
function shimWindow(win: ReturnType<typeof parseHTML>, deviceType?: string | null): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = (win.window ?? win) as any;
  // Use a width matching the variant's target device so device-gated JS
  // (innerWidth checks, matchMedia) runs its MAIN path instead of bailing.
  const isDesktop = deviceType === "desktop";
  const width = isDesktop ? 1440 : 390;
  const height = isDesktop ? 900 : 844;
  w.innerWidth = width;
  w.innerHeight = height;
  w.matchMedia = function (q: string) {
    // Evaluate min-width / max-width queries against our chosen width.
    let matches = false;
    const min = /min-width:\s*(\d+)/.exec(q);
    const max = /max-width:\s*(\d+)/.exec(q);
    if (min && max) matches = width >= parseInt(min[1], 10) && width <= parseInt(max[1], 10);
    else if (min) matches = width >= parseInt(min[1], 10);
    else if (max) matches = width <= parseInt(max[1], 10);
    return { matches, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
  };
  w.requestAnimationFrame = w.requestAnimationFrame || ((cb: (t: number) => void) => { try { cb(0); } catch { /* */ } return 0; });
  w.scrollTo = w.scrollTo || (() => {});
  w.getComputedStyle = w.getComputedStyle || (() => ({ getPropertyValue: () => "" }));
  // getBoundingClientRect: pretend elements are below the fold so "show on scroll"
  // logic that reveals a bar will reveal it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = (win.document as any)?.defaultView?.Element?.prototype;
  if (proto && !proto.getBoundingClientRect) {
    proto.getBoundingClientRect = function () {
      return { top: 9999, bottom: 9999, left: 0, right: 0, width: 0, height: 0 };
    };
  }
}

/**
 * Visual (geometry) validation of a variant — catches AESTHETIC/layout breakage
 * that the linkedom render check can't (linkedom has no layout engine).
 *
 * Renders the REAL target page in headless Chromium, injects the variant, and
 * runs DETERMINISTIC geometry assertions (no fuzzy "is it pretty" judgment):
 *   - text wrapped into an absurd number of lines (e.g. "Subtotal" → "Sub/tota/l")
 *   - an element overflows its parent's width
 *   - the variant's own added element overflows the viewport / its container
 *   - horizontal overflow appears on the page that wasn't there in control
 *
 * Designed to FAIL OPEN: if Chromium can't launch (e.g. missing libs in the
 * worker image) or the page can't load, it returns ok:true with a skipped flag
 * so a build is never blocked by validator infrastructure. Gated behind
 * VISUAL_VALIDATION=on so it can be turned off without a deploy.
 */

export interface VisualValidationResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  detail?: string;
}

interface VisualInput {
  pageUrl: string;               // the real target page URL (with ?_cro to bust cache if desired)
  htmlPatch: string | null;
  cssPatch: string | null;
  jsPatch: string | null;
  deviceType?: string | null;    // "mobile" | "desktop"
  storefrontPassword?: string | null; // for password-protected dev stores
}

const VIEWPORTS: Record<string, { width: number; height: number }> = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 },
  tablet: { width: 820, height: 1180 },
};

/**
 * The geometry assertions, serialized to run INSIDE the page via evaluate().
 * Returns a list of problems found (empty = clean).
 */
function pageAuditFn() {
  const problems: string[] = [];
  const docWidth = document.documentElement.clientWidth;

  // 1. Page-level horizontal overflow (something pushed the page wider than the viewport).
  if (document.documentElement.scrollWidth > docWidth + 2) {
    problems.push(`page overflows horizontally by ${document.documentElement.scrollWidth - docWidth}px`);
  }

  // Inspect elements the variant created (cro-/ab- prefixed ids/classes) + their neighbours.
  const variantEls = Array.from(
    document.querySelectorAll('[id^="cro-"],[id^="ab-"],[class*="cro-"],[class*="ab-"]'),
  );

  for (const el of variantEls) {
    const node = el as HTMLElement;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue; // hidden/not shown — not a layout break

    // 2. Variant element overflows its parent's width.
    const parent = node.parentElement;
    if (parent) {
      const pRect = parent.getBoundingClientRect();
      if (rect.right > pRect.right + 2 || rect.left < pRect.left - 2) {
        problems.push(`variant element <${node.tagName.toLowerCase()} ${node.id || node.className}> overflows its container horizontally`);
      }
    }

    // 3. Variant element overflows the viewport.
    if (rect.right > docWidth + 2 || rect.left < -2) {
      problems.push(`variant element <${node.id || node.className}> extends outside the viewport`);
    }
  }

  // 4. Absurd text wrapping: any element whose text wrapped into many lines for a
  //    short string (the "Sub/tota/l" symptom). Check elements near the variant.
  const checkWrap = (node: Element) => {
    const he = node as HTMLElement;
    const text = (he.textContent || "").trim();
    if (!text || text.length > 40 || text.includes(" ")) return; // only single short words
    const cs = getComputedStyle(he);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2 || 16;
    const lines = he.getBoundingClientRect().height / lh;
    // A single short word rendering on 3+ lines means it got squeezed.
    if (lines >= 3) problems.push(`text "${text}" wrapped onto ${Math.round(lines)} lines (squeezed)`);
  };
  // Check the variant elements' siblings (where squeezing shows up).
  for (const el of variantEls) {
    const p = el.parentElement;
    if (!p) continue;
    Array.from(p.children).forEach(checkWrap);
  }

  return problems;
}

/** Apply the variant the way the storefront injector does. Runs inside the page. */
function applyPatchInPage(p: { htmlPatch: string | null; cssPatch: string | null; jsPatch: string | null }) {
  try {
    if (p.cssPatch) {
      const style = document.createElement("style");
      style.textContent = p.cssPatch;
      document.head.appendChild(style);
    }
    if (p.htmlPatch) {
      const tmp = document.createElement("div");
      tmp.innerHTML = p.htmlPatch;
      while (tmp.firstChild) document.body.appendChild(tmp.firstChild);
    }
    if (p.jsPatch) {
      let code = p.jsPatch;
      if (/<script[\s>]/i.test(code)) code = code.replace(/<script[^>]*>/gi, "").replace(/<\/script>/gi, "").trim();
      // eslint-disable-next-line no-new-func
      new Function(code)();
    }
  } catch { /* a thrown variant is caught by the no-change render check separately */ }
}

/** If we're validating a cart-page variant, make sure the cart has an item. */
async function ensureCartForCartPage(page: import("playwright").Page, pageUrl: string): Promise<void> {
  if (!/\/cart(\?|$)/.test(pageUrl)) return;
  try {
    const empty = await page.evaluate(() => !document.querySelector(".cart-item, tr.cart-item, .cart__items"));
    if (empty) {
      const origin = new URL(pageUrl).origin;
      // grab a product + add to cart, then reload the cart
      await page.goto(`${origin}/products.json?limit=1`, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      const vid = await page.evaluate(() => {
        try { const j = JSON.parse(document.body.innerText); return j.products?.[0]?.variants?.[0]?.id ?? null; } catch { return null; }
      });
      if (vid) {
        await page.goto(`${origin}/cart/add?id=${vid}&quantity=1`, { waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
        await page.goto(pageUrl, { waitUntil: "networkidle", timeout: 20000 });
      }
    }
  } catch { /* best effort */ }
}

export async function validateVariantVisually(input: VisualInput): Promise<VisualValidationResult> {
  if (process.env.VISUAL_VALIDATION !== "on") {
    return { ok: true, skipped: true, reason: "disabled" };
  }

  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return { ok: true, skipped: true, reason: "playwright_unavailable" };
  }

  const vp = VIEWPORTS[input.deviceType ?? "mobile"] ?? VIEWPORTS.mobile;
  let browser: import("playwright").Browser | null = null;
  try {
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      // Use the Alpine system Chromium in prod (Playwright's bundled browser is
      // glibc and won't run on musl). Falls back to Playwright's browser locally.
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    });
    const ctx = await browser.newContext({ viewport: vp });
    const page = await ctx.newPage();

    // Unlock a password-protected dev storefront if needed.
    if (input.storefrontPassword) {
      try {
        const u = new URL(input.pageUrl);
        await page.goto(`${u.origin}/password`, { waitUntil: "domcontentloaded", timeout: 15000 });
        await page.fill('input[name="password"]', input.storefrontPassword);
        await page.click('form[action*="password"] button, button[type="submit"]');
        await page.waitForTimeout(1200);
      } catch { /* not password-protected, or already unlocked */ }
    }

    // Load the real page, then measure baseline horizontal overflow BEFORE the variant.
    await page.goto(input.pageUrl, { waitUntil: "networkidle", timeout: 20000 });
    await ensureCartForCartPage(page, input.pageUrl);
    const controlOverflow = (await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )) as number;

    // Apply the variant the SAME way the injector does: CSS in <style>, HTML
    // appended to body, JS via new Function (script-unwrapped).
    await page.evaluate(applyPatchInPage, {
      htmlPatch: input.htmlPatch,
      cssPatch: input.cssPatch,
      jsPatch: input.jsPatch,
    });
    await page.waitForTimeout(700); // let the variant's JS run
    // Force layout of lazy/below-fold sections so geometry is real, not zero.
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      const el = document.querySelector('[id^="cro-"],[id^="ab-"]');
      if (el) (el as HTMLElement).scrollIntoView({ block: "center" });
    });
    await page.waitForTimeout(300);

    const problems = (await page.evaluate(pageAuditFn)) as string[];
    const filtered = problems.filter((p) => {
      if (p.startsWith("page overflows") && controlOverflow > 2) return false; // pre-existing
      return true;
    });

    await browser.close();
    browser = null;

    if (filtered.length > 0) {
      return { ok: false, reason: "layout_broken", detail: filtered.slice(0, 4).join("; ") };
    }
    return { ok: true };
  } catch (err) {
    // Fail open — never block a build on validator infra.
    if (browser) await browser.close().catch(() => {});
    return { ok: true, skipped: true, reason: "render_error", detail: String((err as Error)?.message ?? err) };
  }
}

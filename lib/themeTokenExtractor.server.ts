/**
 * Extracts CSS custom properties and native component HTML from a store's
 * live public storefront. No Shopify API scope required — pure HTTP fetch.
 *
 * Replaces the old brandExtractor.server.ts which required read_themes scope.
 */

import type { Shop } from "@prisma/client";
import prisma from "../app/db.server";

export interface ThemeTokens {
  extractedAt: string;
  storeDomain: string;
  cssVars: Record<string, string>;
  componentHtml: {
    button?: string;
    heading?: string;
    card?: string;
  };
  /**
   * Real DOM vocabulary scraped from the live storefront — the set of class
   * names, ids, and data-* attributes that ACTUALLY exist. The variant builder
   * is constrained to these so it can't invent selectors that match nothing.
   */
  domVocabulary?: {
    classes: string[];
    ids: string[];
    dataAttrs: string[];
  };
  /** Curated real selectors by element kind, for prompt grounding. */
  realSelectors?: {
    headings: string[];
    buttons: string[];
  };
  capturedPages?: string[];
}

type ShopForExtraction = Pick<Shop, "id" | "shopifyDomain">;

const FETCH_TIMEOUT_MS = 10_000;

// ─── Pure functions (exported for testing) ───────────────────────────────────

/**
 * Bare CSS unit with no numeric component. Shopify themes frequently template
 * vars from theme settings (e.g. `--media-padding: {{ settings.padding }}px;`).
 * When the setting is empty this renders to a lone unit like `px` — useless and
 * actively harmful if a variant interpolates it. We drop these.
 */
const BARE_UNIT_RE = /^(?:px|rem|em|%|vh|vw|vmin|vmax|pt|pc|ch|ex|cm|mm|in|q|fr|deg|rad|s|ms)$/i;

/** True if a CSS var value is usable (not empty, not a bare unit, not stray Liquid). */
export function isUsableCssVarValue(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  // Un-rendered Liquid template fragments leaked into the CSS
  if (v.includes("{{") || v.includes("}}") || v.includes("{%")) return false;
  // Lone unit with no number (empty theme-setting interpolation)
  if (BARE_UNIT_RE.test(v)) return false;
  return true;
}

/** Extract CSS custom properties from raw CSS text (no HTML) */
export function extractCssVarsFromCss(css: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const rootMatches = css.matchAll(/:root\s*\{([^}]+)\}/g);
  for (const block of rootMatches) {
    const varMatches = block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g);
    for (const v of varMatches) {
      const value = v[2].trim();
      if (isUsableCssVarValue(value)) vars[v[1].trim()] = value;
    }
  }
  return vars;
}

/** Extract all CSS custom properties from :root blocks in raw HTML */
export function extractCssVarsFromHtml(html: string): Record<string, string> {
  const styleContents: string[] = [];
  const styleMatches = html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi);
  for (const m of styleMatches) {
    styleContents.push(m[1]);
  }
  return extractCssVarsFromCss(styleContents.join("\n"));
}

/** Scrape first instance of known component patterns from HTML */
export function extractComponentHtml(html: string): ThemeTokens["componentHtml"] {
  const components: ThemeTokens["componentHtml"] = {};

  const btnMatch = html.match(/<button[^>]*class="[^"]*button--primary[^"]*"[^>]*>/i);
  if (btnMatch) components.button = btnMatch[0].slice(0, 500);

  const h1Match = html.match(/<h1[^>]*>/i);
  const h2Match = html.match(/<h2[^>]*>/i);
  if (h1Match) components.heading = h1Match[0].slice(0, 500);
  else if (h2Match) components.heading = h2Match[0].slice(0, 500);

  const cardMatch = html.match(/<div[^>]*class="[^"]*(?:card(?:--standard|--media|--product)?|product-card)[^"]*"[^>]*>/i);
  if (cardMatch) components.card = cardMatch[0].slice(0, 500);

  return components;
}

/** Every class name, id, and data-* attribute name that appears in the HTML. */
export function extractDomVocabulary(html: string): { classes: string[]; ids: string[]; dataAttrs: string[] } {
  const classes = new Set<string>();
  const ids = new Set<string>();
  const dataAttrs = new Set<string>();
  for (const m of html.matchAll(/\sclass\s*=\s*"([^"]*)"/gi)) {
    for (const c of m[1].split(/\s+/)) if (c && c.length <= 60) classes.add(c);
  }
  for (const m of html.matchAll(/\sid\s*=\s*"([^"]*)"/gi)) {
    const id = m[1].trim();
    if (id && id.length <= 60) ids.add(id);
  }
  for (const m of html.matchAll(/\s(data-[a-z0-9-]+)\s*=/gi)) {
    dataAttrs.add(m[1].toLowerCase());
  }
  return { classes: [...classes], ids: [...ids], dataAttrs: [...dataAttrs] };
}

/** Real, usable selectors for the elements variants most commonly target. */
export function extractRealSelectors(html: string): { headings: string[]; buttons: string[] } {
  const headings: string[] = [];
  const buttons: string[] = [];
  const seen = new Set<string>();
  const pick = (classAttr: string | undefined): string | null => {
    if (!classAttr) return null;
    const cls = classAttr.split(/\s+/).filter(Boolean);
    // Prefer a descriptive class — skip state/utility prefixes.
    return (
      cls.find((c) => c.length > 3 && !/^(js-|is-|has-|w-|h-|sr-|visually)/.test(c)) ??
      cls[0] ??
      null
    );
  };
  const add = (arr: string[], tag: string, classAttr: string | undefined) => {
    const c = pick(classAttr);
    const sel = c ? `${tag}.${c}` : tag;
    if (!seen.has(sel)) {
      seen.add(sel);
      arr.push(sel);
    }
  };
  for (const m of html.matchAll(/<(h1|h2|h3)\b([^>]*)>/gi)) {
    if (headings.length >= 10) break;
    add(headings, m[1].toLowerCase(), m[2].match(/class\s*=\s*"([^"]*)"/i)?.[1]);
  }
  for (const m of html.matchAll(/<(button|a)\b([^>]*)>/gi)) {
    if (buttons.length >= 10) break;
    const classAttr = m[2].match(/class\s*=\s*"([^"]*)"/i)?.[1];
    // Only "buttony" anchors; all <button>s.
    if (m[1].toLowerCase() === "a" && !(classAttr && /button|btn|cta/i.test(classAttr))) continue;
    add(buttons, m[1].toLowerCase(), classAttr);
  }
  return { headings, buttons };
}

/** First product URL path found on a page (for sampling product-page structure). */
function findProductPath(html: string): string | null {
  const m = html.match(/href\s*=\s*"(\/products\/[A-Za-z0-9\-_%]+)(?:[?#"]|$)/i);
  return m ? m[1] : null;
}

// ─── Async orchestration ─────────────────────────────────────────────────────

async function fetchStorefrontHtml(shopDomain: string, path = "/"): Promise<string> {
  const storefrontPassword = process.env.STOREFRONT_PASSWORD;
  const baseHeaders: Record<string, string> = {
    "User-Agent": "Shivook-CRO-Extractor/1.0",
    Accept: "text/html,application/xhtml+xml",
  };

  const abortFetch = (url: string, init: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    return fetch(url, { ...init, signal: controller.signal }).finally(() =>
      clearTimeout(timer)
    );
  };

  // First attempt — works for non-password-protected stores
  const firstRes = await abortFetch(`https://${shopDomain}${path}`, { headers: baseHeaders });

  // If redirected to /password and we have a password, do the Shopify form POST
  if (
    storefrontPassword &&
    (firstRes.url.includes("/password") || firstRes.redirected && firstRes.url.includes("/password") ||
      firstRes.status === 302)
  ) {
    // Step 1: get the form page to capture session cookie
    const pwPageRes = await abortFetch(`https://${shopDomain}/password`, {
      headers: baseHeaders,
    });
    const setCookie = pwPageRes.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0]; // take first key=value pair

    // Step 2: POST the password
    const formBody = new URLSearchParams({
      form_type: "storefront_password",
      utf8: "✓",
      password: storefrontPassword,
    });
    const postRes = await abortFetch(`https://${shopDomain}/password`, {
      method: "POST",
      headers: {
        ...baseHeaders,
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
      },
      body: formBody.toString(),
      redirect: "manual",
    });

    // Step 3: follow the redirect with the session cookie
    const redirectCookie =
      postRes.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    const pageRes = await abortFetch(`https://${shopDomain}${path}`, {
      headers: { ...baseHeaders, Cookie: redirectCookie },
    });
    if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status} after password auth`);
    return pageRes.text();
  }

  if (!firstRes.ok) throw new Error(`HTTP ${firstRes.status} fetching https://${shopDomain}${path}`);
  return firstRes.text();
}

function isSafeStylesheetUrl(url: string, shopDomain: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === shopDomain ||
      hostname.endsWith(".shopifycdn.com") ||
      hostname.endsWith(".shopify.com") ||
      hostname.endsWith(".myshopify.com") ||
      hostname.endsWith(".cdn.shopify.com") ||
      hostname.endsWith(".shopifycloud.com") // Shopify theme CDN
    );
  } catch {
    return false;
  }
}

async function fetchLinkedStylesheets(
  html: string,
  shopDomain: string
): Promise<string> {
  const urls: string[] = [];
  const linkMatches = html.matchAll(
    /<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["'][^>]*>/gi
  );
  for (const m of linkMatches) {
    const href = m[1];
    if (href.startsWith("//")) {
      const full = "https:" + href;
      if (isSafeStylesheetUrl(full, shopDomain)) urls.push(full);
    } else if (href.startsWith("/")) {
      urls.push(`https://${shopDomain}${href}`); // same-origin, always safe
    } else if (href.startsWith("http")) {
      if (isSafeStylesheetUrl(href, shopDomain)) urls.push(href);
    }
  }

  const results = await Promise.allSettled(
    urls.slice(0, 5).map((url) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      return fetch(url, { signal: ctrl.signal })
        .then((r) => r.text())
        .finally(() => clearTimeout(t));
    })
  );
  return results
    .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
    .map((r) => r.value)
    .join("\n");
}

/**
 * Fetch and store theme tokens for a shop. Never throws — always best-effort.
 * Replaces extractStoreBranding() from the old brandExtractor.server.ts.
 */
export async function extractThemeTokens(shop: ShopForExtraction): Promise<void> {
  const domain = shop.shopifyDomain;
  try {
    const html = await fetchStorefrontHtml(domain);

    // Extract from inline <style> blocks
    let cssVars = extractCssVarsFromHtml(html);

    // Also try linked stylesheets (Shopify themes often put :root vars there)
    const sheetCss = await fetchLinkedStylesheets(html, domain);
    if (sheetCss) {
      const sheetVars = extractCssVarsFromCss(sheetCss);
      // Stylesheet vars win on conflict — Shopify themes define :root vars
      // in external stylesheets; these are "later" in the cascade
      cssVars = { ...cssVars, ...sheetVars };
    }

    const componentHtml = extractComponentHtml(html);

    // ── Real DOM grounding: capture the actual selector vocabulary so the
    // variant builder targets elements that exist instead of inventing them.
    const capturedPages = ["homepage"];
    const vocab = extractDomVocabulary(html);
    const realSelectors = extractRealSelectors(html);

    // Sample a product page too (different structure from the homepage) so
    // product-page experiments have real selectors to target.
    try {
      const productPath = findProductPath(html);
      if (productPath) {
        const productHtml = await fetchStorefrontHtml(domain, productPath);
        const pVocab = extractDomVocabulary(productHtml);
        const pSelectors = extractRealSelectors(productHtml);
        vocab.classes = [...new Set([...vocab.classes, ...pVocab.classes])];
        vocab.ids = [...new Set([...vocab.ids, ...pVocab.ids])];
        vocab.dataAttrs = [...new Set([...vocab.dataAttrs, ...pVocab.dataAttrs])];
        realSelectors.headings = [...new Set([...realSelectors.headings, ...pSelectors.headings])];
        realSelectors.buttons = [...new Set([...realSelectors.buttons, ...pSelectors.buttons])];
        capturedPages.push("product");
      }
    } catch (err) {
      console.warn(`[themeTokenExtractor] product-page sample failed for ${domain}:`, err);
    }

    if (Object.keys(cssVars).length === 0) {
      console.warn(
        `[themeTokenExtractor] no CSS vars found for ${domain} — store may use a legacy theme`
      );
    }

    const tokens: ThemeTokens = {
      extractedAt: new Date().toISOString(),
      storeDomain: domain,
      cssVars,
      componentHtml,
      domVocabulary: vocab,
      realSelectors,
      capturedPages,
    };

    await prisma.shop.update({
      where: { id: shop.id },
      data: { themeTokens: tokens as object },
    });

    console.log(
      `[themeTokenExtractor] ${domain}: ${Object.keys(cssVars).length} CSS vars, ` +
        `${vocab.classes.length} classes / ${vocab.ids.length} ids / ${vocab.dataAttrs.length} data-attrs ` +
        `across [${capturedPages.join(", ")}]`
    );
  } catch (err) {
    console.warn(`[themeTokenExtractor] extraction failed for ${domain}:`, err);
  }
}

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
}

type ShopForExtraction = Pick<Shop, "id" | "shopifyDomain">;

const FETCH_TIMEOUT_MS = 10_000;

// ─── Pure functions (exported for testing) ───────────────────────────────────

/** Extract CSS custom properties from raw CSS text (no HTML) */
export function extractCssVarsFromCss(css: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const rootMatches = css.matchAll(/:root\s*\{([^}]+)\}/g);
  for (const block of rootMatches) {
    const varMatches = block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g);
    for (const v of varMatches) {
      vars[v[1].trim()] = v[2].trim();
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

// ─── Async orchestration ─────────────────────────────────────────────────────

async function fetchStorefrontHtml(shopDomain: string): Promise<string> {
  const storefrontPassword = process.env.STOREFRONT_PASSWORD;
  const headers: Record<string, string> = {
    "User-Agent": "Shivook-CRO-Extractor/1.0",
    Accept: "text/html,application/xhtml+xml",
  };
  if (storefrontPassword) {
    headers["Storefront-Password"] = storefrontPassword;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://${shopDomain}/`, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching https://${shopDomain}/`);
    return res.text();
  } finally {
    clearTimeout(timer);
  }
}

function isSafeStylesheetUrl(url: string, shopDomain: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === shopDomain ||
      hostname.endsWith(".shopifycdn.com") ||
      hostname.endsWith(".shopify.com") ||
      hostname.endsWith(".myshopify.com") ||
      hostname.endsWith(".cdn.shopify.com")
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
    };

    await prisma.shop.update({
      where: { id: shop.id },
      data: { themeTokens: tokens as object },
    });

    console.log(
      `[themeTokenExtractor] extracted ${Object.keys(cssVars).length} CSS vars, ` +
        `${Object.keys(componentHtml).length} components for ${domain}`
    );
  } catch (err) {
    console.warn(`[themeTokenExtractor] extraction failed for ${domain}:`, err);
  }
}

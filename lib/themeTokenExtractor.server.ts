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

// ─── Pure functions (exported for testing) ───────────────────────────────────

/** Extract all CSS custom properties from :root blocks in raw HTML */
export function extractCssVarsFromHtml(html: string): Record<string, string> {
  const vars: Record<string, string> = {};

  // Collect all <style> block contents
  const styleContents: string[] = [];
  const styleMatches = html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi);
  for (const m of styleMatches) {
    styleContents.push(m[1]);
  }
  const allCss = styleContents.join("\n");

  // Extract :root { } blocks
  const rootMatches = allCss.matchAll(/:root\s*\{([^}]+)\}/g);
  for (const block of rootMatches) {
    const varMatches = block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g);
    for (const v of varMatches) {
      vars[v[1].trim()] = v[2].trim();
    }
  }

  return vars;
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

  const cardMatch = html.match(/<div[^>]*class="[^"]*(?:product-card|card--standard|card--media)[^"]*"[^>]*>/i);
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

  const res = await fetch(`https://${shopDomain}/`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching https://${shopDomain}/`);
  return res.text();
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
    if (href.startsWith("//")) urls.push("https:" + href);
    else if (href.startsWith("/")) urls.push(`https://${shopDomain}${href}`);
    else if (href.startsWith("http")) urls.push(href);
  }

  const results = await Promise.allSettled(
    urls.slice(0, 5).map((url) => fetch(url).then((r) => r.text()))
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
      const sheetVars = extractCssVarsFromHtml(`<style>${sheetCss}</style>`);
      // Inline vars win on conflict (set after merging sheet vars)
      cssVars = { ...sheetVars, ...cssVars };
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

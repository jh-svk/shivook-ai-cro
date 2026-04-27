/**
 * Extracts design tokens from the shop's active Shopify theme.
 * Writes merged result back to shop.brandGuardrails.
 * Uses stored access token — safe to call from both route loaders and BullMQ jobs.
 */

import type { Shop } from "@prisma/client";
import prisma from "../app/db.server";

type ShopForExtraction = Pick<Shop, "id" | "shopifyDomain" | "accessToken" | "brandGuardrails">;

const THEMES_QUERY = `
  query {
    themes(first: 10, roles: [MAIN]) {
      nodes { id name role }
    }
  }
`;

const THEME_FILES_QUERY = `
  query ($themeId: ID!) {
    theme(id: $themeId) {
      files(filenames: ["config/settings_data.json"]) {
        nodes {
          filename
          body {
            ... on OnlineStoreThemeFileBodyText { content }
          }
        }
      }
    }
  }
`;

async function shopifyGraphQL(
  shop: Pick<Shop, "shopifyDomain" | "accessToken">,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<unknown> {
  const res = await fetch(
    `https://${shop.shopifyDomain}/admin/api/2026-04/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": shop.accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (res.status === 429) {
    const retryAfter = parseFloat(res.headers.get("Retry-After") ?? "2");
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    throw new Error("Shopify rate limited");
  }
  if (!res.ok) throw new Error(`Shopify Admin API ${res.status}`);
  return res.json();
}

// Shopify theme font values look like "assistant_n4" — pull the family name
function parseFontFamily(val: unknown): string | null {
  if (typeof val !== "string" || !val) return null;
  const family = val.split("_")[0].replace(/-/g, " ");
  return family || null;
}

export async function extractStoreBranding(shop: ShopForExtraction): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const themesResult = (await shopifyGraphQL(shop, THEMES_QUERY)) as any;
    const themes: { id: string; name: string; role: string }[] =
      themesResult?.data?.themes?.nodes ?? [];
    const mainTheme = themes.find((t) => t.role === "MAIN") ?? themes[0];
    if (!mainTheme) {
      console.warn(`[brandExtractor] no theme found for ${shop.shopifyDomain}`);
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filesResult = (await shopifyGraphQL(shop, THEME_FILES_QUERY, { themeId: mainTheme.id })) as any;
    const fileNode = filesResult?.data?.theme?.files?.nodes?.[0];
    const content: string | undefined = fileNode?.body?.content;
    if (!content) {
      console.warn(`[brandExtractor] settings_data.json not found for ${shop.shopifyDomain}`);
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let settingsData: Record<string, any>;
    try {
      settingsData = JSON.parse(content);
    } catch {
      console.warn(`[brandExtractor] could not parse settings_data.json for ${shop.shopifyDomain}`);
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const current: Record<string, any> = settingsData?.current ?? {};

    // Extract colors using common theme key patterns
    const colors: Record<string, string> = {};
    const colorCandidates: [string, string[]][] = [
      ["primary", ["colors_accent_1", "color_primary", "color_accent", "color_button"]],
      ["secondary", ["colors_accent_2", "color_secondary"]],
      ["background", ["colors_background_1", "color_body_bg", "color_background"]],
      ["text", ["colors_text", "color_text", "color_base_text"]],
      ["button", ["colors_solid_button_labels", "color_button_label"]],
    ];
    for (const [label, keys] of colorCandidates) {
      for (const key of keys) {
        const val = current[key];
        if (val && typeof val === "string" && /^#[0-9a-fA-F]{3,8}$/.test(val.trim())) {
          colors[label] = val.trim();
          break;
        }
      }
    }

    // Extract fonts
    const fonts: Record<string, string> = {};
    const headingFont = parseFontFamily(
      current.type_header_font ?? current.font_heading ?? current.heading_font
    );
    const bodyFont = parseFontFamily(
      current.type_body_font ?? current.font_body ?? current.body_font
    );
    if (headingFont) fonts.heading = headingFont;
    if (bodyFont) fonts.body = bodyFont;

    // Extract border radius
    let borderRadius: string | undefined;
    for (const key of ["buttons_border_radius", "button_border_radius", "inputs_border_radius"]) {
      if (current[key] != null) {
        borderRadius = `${current[key]}px`;
        break;
      }
    }

    if (Object.keys(colors).length === 0 && Object.keys(fonts).length === 0) {
      console.warn(`[brandExtractor] no usable tokens extracted for ${shop.shopifyDomain}`);
      return;
    }

    const extracted: Record<string, unknown> = {
      extractedAt: new Date().toISOString(),
      source: "shopify_theme",
      colors: Object.keys(colors).length > 0 ? colors : undefined,
      fonts: Object.keys(fonts).length > 0 ? fonts : undefined,
      borderRadius,
    };
    // Remove undefined keys
    for (const k of Object.keys(extracted)) {
      if (extracted[k] === undefined) delete extracted[k];
    }

    // Manual fields win — spread extracted as base, then manual on top
    const existing = (shop.brandGuardrails as Record<string, unknown>) ?? {};
    const merged: Record<string, unknown> = {
      ...extracted,
      ...existing,
      // Always refresh the extraction metadata
      extractedAt: extracted.extractedAt,
      source: "shopify_theme",
      // Prefer extracted colors/fonts only when not manually set
      colors: existing.colors ?? extracted.colors,
      fonts: existing.fonts ?? extracted.fonts,
      borderRadius: existing.borderRadius ?? extracted.borderRadius,
    };

    await prisma.shop.update({
      where: { id: shop.id },
      data: { brandGuardrails: merged as object },
    });

    console.log(
      `[brandExtractor] extracted tokens for ${shop.shopifyDomain}: ` +
        `${Object.keys(colors).length} colors, ${Object.keys(fonts).length} fonts`
    );
  } catch (err) {
    // Never throw — brand extraction is best-effort
    console.warn(`[brandExtractor] extraction failed for ${shop.shopifyDomain}:`, err);
  }
}

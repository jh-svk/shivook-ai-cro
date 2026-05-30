# Brand-Native Variant Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the autoBuild job generate variants that look visually native to the store by extracting live CSS custom properties + component HTML, injecting them as hard constraints into the generation prompt, and adding a Haiku-powered design critique pass before variants reach QA.

**Architecture:** A new `lib/themeTokenExtractor.server.ts` fetches the store's public storefront HTML and extracts CSS custom properties + native component markup, storing the result in a new `shop.themeTokens` DB field. The autoBuild job loads these tokens, passes them to an enhanced generation prompt, then runs a fast Haiku critique pass — with one retry on failure — before handing off to the existing qaReview stage.

**Tech Stack:** TypeScript, Prisma (Postgres/Neon), BullMQ, Anthropic SDK (Sonnet for generation, Haiku for critique), Vitest (new, for unit tests on pure functions)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `prisma/schema.prisma` | Modify | Add `themeTokens Json?` to Shop model |
| `prisma/migrations/*/migration.sql` | Create (auto) | ALTER TABLE for new field |
| `lib/themeTokenExtractor.server.ts` | **Create** | Public HTTP fetch, CSS var parsing, component HTML scraping |
| `lib/brandExtractor.server.ts` | Retire | Remove file; replace two callers |
| `lib/themeTokenExtractor.test.ts` | **Create** | Vitest unit tests for pure parsing functions |
| `jobs/dataSync.ts` | Modify | Replace `extractStoreBranding` call with `extractThemeTokens` |
| `jobs/autoBuild.ts` | Modify | Load themeTokens; enhance buildSystemPrompt + buildUserPrompt; add designCritique |
| `app/routes/app.tsx` | Modify | Replace `extractStoreBranding` import + call |
| `app/routes/app.settings.tsx` | Modify | Add "Re-sync theme tokens" action + button |

---

## Task 1: Add vitest

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Install vitest**

```bash
npm install --save-dev vitest
```

Expected: vitest appears in `package.json` devDependencies.

- [ ] **Step 2: Create vitest config**

Create `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "jobs/**/*.test.ts"],
  },
});
```

- [ ] **Step 3: Add test script to package.json**

In `package.json`, add to `scripts`:
```json
"test:unit": "vitest run"
```

- [ ] **Step 4: Verify vitest runs (no tests yet)**

```bash
npm run test:unit
```

Expected: `No test files found` or similar — exits 0.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add vitest for unit tests"
```

---

## Task 2: Schema migration — add themeTokens

**Files:**
- Modify: `prisma/schema.prisma` (line ~39, after `brandGuardrails`)
- Create: `prisma/migrations/*/migration.sql` (auto-generated)

- [ ] **Step 1: Add field to schema**

In `prisma/schema.prisma`, after `brandGuardrails Json?`:

```prisma
brandGuardrails        Json?
themeTokens            Json?
```

- [ ] **Step 2: Run migration against Neon**

```bash
DATABASE_URL="postgresql://neondb_owner:npg_5ZQRUhIWJ3Ez@ep-proud-glade-aqo5nhkc.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require" DATABASE_URL_UNPOOLED="postgresql://neondb_owner:npg_5ZQRUhIWJ3Ez@ep-proud-glade-aqo5nhkc.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require" npx prisma migrate dev --name add_theme_tokens
```

Expected: Migration created and applied. New file appears in `prisma/migrations/`.

- [ ] **Step 3: Regenerate Prisma client**

```bash
npx prisma generate
```

Expected: Client regenerated, `Shop` type now includes `themeTokens: Prisma.JsonValue | null`.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add Shop.themeTokens Json field via migration"
```

---

## Task 3: Build themeTokenExtractor — pure functions + tests

**Files:**
- Create: `lib/themeTokenExtractor.server.ts`
- Create: `lib/themeTokenExtractor.test.ts`

- [ ] **Step 1: Write failing tests first**

Create `lib/themeTokenExtractor.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extractCssVarsFromHtml, extractComponentHtml } from "./themeTokenExtractor.server";

const SAMPLE_HTML = `
<html>
<head>
<style>
:root {
  --color-button: #1a1a1a;
  --color-button-text: #ffffff;
  --font-body-family: 'Helvetica Neue', sans-serif;
  --buttons--border-radius: 0px;
}
body { color: red; }
</style>
</head>
<body>
  <button type="submit" class="button button--primary button--full-width">Add to cart</button>
  <h1 class="h1">Product Title</h1>
  <div class="card card--standard">Card</div>
</body>
</html>
`;

const NO_VARS_HTML = `<html><body><p>No styles here</p></body></html>`;

describe("extractCssVarsFromHtml", () => {
  it("extracts all :root CSS custom properties", () => {
    const vars = extractCssVarsFromHtml(SAMPLE_HTML);
    expect(vars["--color-button"]).toBe("#1a1a1a");
    expect(vars["--color-button-text"]).toBe("#ffffff");
    expect(vars["--font-body-family"]).toBe("'Helvetica Neue', sans-serif");
    expect(vars["--buttons--border-radius"]).toBe("0px");
  });

  it("does not include non-custom-property declarations", () => {
    const vars = extractCssVarsFromHtml(SAMPLE_HTML);
    expect(Object.keys(vars).every(k => k.startsWith("--"))).toBe(true);
  });

  it("returns empty object when no CSS vars present", () => {
    const vars = extractCssVarsFromHtml(NO_VARS_HTML);
    expect(vars).toEqual({});
  });

  it("later declaration wins when same var declared twice", () => {
    const html = `<style>:root { --color-button: #first; } :root { --color-button: #second; }</style>`;
    const vars = extractCssVarsFromHtml(html);
    expect(vars["--color-button"]).toBe("#second");
  });
});

describe("extractComponentHtml", () => {
  it("extracts button--primary element", () => {
    const components = extractComponentHtml(SAMPLE_HTML);
    expect(components.button).toContain("button--primary");
  });

  it("extracts h1 as heading", () => {
    const components = extractComponentHtml(SAMPLE_HTML);
    expect(components.heading).toContain("<h1");
  });

  it("extracts card element", () => {
    const components = extractComponentHtml(SAMPLE_HTML);
    expect(components.card).toContain("card");
  });

  it("returns empty object when no components found", () => {
    const components = extractComponentHtml(NO_VARS_HTML);
    expect(components).toEqual({});
  });

  it("trims component HTML to 500 chars max", () => {
    const longAttr = "x".repeat(1000);
    const html = `<button class="button--primary" data-long="${longAttr}">Click</button>`;
    const components = extractComponentHtml(html);
    expect((components.button ?? "").length).toBeLessThanOrEqual(500);
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
npm run test:unit
```

Expected: FAIL — `extractCssVarsFromHtml` and `extractComponentHtml` not found.

- [ ] **Step 3: Implement the extractor**

Create `lib/themeTokenExtractor.server.ts`:

```typescript
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
      // Sheet vars merge in; inline vars win on conflict (set before merging)
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
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
npm run test:unit
```

Expected: All 9 tests PASS.

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add lib/themeTokenExtractor.server.ts lib/themeTokenExtractor.test.ts
git commit -m "feat: add themeTokenExtractor — public CSS var + component HTML extraction"
```

---

## Task 4: Wire extractor into dataSync and app.tsx; retire brandExtractor

**Files:**
- Modify: `jobs/dataSync.ts`
- Modify: `app/routes/app.tsx`
- Delete: `lib/brandExtractor.server.ts`

- [ ] **Step 1: Update dataSync.ts**

In `jobs/dataSync.ts`, replace the import at line 6:

```typescript
// Remove this line:
import { extractStoreBranding } from "../lib/brandExtractor.server";

// Add this line:
import { extractThemeTokens } from "../lib/themeTokenExtractor.server";
```

Find the call at line ~89 (after the dataSource.updateMany):

```typescript
// Replace:
await extractStoreBranding(freshShop).catch((err) =>
  console.error(`[dataSync] brandExtraction failed`, err)
);

// With:
await extractThemeTokens(freshShop);
```

Note: `extractThemeTokens` never throws, so no `.catch()` wrapper needed.

- [ ] **Step 2: Update app.tsx**

In `app/routes/app.tsx`, replace the import at line 9:

```typescript
// Remove:
import { extractStoreBranding } from "../../lib/brandExtractor.server";

// Add:
import { extractThemeTokens } from "../../lib/themeTokenExtractor.server";
```

Replace the call at line ~27:

```typescript
// Remove:
extractStoreBranding(shop).catch(() => {});

// Add:
extractThemeTokens(shop).catch(() => {});
```

- [ ] **Step 3: Delete brandExtractor**

```bash
rm lib/brandExtractor.server.ts
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: 0 errors (no remaining references to brandExtractor).

- [ ] **Step 5: Confirm no remaining references**

```bash
grep -r "brandExtractor\|extractStoreBranding" --include="*.ts" --include="*.tsx" .
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add jobs/dataSync.ts app/routes/app.tsx lib/brandExtractor.server.ts
git commit -m "refactor: replace brandExtractor with themeTokenExtractor in dataSync + app layout"
```

---

## Task 5: Enhance autoBuild prompt — tokens + craft principles

**Files:**
- Modify: `jobs/autoBuild.ts`

- [ ] **Step 1: Update hypothesis query to include themeTokens**

In `jobs/autoBuild.ts`, find the `prisma.hypothesis.findUnique` call in `runAutoBuild` and update the include:

```typescript
const hypothesis = await prisma.hypothesis.findUnique({
  where: { id: hypothesisId, shopId },
  include: {
    shop: {
      select: {
        brandGuardrails: true,
        themeTokens: true,       // ← add this
      },
    },
  },
});
```

- [ ] **Step 2: Replace buildSystemPrompt**

Replace the entire `buildSystemPrompt` function:

```typescript
function buildSystemPrompt(): string {
  return `You are an expert front-end developer specialising in Shopify storefronts and CRO.
Generate minimal, focused HTML/CSS/JS patches.
Patches must not use external resources, must not contain synchronous scripts, and must be under 10kb combined.
Respond ONLY with a valid JSON object — no markdown fences, no explanation.
The JSON must have exactly these keys: htmlPatch, cssPatch, jsPatch, variantDescription.
Each patch value is a string or null. variantDescription is a short string summarising the change.

Design principles you MUST follow:
- Every spacing decision must be intentional — no arbitrary padding values
- One clear visual focal point per element — clear hierarchy
- Never introduce gradients, drop shadows, pill borders, or animations unless they already exist in the store's design system
- Mobile-first: size all elements for touch targets (min 44px)
- Minimal markup: add only what is needed, nothing decorative that isn't earned`;
}
```

- [ ] **Step 3: Replace buildUserPrompt signature and body**

Replace the entire `buildUserPrompt` function:

```typescript
function buildUserPrompt(
  title: string,
  hypothesis: string,
  pageType: string,
  elementType: string,
  targetMetric: string,
  brandGuardrails: unknown,
  themeTokens: unknown
): string {
  const guardrails = (brandGuardrails as Record<string, unknown>) ?? {};
  const tokens = themeTokens as {
    cssVars?: Record<string, string>;
    componentHtml?: Record<string, string>;
  } | null;

  const hasCssVars =
    tokens?.cssVars != null && Object.keys(tokens.cssVars).length > 0;

  let constraintsBlock: string;

  if (hasCssVars) {
    const componentLines = [
      tokens!.componentHtml?.button
        ? `Button: ${tokens!.componentHtml.button}`
        : null,
      tokens!.componentHtml?.heading
        ? `Heading: ${tokens!.componentHtml.heading}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    constraintsBlock = `## Store design system — NON-NEGOTIABLE constraints
These are extracted directly from the store's live theme.

CSS custom properties (use var(--name) in ALL CSS — never hardcode hex values):
${JSON.stringify(tokens!.cssVars, null, 2)}
${componentLines ? `\nNative component HTML (copy this structure — do not invent your own):\n${componentLines}` : ""}

Rules:
- Every color in your CSS must use var(--token-name)
- Font families must use var(--font-*) tokens or inherit
- Border radius must use var(--buttons--border-radius) or the value from tokens
- If you need a color not in the token set, use the closest listed token
- Do not introduce CSS classes that conflict with theme class names`;
  } else {
    const hasExtractedTokens =
      guardrails.colors != null && typeof guardrails.colors === "object";
    constraintsBlock = hasExtractedTokens
      ? `## Brand constraints (MUST follow — non-negotiable)
Colors: ${JSON.stringify(guardrails.colors)}
Fonts: ${JSON.stringify(guardrails.fonts ?? {})}
Border radius: ${guardrails.borderRadius ?? "as-is"}
Full guardrails: ${JSON.stringify(guardrails, null, 2)}`
      : `Brand guardrails: ${JSON.stringify(guardrails)}`;
  }

  return `Generate variant patches for this A/B test hypothesis:

Title: ${title}
Hypothesis: ${hypothesis}
Page type: ${pageType}
Element type: ${elementType}
Target metric: ${targetMetric}

${constraintsBlock}

Return JSON with: htmlPatch, cssPatch, jsPatch, variantDescription.`;
}
```

- [ ] **Step 4: Update the buildUserPrompt call site**

In `runAutoBuild`, find the `client.messages.create` call and update the `buildUserPrompt` invocation to pass `themeTokens`:

```typescript
content: buildUserPrompt(
  hypothesis.title,
  hypothesis.hypothesis,
  hypothesis.pageType,
  hypothesis.elementType,
  hypothesis.targetMetric,
  hypothesis.shop.brandGuardrails,
  hypothesis.shop.themeTokens,   // ← add this argument
),
```

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 6: Build**

```bash
npm run build 2>&1 | tail -5
```

Expected: `✓ built in ...ms`

- [ ] **Step 7: Commit**

```bash
git add jobs/autoBuild.ts
git commit -m "feat: enhance autoBuild prompt with themeTokens constraints + craft principles"
```

---

## Task 6: Add design critique pass to autoBuild

**Files:**
- Modify: `jobs/autoBuild.ts`

- [ ] **Step 1: Add CritiqueResult type and designCritique function**

Add this directly before `runAutoBuild`:

```typescript
interface CritiqueResult {
  passed: boolean;
  failedItems: string[];
  specificFixes: string[];
}

async function designCritique(
  htmlPatch: string | null,
  cssPatch: string | null,
  jsPatch: string | null,
  cssVars: Record<string, string>
): Promise<CritiqueResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  // Fail-open: if no key or empty patches, skip critique
  if (!apiKey || (!htmlPatch && !cssPatch)) {
    return { passed: true, failedItems: [], specificFixes: [] };
  }

  const client = new Anthropic({ apiKey });

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: `You are a Shopify front-end design reviewer.
Review this generated variant against the store's design system.
Return ONLY valid JSON — no explanation, no markdown fences.
Shape: { "passed": boolean, "failedItems": string[], "specificFixes": string[] }

Rubric (check each — fail if violated):
1. No hardcoded hex color values in CSS patch
2. No hardcoded font-family strings (must use CSS var or inherit)
3. No introduced box-shadow, text-shadow, gradients, or transitions absent from token set
4. Spacing uses relative units (rem, em, %) or CSS vars — no arbitrary px values
5. No CSS class names that would conflict with Shopify theme namespacing

Store CSS custom properties:
${JSON.stringify(cssVars, null, 2)}

Generated variant:
HTML: ${htmlPatch ?? "null"}
CSS: ${cssPatch ?? "null"}
JS: ${jsPatch ?? "null"}`,
        },
      ],
    });

    const raw = response.content[0];
    if (raw.type !== "text") return { passed: true, failedItems: [], specificFixes: [] };
    const jsonStr = raw.text
      .trim()
      .replace(/^```(?:json)?\n?/, "")
      .replace(/\n?```$/, "");
    return JSON.parse(jsonStr) as CritiqueResult;
  } catch (err) {
    // Critique failures are non-fatal — fail open so variants aren't blocked
    console.error("[autoBuild] designCritique error (failing open):", err);
    return { passed: true, failedItems: [], specificFixes: [] };
  }
}
```

- [ ] **Step 2: Integrate critique into runAutoBuild after initial generation**

In `runAutoBuild`, find the section after the first `JSON.parse(jsonStr)` call (where `patches` is destructured) and after the static `qaGate` check. Add the critique block before the `prisma.experiment.create` call:

```typescript
// ── Design critique pass ──────────────────────────────────────────────────
const tokens = hypothesis.shop.themeTokens as {
  cssVars?: Record<string, string>;
} | null;
const cssVars = tokens?.cssVars ?? {};
const hasCssVars = Object.keys(cssVars).length > 0;

if (hasCssVars) {
  let critique = await designCritique(htmlPatch ?? null, cssPatch ?? null, jsPatch ?? null, cssVars);

  if (!critique.passed) {
    // One retry: append critique feedback to the original prompt
    console.log(
      `[autoBuild] design critique failed for ${hypothesisId} — retrying with feedback`
    );
    const retryPrompt =
      buildUserPrompt(
        hypothesis.title,
        hypothesis.hypothesis,
        hypothesis.pageType,
        hypothesis.elementType,
        hypothesis.targetMetric,
        hypothesis.shop.brandGuardrails,
        hypothesis.shop.themeTokens
      ) +
      `\n\n## Design critique feedback (MUST fix before responding):\n` +
      critique.failedItems.map((item) => `- ${item}`).join("\n") +
      (critique.specificFixes.length > 0
        ? `\n\nSpecific fixes required:\n` +
          critique.specificFixes.map((f) => `- ${f}`).join("\n")
        : "");

    const retryResponse = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: buildSystemPrompt(),
      messages: [{ role: "user", content: retryPrompt }],
    });

    const retryRaw = retryResponse.content[0];
    if (retryRaw.type === "text") {
      const retryJsonStr = retryRaw.text
        .trim()
        .replace(/^```(?:json)?\n?/, "")
        .replace(/\n?```$/, "");
      try {
        const retryPatches = JSON.parse(retryJsonStr);
        patches = retryPatches;
        const { htmlPatch: rh, cssPatch: rc, jsPatch: rj } = retryPatches;

        // Re-run critique on revised output
        critique = await designCritique(rh ?? null, rc ?? null, rj ?? null, cssVars);
        if (!critique.passed) {
          await prisma.hypothesis.update({
            where: { id: hypothesisId },
            data: { status: "qa_failed" },
          });
          await logOrchestrator(shopId, runId, "DESIGN_CRITIQUE", "failed", {
            hypothesisId,
            failedItems: critique.failedItems,
          });
          console.log(
            `[autoBuild] design critique failed after retry for ${hypothesisId} — marked qa_failed`
          );
          return;
        }
        console.log(`[autoBuild] design critique passed after retry for ${hypothesisId}`);
      } catch {
        // Retry JSON parse failed — continue with original patches
        console.warn(`[autoBuild] retry JSON parse failed for ${hypothesisId} — using original`);
      }
    }
  } else {
    console.log(`[autoBuild] design critique passed on first attempt for ${hypothesisId}`);
  }
}
```

Note: The `patches` variable needs to be declared with `let` instead of `const` to allow reassignment on retry. Find the line:

```typescript
const { htmlPatch, cssPatch, jsPatch, variantDescription } = patches;
```

And move the destructuring to AFTER the critique block (since `patches` may be reassigned). Change it to:

```typescript
let patches: { htmlPatch: string | null; cssPatch: string | null; jsPatch: string | null; variantDescription: string };
```

at the initial parse site, then destructure after the critique block:

```typescript
const { htmlPatch, cssPatch, jsPatch, variantDescription } = patches;
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 4: Build**

```bash
npm run build 2>&1 | tail -5
```

Expected: `✓ built in ...ms`

- [ ] **Step 5: Commit**

```bash
git add jobs/autoBuild.ts
git commit -m "feat: add Haiku design critique pass with one retry to autoBuild pipeline"
```

---

## Task 7: Settings page — Re-sync theme tokens button

**Files:**
- Modify: `app/routes/app.settings.tsx`

- [ ] **Step 1: Add resync action to the settings action handler**

In `app/routes/app.settings.tsx`, add the import at the top:

```typescript
import { extractThemeTokens } from "../../lib/themeTokenExtractor.server";
```

In the `action` function, add handling for the resync intent before the existing form save logic:

```typescript
const intent = String(fd.get("intent") ?? "save");

if (intent === "resync_tokens") {
  const shop = await findOrCreateShop(session.shop, session.accessToken ?? "");
  await extractThemeTokens(shop);
  return { success: true, message: "Theme tokens refreshed." };
}
```

- [ ] **Step 2: Add the resync button to the settings UI**

In the settings component, add a new `<s-section>` after the existing brand guardrails section:

```tsx
<s-section heading="Theme tokens">
  <s-stack direction="block" gap="base">
    <s-paragraph>
      Shivook AI CRO automatically reads your store's CSS design tokens (colors, fonts, spacing) to ensure generated variants match your theme. Tokens refresh nightly. Use this button if you've recently updated your theme.
    </s-paragraph>
    {shop.themeTokens ? (
      <s-banner tone="success" heading="Tokens extracted">
        <s-paragraph>
          {Object.keys((shop.themeTokens as Record<string, Record<string, string>>).cssVars ?? {}).length} CSS variables loaded from your theme.
        </s-paragraph>
      </s-banner>
    ) : (
      <s-banner tone="warning" heading="No tokens yet">
        <s-paragraph>Click below to extract your theme's design tokens.</s-paragraph>
      </s-banner>
    )}
    <Form method="post">
      <input type="hidden" name="intent" value="resync_tokens" />
      <s-button type="submit" variant="secondary">
        Re-sync theme tokens
      </s-button>
    </Form>
  </s-stack>
</s-section>
```

- [ ] **Step 3: Confirm themeTokens is available in the loader**

The settings loader calls `findOrCreateShop()` which returns the full `Shop` object — `themeTokens` is automatically available after the Task 2 migration. No loader change needed. Verify by checking `shop.themeTokens` is accessible in the component (TypeScript will confirm this after `npx prisma generate` runs in Task 2).

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 5: Build**

```bash
npm run build 2>&1 | tail -5
```

Expected: `✓ built in ...ms`

- [ ] **Step 6: Commit**

```bash
git add app/routes/app.settings.tsx
git commit -m "feat: add Re-sync theme tokens button to Settings page"
```

---

## Task 8: Deploy and verify

- [ ] **Step 1: Push to main and deploy**

```bash
git push origin main
cd ~/shivook-ai-cro && fly deploy --remote-only 2>&1 | tail -10
```

Expected: Both machines reach started state, health checks passing.

- [ ] **Step 2: Verify /healthz**

```bash
curl -s https://shivook-ai-cro.fly.dev/healthz
```

Expected: `ok`

- [ ] **Step 3: Trigger theme token extraction**

In the Shopify admin, navigate to the app → Settings → click **"Re-sync theme tokens"**.

Then query Neon to confirm tokens were extracted:

```bash
node -e "
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url: 'postgresql://neondb_owner:npg_5ZQRUhIWJ3Ez@ep-proud-glade-aqo5nhkc.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require' } } });
async function main() {
  const shop = await prisma.shop.findFirst({ select: { themeTokens: true } });
  const tokens = shop.themeTokens;
  console.log('cssVars count:', Object.keys(tokens?.cssVars ?? {}).length);
  console.log('components:', Object.keys(tokens?.componentHtml ?? {}));
  console.log('sample vars:', JSON.stringify(Object.entries(tokens?.cssVars ?? {}).slice(0, 3)));
  await prisma.\$disconnect();
}
main().catch(console.error);
"
```

Expected: `cssVars count: > 0`, component names listed.

- [ ] **Step 4: Trigger a hypothesis → autoBuild flow**

In the app, navigate to Hypotheses → pick the top hypothesis → click Promote to Experiment. Watch the Fly logs:

```bash
fly logs --no-tail 2>&1 | grep -E "autoBuild|designCritique|themeToken" | tail -20
```

Expected: Logs showing `[autoBuild] design critique passed on first attempt` and a new experiment created.

- [ ] **Step 5: Verify generated CSS uses var() not hex**

Query the newly created experiment's treatment variant:

```bash
node -e "
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url: 'postgresql://neondb_owner:npg_5ZQRUhIWJ3Ez@ep-proud-glade-aqo5nhkc.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require' } } });
async function main() {
  const exp = await prisma.experiment.findFirst({
    orderBy: { createdAt: 'desc' },
    include: { variants: { where: { type: 'treatment' } } }
  });
  const v = exp?.variants[0];
  console.log('cssPatch:', v?.cssPatch);
  const hasHardcodedHex = /#[0-9a-fA-F]{3,8}/.test(v?.cssPatch ?? '');
  console.log('hasHardcodedHex:', hasHardcodedHex, '(should be false)');
  await prisma.\$disconnect();
}
main().catch(console.error);
"
```

Expected: CSS patch shown, `hasHardcodedHex: false`.

---

## Success Criteria Checklist

- [ ] `shop.themeTokens` populated within 60s of triggering re-sync
- [ ] CSS vars count > 0 for shivook-team.myshopify.com
- [ ] Generated variant CSS contains no hardcoded hex values
- [ ] `[autoBuild] design critique passed on first attempt` appears in logs
- [ ] All 9 unit tests pass (`npm run test:unit`)
- [ ] `npx tsc --noEmit` exits 0
- [ ] `npm run build` exits 0
- [ ] `/healthz` returns `ok` on production

# Brand-Native Variant Generation — Design Spec

**Date:** 2026-05-30  
**Status:** Approved  
**Scope:** Auto-build pipeline (primary) + manual editor surface (later phase)

---

## Problem

When the autoBuild job generates variant HTML/CSS/JS from a hypothesis, the output looks generic and amateur:
1. **Wrong colors/fonts** — hardcoded hex values that don't match the store's palette or typography
2. **Wrong structure** — invented component markup that clashes with the theme's HTML patterns
3. **Poor craft** — technically on-brand tokens but bad spacing, hierarchy, and visual decisions

The existing `brandExtractor.server.ts` was supposed to supply brand context but fails silently because it queries the Shopify Admin API for theme files — which requires the `read_themes` OAuth scope that was never added.

---

## Solution

Three new/enhanced pieces slot into the existing autoBuild flow:

1. **`lib/themeTokenExtractor.server.ts`** (new) — fetches the store's public storefront HTML, extracts all CSS custom properties and native component HTML, stores as `shop.themeTokens`
2. **Enhanced `autoBuild` prompt** — passes the full token map + component HTML as hard constraints; bakes frontend-design craft principles into the system prompt
3. **Design critique pass** (new, within autoBuild) — second Claude call that reviews the generated code against the token map and a quality rubric; one retry on failure

---

## Architecture

```
themeTokenExtractor  ←  runs on: install, nightly dataSync, on-demand
        ↓
shop.themeTokens  (DB)
        ↓
autoBuild job
  1. Load hypothesis + themeTokens
  2. buildUserPrompt() — tokens as hard constraints + craft principles  [ENHANCED]
  3. Claude Sonnet generation
  4. designCritique() — Haiku reviews against rubric                   [NEW]
     └─ Pass  → proceed to qaReview
     └─ Revise → one retry with critique feedback appended
     └─ Fail  → hypothesis marked qa_failed, no experiment created
        ↓
qaReview → activationGate  (unchanged)
```

---

## Data Model

### New field: `Shop.themeTokens` (Json?, nullable)

Added via Prisma migration. Shape:

```json
{
  "extractedAt": "2026-05-30T15:00:00.000Z",
  "storeDomain": "brand.myshopify.com",
  "cssVars": {
    "--color-button": "#1a1a1a",
    "--color-button-text": "#ffffff",
    "--font-body-family": "'Helvetica Neue', Helvetica, Arial, sans-serif",
    "--buttons--border-radius": "0px",
    "--color-background-1": "#ffffff",
    "--color-foreground": "#121212"
  },
  "componentHtml": {
    "button": "<button type=\"submit\" class=\"button button--primary button--full-width\">",
    "heading": "<h2 class=\"h1\">",
    "card": "<div class=\"card card--standard\">"
  }
}
```

**Priority:** `brandGuardrails` (manually set by merchant) always wins over `themeTokens` on any key conflict.

---

## `lib/themeTokenExtractor.server.ts`

### Approach
Public HTTP fetch — no new OAuth scope required. Replaces the failing `brandExtractor.server.ts`.

### Algorithm

1. Fetch `https://{shopDomain}/` and `https://{shopDomain}/products/{firstTopProduct}` with `Storefront-Password` header if `shop.storefrontPassword` is set
2. For each page:
   - Find all inline `<style>` blocks
   - Find all `<link rel="stylesheet">` hrefs, fetch each (cache-busted)
   - Parse every `:root { }` block and extract `--token-name: value` declarations
3. Merge all CSS vars (later declaration wins — matches browser cascade)
4. Scrape first instance of `.button--primary`, `h1`, `h2`, `.card`, `.product-card` — store `outerHTML` trimmed to 500 chars
5. Write to `shop.themeTokens`, update `shop.brandGuardrails` with extracted `colors`/`fonts`/`borderRadius` (only if not already manually set — `existing.colors ?? extracted.colors`)
6. Never throws — all errors are caught and logged, autoBuild continues with fallback

### When it runs
- On first OAuth install (via `app.tsx` loader, fire-and-forget)
- Nightly via `dataSync` job (after Shopify funnel data collection)
- On-demand via Settings page "Re-sync theme tokens" button

### Stale token handling
If `themeTokens` is null or `extractedAt` is older than 7 days: autoBuild logs `[autoBuild] themeTokens stale — falling back to brandGuardrails` and continues. Does not block variant generation.

---

## Enhanced `autoBuild` Prompt

### System prompt additions (craft principles)
```
You are an expert front-end developer specialising in Shopify storefronts.
Produce minimal, intentional, production-grade HTML/CSS/JS patches.

Design principles you MUST follow:
- Every spacing decision must be intentional — no arbitrary padding values
- One clear visual focal point per element — clear hierarchy
- Never introduce gradients, drop shadows, pill borders, or animations unless
  they already exist in the store's design system
- Mobile-first: size all elements for touch targets (min 44px)
- Minimal markup: add only what is needed, nothing decorative that isn't earned
```

### User prompt — hard constraints block
When `themeTokens.cssVars` is present:
```
## Store design system — NON-NEGOTIABLE constraints
These are extracted directly from the store's live theme.

CSS custom properties (use var(--name) in all CSS — never hardcode these values):
{cssVars as JSON}

Native component HTML (copy this structure exactly — do not invent your own):
Button: {componentHtml.button}
Heading: {componentHtml.heading}

Rules:
- Every color in your CSS must use var(--token-name)
- Font families must use var(--font-*) tokens
- Border radius must match --buttons--border-radius
- If you need a color not in the token set, use the closest listed token
```

---

## Design Critique Pass

### Model
Claude Haiku (fast, ~$0.001 per call)

### Rubric (each item is pass/fail)
1. No hardcoded hex color values in CSS patch
2. No hardcoded font-family strings (must use CSS var or inherit)
3. Border radius matches `--buttons--border-radius` token
4. No introduced shadows, gradients, or animations absent from the token set
5. Component structure follows native HTML patterns (not invented markup)
6. Spacing uses relative units (`rem`, `em`, `%`) or CSS vars

### Prompt
```
You are a Shopify front-end design reviewer.
Review this generated variant against the store's design system.
Score each rubric item pass/fail.
If any item fails, list the specific lines to fix.
Return JSON: { passed: boolean, failedItems: string[], specificFixes: string[] }

Store design system:
{cssVars}

Generated variant:
HTML: {htmlPatch}
CSS: {cssPatch}
JS: {jsPatch}
```

### Retry logic
- **Pass:** variant proceeds to `qaReview` unchanged
- **Revise:** critique feedback appended to original prompt → one more Sonnet generation call → critique re-runs (no second retry)
- **Fail after retry:** hypothesis marked `qa_failed`, orchestratorLog updated with `stage: "DESIGN_CRITIQUE"`, no experiment created

---

## Manual Editor — Phase 2 (later, low effort)

After the auto-build pipeline is solid, expose `themeTokens` in the manual experiment creation form:

- Collapsible "Brand tokens" panel in `/app/experiments/new`
- Lists extracted CSS vars with copy buttons
- Shows the native button HTML as a reference snippet
- No new infrastructure — just add `shop.themeTokens` to the loader's return value

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Storefront fetch fails (private/password-protected store) | Log warning, skip extraction, autoBuild uses `brandGuardrails` fallback |
| No CSS vars found in storefront HTML | Log warning, `themeTokens.cssVars = {}`, prompt falls back to `brandGuardrails` |
| Critique call fails (API error) | Log error, variant proceeds as if critique passed — don't block on non-critical review |
| Retry variant still fails critique | `qa_failed`, logged to orchestratorLog |

---

## Files Changed

| File | Change |
|---|---|
| `prisma/schema.prisma` | Add `themeTokens Json?` to Shop model |
| `prisma/migrations/` | New migration for themeTokens field |
| `lib/themeTokenExtractor.server.ts` | **New** — public fetch + CSS var extraction |
| `lib/brandExtractor.server.ts` | Retire — replaced by themeTokenExtractor |
| `jobs/dataSync.ts` | Call themeTokenExtractor after Shopify data sync |
| `jobs/autoBuild.ts` | Load themeTokens; enhance buildUserPrompt(); add designCritique() |
| `app/routes/app.tsx` | Fire themeTokenExtractor on first install |
| `app/routes/app.settings.tsx` | Add "Re-sync theme tokens" button |

---

## Success Criteria

1. `shop.themeTokens` is populated for any store within 60 seconds of install
2. Generated variant CSS contains zero hardcoded hex values when tokens are available
3. Design critique pass rate ≥ 80% on first attempt (i.e. generation is good enough without needing the retry most of the time)
4. A human reviewing a generated variant on a Dawn/Sense/Craft theme cannot visually distinguish it from a manually-crafted element

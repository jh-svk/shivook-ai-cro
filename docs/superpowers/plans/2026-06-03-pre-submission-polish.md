# Pre-Submission Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship five independent improvements — MutationObserver re-apply, segment-signature unification, render-validator warning, full-funnel p-value results redesign, and variant code collapse — before Shopify app store submission.

**Architecture:** Tasks 1–2 are pure refactors with no schema changes. Task 3 is a DB migration + stats computation. Task 4 is the UI for Task 3. Task 5 is a self-contained UI change. Task 6 is an isolated injector JS change. All tasks are independent except Task 4 depends on Task 3.

**Tech Stack:** TypeScript, Prisma (Neon Postgres), React Router 7, Shopify Polaris (`s-*` web components), Vitest, vanilla JS (storefront injector)

---

## File Map

| File | Change |
|---|---|
| `lib/segmentSignature.server.ts` | **Create** — canonical `segmentSignature` function |
| `lib/segmentSignature.test.ts` | **Create** — unit tests for the canonical function |
| `jobs/hypothesisGenerator.ts` | Modify — import from new module, delete local function |
| `lib/concurrentTestManager.server.ts` | Modify — import from new module, delete local function |
| `jobs/autoBuild.ts` line ~796 | Modify — add `shopId`, `hypothesisId` to existing `console.warn` |
| `prisma/schema.prisma` | Modify — add 5 p-value fields to `Result` model |
| `lib/stats.ts` | Modify — add `proportionPValue` + `poissonRatePValue` helpers, export them |
| `lib/stats.test.ts` | **Create** — tests for new p-value helpers |
| `jobs/resultRefresh.ts` | Modify — compute 5 per-metric p-values, include in upsert |
| `app/routes/app.experiments.$id.tsx` | Modify — compute `monthlyImpact` in loader; redesign results section; code-collapse in variants section |
| `extensions/variant-injector/assets/experiment-injector.js` | Modify — idempotent `applyPatch`, MutationObserver re-apply |

---

## Task 1: Segment Signature Unification

**Files:**
- Create: `lib/segmentSignature.server.ts`
- Create: `lib/segmentSignature.test.ts`
- Modify: `jobs/hypothesisGenerator.ts`
- Modify: `lib/concurrentTestManager.server.ts`

- [ ] **Step 1: Write failing tests**

Create `lib/segmentSignature.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { segmentSignature } from "./segmentSignature.server";

describe("segmentSignature", () => {
  it("returns pipe-separated canonical string", () => {
    expect(segmentSignature("product", { deviceType: "mobile", trafficSource: "organic", visitorType: "new", geoCountry: [] }))
      .toBe("product|mobile|organic|new|any");
  });

  it("sorts geoCountry alphabetically", () => {
    expect(segmentSignature("product", { deviceType: "mobile", trafficSource: null, visitorType: null, geoCountry: ["US", "CA"] }))
      .toBe("product|mobile|any|any|CA,US");
  });

  it("falls back to 'any' for null/undefined segment", () => {
    expect(segmentSignature("homepage", null))
      .toBe("homepage|any|any|any|any");
  });

  it("falls back to 'any' for undefined fields", () => {
    expect(segmentSignature("cart", {}))
      .toBe("cart|any|any|any|any");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm run test:unit -- lib/segmentSignature.test.ts
```
Expected: FAIL — `Cannot find module './segmentSignature.server'`

- [ ] **Step 3: Create the module**

Create `lib/segmentSignature.server.ts`:
```typescript
type SegmentLike = {
  deviceType?: string | null;
  trafficSource?: string | null;
  visitorType?: string | null;
  geoCountry?: string[];
} | null | undefined;

/** Canonical "page + segment" dedup key. Used in hypothesisGenerator and concurrentTestManager. */
export function segmentSignature(pageType: string, s: SegmentLike): string {
  const d = s?.deviceType || "any";
  const t = s?.trafficSource || "any";
  const v = s?.visitorType || "any";
  const g = (s?.geoCountry ?? []).slice().sort().join(",") || "any";
  return `${pageType}|${d}|${t}|${v}|${g}`;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm run test:unit -- lib/segmentSignature.test.ts
```
Expected: PASS (4 tests)

- [ ] **Step 5: Update `jobs/hypothesisGenerator.ts`**

Find the local `segmentSignature` function (around line 104):
```typescript
/** Canonical "page + segment" signature — used to prevent duplicate-segment tests. */
function segmentSignature(pageType: string, s: SegmentShape | null | undefined): string {
  const d = s?.deviceType || "any";
  const t = s?.trafficSource || "any";
  const v = s?.visitorType || "any";
  const g = (s?.geoCountry ?? []).slice().sort().join(",") || "any";
  return `${pageType}|${d}|${t}|${v}|${g}`;
}
```
Delete it. Add this import near the top of the file (alongside other imports):
```typescript
import { segmentSignature } from "../lib/segmentSignature.server";
```

- [ ] **Step 6: Update `lib/concurrentTestManager.server.ts`**

Delete the local `audienceSignature` function (lines 5–14). Replace the two call sites:
- Line ~41: `const mySig = audienceSignature(pageType, segment);` → `const mySig = segmentSignature(pageType, segment);`
- Line ~46: `audienceSignature(pageType, e.segment)` → `segmentSignature(pageType, e.segment)`

Add import at top:
```typescript
import { segmentSignature } from "./segmentSignature.server";
```

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
```
Expected: no errors

```bash
git add lib/segmentSignature.server.ts lib/segmentSignature.test.ts jobs/hypothesisGenerator.ts lib/concurrentTestManager.server.ts
git commit -m "refactor: unify segment signature into shared lib/segmentSignature.server.ts"
```

---

## Task 2: Render Validator Fail-Open Warning

**Files:**
- Modify: `jobs/autoBuild.ts` (~line 796)

- [ ] **Step 1: Locate the catch block**

In `jobs/autoBuild.ts`, find the catch block that wraps the storefront fetch + render validation (around line 794):
```typescript
  } catch (err) {
    // Never block a build on the validator infra itself failing.
    console.warn(`[autoBuild] render validation skipped for ${hypothesisId}:`, err);
  }
```

- [ ] **Step 2: Add structured fields to the warning**

Replace the `console.warn` line inside that catch block:
```typescript
  } catch (err) {
    // Never block a build on the validator infra itself failing.
    console.warn("[autoBuild] render validator skipped — storefront fetch failed", {
      shopId,
      hypothesisId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
```

- [ ] **Step 3: Typecheck and commit**

```bash
npm run typecheck
```
Expected: no errors

```bash
git add jobs/autoBuild.ts
git commit -m "fix: add structured log fields when render validator skips on fetch failure"
```

---

## Task 3: Per-Metric P-Values — Schema + Stats

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `lib/stats.ts`
- Create: `lib/stats.test.ts`
- Modify: `jobs/resultRefresh.ts`

### 3a — Schema migration

- [ ] **Step 1: Add fields to Result model**

In `prisma/schema.prisma`, find the `model Result` block. After the `aovLift` field (around line 187), add:
```prisma
  // Per-metric frequentist p-values (two-proportion z-test for rates; Poisson rate test for revenue metrics)
  addToCartPValue     Float?
  checkoutPValue      Float?
  convRatePValue      Float?
  aovPValue           Float?
  revPerVisitorPValue Float?
```

- [ ] **Step 2: Create and apply the migration**

```bash
npx prisma migrate dev --name add_per_metric_pvalues --create-only
```
Then review the generated SQL in `prisma/migrations/` (should be 5 `ALTER TABLE` add-column statements), then apply:
```bash
npx prisma migrate dev
```
Expected: `✔ Generated Prisma Client`

### 3b — Stats helpers

- [ ] **Step 3: Write failing tests for p-value helpers**

Create `lib/stats.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { proportionPValue, poissonRatePValue } from "./stats";

describe("proportionPValue", () => {
  it("returns null when sample too small", () => {
    expect(proportionPValue(5, 0.1, 100, 0.2)).toBeNull();
  });

  it("returns small p for clearly different proportions", () => {
    const p = proportionPValue(1000, 0.08, 1000, 0.12);
    expect(p).not.toBeNull();
    expect(p!).toBeLessThan(0.05);
  });

  it("returns large p for similar proportions", () => {
    const p = proportionPValue(100, 0.10, 100, 0.11);
    expect(p).not.toBeNull();
    expect(p!).toBeGreaterThan(0.2);
  });

  it("returns null when pooled proportion is 0 or 1", () => {
    expect(proportionPValue(100, 0, 100, 0)).toBeNull();
  });
});

describe("poissonRatePValue", () => {
  it("returns null when sample too small", () => {
    expect(poissonRatePValue(5, 1.5, 5, 2.0)).toBeNull();
  });

  it("returns small p for clearly different rates", () => {
    const p = poissonRatePValue(1000, 1.0, 1000, 2.0);
    expect(p).not.toBeNull();
    expect(p!).toBeLessThan(0.05);
  });

  it("returns large p for similar rates", () => {
    const p = poissonRatePValue(100, 2.0, 100, 2.1);
    expect(p).not.toBeNull();
    expect(p!).toBeGreaterThan(0.2);
  });
});
```

- [ ] **Step 4: Run to confirm they fail**

```bash
npm run test:unit -- lib/stats.test.ts
```
Expected: FAIL — `proportionPValue is not exported`

- [ ] **Step 5: Add helpers to `lib/stats.ts`**

Append to the end of `lib/stats.ts` (after the `computeStats` export):
```typescript
// ── Frequentist p-value helpers (supplementary per-metric signals) ────────────

/** Abramowitz & Stegun normal CDF approximation (error < 7.5e-8). */
function normalCdf(z: number): number {
  if (z < 0) return 1 - normalCdf(-z);
  const t = 1 / (1 + 0.2316419 * z);
  const poly =
    t * (0.319381530 +
    t * (-0.356563782 +
    t * (1.781477937 +
    t * (-1.821255978 +
    t * 1.330274429))));
  return 1 - 0.39894228 * Math.exp(-0.5 * z * z) * poly;
}

/**
 * Two-proportion z-test, two-tailed.
 * n1/n2: sample sizes, p1/p2: observed proportions (0–1).
 * Returns null when sample is too small (< 10) or edge-case proportions.
 */
export function proportionPValue(
  n1: number, p1: number,
  n2: number, p2: number
): number | null {
  if (n1 < 10 || n2 < 10) return null;
  const pPool = (p1 * n1 + p2 * n2) / (n1 + n2);
  if (pPool <= 0 || pPool >= 1) return null;
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (se === 0) return null;
  const z = Math.abs((p2 - p1) / se);
  return 2 * (1 - normalCdf(z));
}

/**
 * Poisson rate test — used for revenue-per-visitor and AOV where we don't
 * have per-order variance. Treats variance ≈ mean (Poisson assumption).
 * n1/n2: denominators (visitors or purchases), r1/r2: rates (revenue/n).
 * Returns null when sample is too small (< 10).
 */
export function poissonRatePValue(
  n1: number, r1: number,
  n2: number, r2: number
): number | null {
  if (n1 < 10 || n2 < 10) return null;
  const se = Math.sqrt(r1 / n1 + r2 / n2);
  if (se === 0) return null;
  const z = Math.abs((r2 - r1) / se);
  return 2 * (1 - normalCdf(z));
}
```

- [ ] **Step 6: Run tests to confirm they pass**

```bash
npm run test:unit -- lib/stats.test.ts
```
Expected: PASS (7 tests)

### 3c — Wire into resultRefresh

- [ ] **Step 7: Add p-value computation in `jobs/resultRefresh.ts`**

Add import at top:
```typescript
import { computeStats, proportionPValue, poissonRatePValue } from "../lib/stats";
```

After the existing lift calculations (after the `aovLift` line, around line 119), add:
```typescript
  // Per-metric frequentist p-values
  const addToCartPValue = proportionPValue(
    controlVisitors, controlAddToCartRate,
    treatmentVisitors, treatmentAddToCartRate
  );
  const checkoutPValue = proportionPValue(
    controlVisitors, controlCheckoutRate,
    treatmentVisitors, treatmentCheckoutRate
  );
  const convRatePValue = proportionPValue(
    controlVisitors, stats.controlConversionRate,
    treatmentVisitors, stats.treatmentConversionRate
  );
  const aovPValue =
    controlPurchases >= 10 && treatmentPurchases >= 10
      ? poissonRatePValue(controlPurchases, controlAov, treatmentPurchases, treatmentAov)
      : null;
  const revPerVisitorPValue = poissonRatePValue(
    controlVisitors, controlRevPerVisitor,
    treatmentVisitors, treatmentRevPerVisitor
  );
```

In the `resultData` object (around line 126), add the five new fields alongside the existing lift metrics:
```typescript
    // Per-metric p-values
    addToCartPValue,
    checkoutPValue,
    convRatePValue,
    aovPValue,
    revPerVisitorPValue,
```

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
```
Expected: no errors

```bash
git add prisma/schema.prisma prisma/migrations lib/stats.ts lib/stats.test.ts jobs/resultRefresh.ts
git commit -m "feat: add per-metric p-values to stats engine and result schema"
```

---

## Task 4: Results Section UI Redesign

**Files:**
- Modify: `app/routes/app.experiments.$id.tsx`

This task depends on Task 3 (new schema fields must exist).

- [ ] **Step 1: Add `monthlyImpact` computation in the loader**

In `app/routes/app.experiments.$id.tsx`, find the loader function. The existing loader already fetches `experiment` (which includes `result` via `include: { variants: true, result: true, segment: true }`). After the `previewPath` computation and before `return`, add:

```typescript
    // Estimated monthly revenue impact from the variant
    const result = experiment.result;
    let monthlyImpact: number | null = null;
    if (
      result &&
      result.controlRevPerVisitor != null &&
      result.treatmentRevPerVisitor != null &&
      experiment.activatedAt
    ) {
      const daysRunning = Math.max(
        1,
        (Date.now() - experiment.activatedAt.getTime()) / 86_400_000
      );
      const dailyVisitors =
        (result.controlVisitors + result.treatmentVisitors) / daysRunning;
      const rpvLift = result.treatmentRevPerVisitor - result.controlRevPerVisitor;
      monthlyImpact = rpvLift * dailyVisitors * 30;
    }

    return { experiment, qaLog, shopDomain: shop.shopifyDomain, previewPath, monthlyImpact };
```

- [ ] **Step 2: Consume `monthlyImpact` in the component**

Find `const { experiment, qaLog, shopDomain, previewPath } = useLoaderData<typeof loader>();` and update:
```typescript
  const { experiment, qaLog, shopDomain, previewPath, monthlyImpact } = useLoaderData<typeof loader>();
```

- [ ] **Step 3: Add `PValueBadge` helper component**

After the existing `MetricRow` component definition (around line 234), add:
```typescript
function PValueBadge({ p }: { p: number | null | undefined }) {
  if (p == null) return <td style={{ textAlign: "right", padding: "4px 8px", color: "#8c9196" }}>—</td>;
  const [bg, color, label] =
    p < 0.05  ? ["#d3f0d3", "#1a6130", `p=${p.toFixed(3)} ✓`] :
    p < 0.2   ? ["#fff3cd", "#7d5200", `p=${p.toFixed(3)} ~`] :
                ["#fde8e8", "#8b1c1c", `p=${p.toFixed(2)} —`];
  return (
    <td style={{ textAlign: "right", padding: "4px 8px" }}>
      <span style={{ background: bg, color, borderRadius: 4, padding: "2px 6px", fontSize: 11 }}>
        {label}
      </span>
    </td>
  );
}
```

- [ ] **Step 4: Replace the results section**

Find `<s-section heading="Results">` and replace the entire section (through `</s-section>`) with:

```tsx
      <s-section heading="Results">
        {result ? (
          <s-stack direction="block" gap="base">
            {/* Hero row */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              {/* P2B card */}
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="extraTight">
                  <s-text tone="subdued">Prob. to Beat Control</s-text>
                  <s-text variant="headingLg" tone={
                    (result.probToBeatControl ?? 0) >= 0.95 ? "success" :
                    (result.probToBeatControl ?? 0) >= 0.70 ? "caution" : undefined
                  }>
                    {result.probToBeatControl != null
                      ? `${(result.probToBeatControl * 100).toFixed(1)}%`
                      : "—"}
                  </s-text>
                  <s-text tone="subdued">need 95% to auto-conclude</s-text>
                </s-stack>
              </s-box>

              {/* Monthly impact card — only when revenue data exists */}
              {monthlyImpact != null ? (
                <s-box padding="base" borderWidth="base" borderRadius="base">
                  <s-stack direction="block" gap="extraTight">
                    <s-text tone="subdued">Est. Monthly Impact</s-text>
                    <s-text variant="headingLg" tone={monthlyImpact >= 0 ? "success" : "critical"}>
                      {monthlyImpact >= 0
                        ? `+$${Math.round(monthlyImpact).toLocaleString()} uplift`
                        : `-$${Math.round(Math.abs(monthlyImpact)).toLocaleString()} at risk`}
                    </s-text>
                    <s-text tone="subdued">at current RPV lift rate</s-text>
                  </s-stack>
                </s-box>
              ) : (
                <s-box padding="base" borderWidth="base" borderRadius="base">
                  <s-stack direction="block" gap="extraTight">
                    <s-text tone="subdued">Est. Monthly Impact</s-text>
                    <s-text tone="subdued">No revenue data yet</s-text>
                  </s-stack>
                </s-box>
              )}

              {/* Visitors card */}
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="extraTight">
                  <s-text tone="subdued">Visitors</s-text>
                  <s-text variant="headingLg">
                    {result.controlVisitors.toLocaleString()} / {result.treatmentVisitors.toLocaleString()}
                  </s-text>
                  <s-text tone="subdued">control / treatment</s-text>
                </s-stack>
              </s-box>
            </div>

            {/* Funnel metrics table */}
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "4px 8px", borderBottom: "1px solid #e1e3e5", color: "#6d7175", fontWeight: 500 }}>Metric</th>
                    <th style={{ textAlign: "right", padding: "4px 8px", borderBottom: "1px solid #e1e3e5", color: "#6d7175", fontWeight: 500 }}>Control</th>
                    <th style={{ textAlign: "right", padding: "4px 8px", borderBottom: "1px solid #e1e3e5", color: "#6d7175", fontWeight: 500 }}>Treatment</th>
                    <th style={{ textAlign: "right", padding: "4px 8px", borderBottom: "1px solid #e1e3e5", color: "#6d7175", fontWeight: 500 }}>Lift</th>
                    <th style={{ textAlign: "right", padding: "4px 8px", borderBottom: "1px solid #e1e3e5", color: "#6d7175", fontWeight: 500 }}>P-value</th>
                  </tr>
                </thead>
                <tbody>
                  {result.controlAddToCartRate != null && (
                    <tr>
                      <td style={{ padding: "4px 8px" }}>Add to cart</td>
                      <td style={{ textAlign: "right", padding: "4px 8px" }}>{(result.controlAddToCartRate * 100).toFixed(2)}%</td>
                      <td style={{ textAlign: "right", padding: "4px 8px" }}>{((result.treatmentAddToCartRate ?? 0) * 100).toFixed(2)}%</td>
                      <LiftCell lift={result.addToCartRateLift ?? null} />
                      <PValueBadge p={result.addToCartPValue} />
                    </tr>
                  )}
                  {result.controlCheckoutRate != null && (
                    <tr>
                      <td style={{ padding: "4px 8px" }}>Checkout rate</td>
                      <td style={{ textAlign: "right", padding: "4px 8px" }}>{(result.controlCheckoutRate * 100).toFixed(2)}%</td>
                      <td style={{ textAlign: "right", padding: "4px 8px" }}>{((result.treatmentCheckoutRate ?? 0) * 100).toFixed(2)}%</td>
                      <LiftCell lift={result.checkoutRateLift ?? null} />
                      <PValueBadge p={result.checkoutPValue} />
                    </tr>
                  )}
                  <tr>
                    <td style={{ padding: "4px 8px" }}>Conversion rate</td>
                    <td style={{ textAlign: "right", padding: "4px 8px" }}>{(result.controlConversionRate * 100).toFixed(2)}%</td>
                    <td style={{ textAlign: "right", padding: "4px 8px" }}>{(result.treatmentConversionRate * 100).toFixed(2)}%</td>
                    <LiftCell lift={result.conversionRateLift ?? null} />
                    <PValueBadge p={result.convRatePValue} />
                  </tr>
                  {result.controlAov != null && (
                    <tr>
                      <td style={{ padding: "4px 8px" }}>AOV</td>
                      <td style={{ textAlign: "right", padding: "4px 8px" }}>${result.controlAov.toFixed(2)}</td>
                      <td style={{ textAlign: "right", padding: "4px 8px" }}>${(result.treatmentAov ?? 0).toFixed(2)}</td>
                      <LiftCell lift={result.aovLift ?? null} />
                      <PValueBadge p={result.aovPValue} />
                    </tr>
                  )}
                  {result.controlRevPerVisitor != null && (
                    <tr style={{ fontWeight: 600 }}>
                      <td style={{ padding: "4px 8px" }}>Rev / visitor</td>
                      <td style={{ textAlign: "right", padding: "4px 8px" }}>${(result.controlRevPerVisitor ?? 0).toFixed(2)}</td>
                      <td style={{ textAlign: "right", padding: "4px 8px" }}>${(result.treatmentRevPerVisitor ?? 0).toFixed(2)}</td>
                      <LiftCell lift={result.revPerVisitorLift ?? null} />
                      <PValueBadge p={result.revPerVisitorPValue} />
                    </tr>
                  )}
                </tbody>
              </table>
            </s-box>
          </s-stack>
        ) : (
          <s-paragraph>
            No results yet. Results are computed hourly once the experiment is active.
          </s-paragraph>
        )}
      </s-section>
```

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
```
Expected: no errors

```bash
git add app/routes/app.experiments.\$id.tsx
git commit -m "feat: redesign results section — hero stats, full funnel table with p-values, monthly revenue impact"
```

---

## Task 5: Experiment Detail Code Collapse

**Files:**
- Modify: `app/routes/app.experiments.$id.tsx`

- [ ] **Step 1: Add `useState` for code expand state**

In `ExperimentDetail`, the component already has `const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);`. Add a second state for expanded variant IDs:
```typescript
  const [expandedVariants, setExpandedVariants] = useState<Set<string>>(new Set());
  const toggleCode = (variantId: string) =>
    setExpandedVariants((prev) => {
      const next = new Set(prev);
      next.has(variantId) ? next.delete(variantId) : next.add(variantId);
      return next;
    });
```

- [ ] **Step 2: Replace the Variants section**

Find `<s-section heading="Variants">` and replace the entire section (through its closing `</s-section>`) with:

```tsx
      <s-section heading="Variants">
        <s-stack direction="block" gap="large">
          {[control, treatment]
            .filter((v): v is NonNullable<typeof v> => Boolean(v))
            .map((variant) => {
              const isExpanded = expandedVariants.has(variant.id);
              const hasCode = variant.htmlPatch || variant.cssPatch || variant.jsPatch;
              return (
                <s-box key={variant.id} padding="base" borderWidth="base" borderRadius="base">
                  <s-stack direction="block" gap="base">
                    {/* Header row */}
                    <s-stack direction="inline" gap="base">
                      <s-heading>{variant.name}</s-heading>
                      <s-badge>{variant.type}</s-badge>
                    </s-stack>

                    {variant.description && (
                      <s-paragraph>{variant.description}</s-paragraph>
                    )}

                    {/* Action row — always visible */}
                    {shopDomain && (
                      <s-stack direction="inline" gap="small" blockAlign="center">
                        {variant.type === "treatment" && (
                          <s-button
                            type="button"
                            variant="primary"
                            href={`https://${shopDomain}${previewPath}${previewPath.includes("?") ? "&" : "?"}cro_preview_experiment=${experiment.id}&cro_preview_variant=${variant.id}`}
                            target="_blank"
                          >
                            Preview variant ↗
                          </s-button>
                        )}
                        <s-button
                          type="button"
                          variant="secondary"
                          href={`https://${shopDomain}${previewPath}`}
                          target="_blank"
                        >
                          Preview control ↗
                        </s-button>
                        {hasCode && (
                          <s-button
                            type="button"
                            variant="plain"
                            onClick={() => toggleCode(variant.id)}
                          >
                            {isExpanded ? "Hide code" : "</> View code"}
                          </s-button>
                        )}
                      </s-stack>
                    )}

                    {/* Code panels — collapsed by default */}
                    {isExpanded && (
                      <s-stack direction="block" gap="base">
                        {variant.htmlPatch && <CodePreview label="HTML" code={variant.htmlPatch} />}
                        {variant.cssPatch && <CodePreview label="CSS" code={variant.cssPatch} />}
                        {variant.jsPatch && <CodePreview label="JS" code={variant.jsPatch} />}
                      </s-stack>
                    )}

                    {!hasCode && (
                      <s-paragraph>No patches — serves the storefront as-is.</s-paragraph>
                    )}
                  </s-stack>
                </s-box>
              );
            })}
        </s-stack>
      </s-section>
```

- [ ] **Step 3: Typecheck and commit**

```bash
npm run typecheck
```
Expected: no errors

```bash
git add app/routes/app.experiments.\$id.tsx
git commit -m "feat: collapse variant code by default, add control preview button"
```

---

## Task 6: MutationObserver Re-apply in Injector

**File:**
- Modify: `extensions/variant-injector/assets/experiment-injector.js`

This is pure vanilla JS — no TypeScript, no Vitest. Test manually via the storefront preview.

- [ ] **Step 1: Make `applyPatch` accept `variantId` for idempotency**

Find the `applyPatch` function (line ~182) and replace it entirely:

```javascript
  // ── DOM patching ────────────────────────────────────────────────────────────
  function applyPatch(htmlPatch, cssPatch, jsPatch, variantId) {
    // CSS: inject once per variantId (idempotent)
    var styleId = variantId ? 'cro-style-' + variantId : null;
    if (cssPatch && !(styleId && document.getElementById(styleId))) {
      try {
        var style = document.createElement('style');
        if (styleId) style.id = styleId;
        style.textContent = cssPatch;
        document.head.appendChild(style);
      } catch (_) {}
    }

    // HTML: inject once per variantId — skip if our marker is already in the DOM
    var patchedAttr = 'data-cro-patched';
    var alreadyPatched = variantId
      ? document.querySelector('[' + patchedAttr + '="' + variantId + '"]')
      : false;
    if (htmlPatch && !alreadyPatched) {
      try {
        var frag = document.createRange().createContextualFragment(htmlPatch);
        // Mark the first element in the fragment so we can detect double-apply
        var child = frag.firstChild;
        while (child && child.nodeType !== 1) child = child.nextSibling;
        if (child && variantId) child.setAttribute(patchedAttr, variantId);
        document.body.appendChild(frag);
      } catch (_) {
        try {
          var tmp = document.createElement('div');
          tmp.innerHTML = htmlPatch;
          if (variantId && tmp.firstElementChild) tmp.firstElementChild.setAttribute(patchedAttr, variantId);
          while (tmp.firstChild) document.body.appendChild(tmp.firstChild);
        } catch (_2) {}
      }
    }

    // JS: run once per variantId per page load
    var jsKey = variantId ? '_cro_js_' + variantId.replace(/-/g, '_') : null;
    if (jsPatch && !(jsKey && window[jsKey])) {
      try {
        if (jsKey) window[jsKey] = true;
        var code = jsPatch;
        if (/<script[\s>]/i.test(code)) {
          code = code.replace(/<script[^>]*>/gi, '').replace(/<\/script>/gi, '').trim();
        }
        // eslint-disable-next-line no-new-func
        withVisiblePreferredQuery(function () { (new Function(code))(); });
      } catch (_) {
        if (jsKey) window[jsKey] = false;
      }
    }
  }
```

- [ ] **Step 2: Add `startMutationObserver` helper**

After the `applyPatch` function (before `fireViewEvent`), add:

```javascript
  // ── MutationObserver re-apply ─────────────────────────────────────────────
  // Re-applies the active patch when AJAX mutates the DOM (e.g. cart empty
  // state, dynamically-loaded sections). Debounced 200ms. Re-entrancy guard
  // prevents our own DOM changes from re-triggering the observer.
  var _cro_applying = false;
  var _cro_reapply_timer = null;

  function startMutationObserver(htmlPatch, cssPatch, jsPatch, variantId) {
    if (!window.MutationObserver) return;
    var observer = new MutationObserver(function () {
      if (_cro_applying) return;
      clearTimeout(_cro_reapply_timer);
      _cro_reapply_timer = setTimeout(function () {
        _cro_applying = true;
        try {
          applyPatch(htmlPatch, cssPatch, jsPatch, variantId);
        } finally {
          _cro_applying = false;
        }
      }, 200);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
```

- [ ] **Step 3: Call `startMutationObserver` in preview mode**

Find the preview mode block (around line 281). After `applyPatch(variant.htmlPatch, variant.cssPatch, variant.jsPatch);`, add:

```javascript
          applyPatch(variant.htmlPatch, variant.cssPatch, variant.jsPatch, variant.id);
          startMutationObserver(variant.htmlPatch, variant.cssPatch, variant.jsPatch, variant.id);
```

(The old call was `applyPatch(variant.htmlPatch, variant.cssPatch, variant.jsPatch)` — update it to pass `variant.id`.)

- [ ] **Step 4: Call `startMutationObserver` in normal assignment mode**

Find the normal assignment path where `applyPatch` is called (search for `applyPatch(variant.htmlPatch` in the lower half of the file — after the Bootstrap section). It will look like:
```javascript
applyPatch(variant.htmlPatch, variant.cssPatch, variant.jsPatch);
```

Update to:
```javascript
applyPatch(variant.htmlPatch, variant.cssPatch, variant.jsPatch, variant.id);
startMutationObserver(variant.htmlPatch, variant.cssPatch, variant.jsPatch, variant.id);
```

- [ ] **Step 5: Manual verification**

Open the dev store storefront with a variant preview URL. Open DevTools → Console. Confirm:
- No errors on load
- `window._cro_js_<variantId>` is set to `true` after load
- `document.querySelector('[data-cro-patched]')` returns the patched element (if HTML patch exists)
- Triggering a DOM mutation (e.g. open/close cart drawer) does NOT cause visible flickering or double-apply

- [ ] **Step 6: Deploy extension and commit**

```bash
shopify app deploy --force
```

```bash
git add extensions/variant-injector/assets/experiment-injector.js
git commit -m "feat: MutationObserver re-apply in injector — handles AJAX-rendered targets"
```

---

## Task 7: Final Check

- [ ] **Run full test suite**

```bash
npm run test:unit
npm run typecheck
```
Expected: all tests pass, no type errors.

- [ ] **Deploy app**

```bash
flyctl deploy -a shivook-ai-cro
```

- [ ] **Smoke test on dev store**
  - Open an experiment detail page → confirm hero stats row + funnel table with p-values renders
  - Confirm monthly impact shows when revenue data exists
  - Confirm variant code is collapsed by default; "View code" toggle works
  - Confirm "Preview control ↗" opens storefront without any `cro_preview_*` params
  - Confirm "Preview variant ↗" applies the variant as before

- [ ] **Commit any fixes, then push**

```bash
git push origin main
```

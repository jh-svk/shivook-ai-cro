# Pre-Submission Polish — Design Spec
_Date: 2026-06-03_

## Scope

Five independent improvements before Shopify app store submission:

1. MutationObserver re-apply in the storefront injector
2. Unify duplicate segment-signature functions
3. Render validator fail-open — add structured log warning
4. Results section redesign — full funnel metrics with p-values and revenue impact
5. Experiment detail page — collapse variant code by default

Shopify submission itself is deferred; requirements will be gathered directly from the Shopify Partner dashboard.

---

## 1. MutationObserver Re-apply (injector)

**File:** `extensions/variant-injector/assets/experiment-injector.js`

**Problem:** Variants are applied once at page load. Targets rendered by later AJAX (cart empty-state, dynamic product sections) are never patched.

**Design:**
- After the initial `applyPatch` call in preview mode and in normal assignment mode, set up a `MutationObserver` on `document.body` with `{ childList: true, subtree: true }`.
- Debounce the callback at **200ms** (clear/reset on each mutation batch).
- Re-entrancy guard: set a module-level `_cro_applying` flag to `true` during `applyPatch`; the debounced handler no-ops if the flag is set.
- Idempotency: before re-applying, check whether the variant's primary target already has `data-cro-patched="<variantId>"`. Set this attribute on the target element(s) after a successful patch. If the attribute is already present and the element is still in the DOM, skip re-apply.
- Disconnect the observer when the experiment concludes or when the visitor is not enrolled (existing early-return paths).
- Preview mode: also attach the observer after preview patch applies, so preview is consistent with production behavior.

**What this fixes:** Cart empty-state test, any test targeting elements injected by Shopify's AJAX cart, lazy-loaded sections.

---

## 2. Segment Signature Unification

**Files affected:**
- `jobs/hypothesisGenerator.ts` — has `segmentSignature(pageType, seg)` (fallback: `"any"`, order: `d|t|v|g`)
- `lib/concurrentTestManager.server.ts` — has `audienceSignature(pageType, seg)` (fallback: `"all"`, order: `d|v|t|g`)
- New: `lib/segmentSignature.server.ts`

**Design:**
- Extract a single exported `segmentSignature(pageType, seg)` into `lib/segmentSignature.server.ts`.
- Canonical form: `pageType|deviceType|trafficSource|visitorType|geoCountry` with `"any"` fallbacks (matches `hypothesisGenerator.ts` — the source of truth for dedup).
- Both `hypothesisGenerator.ts` and `concurrentTestManager.server.ts` import from the new module; local functions deleted.
- No DB changes; signature is only used in-memory.

---

## 3. Render Validator Fail-Open — Structured Warning

**File:** `jobs/autoBuild.ts`

**Current behavior:** If the storefront fetch fails (store slow/blocked), the render validator cannot run and the variant passes through silently.

**Design:**
- Keep the fail-open behavior (blocking all builds when the store is unreachable would be worse).
- When the validator is skipped due to a fetch error, emit a structured log: `console.warn("[autoBuild] render validator skipped — storefront fetch failed", { shopId, hypothesisId, error: err.message })`.
- No schema changes, no UI changes.

---

## 4. Results Section Redesign

### 4a. New per-metric p-values (schema + stats)

**Schema migration:** Add to `Result` model in `prisma/schema.prisma`:
```
addToCartPValue    Float?
checkoutPValue     Float?
convRatePValue     Float?
aovPValue          Float?
revPerVisitorPValue Float?
```

**Stats computation** (`jobs/resultRefresh.ts` or `lib/stats.ts`):
- Compute each p-value using a **two-proportion z-test** for rate metrics (ATC rate, checkout rate, conv rate) and a **Welch's t-test approximation** for value metrics (AOV, RPV).
- For rate metrics: `z = (p2 - p1) / sqrt(p_pool * (1 - p_pool) * (1/n1 + 1/n2))`, two-tailed p-value from normal CDF.
- For value metrics (AOV/RPV): use the normal approximation since we don't have per-order variance. Use `controlRevenue/controlVisitors` and `treatmentRevenue/treatmentVisitors` as means; estimate variance from the Poisson revenue model (`var ≈ mean`). This is an approximation; label it as such in the UI.
- Existing `pValue` field (overall conv rate) is kept and stays the primary Bayesian gate. New fields are supplementary per-metric signals.

### 4b. Monthly revenue uplift estimate

Computed in the **loader** (`app/routes/app.experiments.$id.tsx`), not stored in DB (it changes as visitors accumulate):

```
daysRunning = max(1, (now - experiment.activatedAt) / 86400000)
dailyVisitors = (result.controlVisitors + result.treatmentVisitors) / daysRunning
rpvLift = (result.treatmentRevPerVisitor ?? 0) - (result.controlRevPerVisitor ?? 0)
monthlyImpact = rpvLift * dailyVisitors * 30
```

- Positive `monthlyImpact` → "Est. monthly uplift: +$X" (green)
- Negative `monthlyImpact` → "Est. monthly revenue at risk: -$X" (red)
- Only shown when `result.controlRevPerVisitor != null` (i.e. revenue data exists)
- Surfaced as a loader-computed field alongside the existing result data

### 4c. UI redesign — experiment detail results section

Replace the current results section with:

**Hero row (3 cards):**
1. Probability to Beat Control — large number, color-coded (green ≥ 95%, yellow 70–94%, grey < 70%), subtext "need 95% to auto-conclude"
2. Estimated Monthly Impact — `+$X uplift` (green) or `-$X at risk` (red); hidden if no revenue data
3. Visitors — `N control / N treatment`

**Funnel metrics table:**

| Metric | Control | Treatment | Lift | P-value |
|---|---|---|---|---|
| Add to Cart | x% | x% | +x% | badge |
| Checkout Rate | x% | x% | +x% | badge |
| Conv. Rate | x% | x% | +x% | badge |
| AOV | $x | $x | +x% | badge |
| Rev / Visitor | $x | $x | +x% | badge |

P-value badge color coding:
- Green (`p < 0.05`): significant
- Yellow (`0.05 ≤ p < 0.2`): trending
- Red (`p ≥ 0.2`): noise / insufficient data
- Grey: data not yet available

Rows are hidden if the underlying data is null (e.g. AOV/RPV rows hidden when no revenue events yet).

**Reuses existing `MetricRow` component** where possible; hero row is new.

---

## 5. Experiment Detail — Code Collapse

**File:** `app/routes/app.experiments.$id.tsx`

**Current:** Each variant card shows HTML/CSS/JS editors by default (always expanded).

**Design:**
- Variant card header: name, type badge, status badge — unchanged.
- Action row (always visible): "↗ Preview variant" button + "↗ Preview control" button + "</> View code" toggle button (right-aligned).
- Code editors: hidden by default, revealed when "View code" is toggled. Toggle label flips to "Hide code" when expanded.
- State is local React `useState` per variant — no persistence needed.
- "Preview control" button opens the storefront URL (already computed as `previewPath`) without the `cro_preview_*` params — just the raw page. This is new; currently only the variant preview link exists.

---

## Out of scope

- Event timeline / per-day chart (deferred — stats table covers the monitoring job)
- Shopify submission requirements (deferred to a dedicated session)

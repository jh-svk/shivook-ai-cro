# Multi-variant (A/B/n) testing — design

**Status:** Proposed. Not yet implemented.
**Author:** drafted 2026-06-03.
**Scope:** Extend experiments from exactly `control + 1 treatment` to `control + up to 2 treatments` (3 arms max).

## Why cap at 3 arms
A/B/n splits traffic N ways, so each arm needs the same per-arm sample to reach significance. With our Bayesian min-runtime gate, each arm needs **≥ ~150 views/day** to conclude in a reasonable window. 3 arms ⇒ **≥ 450 views/day** on that page type; 4 arms ⇒ 600+, where the added wait rarely pays for the marginal learning. So: **hard cap 3 arms**, and arm count is gated on traffic (see §6).

## Current constraints (verified in code)
- `Variant` table is already N-capable — `type` is a free string, FK to experiment, `events[]`. **No schema change needed for variants.**
- `Result` table (`prisma/schema.prisma`) has fixed `control*` / `treatment*` columns — **no room for a 2nd treatment**. This is the main storage blocker.
- `lib/stats.ts` `computeStats(control, treatment)` samples exactly 2 Beta posteriors — pairwise only.
- `jobs/resultRefresh.ts:33-35` does `variants.find(type==="treatment")` — picks one arm. (The SQL at `:47-62` already `GROUP BY "variantId"`, so it's N-ready upstream.)
- `extensions/variant-injector/assets/experiment-injector.js:133` buckets with `fnv32a(...) % 2` and stores the literal string `"control"`/`"treatment"`.

## 1. Variant model — no migration
Keep `type = "control"` for the control and `type = "treatment"` for **every** treatment arm. Disambiguate treatments by their own `Variant.id` + `Variant.name` ("Variant B", "Variant C"). Stop using `.find(type==="treatment")`; iterate **all** non-control variants instead. Display order = `createdAt`.

## 2. Result storage — new `VariantResult` table (the one real migration)
`Result` stays as the **experiment-level summary** (overall decision, guardrail status, winner pointer). Add a per-arm table:

```prisma
model VariantResult {
  id                String   @id @default(uuid())
  shopId            String   // non-negotiable: every table has shopId
  experimentId      String
  variantId         String
  computedAt        DateTime
  visitors          Int      @default(0)
  conversions       Int      @default(0)
  conversionRate    Float    @default(0)
  revenue           Float    @default(0)
  addToCartCount    Int?
  checkoutCount     Int?
  purchaseCount     Int?
  aov               Float?
  // vs-control comparison (null for the control row itself)
  relativeLift      Float?
  probToBeatControl Float?   // pairwise P(arm > control)
  probBestArm       Float?   // joint P(this arm is the best of all arms)
  guardrailStatus   String   @default("ok") // per-arm AOV guardrail
  experiment        Experiment @relation(fields: [experimentId], references: [id])
  variant           Variant    @relation(fields: [variantId], references: [id])
  @@unique([experimentId, variantId])
  @@index([shopId])
  @@map("variant_results")
}
```

Add `Experiment.winningVariantId String?` so the summary can point at the chosen arm.
Backward compat: existing 2-arm experiments backfill cleanly (control row + one treatment row).

## 3. Stats kernel — `computeMultiArmStats`
New export in `lib/stats.ts` (keep `computeStats` for callers that still want pairwise):

```ts
computeMultiArmStats(control: VariantStats, treatments: VariantStats[]): {
  arms: Array<{ probToBeatControl: number; probBestArm: number; relativeLift: number | null; ... }>;
  bestArmIndex: number;
}
```

- **Joint Monte Carlo:** each of 10k iterations samples a Beta draw for *every* arm at once; track which arm is max → `probBestArm` per arm. Same loop yields pairwise `probToBeatControl` (arm draw > control draw).
- **No Bonferroni needed.** The joint `P(best)` already integrates over the whole field of arms — that *is* the multiple-comparison correction in the Bayesian framing. State this in code comments so nobody bolts on a frequentist correction later.

## 4. Conclusion rule (`jobs/resultRefresh.ts`)
After `minRuntimeDays`, conclude as a **winner** when some treatment arm has **both**:
- `probBestArm ≥ 0.95` (it's the best of all arms), AND
- `probToBeatControl ≥ 0.95` (it actually beats doing nothing).

Set `Experiment.winningVariantId` to that arm. Guardrail: AOV checked **per arm** (arm tripped if its AOV < control × 0.97). A tripped arm is removed from winner eligibility but the test keeps running unless **all** treatments are tripped (then conclude inconclusive, as today). Write one `VariantResult` row per arm + update the `Result` summary.

## 5. Injector — N-way bucketing
`extensions/variant-injector/assets/experiment-injector.js`:
- API payload (`/apps/cro/api/experiments`) sends `variants[]` in stable `createdAt` order, each with `{ id, type, htmlPatch, cssPatch, jsPatch }`.
- `assignVariant`: `bucket = fnv32a(visitorId + '|' + experimentId) % variants.length`; store the **variantId** (not the string `"treatment"`). Migrate stored values: legacy `"control"`/`"treatment"` still resolve via type lookup.
- Even split only for v1 (`% N`). Weighted splits = future work.

## 6. autoBuild + traffic gate
`jobs/autoBuild.ts`: compute `dailyViews` = 14-day rolling avg of `view` events for the hypothesis's page type. Then:
`maxArms = clamp(floor(dailyViews / 150), 2, 3)`.
If `maxArms ≥ 3`, generate **2 distinct treatments** (different mechanisms for the same hypothesis), run both through the Haiku critique pass, and write a single `pending_approval` experiment with 3 arms. Merchant approves/rejects the whole experiment.

## 7. UI
- `/app/experiments/new`: "Add variant" button (cap 3). Each arm gets its own HTML/CSS/JS CodeMirror editors + name.
- `/app/experiments/:id`: results table becomes N rows (control + each treatment), columns: visitors, conv rate, lift, `P(beat control)`, `P(best)`. Highlight the leader; badge the winner on conclusion.
- Approval UI: show "3-arm test" with all variant previews.

## 8. Rollout order (each independently shippable)
1. `VariantResult` migration + `winningVariantId` (no behavior change; backfill 2-arm).
2. `computeMultiArmStats` + unit tests (pure function, TDD).
3. `resultRefresh` writes per-arm rows + new conclusion rule (still 2-arm in practice).
4. Injector N-way bucketing (backward compatible).
5. `/experiments/new` manual 3-arm authoring + results table.
6. autoBuild auto-generates the 2nd treatment behind the traffic gate.

Steps 1-4 are invisible to merchants and safe to ship incrementally; the feature "turns on" at step 5.

## Local validation
`scripts/seedDemo.ts` now seeds high-volume, segment-scoped data. Once step 3 lands, extend a `SPECS` entry to emit `control + t1 + t2` so the 3-arm stats/conclusion path can be exercised at thousands of views/arm without waiting on real traffic.

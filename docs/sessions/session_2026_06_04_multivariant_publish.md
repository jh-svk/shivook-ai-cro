# Session 2026-06-04 — Multi-variant, prevention guards, dashboard, Publish Win Live

**This is the LATEST state. Read this first.** Everything below is shipped to `main` and deployed unless noted.

## Deploy state at end of session
- **Fly app:** version **52**, 2 machines healthy (Amsterdam). `flyctl deploy -a shivook-ai-cro`.
- **Storefront extension:** version **shivook-ai-cro-14** (deployed via `shopify app deploy --force`). The injector change for Publish Win Live needs THIS, not just Fly.
- **Migration applied to prod DB:** `20260603162652_add_variant_results_multivariant` (additive — new `variant_results` table + `experiments.winningVariantId`).
- **All on `main`**, feature branches merged `--no-ff` then deleted. Another agent shares the repo — `git pull --ff-only` before working.
- Last unit-test/typecheck/build run: **62 unit tests pass, typecheck clean, build clean.**

## DATA STATE = CLEAN SLATE (wiped at user's request, end of session)
0 experiments, 0 hypotheses, 0 segments, 0 research reports, 0 events. `platform_learnings` cleared (it's a GLOBAL table, no shopId — all entries were dummy-derived). **Kept:** `shop.themeTokens` (real, extracted). **Cleared:** `shop.dataSnapshot` (was dummy). Shop/subscription/session/data_sources untouched.

## What shipped this session (features, all live)
1. **High-volume seed** — `scripts/seedDemo.ts` rewritten: segment-matrix (device×geo×source×visitor), thousands of visitors/arm, `SCALE=N` env, real stats engine. (Dimensions live on `Segment`, not events — see gotchas.)
2. **Multi-variant A/B/n (control + up to 2 treatments, cap 3).** Design doc: `docs/multi-variant-design.md` (marked implemented). Steps:
   - `prisma/schema.prisma`: `VariantResult` per-arm table (has shopId) + `Experiment.winningVariantId`.
   - `lib/stats.ts`: `computeMultiArmStats(control, treatments[])` — joint Beta-Binomial Monte Carlo → per-arm `probToBeatControl` + `probBestArm`. Winner = best arm AND beats control, both ≥95%. **This joint P(best) IS the multiple-comparison correction — do NOT add Bonferroni** (commented in code). 7 unit tests in `lib/stats.test.ts`.
   - `jobs/resultRefresh.ts`: aggregates ALL arms (grouped SQL), writes a `VariantResult` row per arm, multi-arm conclusion sets `winningVariantId`; per-arm AOV guardrail (whole test concludes for loss only if ALL treatments trip). Legacy `Result` summary tracks the leading/winning treatment so old UI unchanged. **2-arm behaviour identical to before.**
   - `extensions/variant-injector/assets/experiment-injector.js`: `assignVariant` now `hash % N`, sticky by variantId, legacy 'control'/'treatment' string still honored.
   - `app/routes/app.experiments.new.tsx`: "Add a third variant" → Variant C section.
   - `app/routes/app.experiments.$id.tsx`: arm-breakdown table (P(beat control), P(best)), winner badge, ship-the-winner uses `winningVariantId`.
   - `jobs/autoBuild.ts`: `maxArmsForTraffic(shopId, pageType)` — 14-day view count, ≥150 views/arm/day, cap 3. When ≥3, generates a 2nd, meaningfully-different treatment through the SAME QA gauntlet — **best-effort: if it fails QA, ships 2-arm.**
3. **Hover-only no-op fix** — `lib/variantValidator.server.ts` `detectHiddenTarget()`: rejects mobile-gated collection variants targeting hover-only Quick-Add/card-footer buttons (the exact wasted-test class). Rides autoBuild's existing render-validation retry. Tests in `lib/variantValidator.test.ts`.
4. **Page-inventory grounding (PREVENTION)** — `lib/pageInventory.server.ts` `extractPageInventory()` + `pageLacksRequiredElement()`. `autoBuild` now fetches the real page BEFORE generating, feeds an element inventory into the prompt, and hard-blocks impossible tests (collection-page CTA with no usable buy button). Falls back to store-wide grounding if fetch fails. Tests in `lib/pageInventory.test.ts`. (Three layers kept: inventory prevention + store-wide selector grounding + post-gen render/hover-only validation.)
5. **Hypothesis generator fix** — `jobs/hypothesisGenerator.ts`: the segment template hardcoded `trafficSource: null`, so traffic-source segments almost never appeared. Now mirrors geo/visitorType + a coverage nudge to span all 5 dims (page×device×visitor×geo×traffic source).
6. **Dashboard** — `app/routes/app._index.tsx`: performance summary cards (tests w/ data, 🏆 winners + win rate, visitors tested, avg winning lift, measured revenue impact) + winner emphasis (badge + colored/bold lift).
7. **Publish Win Live** — replaces "copy code → theme editor" with a one-click button.
   - `app.experiments.$id.tsx`: `publish_win` (status→`published`, sets winningVariantId) / `unpublish_win` (→`concluded`). Copy-code kept as secondary "hard-code it" option.
   - `api.experiments.tsx`: returns `publishedWins[]` (winning variant patches + segment).
   - injector: applies published wins to 100% of MATCHING visitors, independent of A/B enrollment, try/catch wrapped (never breaks page). No events, no bucketing.
   - New `published` status added to STATUS_TONE maps + formatStatus handles it.
   - **Tradeoff (told to user):** served by the app (reversible, no theme-file risk) but only live while app installed. Hard-code option covers the permanent case.

## Seed scripts (for testing next time)
- `scripts/seedDemo.ts` — high-volume demo experiments. `--clean` to remove. `SCALE=N`.
- `scripts/seedHypothesisDemo.ts` — sets rich `dataSnapshot` (geo+traffic sources), seeds historical per-page traffic so the 3-arm gate opens, creates a research report, RUNS the real AI generator → multi-segment hypotheses. Flags: `--clean`, `--traffic-only` (reseed traffic+results without touching hypotheses). The historical "DATA ·" experiments now carry real funnels + computed Results (so they show data, not blank rows).

## KEY GOTCHAS / architecture notes
- **Dimensions live on `Segment` (experiment-level), NOT per-event.** `events` has no device/country/source columns. To make the dashboard show segmented data, attach segment-scoped experiments. Per-event dimensions = a separate unbuilt feature ("Option 3").
- **The Hypotheses page "Generate" button runs `dataSync` first, which OVERWRITES `shop.dataSnapshot` from the live (empty dev) store.** So to demo multi-segment hypotheses you must run the generator server-side (seedHypothesisDemo), NOT click that button — clicking it wipes the dummy snapshot.
- **`maxArmsForTraffic`** needs historical view events for the page type in the last 14 days (≥450/day → 3 arms). No history → always 2 arms. seedHypothesisDemo provides this.
- **2nd-treatment generation is best-effort** → sometimes a product/homepage/cart test still ships 2-arm if the 2nd variant fails QA. Not a bug.
- `platform_learnings` is GLOBAL (no shopId). Single-tenant dev so safe to clear, but be careful if multi-shop ever.
- Prod DB = the Neon DB that local `.env` `DATABASE_URL` points to (single DB). Scripts run via `npx -y tsx scripts/<x>.ts` with `.env` loaded.

## Open / not done (intentional)
- Per-event dimensional breakdown (slice ONE experiment by device/country) — not built; would need migration + segment-aware stats + UI. Natural companion if revisited.
- The "1 variant not 3" the user saw was a timing artifact during the blank-row fix (gate dipped), not a code bug.

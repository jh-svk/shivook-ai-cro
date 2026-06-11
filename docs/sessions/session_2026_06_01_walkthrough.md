---
name: session-2026-06-01-walkthrough
description: "Blow-by-blow of the long merchant-walkthrough session: activated Phase 3, fixed variant-quality bug classes, built dashboard QA tooling. All in PR #3."
metadata: 
  node_type: memory
  type: project
  originSessionId: 817efe5d-2236-4517-88b5-15ab32116dc7
---

# Session 2026-05-31 → 2026-06-01: walkthrough hardening (PR #3)

The user clicked through the whole app as a merchant would and previewed AI-generated
variants on the live storefront, surfacing a long series of real bugs. 39 commits on
`polish/walkthrough-feedback-1`, all deployed + verified, opened as **PR #3 → main**.

## The recurring lesson
The AI kept generating **plausible code that didn't actually work on the real Dawn theme**.
Each preview surfaced a new failure mode. The fixes form layered guards:

### Variant correctness (code-level guards — these are real, enforced)
- **DOM grounding** (`lib/themeTokenExtractor.server.ts`): scrapes the store's real class/id/
  data-attr vocabulary + real selectors from homepage AND a sampled product page; builder is
  constrained to them; `validateVariantSelectors` in autoBuild rejects invented selectors.
- **Render validator** (`lib/variantValidator.server.ts`, `validateVariantAgainstHtml`): runs the
  variant against a linkedom DOM of the REAL page; fails+retries if it produces NO visible change.
  Device-aware width shim (mobile 390 / desktop 1440) so device-gated JS runs its main path.
  Catches: wrong-form lookups (Dawn's ATC button is OUTSIDE form[action*=/cart/add]),
  missing-data no-ops (empty meta description), etc.
- **Injector** (`experiment-injector.js`): `withVisiblePreferredQuery` makes querySelector prefer the
  VISIBLE match (Dawn renders a hidden cart-drawer duplicate of `.cart__checkout-button`); unwraps
  `<script>`-wrapped jsPatch before `new Function`; one-test-per-visitor mutual exclusion
  (`cro_enrolled_experiment`); draggable preview banner.
- **JSON resilience** (`parsePatchesJson` in autoBuild): Claude emits multi-line CSS/JS with raw
  newlines inside JSON strings → bare JSON.parse throws → spurious qa_failed. Now newline-tolerant,
  used at ALL patch-parse sites incl. the render retry (was the one bare-parse bug the audit found).

### Variant quality (PROMPT guardrails — guidance, not guaranteed)
In `jobs/autoBuild.ts` system prompt + `jobs/hypothesisGenerator.ts`:
- front-end-only: no shipping/discount/price/stock/checkout, **no product-image-swap** (media is
  backend — invented URL 404s), no rebuilding theme-JS widgets (filters/sort/cart-drawer).
- single-element targeting: don't `querySelectorAll(...).forEach` and clobber every match (the
  hero-headline-pasted-everywhere bug).
- respect page layout: don't span edge-to-edge / hug the viewport edge; match the anchor's width;
  below "Add to Cart" with two CTAs means below the WHOLE button group (below "Buy it now").
- **never inject between items in a flex/grid row** (the cart "Subtotal … $price" → "Sub/tota/l"
  squeeze bug). Insert after the row container, block-level, full-width.
- always render a change (no no-op on missing data); no em-dashes (AI tell — also stripped post-gen);
  heuristic page-relevance (don't propose collection-CTA tests when cards have no CTAs).

### Segmentation
- Every hypothesis = ONE specific segment, from honest data only: device + visitor always; geo +
  **traffic source from Shopify order attribution (customerJourneySummary) — GA4 dependency DROPPED**.
- Dedup at GENERATION (vs backlog hypotheses AND live experiments) and at ACTIVATION
  (`canActivateExperiment` blocks a 2nd test on same page+device+audience+geo; applied to
  activate/approve/resume).

### Dashboard / QA tooling
- Experiments table: Device/Audience/Geo columns, segment quick-filter chips, **dual Control ↗ /
  Variant ↗ storefront preview links** (open in a NEW TAB without the embedded-app re-auth loop —
  this was the QA-speed win; opening the embedded detail page in a raw tab loops on re-auth).
- "Building variants" + "Build failed (retry/dismiss)" sections; research progress timer that
  survives refresh (localStorage-anchored).
- Settings: `autoConcludeEnabled` toggle (merchant decides when tests end; AOV guardrail always fires).

### State-machine fixes
- qaReview reject + reject_approval used to leave orphaned draft experiments + stale "promoted"
  hypotheses ("stuck in Draft" bug). Both now clean up: hypothesis → qa_failed, clear
  promotedExperimentId, delete the draft.
- Experiment delete works at ANY status with FK-safe cleanup.

## What we deliberately did NOT ship
- **Visual/headless-Chromium geometry validator**: fully built + tested (catches flex-squeeze +
  overflow via real geometry). REVERTED because Shopify/Cloudflare bot-blocks headless Chromium
  ("Just a moment…" / "Verifying your connection") — the real storefront never loads, so it could
  only fail-open. Bypassing bot detection is an arms race + against ToS. Layout-aesthetic QA stays
  MANUAL via the dual preview links (how most CRO tools work anyway).

## Agreed NEXT task
**MutationObserver re-apply in the injector** — variants are one-shot at load and miss targets
rendered by later AJAX (cart-empty-state test fails for this). Touches live shopper code: debounce,
loop-guard, no double-apply. Its own focused session.

## Collaboration note
Another agent also commits to this repo (see git_workflow.md). This session's branch was 39 commits
ahead of main with 0 divergence at close. There was one scare mid-session reading interleaved
parallel-tool output as a merge conflict — it was a false alarm (`git merge` said "already up to
date"). Be careful reading parallel Bash outputs.

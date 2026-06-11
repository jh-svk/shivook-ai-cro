# Session 2026-06-11 — Diagnosis walkthrough + orchestrator pause + AI-pipeline quality fixes

**This is the LATEST state. Read this first.** It supersedes the 2026-06-04 log on everything below.
Work this session is on **3 open PRs (#4, #5, #6) — NOT merged, NOT deployed.** The prod app is still
running Fly v52 code; only two out-of-band prod changes were made (a runtime pg-boss unschedule + a small
data retag, both noted below).

---

## TL;DR
Came in after ~1 week away to "see where we stand." Did a live walkthrough of the app (Shopify admin →
Shivook AI CRO) and discovered the autonomous pipeline had been running unattended all week against a
**password-protected dev store with zero reachable traffic** — generating experiments that can never
collect data, with a ~70% QA-fail rate. Diagnosed the two real bugs behind that, paused the pipeline, and
fixed both. Three PRs opened. User paused for the day here.

## ⚠️ Memory correction: it was NEVER a clean slate this week
The 2026-06-04 log said data was wiped to a clean slate. **That is stale.** The 6-hourly orchestrator
(`orchestrator-tick`, pg-boss cron) ran all week and rebuilt everything. **Actual state at end of
2026-06-11:**
- **Experiments:** 7 active, 1 draft
- **Hypotheses:** 8 promoted, 15 backlog, **11 qa_failed, 8 not_viable** (the `not_viable` status is NEW — see PR #5)
- **Events: 0** (root cause: store is password-walled — see below)
- **pg-boss schedules now:** `hourly-refresh`, `nightly-sync` ONLY. `orchestrator-tick` was removed (paused).

## Key diagnostic findings (the "why")
1. **Storefront is password-protected.** `https://shivook-team.myshopify.com/products/gift-card` 302-redirects
   to `/password` ("Opening soon"). No public visitor can reach the storefront → the 7 active experiments
   physically **cannot collect a single event**. The autonomous pipeline was running blind, burning Anthropic
   tokens every 6h. **User said: this is a dev store, the password CANNOT be removed.** So no real traffic is
   possible here — the pipeline's measurement half is untestable on this store; only the generation half is.
2. **~70% QA-fail rate**, dominated by `empty_variant` (8 of last 40 orchestrator failures). Root-caused → PR #5.
3. **Low idea diversity** — the generator kept proposing the same 2 motifs (trust-badge, sticky-ATC). Root-caused → PR #6.
4. **Embedded app cold-load ~10s blank** before content renders (minor UX nit, not fixed).

---

## What shipped this session — 3 OPEN PRs (all green: typecheck + unit + build)

### PR #4 — `chore/pause-autonomous-orchestrator` — pausable orchestrator
- Added `AUTONOMOUS_PIPELINE_ENABLED` env flag (default `true` = unchanged behaviour) in `jobs/scheduler.ts`.
  When `"false"`, `registerSchedules()` skips `orchestrator-tick` AND calls `boss.unschedule("orchestrator-tick")`
  so the pause survives restarts/redeploys.
- **ALSO did a runtime prod change (no deploy):** deleted the `orchestrator-tick` row from `pgboss.schedule`
  in the prod DB. **The orchestrator is paused RIGHT NOW.** BUT this holds only until the next deploy/restart of
  `main` — `registerSchedules()` re-adds it on boot unless PR #4 is merged AND the secret is set. So if the
  pipeline is mysteriously running again next session, that's why: a deploy re-armed it.

### PR #5 — `fix/empty-variant-classification` — empty variants = not-viable, not failures
- **Root cause:** the generation prompt explicitly tells the model to "return null patches instead of guessing"
  when no real selector exists / the page lacks the element. The model correctly declines (all-null patch set)
  for non-viable hypotheses the page-capability pre-gate misses (homepage add-to-cart, trust badge anchored to a
  non-existent ATC button, ATC selector not in extracted vocab). `validateVariantAgainstHtml` raises
  `empty_variant` ONLY when html+css+js are ALL empty (CSS-only passes) — so it's deterministic proof of an
  all-null model output.
- **Old behaviour:** a decline still ran a Haiku design-critique + a Sonnet render-retry (2 wasted model calls)
  then got marked `qa_failed`, polluting the merchant "Build failed" list.
- **Fix:** new `isEmptyPatchSet()` in `lib/variantValidator.server.ts` (CSS-only ≠ empty; 5 unit tests).
  `jobs/autoBuild.ts` detects all-empty right after parse → marks hypothesis **`not_viable`** (NEW terminal
  status; `status` is a plain String, NO migration), logs `BUILD/skipped` reason `declined_not_viable`, returns
  before critique/retry. Orchestrator only builds `backlog`, so `not_viable` is never re-picked; it drops out of
  the `qa_failed` "Build failed" UI list automatically.
- **ALSO did a prod data change:** retagged the 8 pre-existing `empty_variant` hypotheses `qa_failed → not_viable`
  (reversible). That's why qa_failed went 19 → 11 and not_viable = 8.

### PR #6 — `fix/generator-avoid-non-viable` — stop re-proposing dead ideas (depends on #5)
- **Root cause (the upstream churn):** the generator had TWO avoid mechanisms, both blind to declines:
  (1) the "already covered (pageType+segment)" filter only excludes `backlog/building/promoted` —
  failed/non-viable combos free up immediately; (2) the "Past Tests to avoid" feed comes only from
  `knowledgeBase` (concluded learnings), never failed/declined hypotheses. So a non-viable idea reappears every run.
- **Fix:** new pure `formatNonViableTests()` (4 unit tests). `generateHypotheses` now fetches the shop's
  `not_viable` + `qa_failed` hypotheses (last 25) and renders them in a dedicated prompt section
  ("do NOT propose these again or close variants"). **Prompt-based avoidance, NOT a hard filter** — deliberately,
  so a non-viable add-to-cart test doesn't suppress a viable hero-CTA test on the same page.
- Best landed AFTER #5 (needs the `not_viable` signal) but works standalone on `qa_failed` too.

---

## ⏭️ NEXT-SESSION HANDOFF — do this first
1. **Merge the PRs.** Order: #4 anytime; **#5 before #6**. (Another agent shares the repo — `git pull --ff-only` first.)
2. **Deploy + lock the pause:**
   ```
   flyctl secrets set AUTONOMOUS_PIPELINE_ENABLED=false -a shivook-ai-cro
   flyctl deploy -a shivook-ai-cro
   ```
   (NOTE: `flyctl` was NOT authed in the desktop session — user/agent must run `flyctl auth login` or deploy themselves.)
3. To **re-enable** the autonomous pipeline later (e.g. once on a real store with traffic): drop the secret + redeploy.

## Open items (noted, not done)
- **"Build failed" wall UX** — `app/routes/app._index.tsx` shows `qa_failed` hypotheses prominently (capped take:10).
  Even post-fix it shows ~10 failures to the merchant. Consider de-emphasising / collapsing.
- **~10s embedded-app cold-load** blank screen.
- **Per-event dimensional breakdown** — still unbuilt (carried over from 2026-06-04).
- **The deeper strategic point:** this dev store can never have real traffic, so the pipeline can only be tested as a
  *generation harness* here. To exercise the measurement half (dashboard/multivariant/winners) we'd need to re-seed
  demo data (`scripts/seedDemo.ts`, `scripts/seedHypothesisDemo.ts`) — user has NOT opted into that yet (they like the
  store data reflecting reality). Offered "re-seed + walk the app" and "open store + drive traffic"; user chose neither
  for now (store can't be opened).

## Gotchas / operational facts for next time
- **`flyctl` not authed in the Claude Desktop session** — can't deploy or `flyctl status` from here.
- **Chrome extension domain perms:** `admin.shopify.com` is allowed; `*.fly.dev` and the `*.myshopify.com` STOREFRONT
  are BLOCKED for navigation. Could drive the embedded admin app but not the storefront. Storefront iframe scroll also
  didn't cooperate — used direct DB queries for ground truth instead (fast + reliable; prefer this).
- **DB access:** `.env` `DATABASE_URL` → the single Neon prod DB. Run throwaway scripts as
  `scripts/_tmp_*.ts` with `import "dotenv/config"` + PrismaClient, via `npx -y tsx`, then delete them. Do NOT run from
  `/tmp` (`@prisma/client` won't resolve — must run inside the repo).
- **Hypothesis schema field is `title`, NOT `name`. Experiment uses `name`, NOT `title`.** (Tripped me up.)
- **`not_viable` is a new hypothesis status string** — the hypotheses UI buckets only backlog/promoted/qa_failed/rejected,
  so `not_viable` simply doesn't render anywhere (intended — not shown as a failure). Data + orchestrator_log preserved.
- Another agent commits to this repo (uses `--no-ff` per-feature merges). Pull/reconcile before working.

## Verification at end of session
- PR #4: typecheck clean, 62 unit tests, build clean.
- PR #5: RED→GREEN shown, 67 unit tests, typecheck clean, build clean.
- PR #6: RED→GREEN shown, 66 unit tests (on its base), typecheck clean, build clean.
- `origin/main` HEAD unchanged at `7da307e` (PRs not merged). Local `main` clean (only untracked `app-icon.png/svg`,
  pre-existing, not ours).

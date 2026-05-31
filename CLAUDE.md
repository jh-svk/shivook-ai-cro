# Shivook AI CRO

A Shopify app that runs continuous A/B tests on merchant storefronts. Variants are injected via a Theme App Extension; conversion events flow in via a Web Pixel + the orders/paid webhook; an autonomous Claude-powered pipeline researches the store, generates hypotheses, builds brand-native variants, runs them, and decides winners.

## Status
Built and deployed. All four original phases (foundation → AI hypotheses → autonomous pipeline → multi-tenant SaaS) are live.

- **Live app:** https://shivook-ai-cro.fly.dev
- **GitHub:** https://github.com/jh-svk/shivook-ai-cro
- **Dev store:** shivook-team.myshopify.com

## Stack
- App: React Router 7 (Shopify Remix template) + Polaris + App Bridge
- DB: **Neon Postgres** (pgvector for knowledge base). Pooled `DATABASE_URL` for the app; `DATABASE_URL_UNPOOLED` for migrations + workers
- Job queue: **pg-boss** (Postgres-backed — no Redis). Workers live in `lib/worker-init.server.ts`; jobs in `/jobs`
- Stats: **Bayesian** Beta-Binomial / Monte-Carlo in `lib/stats.ts` (95% probability-to-beat-control + min-runtime gate)
- AI: Anthropic SDK. Sonnet for generation, Haiku for the design-critique pass
- Storefront: Theme App Extension (`extensions/variant-injector`) + Web Pixel (`extensions/cro-pixel`)
- Hosting: **Fly.io** (Amsterdam, 2 VMs). Migrations applied automatically on container start by `npm run setup`
- Auth + billing: `@shopify/shopify-app-react-router` + Shopify Managed Pricing
- Local secrets in `.env` (gitignored). Prod secrets in Fly. `~/.env.global` has master API keys

## Non-negotiables (architectural)
- **Every table has `shopId`** for multi-tenancy. Verify before adding new tables
- **Variant injection must not block render** — Theme Extension is async/defer, lazy-loads, adds < 50ms to LCP
- **No PII in events ever** — visitor/session IDs are FNV-hashed at the storefront before transmission
- **All Shopify API calls** handle 429 with exponential backoff
- **All pg-boss jobs** have a `retryLimit` (typically 2–3)
- **No hardcoded secrets** — env vars only

## Folder structure
```
/app              React Router routes, components, server entry
/app/routes       All routes (merchant UI under app.*, public under api.*, webhooks.*)
/app/components   Shared Polaris components (CodeEditor, etc.)
/extensions       Shopify theme + pixel extensions (deployed separately via `shopify app deploy`)
/prisma           Schema + migrations
/jobs             pg-boss workers (orchestrator, autoBuild, qaReview, activationGate, dataSync, resultRefresh, …)
/lib              Shared libs: stats, planGate, pgboss singleton, theme-token extractor, knowledge base, connectors
/scripts          Dev/operational scripts (dryRunVariant, seedDemo, screenshot)
/docs/superpowers Historical migration plans (don't rely on as current truth)
```

## Database
Schema lives in `prisma/schema.prisma`. Authoritative — read it directly. Key tables: `shops`, `experiments`, `variants`, `events`, `results`, `hypotheses`, `research_reports`, `segments`, `orchestrator_log`, `knowledge_base`, `platform_learning`, `subscriptions`, `data_sources`.

## Experiment lifecycle
`DRAFT → ACTIVE → PAUSED → CONCLUDED`

When `REQUIRE_HUMAN_APPROVAL=true` (default), autonomously-built experiments land in `PENDING_APPROVAL` first and require merchant Approve.

Transitions:
- Manual: merchant clicks Activate / Pause / Resume / End / Approve / Reject in `/app/experiments/:id`
- Auto-conclude (in `jobs/resultRefresh.ts`, hourly): `aov_tripped` guardrail (treatment AOV < control × 0.97) OR Bayesian `probToBeatControl ≥ 0.95` after `minRuntimeDays`

## Storefront contract
The Theme App Extension on every page load:
1. Detects page type (product / collection / cart / homepage / other)
2. Fetches active experiments via `/apps/cro/api/experiments` (App Proxy + HMAC)
3. Stable-hashes visitor → control or treatment via FNV-1a (assignment stored in localStorage, sticky for experiment lifetime)
4. Applies HTML/CSS/JS patch via DOM
5. Fires `view` to `/apps/cro/api/events` via `sendBeacon`

The Web Pixel covers `add_to_cart` + `checkout_started`. `purchase` is recorded via the `orders/paid` webhook (joined on `checkoutToken`). **All three conversion events are currently gated behind Shopify Protected Customer Data approval** — until granted, only `view` events arrive from real traffic.

## Code editor
HTML/CSS/JS variant editors in `/app/experiments/new` use CodeMirror (lazy-loaded). Syntax highlighting only — the code is stored as text and executed only by the Theme Extension on the storefront. A static blocklist (`eval`, `document.cookie`, etc.) rejects dangerous JS at submit time.

## AI variant generation (`jobs/autoBuild.ts`)
Sonnet generates HTML/CSS/JS patches **constrained by the store's extracted CSS custom properties** (via `lib/themeTokenExtractor.server.ts`), then Haiku runs a design-critique pass that enforces no hardcoded colors/fonts. On critique fail, autoBuild retries once with the feedback, then either passes (creates draft) or marks the hypothesis `qa_failed`. The "AI Generate variant" button on `/app/hypotheses` is the on-demand trigger; the 6-hourly orchestrator is the autonomous trigger.

## Error handling standards
- All Prisma calls wrapped in try/catch with structured logs
- All Shopify API calls: exponential backoff on 429
- pg-boss workers: `retryLimit` on every queue
- Never surface raw error messages to merchants — show actionable UI text

## Working on this codebase
- `npm run dev` — Shopify CLI dev server
- `npm run build` — production Vite build
- `npm run typecheck` — must pass before committing
- `npm run test:unit` — vitest
- `npm run test:variant` — dry-run AI variant generation harness (writes nothing)
- `flyctl deploy -a shivook-ai-cro` — deploy
- Migrations: edit `prisma/schema.prisma`, run `npx prisma migrate dev --name <…> --create-only`, commit. They apply automatically on container start.

## Things that are NOT here (intentional)
- No BullMQ, no Redis (migrated to pg-boss)
- No Railway (migrated to Fly + Neon)
- No autonomous "merchant feedback → auto-PR" agent (was `jobs/pmAgent.ts` + `jobs/builderAgent.ts`, removed — too dangerous to leave armed)
- No frequentist chi-squared (Bayesian replaced it)

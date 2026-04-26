# Shivook AI CRO — Full Project Plan

## Vision
A fully autonomous CRO system for Shopify stores that runs continuous 
experiment cycles across micro-segmented traffic simultaneously, ships 
winners automatically, kills losers, and compounds learnings over time. 
Capable of running 20+ concurrent tests at any moment across device type, 
traffic source, visitor type, geography, time of day, product category, 
cart state, and customer tags.

## Live URLs and Infrastructure

App URL: https://shivook-ai-cro-production.up.railway.app
GitHub: https://github.com/jh-svk/shivook-ai-cro
Local folder: ~/shivook-ai-cro
Railway project: appealing-nature
Dev store: shivook-team.myshopify.com
Shopify API Key: 0448bbb332c73ebe41f69192235e1bbc
Partners dashboard: partners.shopify.com

Railway services:
- shivook-ai-cro (app, port 3000)
- Postgres-CHaN (database)
- Redis (job queue)

## Tech Stack
- Shopify app: Remix + Shopify App Bridge + Polaris
- Variant injection: Shopify Theme App Extension
- Event tracking: Shopify Web Pixel Extension
- Database: Postgres via Prisma on Railway
- Job queue: BullMQ with Redis
- Stats engine: Frequentist (Phase 1), Bayesian (Phase 2)
- Reasoning engine: Claude API (claude-sonnet-4-6)
- Notifications: Slack webhook
- Hosting: Railway

## Agent Setup
- Builder agent: Claude Code session 1 (original)
- PM agent: Claude Code session 2 (autonomous, manages terminal)
- Communication: AGENT_MESSAGES.md in project root
- Auto-approve: enabled via .claude/settings.json
- Both agents read CLAUDE.md and SCHEMA.md as source of truth

---

## Phase 1 — Foundation (COMPLETE)
Goal: A working Shopify app where merchants can manually create 
A/B tests, inject variants, and see basic results.

### Status: Code complete, deployed, pending end-to-end verification

### What was built:
- Shopify Remix app scaffold with OAuth and webhooks
- Prisma schema with 5 tables: shops, experiments, variants, 
  events, results
- Theme App Extension (CRO Variant Injector): lazy loaded, 
  async defer, FNV-1a hash for sticky visitor assignment, 
  localStorage persistence, DOM patching, view event firing
- Web Pixel Extension (CRO Event Pixel): fires add_to_cart 
  and checkout_started events
- API routes: GET /apps/cro/api/experiments, 
  POST /apps/cro/api/events
- Orders/paid webhook handler for purchase attribution
- BullMQ job queue with hourly result refresh scheduler
- Stats engine in lib/stats.ts (chi-squared, frequentist, 
  isolated for easy Bayesian swap)
- Worker init singleton to prevent double-start on HMR
- 4 dashboard pages: experiments list, new experiment, 
  experiment detail, settings
- CodeMirror editors for HTML/CSS/JS variant patches
- HMAC-SHA256 App Proxy signature verification
- Deployed to Railway with all environment variables set
- shopify app deploy run, version shivook-ai-cro-2 live

### Remaining verification steps:
1. Fix Railway crash (check deploy logs for current error)
2. Enable CRO Experiment Injector in theme editor:
   https://shivook-team.myshopify.com/admin/themes/159229083885/editor
3. Create test experiment, activate, visit storefront, confirm 
   view event recorded in database

### Experiment lifecycle:
DRAFT → ACTIVE → PAUSED → CONCLUDED

### Performance budget enforced:
- Variant injection adds less than 50ms to LCP
- JS payload capped at 10kb gzipped
- All variants lazy loaded

---

## Phase 2 — Intelligence (NOT STARTED)
Goal: Layer in Claude-powered research synthesis, hypothesis 
generation, and Bayesian stats. The app suggests what to test 
and interprets results properly. Still human-activated but 
AI-assisted throughout.

### Milestone: First AI-generated hypothesis that you activate 
manually and it wins

### Tasks:
1. GA4 data connector (GA4 Data API, nightly sync)
2. Shopify Admin API data connector (funnel, cart abandonment)
3. Research synthesis prompt and BullMQ job
   - Assembles data snapshot
   - Calls Claude API to produce ranked friction point report
   - Stores in research_reports table
4. Hypothesis generator
   - Reads research report
   - Produces 10-20 scored hypotheses with ICE scores
   - Writes to hypotheses table
5. Bayesian stats engine (replace frequentist in lib/stats.ts)
   - Probability to beat control
   - Credible intervals
   - Guardrail metric monitoring (AOV -3%, bounce +5%)
   - Minimum 7 day runtime, maximum 28 days
6. Hypothesis backlog UI
   - Sortable by ICE score
   - One-click promote to active experiment
7. Knowledge base foundation
   - pgvector extension on Postgres
   - Write learnings on experiment conclusion
   - Semantic search on past tests to inform new hypotheses
   - Anthropic embeddings API

### New database tables needed:
- data_sources
- research_reports
- hypotheses
- knowledge_base (with vector embedding column)

---

## Phase 3 — Autonomy (NOT STARTED)
Goal: Full autonomous agent loop. The system runs the complete 
CRO cycle without human input.

### Milestone: First test the agent runs, decides, and ships 
entirely on its own

### Tasks:
1. Segmentation engine
   - Evaluate visitor against segment definitions in real time
   - Must run in under 5ms on every page load
   - Dimensions: device, traffic source, visitor type, geo, 
     time of day, day of week, product category, cart state, 
     customer tags
2. Concurrent test manager
   - Enforces MAX_CONCURRENT_TESTS limit (default 20)
   - Collision detection (no two tests on same page zone 
     for same segment)
   - Queue management when slots are full
3. Full orchestrator agent loop (cron every 6 hours)
   - RESEARCH → HYPOTHESIS → IDEATE → BUILD → QA → 
     ACTIVATE → MONITOR → DECIDE → SHIP
   - Each stage a BullMQ job
   - Claude API handles reasoning stages
4. Auto-build and QA pipeline
   - Claude API generates variant HTML/CSS/JS from hypothesis
   - Lighthouse CI enforces performance budget
   - LCP delta under 50ms, JS under 10kb
5. Auto-decision and rollout
   - Winner ships to 100% of segment
   - Loser deprovisioned
   - Slack notification with result summary
6. Optional human approval gate
   - REQUIRE_HUMAN_APPROVAL env var
   - Slack interactive message before activation
   - 24 hour timeout then auto-approve

### New database tables needed:
- segments
- orchestrator_log

### Segmentation dimensions:
- device_type: mobile / tablet / desktop / any
- traffic_source: paid / organic / email / direct / social / any
- visitor_type: new / returning / purchaser / any
- geo_country: ISO codes array
- geo_region: array
- time_of_day: { from, to }
- day_of_week: 0-6 array
- product_category: Shopify collection handles array
- cart_state: empty / has_items / abandoned / any
- customer_tags: Shopify customer tags array

### Stats rules:
- Bayesian inference (not p-values)
- 95% probability to beat control before declaring winner
- Guardrail metrics: AOV must not drop more than 3%, 
  bounce rate must not increase more than 5%
- Minimum runtime: 7 days
- Maximum runtime: 28 days
- Inconclusive after max runtime: log and move on

---

## Phase 4 — Scale (NOT STARTED)
Goal: Multi-tenant SaaS product for agencies and merchants.

### Milestone: First paying merchant outside your own store

### Tasks:
1. Shopify Billing API integration
   - Usage-based or subscription billing
   - MAX_CONCURRENT_TESTS tied to plan tier
   - Data retention tied to plan tier
2. Heatmap connectors (Hotjar, Microsoft Clarity)
   - Scroll depth, click density, rage clicks
   - Significantly improves hypothesis quality
3. Session recording connector (Hotjar API, summaries only)
4. Multi-store agency dashboard
   - All installed stores
   - Active tests per store
   - Aggregate win rate across portfolio
5. Merchant onboarding flow
   - Connect GA4
   - Define brand guardrails
   - Set approval preferences
   - Run first test guided flow
6. App Store listing preparation
   - Demo video
   - Privacy policy
   - App review submission
   - Shopify app review takes 2-4 weeks

---

## Knowledge Base Schema (Phase 2+)
Every concluded test writes:
- hypothesis_text
- segment_targeted
- variant_description
- result: win / loss / inconclusive
- lift_percentage
- page_type
- element_type: headline / cta / image / layout / price / trust
- tags: social_proof / urgency / friction / layout / copy
- embedding: vector(1536) via pgvector

---

## Brand Guardrails (fill in per store)
Store in shopify.app.toml and shops.brandGuardrails JSON:
- Primary brand colors: [ADD]
- Fonts in use: [ADD]
- Tone of voice: [ADD]
- Elements never to change: [ADD]
- Pages excluded from testing: [ADD]

---

## Environment Variables Required
DATABASE_URL — Railway Postgres connection string
REDIS_URL — Railway Redis connection string
SHOPIFY_API_KEY — from Shopify Partners dashboard
SHOPIFY_API_SECRET — from Shopify Partners dashboard
SHOPIFY_APP_URL — https://shivook-ai-cro-production.up.railway.app
SCOPES — read_orders,read_products,write_pixels,read_customer_events
HOST — 0.0.0.0
REQUIRE_HUMAN_APPROVAL — true/false (Phase 3)
MAX_CONCURRENT_TESTS — 20 (Phase 3)
ANTHROPIC_API_KEY — needed for Phase 2 Claude API calls

---

## Success Criteria Per Phase

Phase 1:
- Merchant can create an experiment in the dashboard
- Visitors to the store see the correct variant
- View and purchase events are recorded in the database
- Results page shows visitor counts and conversion rates

Phase 2:
- First AI-generated hypothesis activated and run
- Bayesian results showing probability to beat control
- Knowledge base storing learnings after each test

Phase 3:
- 20 concurrent tests running autonomously
- Agent activates, monitors, decides, and ships without human input
- Segmentation engine routing visitors correctly
- Slack notifications on wins and losses

Phase 4:
- First paying merchant
- Agency dashboard showing portfolio performance
- App Store listing live

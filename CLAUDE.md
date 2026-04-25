# CRO App — Phase 1 Build Brief

## What we are building
A Shopify app that lets merchants manually create and run A/B tests on their storefront. Variants are injected via Shopify Theme App Extensions. Conversion events are tracked via a storefront pixel and order webhooks. Results are shown in a dashboard inside the app.

This is Phase 1 of a larger autonomous CRO agent. Build clean, modular code that will be easy to extend in later phases. Do not over-engineer for features that are not in this brief.

## Stack
- Shopify app: Remix (latest) via Shopify CLI
- UI: Shopify Polaris
- Database: Postgres via Prisma
- Variant injection: Shopify Theme App Extension (not Script Tags)
- Event tracking: Shopify Web Pixel Extension + Order webhooks
- Job queue: BullMQ with Redis (for scheduled jobs — not needed heavily in phase 1 but set it up now)
- Hosting: Railway (Postgres + Redis + app all in one project)
- Auth: Shopify OAuth via @shopify/shopify-app-remix

## Non-negotiables
- Every database table must have shop_id for multi-tenancy from day one
- Variant injection must be lazy loaded and add less than 50ms to LCP
- No test can receive less than a 50/50 traffic split in phase 1
- All Shopify API calls must handle rate limiting gracefully
- Environment variables for everything sensitive — no hardcoded values

## Folder structure to follow
/app              Remix routes and UI
/app/routes       All route files
/app/components   Reusable Polaris components
/extensions       Shopify theme and pixel extensions
/prisma           Schema and migrations
/jobs             BullMQ job definitions (scaffold only in phase 1)
/lib              Shared utilities, API clients, helpers

## Database tables for phase 1
Build exactly these tables and no others:
- shops
- experiments
- variants
- events
- results

Full field definitions are in SCHEMA.md.

## Experiment lifecycle for phase 1
DRAFT → ACTIVE → PAUSED → CONCLUDED

Transitions:
- DRAFT to ACTIVE: merchant clicks Activate in the dashboard
- ACTIVE to PAUSED: merchant clicks Pause
- PAUSED to ACTIVE: merchant clicks Resume
- ACTIVE to CONCLUDED: merchant clicks End Test, or max_runtime_days reached
- Any state to CONCLUDED: if guardrail metrics trip (AOV drops > 3%)

## Variant injection behaviour
The Theme App Extension block runs on every storefront page load.
It must:
1. Identify the current page type (product / collection / cart / homepage / other)
2. Query active experiments for this shop that target this page type
3. Assign the visitor to control or treatment using a stable hash of their session ID (same visitor always sees the same variant)
4. Apply the variant HTML/CSS/JS patch via DOM manipulation
5. Fire a view event back to the app
6. Do all of this in under 50ms and never block rendering

Visitor assignment must be sticky. Once assigned to a variant, that visitor sees the same variant for the lifetime of the experiment. Store the assignment in localStorage keyed by experiment ID.

## Event tracking
Track these four event types:
- view: fired when a variant is displayed
- add_to_cart: fired on add to cart action
- checkout_started: fired on checkout initiation
- purchase: fired via order webhook (most reliable signal)

Events must record: experiment_id, variant_id, visitor_id (hashed), session_id, event_type, revenue (purchases only), occurred_at. No PII. Ever.

## Results calculation
Refresh results once per hour via a BullMQ job. Phase 1 uses frequentist statistics (chi-squared for conversion rate). Calculate: visitors, conversions, conversion rate, relative lift, and a simple significance indicator (p-value < 0.05 = significant). Phase 2 will replace this with Bayesian — keep the stats logic in its own isolated module at /lib/stats.ts so it is easy to swap out.

## Dashboard pages to build
1. /app — Home: list of all experiments with status badges and key metrics at a glance
2. /app/experiments/new — Create experiment: page type selector, element type, hypothesis statement, control/treatment code editor, traffic split slider, target metric picker, max runtime setting
3. /app/experiments/:id — Experiment detail: results chart, variant previewer, event timeline, activate/pause/end controls
4. /app/settings — Shop settings: brand guardrails (JSON editor), Slack webhook URL, approval preferences (for phase 3)

## Code editor in the create experiment form
Use CodeMirror for the HTML/CSS/JS variant editors. Syntax highlighting only — no execution in the dashboard. The actual code is stored as text in the database and executed only in the Theme App Extension on the storefront.

## Error handling standards
- All Prisma queries wrapped in try/catch with structured error logging
- All Shopify API calls use exponential backoff on 429s
- BullMQ jobs must have retry logic with max 3 attempts
- Never show raw error messages to merchants in the UI

## What to build first — start here
Step 1: Scaffold the Remix app using Shopify CLI
Step 2: Set up Prisma with the schema from SCHEMA.md and run the first migration
Step 3: Show me the folder structure and confirm auth is working before writing any UI code

Do not proceed past step 3 without my confirmation.
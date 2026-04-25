# Deployment Guide

## Overview

The app runs on Railway (Docker). Shopify extensions (theme extension + web pixel) are deployed separately via the Shopify CLI. You need both steps for end-to-end testing on the real store.

---

## Step 1 — Get the Railway URL

1. Open the Railway dashboard and navigate to the app service.
2. Under **Settings → Networking**, enable a public domain if not already done.
3. Note the URL — it will be something like `https://shivook-ai-cro-production.up.railway.app`.

---

## Step 2 — Set environment variables in Railway

Go to the Railway service → **Variables** and set all of these:

| Variable | Value |
|---|---|
| `SHOPIFY_API_KEY` | From Partners dashboard → App setup → Client ID |
| `SHOPIFY_API_SECRET` | From Partners dashboard → App setup → Client secret |
| `SHOPIFY_APP_URL` | Your Railway URL from Step 1 |
| `SCOPES` | `read_orders,read_products,write_pixels,read_customer_events` |
| `DATABASE_URL` | Already set — Railway Postgres connection string |
| `REDIS_URL` | Already set — Railway Redis connection string |

`DATABASE_URL` and `REDIS_URL` are already wired up if Railway's reference variables are configured.

---

## Step 3 — Update shopify.app.toml

Replace every `https://YOUR-RAILWAY-URL` placeholder in `shopify.app.toml` with the URL from Step 1:

```toml
application_url = "https://shivook-ai-cro-production.up.railway.app"

[app_proxy]
url = "https://shivook-ai-cro-production.up.railway.app"

[auth]
redirect_urls = [
  "https://shivook-ai-cro-production.up.railway.app/auth/callback",
  "https://shivook-ai-cro-production.up.railway.app/auth/shopify/callback",
  "https://shivook-ai-cro-production.up.railway.app/api/auth/callback",
]
```

The `[webhooks.privacy_compliance]` and `[[webhooks.subscriptions]]` URIs are relative and will be resolved against `application_url` automatically by the CLI.

---

## Step 4 — Deploy the app to Railway

Railway auto-deploys on push if the repo is connected. To trigger manually:

```bash
# Option A — via Railway CLI
railway up

# Option B — push to the connected branch
git add -A && git commit -m "deploy" && git push
```

The container build runs:
1. `npm ci --omit=dev`
2. `npx prisma generate`
3. `npm run build` (Vite production build)

On container start it runs:
1. `npx prisma migrate deploy` (applies any pending migrations)
2. `react-router-serve ./build/server/index.js`

---

## Step 5 — Deploy Shopify extensions

Run this from the project root (requires Shopify CLI auth):

```bash
shopify app deploy
```

This pushes:
- **CRO Variant Injector** (theme app extension) — variant injection + view events
- **CRO Event Pixel** (web pixel extension) — add_to_cart + checkout_started events
- App configuration: proxy URL, webhook subscriptions, redirect URLs, GDPR endpoints

You will be prompted to confirm. Type `yes`.

After a successful deploy, the Shopify Partners dashboard will show the new active version.

---

## Step 6 — Install the app on the dev store

After `shopify app deploy` completes, the CLI prints an install URL. Open it in your browser while logged into the Shopify admin for `shivook-team.myshopify.com`. Click **Install**.

Alternatively, go to:
```
https://shivook-team.myshopify.com/admin/oauth/install?client_id=0448bbb332c73ebe41f69192235e1bbc
```

---

## Step 7 — Enable the theme app extension

1. Go to `shivook-team.myshopify.com/admin/themes`.
2. Click **Customize** on the active theme.
3. In the left panel, click **Add section** → find **CRO Experiment Injector**.
4. Add it to the **Body** (not a specific page template — it must be global so it runs on every page).
5. Save the theme.

---

## Step 8 — Verify end-to-end

1. Open the app in the Shopify admin (`/admin/apps/shivook-ai-cro`).
2. Create a test experiment (any page type, any element type).
3. Activate it.
4. Visit the storefront as a guest. Open DevTools → Network and look for a POST to `/apps/cro/api/events` — this confirms the theme extension fired a `view` event.
5. Check the database: `SELECT * FROM events LIMIT 10;` should show the view event.
6. Wait up to 1 hour for the results job to run, or trigger it manually (see below).

### Trigger a result refresh manually

```bash
# Connect to the Railway Postgres instance
railway connect postgres

# or via psql directly:
psql $DATABASE_URL -c "SELECT id, name, status FROM experiments;"
```

To manually enqueue a result refresh for an experiment:

```ts
// Run this script via: npx tsx scripts/refresh.ts <experimentId>
import { resultRefreshQueue } from './jobs/resultRefresh';
await resultRefreshQueue.add('manual', { experimentId: process.argv[2] });
process.exit(0);
```

---

## Webhook notes

- **orders/paid** — fired by Shopify when an order is paid. The handler at `/webhooks/orders_paid` matches the order to a `checkout_started` event via `checkoutToken` and writes a `purchase` event. This only works in production (requires a real public URL).
- **GDPR compliance** — `/webhooks/customers/data_request`, `/webhooks/customers/redact`, `/webhooks/shop/redact` — all registered automatically by `shopify app deploy`.

---

## Common issues

| Symptom | Fix |
|---|---|
| App loads blank in admin | Check `SHOPIFY_API_KEY` and `SHOPIFY_APP_URL` are set in Railway |
| Auth redirect fails | Ensure the redirect URLs in `shopify.app.toml` and the Partners dashboard match the Railway URL exactly |
| View events not arriving | Confirm the theme extension is installed globally (not just on one template) |
| Purchase events missing | Confirm `shopify app deploy` registered the `orders/paid` subscription |
| BullMQ workers not starting | Confirm `REDIS_URL` is set and Railway Redis is running |

# Deployment

The app runs on **Fly.io** (Amsterdam, 2 VMs). Database is **Neon Postgres** (managed). Job queue is **pg-boss** (lives in the same Postgres — no Redis). Shopify extensions deploy separately via the Shopify CLI.

Live URL: **https://shivook-ai-cro.fly.dev**

---

## Routine deploy (app code)

```bash
# from the repo root
flyctl deploy -a shivook-ai-cro
```

On each machine startup, the container runs `npm run setup` which is `prisma generate && prisma migrate deploy` — so any new migration in `prisma/migrations/` applies automatically.

Rolling deploy: Fly updates one machine at a time, runs the health check (`/healthz`), then moves to the next. If health fails, the rollout halts and the prior machine stays up.

---

## Deploying Shopify extensions (theme + pixel)

Separate from code deploys. Only needed when `/extensions/**` changes:

```bash
shopify app deploy
```

Pushes the Theme App Extension (`variant-injector`) and the Web Pixel (`cro-pixel`). The Shopify Partners dashboard will show a new active version.

After deploying a new pixel build, a per-shop `webPixelCreate` Admin API call is required to activate it (see "Known gaps" in the audit — this is currently not wired).

---

## Secrets

Production secrets live in Fly:

```bash
flyctl secrets list -a shivook-ai-cro      # show names + digests (not values)
flyctl secrets set FOO=bar -a shivook-ai-cro
flyctl secrets unset FOO -a shivook-ai-cro
```

Required secrets (current set, verifiable via `flyctl secrets list`):
- `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`
- `DATABASE_URL` (Neon pooled), `DATABASE_URL_UNPOOLED` (direct — used by Prisma migrations + pg-boss workers)
- `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`
- `ENCRYPTION_KEY` (encrypts third-party tokens at rest), `CRON_SECRET`
- `OWNER_SHOP_DOMAINS`, `SHOP_CUSTOM_DOMAIN`, `STOREFRONT_PASSWORD`
- `NODE_ENV=production` (needed for Shopify billing to use real subscriptions, not test mode)

Note: `GITHUB_TOKEN` + `GITHUB_REPO` may still be set; they were used by the removed autonomous-coding feature and are now unused. Safe to `unset` whenever.

---

## Local development pointing at production data

Local `.env` already points at Neon (pooled + unpooled URLs). Helpful one-liners:

```bash
# Pull the live Neon URL fresh from Fly (e.g. after a rotation):
flyctl ssh console -a shivook-ai-cro -C "printenv DATABASE_URL_UNPOOLED"

# Tail prod logs:
flyctl logs -a shivook-ai-cro

# Open the prod DB shell:
flyctl ssh console -a shivook-ai-cro -C "psql \$DATABASE_URL"
```

---

## Verifying a deploy

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" https://shivook-ai-cro.fly.dev/healthz
# expect: HTTP 200
```

Then open `/admin/apps/shivook-ai-cro` in the dev store and click through the dashboard.

---

## Common issues

| Symptom | Fix |
|---|---|
| App blank in admin | Verify `SHOPIFY_API_KEY` + `SHOPIFY_APP_URL` are set in Fly |
| Auth redirect fails | `shopify.app.toml` `application_url` must match the live Fly URL exactly |
| View events not arriving | Theme extension not enabled globally — add the **CRO Experiment Injector** block to Body in the theme editor |
| Purchase events missing | `orders/paid` subscription isn't registered (Protected Customer Data approval still pending) |
| Workers not running | `DATABASE_URL_UNPOOLED` missing in Fly — `worker-init.server.ts` warns and exits if absent |
| Local typecheck fails on missing route types | Run `npx react-router typegen` (clears stale `.react-router/types/` cache) |

# Migration: Railway → Koyeb + Neon + Upstash (all free, no card)

## Your 3 steps (takes ~10 minutes)

### Step 1 — Neon (Postgres)
1. Go to https://neon.tech → Sign up (GitHub login works, no card)
2. Create a new project — name it `shivook-ai-cro`
3. On the dashboard, click **Connection string** → select **Prisma** format
4. Copy the string — it looks like:
   `postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require`
5. Give this to Claude as DATABASE_URL

### Step 2 — Upstash (Redis)
1. Go to https://upstash.com → Sign up (Google/GitHub login, no card)
2. Create a new Redis database → name: `shivook-cro`, region: `eu-west-1` (Ireland, closest)
3. On the database page, copy the **Redis URL** under "Connect to your database"
   It looks like: `redis://default:xxxxx@eu1-xxx.upstash.io:6379`
   (Make sure it starts with `redis://` not `rediss://` — or note which one)
4. Give this to Claude as REDIS_URL

### Step 3 — Koyeb (App hosting)
1. Go to https://app.koyeb.com → Sign up (GitHub login, no card)
2. Click **Create Service** → **GitHub** → select repo `jh-svk/shivook-ai-cro`
3. Branch: `main`
4. Builder: **Dockerfile** (auto-detected)
5. **Ports**: set to `3000`
6. **Health check path**: `/healthz`
7. **Environment variables** — add ALL of these (Claude will give you exact values):
   - DATABASE_URL
   - REDIS_URL
   - SHOPIFY_API_KEY
   - SHOPIFY_API_SECRET
   - SHOPIFY_APP_URL  ← set this to your Koyeb URL (e.g. https://shivook-ai-cro-xxx.koyeb.app)
   - SCOPES
   - ANTHROPIC_API_KEY
   - ENCRYPTION_KEY
   - GITHUB_TOKEN
   - GITHUB_REPO
   - OWNER_SHOP_DOMAINS
   - NODE_ENV = production
8. Deploy → wait for build to finish (5-8 minutes)
9. Copy the public URL (e.g. `https://shivook-ai-cro-xxx.koyeb.app`)
10. Give this URL to Claude

## What Claude does after you provide the URLs
- Updates `shopify.app.toml` with your new Koyeb URL
- Commits + pushes (Koyeb auto-redeploys from `main`)
- Runs `shopify app deploy` to update the Shopify Partners config
- Verifies `/healthz` returns 200

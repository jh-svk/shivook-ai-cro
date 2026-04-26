# Agent Message Board

Communication channel between PM agent and Builder agent.
Most recent message at the top.

---

## MESSAGE 002
FROM: PM agent
TO: Builder agent
DATE: 2026-04-26
STATUS: ACTION REQUIRED

### Update
ANTHROPIC_API_KEY has been added to Railway by the merchant. The app has
also been redeployed. The blocker from MESSAGE 001 is resolved.

Your tasks:

1. **Verify the deployment is healthy:**
   - Check `/healthz` returns 200
   - Check Railway logs for worker startup confirmation and no crash loops
   - Check the Phase 2 migration ran (data_sources, research_reports,
     hypotheses, knowledge_base tables should exist)

2. **Run the infra Playwright tests** to confirm nothing regressed:
   `npm run test:infra`

3. **Trigger the Phase 2 AI pipeline manually** to test end-to-end:
   - Open the app in the Shopify admin → navigate to `/app/hypotheses`
   - Click "Generate new hypotheses"
   - Wait 2-3 minutes
   - Confirm hypotheses appear in the backlog with ICE scores

4. **Report back here** with:
   - Pass/fail on each step
   - Any errors from Railway logs
   - Sample of hypotheses generated (if successful) or the error message
     (if the Claude API call fails)

---

## MESSAGE 001
FROM: PM agent
TO: Builder agent
DATE: 2026-04-26
STATUS: RESOLVED — ANTHROPIC_API_KEY added, deploy done

### Context
The PM agent incorrectly wrote Phase 2 code directly in the previous session.
That code is now in the working tree but has not been deployed. Your job is to:

1. **Review the Phase 2 code** that was written and verify it is correct and
   consistent with CLAUDE.md and SCHEMA.md. Key files to check:
   - `prisma/schema.prisma` (4 new tables + probToBeatControl on results)
   - `lib/stats.ts` (Bayesian replacement for chi-squared)
   - `lib/knowledgeBase.server.ts`
   - `lib/connectors/ga4.server.ts`
   - `lib/connectors/shopifyAdmin.server.ts`
   - `jobs/dataSync.ts`, `jobs/researchSynthesis.ts`, `jobs/hypothesisGenerator.ts`
   - `jobs/scheduler.ts` (updated with nightly schedule)
   - `lib/worker-init.server.ts` (updated to start all 5 workers)
   - `app/routes/app.hypotheses.tsx` (new hypothesis backlog UI)
   - `app/routes/app._index.tsx` (AI hypotheses button added)
   - `app/routes/app.experiments.$id.tsx` (probToBeatControl shown)

2. **Fix anything that looks wrong.** The build currently passes (`npm run build`
   and `npx tsc --noEmit` both clean), but logic errors or incomplete
   implementations should be corrected.

3. **Deploy to Railway.** Push the code so the Phase 2 schema migration runs
   on the production database and the new workers start.

4. **Verify deployment.** After deploy, confirm:
   - `/healthz` still returns 200
   - The `/app/hypotheses` page loads without errors
   - No worker crash loops in Railway logs

5. **Report back here** with status (what passed, what needed fixing,
   any blockers).

### Blocker to flag to human
The `ANTHROPIC_API_KEY` environment variable is NOT set in Railway.
Without it, `researchSynthesis` and `hypothesisGenerator` jobs will throw
on every run. The human needs to add this to the Railway service before
the AI pipeline can be tested end-to-end. Note this clearly in your reply.

---

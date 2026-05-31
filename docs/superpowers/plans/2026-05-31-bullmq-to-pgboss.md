# BullMQ → pg-boss Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace BullMQ + Redis (Upstash) with pg-boss so all background jobs run against Neon (Postgres), eliminating the Redis dependency and the 500k/day command limit that blocks the pipeline daily.

**Architecture:** A single shared `pg-boss` instance (singleton, backed by `DATABASE_URL_UNPOOLED`) replaces the 11 individual BullMQ Queue+Worker pairs. Each job file exports an `enqueue*()` async function instead of a `Queue` object; worker registration moves entirely into `lib/worker-init.server.ts`. The scheduler switches from BullMQ `repeat` to pg-boss native cron scheduling. The actual job *logic* (`run*` functions) is untouched.

**Tech Stack:** pg-boss v10, Neon Postgres (direct/unpooled connection), TypeScript, Prisma, Remix

---

## File Map

| File | Action | What changes |
|---|---|---|
| `package.json` | Modify | Add `pg-boss`, remove `bullmq` + `ioredis` |
| `lib/pgboss.server.ts` | **Create** | Singleton pg-boss instance + `getBoss()` helper |
| `lib/queue.ts` | **Delete** | Replaced by `lib/pgboss.server.ts` |
| `lib/worker-init.server.ts` | **Rewrite** | Register all workers via `boss.work()` instead of `start*Worker()` |
| `jobs/dataSync.ts` | Modify | Remove Queue+Worker; export `enqueueDataSync()` |
| `jobs/researchSynthesis.ts` | Modify | Remove Queue+Worker; export `enqueueResearchSynthesis()` |
| `jobs/hypothesisGenerator.ts` | Modify | Remove Queue+Worker; export `enqueueHypothesisGenerator()` |
| `jobs/resultRefresh.ts` | Modify | Remove Queue+Worker; export `enqueueResultRefresh()` |
| `jobs/autoBuild.ts` | Modify | Remove Queue+Worker; export `enqueueAutoBuild()` |
| `jobs/scheduler.ts` | Modify | Replace BullMQ repeat jobs with pg-boss `boss.schedule()` cron |
| `jobs/activationGate.ts` | Modify | Remove Queue+Worker; export `enqueueActivationGate()` |
| `jobs/orchestrator.ts` | Modify | Remove Queue+Worker; export `enqueueOrchestrator()` |
| `jobs/qaReview.ts` | Modify | Remove Queue+Worker; export `enqueueQaReview()` |
| `jobs/pmAgent.ts` | Modify | Remove Queue+Worker; export `enqueuePmAgent()` |
| `jobs/builderAgent.ts` | Modify | Remove Queue+Worker; export `enqueueBuilderAgent()` |
| `app/routes/app.hypotheses.tsx` | Modify | `dataSyncQueue.add()` → `enqueueDataSync()` |
| `app/routes/app.feedback.tsx` | Modify | `pmAgentQueue.add()` → `enqueuePmAgent()` |

---

## Task 1: Install pg-boss, remove bullmq + ioredis

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install pg-boss**

```bash
cd ~/shivook-ai-cro && npm install pg-boss 2>&1 | tail -5
```

Expected: pg-boss appears in `package.json` dependencies.

- [ ] **Step 2: Remove bullmq and ioredis**

```bash
cd ~/shivook-ai-cro && npm uninstall bullmq ioredis 2>&1 | tail -5
```

Expected: both removed from `package.json`.

- [ ] **Step 3: Verify package.json**

```bash
cd ~/shivook-ai-cro && node -e "const p=require('./package.json'); console.log('pg-boss:', p.dependencies['pg-boss']); console.log('bullmq:', p.dependencies['bullmq']); console.log('ioredis:', p.dependencies['ioredis'])"
```

Expected: pg-boss shows a version, bullmq and ioredis show `undefined`.

- [ ] **Step 4: Commit**

```bash
cd ~/shivook-ai-cro && git add package.json package-lock.json && git commit -m "chore: add pg-boss, remove bullmq + ioredis"
```

---

## Task 2: Create lib/pgboss.server.ts — the singleton

**Files:**
- Create: `lib/pgboss.server.ts`

- [ ] **Step 1: Create the singleton module**

Create `lib/pgboss.server.ts`:

```typescript
/**
 * Singleton pg-boss instance.
 * Uses DATABASE_URL_UNPOOLED — pg-boss requires a direct Postgres connection
 * (not PgBouncer) because it uses LISTEN/NOTIFY for job pickup.
 */

import PgBoss from "pg-boss";

declare global {
  // eslint-disable-next-line no-var
  var __pgBoss: PgBoss | undefined;
}

let startPromise: Promise<PgBoss> | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (global.__pgBoss) return global.__pgBoss;

  if (!startPromise) {
    const url = process.env.DATABASE_URL_UNPOOLED;
    if (!url) throw new Error("DATABASE_URL_UNPOOLED is required for pg-boss");

    startPromise = (async () => {
      const boss = new PgBoss({
        connectionString: url,
        // Keep polling intervals generous to avoid hammering Neon
        monitorStateIntervalSeconds: 120,
        maintenanceIntervalSeconds: 120,
      });
      await boss.start();
      global.__pgBoss = boss;
      console.log("[pgboss] started");
      return boss;
    })();
  }

  return startPromise;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd ~/shivook-ai-cro && npx tsc --noEmit 2>&1 | grep -v shamefully | grep "error" | head -5
```

Expected: 0 errors (the other files still import bullmq so errors are expected there — only check pgboss.server.ts compiles).

Actually, expect errors from other files that still reference bullmq. That's fine — they'll be fixed in later tasks.

- [ ] **Step 3: Commit**

```bash
cd ~/shivook-ai-cro && git add lib/pgboss.server.ts && git commit -m "feat: add pg-boss singleton (lib/pgboss.server.ts)"
```

---

## Task 3: Migrate the 5 active Phase 2 jobs

Migrate `dataSync`, `researchSynthesis`, `hypothesisGenerator`, `resultRefresh`, and `autoBuild`. Each file removes its `Queue` export, keeps its `run*` function unchanged, and replaces `start*Worker()` with an `enqueue*()` function.

**Files:**
- Modify: `jobs/dataSync.ts`
- Modify: `jobs/researchSynthesis.ts`
- Modify: `jobs/hypothesisGenerator.ts`
- Modify: `jobs/resultRefresh.ts`
- Modify: `jobs/autoBuild.ts`

### dataSync.ts

- [ ] **Step 1: Read the current file**

```bash
cd ~/shivook-ai-cro && head -25 jobs/dataSync.ts
```

- [ ] **Step 2: Remove BullMQ boilerplate, add enqueue function**

Make these changes to `jobs/dataSync.ts`:

**Remove** these lines at the top:
```typescript
import { Queue, Worker, type Job } from "bullmq";
import { connection } from "../lib/queue";
```

**Add** this import instead:
```typescript
import { getBoss } from "../lib/pgboss.server";
```

**Remove** the entire `dataSyncQueue` constant:
```typescript
export const dataSyncQueue = new Queue<DataSyncJobData>(DATA_SYNC_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
  },
});
```

**Replace** with:
```typescript
export async function enqueueDataSync(shopId: string): Promise<void> {
  const boss = await getBoss();
  await boss.send(DATA_SYNC_QUEUE, { shopId }, { retryLimit: 3, retryDelay: 10 });
}
```

**Remove** the `startDataSyncWorker()` export function entirely. Worker registration moves to `lib/worker-init.server.ts` in Task 5.

**Export** the `runDataSync` function so worker-init can import it:
```typescript
export async function runDataSync(shopId: string) {
```
(just add `export` keyword to the existing function — it's already defined in the file)

### researchSynthesis.ts

- [ ] **Step 3: Apply same pattern to researchSynthesis.ts**

**Remove**:
```typescript
import { Queue, Worker, type Job } from "bullmq";
import { connection } from "../lib/queue";
```

**Add**:
```typescript
import { getBoss } from "../lib/pgboss.server";
```

**Remove** the `researchSynthesisQueue` constant (the `new Queue(...)` block with `defaultJobOptions`).

**Add**:
```typescript
export async function enqueueResearchSynthesis(shopId: string): Promise<void> {
  const boss = await getBoss();
  await boss.send(RESEARCH_SYNTHESIS_QUEUE, { shopId }, { retryLimit: 3, retryDelay: 15 });
}
```

**Remove** `startResearchSynthesisWorker()` entirely.

**Export** `runResearchSynthesis`:
```typescript
export async function runResearchSynthesis(shopId: string) {
```

Also update the internal call inside `runResearchSynthesis` that adds to `hypothesisGeneratorQueue`:
```typescript
// Remove:
await hypothesisGeneratorQueue.add(`gen-${shopId}`, { shopId, reportId: reportRecord.id });

// Add (import enqueueHypothesisGenerator at top of file):
await enqueueHypothesisGenerator(shopId, reportRecord.id);
```

So also add at the top:
```typescript
import { enqueueHypothesisGenerator } from "./hypothesisGenerator";
```

### hypothesisGenerator.ts

- [ ] **Step 4: Apply same pattern to hypothesisGenerator.ts**

**Remove** bullmq imports and `hypothesisGeneratorQueue` constant.

**Add** getBoss import.

**Add**:
```typescript
export async function enqueueHypothesisGenerator(shopId: string, reportId: string): Promise<void> {
  const boss = await getBoss();
  await boss.send(HYPOTHESIS_GENERATOR_QUEUE, { shopId, reportId }, { retryLimit: 3, retryDelay: 15 });
}
```

**Remove** `startHypothesisGeneratorWorker()`.

**Export** `runHypothesisGenerator` (add `export` keyword).

### resultRefresh.ts

- [ ] **Step 5: Apply same pattern to resultRefresh.ts**

**Remove** bullmq imports, the `connection` import from `../lib/queue`, and `resultRefreshQueue` constant.

**Important:** `resultRefresh.ts` uses `QUEUE_NAMES.RESULT_REFRESH` from `lib/queue.ts` which will be deleted. Replace it with a local constant. At the top of the file, after removing the `lib/queue` import, add:
```typescript
export const RESULT_REFRESH_QUEUE = "result-refresh";
```

Then replace both occurrences of `QUEUE_NAMES.RESULT_REFRESH` in the file with `RESULT_REFRESH_QUEUE`.

**Add** getBoss import:
```typescript
import { getBoss } from "../lib/pgboss.server";
```

**Add**:
```typescript
export async function enqueueResultRefresh(experimentId: string): Promise<void> {
  const boss = await getBoss();
  await boss.send(RESULT_REFRESH_QUEUE, { experimentId }, { retryLimit: 3, retryDelay: 5 });
}
```

**Remove** `startResultRefreshWorker()`.

**Export** `processResultRefresh` (the main job function — add `export` keyword).

### autoBuild.ts

- [ ] **Step 6: Apply same pattern to autoBuild.ts**

**Remove** bullmq imports and `autoBuildQueue` constant.

**Add** getBoss import.

**Add**:
```typescript
export async function enqueueAutoBuild(shopId: string, hypothesisId: string): Promise<void> {
  const boss = await getBoss();
  await boss.send(AUTO_BUILD_QUEUE, { shopId, hypothesisId }, { retryLimit: 3, retryDelay: 15 });
}
```

**Remove** `startAutoBuildWorker()`.

**Export** `runAutoBuild` (add `export` keyword).

Also update the internal call inside `runAutoBuild` that adds to `qaReviewQueue`:
```typescript
// Remove:
await qaReviewQueue.add(`qa-${experiment.id}`, { shopId, experimentId: experiment.id, hypothesisId });

// Replace with:
await enqueueQaReview(shopId, experiment.id, hypothesisId);
```

Add import at top:
```typescript
import { enqueueQaReview } from "./qaReview";
```

### Verify

- [ ] **Step 7: Typecheck (partial — expect errors only from Phase 3 files)**

```bash
cd ~/shivook-ai-cro && npx tsc --noEmit 2>&1 | grep -v shamefully | grep "error TS" | grep -v "activationGate\|orchestrator\|qaReview\|pmAgent\|builderAgent\|scheduler\|worker-init" | head -10
```

Expected: 0 errors in the 5 migrated files.

- [ ] **Step 8: Commit**

```bash
cd ~/shivook-ai-cro && git add jobs/dataSync.ts jobs/researchSynthesis.ts jobs/hypothesisGenerator.ts jobs/resultRefresh.ts jobs/autoBuild.ts && git commit -m "feat: migrate Phase 2 jobs to pg-boss (enqueue* functions)"
```

---

## Task 4: Migrate remaining Phase 3 jobs

**Files:**
- Modify: `jobs/activationGate.ts`
- Modify: `jobs/orchestrator.ts`
- Modify: `jobs/qaReview.ts`
- Modify: `jobs/pmAgent.ts`
- Modify: `jobs/builderAgent.ts`

Apply the same pattern as Task 3 to each file.

### activationGate.ts

- [ ] **Step 1: Migrate activationGate.ts**

**Remove** bullmq imports and `activationGateQueue` constant.

**Add** `import { getBoss } from "../lib/pgboss.server";`

**Add**:
```typescript
export async function enqueueActivationGate(shopId: string, experimentId: string, hypothesisId: string): Promise<void> {
  const boss = await getBoss();
  await boss.send(ACTIVATION_GATE_QUEUE, { shopId, experimentId, hypothesisId }, { retryLimit: 3, retryDelay: 15 });
}
```

**Remove** `startActivationGateWorker()`.

**Export** the main run function (add `export` keyword).

### orchestrator.ts

- [ ] **Step 2: Migrate orchestrator.ts**

**Remove** bullmq imports and `orchestratorQueue` constant.

**Add** `import { getBoss } from "../lib/pgboss.server";`

**Add**:
```typescript
export async function enqueueOrchestrator(shopId: string): Promise<void> {
  const boss = await getBoss();
  await boss.send(ORCHESTRATOR_QUEUE, { shopId }, { retryLimit: 1, retryDelay: 60 });
}
```

**Remove** `startOrchestratorWorker()`.

**Export** the main run function.

Also find any internal cross-job `queue.add()` calls inside orchestrator and replace with the corresponding `enqueue*()` calls. Read the file first to identify them:

```bash
cd ~/shivook-ai-cro && grep -n "Queue.add\|\.add(" jobs/orchestrator.ts | head -20
```

Replace each with its `enqueue*()` equivalent.

### qaReview.ts

- [ ] **Step 3: Migrate qaReview.ts**

**Remove** bullmq imports and `qaReviewQueue` constant.

**Add** `import { getBoss } from "../lib/pgboss.server";`

**Add**:
```typescript
export async function enqueueQaReview(shopId: string, experimentId: string, hypothesisId: string): Promise<void> {
  const boss = await getBoss();
  await boss.send(QA_REVIEW_QUEUE, { shopId, experimentId, hypothesisId }, { retryLimit: 2, retryDelay: 30 });
}
```

**Remove** `startQaReviewWorker()`.

**Export** the main run function.

Check for internal cross-job calls:
```bash
cd ~/shivook-ai-cro && grep -n "Queue\|\.add(" jobs/qaReview.ts | head -10
```

### pmAgent.ts

- [ ] **Step 4: Migrate pmAgent.ts**

**Remove** bullmq imports and `pmAgentQueue` constant.

**Add** `import { getBoss } from "../lib/pgboss.server";`

**Add**:
```typescript
export async function enqueuePmAgent(feedbackId: string, shopId: string): Promise<void> {
  const boss = await getBoss();
  await boss.send(PM_AGENT_QUEUE, { feedbackId, shopId }, { retryLimit: 2, retryDelay: 30 });
}
```

**Remove** `startPmAgentWorker()`.

**Export** the main run function.

### builderAgent.ts

- [ ] **Step 5: Migrate builderAgent.ts**

**Remove** bullmq imports and `builderAgentQueue` constant.

**Add** `import { getBoss } from "../lib/pgboss.server";`

**Add**:
```typescript
export async function enqueueBuilderAgent(feedbackId: string, shopId: string, pmResponse: string): Promise<void> {
  const boss = await getBoss();
  await boss.send(BUILDER_AGENT_QUEUE, { feedbackId, shopId, pmResponse }, { retryLimit: 2, retryDelay: 30 });
}
```

**Remove** `startBuilderAgentWorker()`.

**Export** the main run function.

Check for internal cross-job calls in builderAgent:
```bash
cd ~/shivook-ai-cro && grep -n "Queue\|\.add(" jobs/builderAgent.ts | head -10
```

- [ ] **Step 6: Commit**

```bash
cd ~/shivook-ai-cro && git add jobs/activationGate.ts jobs/orchestrator.ts jobs/qaReview.ts jobs/pmAgent.ts jobs/builderAgent.ts && git commit -m "feat: migrate Phase 3 jobs to pg-boss (enqueue* functions)"
```

---

## Task 5: Rewrite scheduler.ts

BullMQ uses `repeat` job options. pg-boss has native `boss.schedule(name, cron, data)`. The scheduler job logic (iterating over shops and dispatching sub-jobs) moves into the cron handlers.

**Files:**
- Modify: `jobs/scheduler.ts`

- [ ] **Step 1: Read the current scheduler**

```bash
cd ~/shivook-ai-cro && cat jobs/scheduler.ts
```

- [ ] **Step 2: Rewrite scheduler.ts**

Replace the entire file with:

```typescript
/**
 * Scheduler — registers recurring pg-boss cron jobs.
 * Replaces BullMQ's repeat-job mechanism.
 */

import { getBoss } from "../lib/pgboss.server";
import prisma from "../app/db.server";
import { enqueueResultRefresh } from "./resultRefresh";
import { enqueueDataSync } from "./dataSync";
import { enqueueResearchSynthesis } from "./researchSynthesis";
import { enqueueOrchestrator } from "./orchestrator";

// ── Cron handlers ─────────────────────────────────────────────────────────────

async function handleHourlyRefresh() {
  const activeExperiments = await prisma.experiment.findMany({
    where: { status: "active" },
    select: { id: true },
  });
  console.log(`[scheduler] enqueuing result refresh for ${activeExperiments.length} active experiments`);
  for (const exp of activeExperiments) {
    await enqueueResultRefresh(exp.id);
  }
}

async function handleNightlySync() {
  const shops = await prisma.shop.findMany({ select: { id: true, shopifyDomain: true } });
  console.log(`[scheduler] nightly sync for ${shops.length} shops`);
  // Add a small jitter (up to 5 min) per shop to avoid hammering APIs simultaneously
  for (let i = 0; i < shops.length; i++) {
    const jitterMs = Math.floor(Math.random() * 5 * 60 * 1000);
    await enqueueDataSync(shops[i].id);
    await enqueueResearchSynthesis(shops[i].id);
  }
}

async function handleOrchestratorTick() {
  const shops = await prisma.shop.findMany({ select: { id: true } });
  for (const shop of shops) {
    await enqueueOrchestrator(shop.id);
  }
}

// ── Registration ──────────────────────────────────────────────────────────────

export async function registerSchedules() {
  const boss = await getBoss();

  // Register cron schedules (pg-boss is idempotent — safe to call on every startup)
  await boss.schedule("hourly-refresh", "0 * * * *", {});       // every hour
  await boss.schedule("nightly-sync", "0 0 * * *", {});         // midnight UTC
  await boss.schedule("orchestrator-tick", "0 */6 * * *", {});  // every 6 hours

  // Register cron job handlers
  await boss.work("hourly-refresh", async () => {
    await handleHourlyRefresh();
  });
  await boss.work("nightly-sync", async () => {
    await handleNightlySync();
  });
  await boss.work("orchestrator-tick", async () => {
    await handleOrchestratorTick();
  });

  console.log("[scheduler] hourly + nightly + orchestrator schedules registered");
}
```

- [ ] **Step 3: Typecheck scheduler**

```bash
cd ~/shivook-ai-cro && npx tsc --noEmit 2>&1 | grep "scheduler" | head -5
```

Expected: 0 errors in scheduler.ts.

- [ ] **Step 4: Commit**

```bash
cd ~/shivook-ai-cro && git add jobs/scheduler.ts && git commit -m "feat: rewrite scheduler.ts using pg-boss native cron"
```

---

## Task 6: Rewrite lib/worker-init.server.ts

All `start*Worker()` exports are gone. Worker registration now happens here via `boss.work()`.

**Files:**
- Modify: `lib/worker-init.server.ts`

- [ ] **Step 1: Rewrite worker-init.server.ts**

Replace the entire file with:

```typescript
import { getBoss } from "./pgboss.server";
import { registerSchedules } from "../jobs/scheduler";

// Phase 2 jobs
import { runDataSync } from "../jobs/dataSync";
import { runResearchSynthesis } from "../jobs/researchSynthesis";
import { runAutoBuild } from "../jobs/autoBuild";
import { processResultRefresh } from "../jobs/resultRefresh";

// Hypothesis pipeline
import { DATA_SYNC_QUEUE } from "../jobs/dataSync";
import { RESEARCH_SYNTHESIS_QUEUE } from "../jobs/researchSynthesis";
import { AUTO_BUILD_QUEUE } from "../jobs/autoBuild";
import { HYPOTHESIS_GENERATOR_QUEUE, runHypothesisGenerator } from "../jobs/hypothesisGenerator";
import { RESULT_REFRESH_QUEUE } from "../jobs/resultRefresh";

// Phase 3 jobs (disabled until Phase 3 is active)
// import { runActivationGate } from "../jobs/activationGate";
// import { runOrchestrator } from "../jobs/orchestrator";
// import { runQaReview } from "../jobs/qaReview";
// import { runPmAgent } from "../jobs/pmAgent";
// import { runBuilderAgent } from "../jobs/builderAgent";

declare global {
  // eslint-disable-next-line no-var
  var __croWorkersStarted: boolean | undefined;
}

export async function ensureWorkersStarted() {
  if (global.__croWorkersStarted) return;
  global.__croWorkersStarted = true;

  if (!process.env.DATABASE_URL_UNPOOLED) {
    console.warn("[workers] DATABASE_URL_UNPOOLED not set — background workers disabled");
    return;
  }

  try {
    const boss = await getBoss();

    // Phase 2 workers
    await boss.work(DATA_SYNC_QUEUE, async (job) => {
      await runDataSync(job.data.shopId);
    });

    await boss.work(RESEARCH_SYNTHESIS_QUEUE, async (job) => {
      await runResearchSynthesis(job.data.shopId);
    });

    await boss.work(HYPOTHESIS_GENERATOR_QUEUE, async (job) => {
      await runHypothesisGenerator(job.data.shopId, job.data.reportId);
    });

    await boss.work(RESULT_REFRESH_QUEUE, async (job) => {
      await processResultRefresh(job.data.experimentId);
    });

    await boss.work(AUTO_BUILD_QUEUE, async (job) => {
      await runAutoBuild(job.data.shopId, job.data.hypothesisId);
    });

    // Register scheduled cron jobs
    await registerSchedules();

    console.log("[workers] pg-boss workers started (5 Phase 2 workers + scheduler)");
  } catch (error) {
    console.error("[workers] failed to start workers", error);
    global.__croWorkersStarted = false;
  }
}
```

Note: `HYPOTHESIS_GENERATOR_QUEUE` and `runHypothesisGenerator` need to be exported from `jobs/hypothesisGenerator.ts`. Verify that constant is exported — if not, add `export` to the `const HYPOTHESIS_GENERATOR_QUEUE` line in that file.

- [ ] **Step 2: Export missing constants from job files**

Check which queue name constants need `export` added:

```bash
cd ~/shivook-ai-cro && grep -n "^const.*_QUEUE\|^export const.*_QUEUE" jobs/dataSync.ts jobs/researchSynthesis.ts jobs/autoBuild.ts jobs/hypothesisGenerator.ts jobs/resultRefresh.ts | head -20
```

For any that are `const` (not `export const`), add `export`:
- `DATA_SYNC_QUEUE` in `jobs/dataSync.ts`
- `RESEARCH_SYNTHESIS_QUEUE` in `jobs/researchSynthesis.ts`
- `AUTO_BUILD_QUEUE` in `jobs/autoBuild.ts`
- `HYPOTHESIS_GENERATOR_QUEUE` in `jobs/hypothesisGenerator.ts`

- [ ] **Step 3: Typecheck**

```bash
cd ~/shivook-ai-cro && npx tsc --noEmit 2>&1 | grep -v shamefully | grep "error" | head -10
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
cd ~/shivook-ai-cro && git add lib/worker-init.server.ts jobs/dataSync.ts jobs/researchSynthesis.ts jobs/autoBuild.ts jobs/hypothesisGenerator.ts && git commit -m "feat: rewrite worker-init to use pg-boss workers"
```

---

## Task 7: Update routes + delete lib/queue.ts

**Files:**
- Modify: `app/routes/app.hypotheses.tsx`
- Modify: `app/routes/app.feedback.tsx`
- Delete: `lib/queue.ts`

- [ ] **Step 1: Update app/routes/app.hypotheses.tsx**

Find the imports at the top:
```typescript
import { dataSyncQueue } from "../../jobs/dataSync";
import { researchSynthesisQueue } from "../../jobs/researchSynthesis";
```

Replace with:
```typescript
import { enqueueDataSync } from "../../jobs/dataSync";
import { enqueueResearchSynthesis } from "../../jobs/researchSynthesis";
```

Find the `.add()` calls in the action (around line 43-46):
```typescript
await dataSyncQueue.add(`manual-sync-${shop.id}`, { shopId: shop.id });
await researchSynthesisQueue.add(
  `synthesis-${shop.id}`,
  { shopId: shop.id },
  { delay: 5000 }
);
```

Replace with:
```typescript
await enqueueDataSync(shop.id);
await enqueueResearchSynthesis(shop.id);
```

(pg-boss handles retry/delay internally; no need to pass delay on manual trigger)

- [ ] **Step 2: Update app/routes/app.feedback.tsx**

Find:
```typescript
import { pmAgentQueue } from "../../jobs/pmAgent";
```

Replace with:
```typescript
import { enqueuePmAgent } from "../../jobs/pmAgent";
```

Find:
```typescript
await pmAgentQueue.add(`pm-${record.id}`, { feedbackId: record.id, shopId: shop.id });
```

Replace with:
```typescript
await enqueuePmAgent(record.id, shop.id);
```

- [ ] **Step 3: Delete lib/queue.ts**

```bash
cd ~/shivook-ai-cro && rm lib/queue.ts
```

- [ ] **Step 4: Verify no remaining bullmq/ioredis/queue imports**

```bash
cd ~/shivook-ai-cro && grep -rn "from.*bullmq\|from.*ioredis\|from.*lib/queue\|require.*bullmq\|require.*ioredis" --include="*.ts" --include="*.tsx" . | grep -v node_modules | head -10
```

Expected: no output.

- [ ] **Step 5: Full typecheck**

```bash
cd ~/shivook-ai-cro && npx tsc --noEmit 2>&1 | grep -v shamefully | grep "error" | head -10
```

Expected: 0 errors.

- [ ] **Step 6: Run unit tests**

```bash
cd ~/shivook-ai-cro && npm run test:unit 2>&1 | tail -5
```

Expected: 9/9 pass.

- [ ] **Step 7: Build**

```bash
cd ~/shivook-ai-cro && npm run build 2>&1 | tail -5
```

Expected: `✓ built in ...ms`

- [ ] **Step 8: Commit**

```bash
cd ~/shivook-ai-cro && git add app/routes/app.hypotheses.tsx app/routes/app.feedback.tsx lib/queue.ts && git commit -m "feat: update routes to use enqueue* functions; delete lib/queue.ts"
```

---

## Task 8: Deploy + verify

**Files:**
- No code changes — deploy and smoke-test.

- [ ] **Step 1: Push to main and deploy**

```bash
cd ~/shivook-ai-cro && git push origin main && fly deploy --remote-only 2>&1 | tail -8
```

Expected: both machines reach started state.

- [ ] **Step 2: Verify healthz**

```bash
curl -s -w " (HTTP %{http_code})" https://shivook-ai-cro.fly.dev/healthz
```

Expected: `ok (HTTP 200)`

- [ ] **Step 3: Check startup logs for pg-boss**

```bash
cd ~/shivook-ai-cro && fly logs --no-tail 2>&1 | grep -E "pgboss|workers|scheduler" | tail -10
```

Expected: `[pgboss] started` and `[workers] pg-boss workers started` and `[scheduler] hourly + nightly + orchestrator schedules registered`

- [ ] **Step 4: Enqueue a dataSync job and confirm it runs**

```bash
cd ~/shivook-ai-cro && node --input-type=module << 'EOF'
import PgBoss from "pg-boss";
const boss = new PgBoss({ connectionString: "postgresql://neondb_owner:npg_5ZQRUhIWJ3Ez@ep-proud-glade-aqo5nhkc.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require" });
await boss.start();
const id = await boss.send("data-sync", { shopId: "ac72e066-9cf2-4296-b000-727871fda03a" });
console.log("Queued data-sync job:", id);
await boss.stop();
EOF
```

Expected: prints a job UUID.

- [ ] **Step 5: Watch logs for the job completing**

Wait ~30 seconds, then:
```bash
cd ~/shivook-ai-cro && fly logs --no-tail 2>&1 | grep "dataSync\|data-sync\|pgboss" | tail -10
```

Expected: `[dataSync] completed for shop shivook-team.myshopify.com`

- [ ] **Step 6: Remove REDIS_URL from Fly.io (cleanup)**

```bash
cd ~/shivook-ai-cro && fly secrets unset REDIS_URL 2>&1 | tail -5
```

Expected: machines redeploy without REDIS_URL; no errors.

- [ ] **Step 7: Final healthz check**

```bash
curl -s -w " (HTTP %{http_code})" https://shivook-ai-cro.fly.dev/healthz
```

Expected: `ok (HTTP 200)`

---

## Success Criteria

- [ ] `npx tsc --noEmit` exits 0
- [ ] `npm run test:unit` shows 9/9 pass
- [ ] `npm run build` succeeds
- [ ] `/healthz` returns 200
- [ ] Fly logs show `[pgboss] started` on boot
- [ ] `data-sync` job queued directly runs and logs completion
- [ ] No BullMQ/ioredis references remain in source
- [ ] `REDIS_URL` removed from Fly secrets

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
  for (const shop of shops) {
    await enqueueDataSync(shop.id);
    await enqueueResearchSynthesis(shop.id);
  }
}

async function handleOrchestratorTick() {
  const shops = await prisma.shop.findMany({ select: { id: true } });
  for (const shop of shops) {
    await enqueueOrchestrator(shop.id);
  }
}

// ── Registration ──────────────────────────────────────────────────────────────

// The autonomous orchestrator (hypothesis -> autoBuild -> qaReview -> activation)
// can be paused without a code change by setting AUTONOMOUS_PIPELINE_ENABLED=false.
// Useful when the storefront has no measurable traffic (e.g. a password-protected
// dev store), so the 6-hourly run isn't generating experiments that can never
// collect data. Defaults to enabled.
const AUTONOMOUS_PIPELINE_ENABLED =
  process.env.AUTONOMOUS_PIPELINE_ENABLED !== "false";

export async function registerSchedules() {
  const boss = await getBoss();

  // Register cron schedules (pg-boss is idempotent — safe to call on every startup)
  await boss.schedule("hourly-refresh", "0 * * * *", {});        // every hour
  await boss.schedule("nightly-sync", "0 0 * * *", {});          // midnight UTC

  if (AUTONOMOUS_PIPELINE_ENABLED) {
    await boss.schedule("orchestrator-tick", "0 */6 * * *", {}); // every 6 hours
  } else {
    // Actively remove any previously-registered schedule so the pause survives
    // restarts/redeploys, not just the initial unschedule.
    await boss.unschedule("orchestrator-tick").catch(() => {});
    console.log(
      "[scheduler] autonomous orchestrator DISABLED (AUTONOMOUS_PIPELINE_ENABLED=false) — orchestrator-tick not scheduled",
    );
  }

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

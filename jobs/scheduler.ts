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

export async function registerSchedules() {
  const boss = await getBoss();

  // Register cron schedules (pg-boss is idempotent — safe to call on every startup)
  await boss.schedule("hourly-refresh", "0 * * * *", {});        // every hour
  await boss.schedule("nightly-sync", "0 0 * * *", {});          // midnight UTC
  await boss.schedule("orchestrator-tick", "0 */6 * * *", {});   // every 6 hours

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

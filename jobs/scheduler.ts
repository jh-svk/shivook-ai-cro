import { Queue, Worker } from "bullmq";
import { connection, QUEUE_NAMES } from "../lib/queue";
import { resultRefreshQueue } from "./resultRefresh";
import { dataSyncQueue } from "./dataSync";
import { researchSynthesisQueue } from "./researchSynthesis";
import { hypothesisGeneratorQueue } from "./hypothesisGenerator";
import prisma from "../app/db.server";

const SCHEDULER_QUEUE = "scheduler";
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

export const schedulerQueue = new Queue(SCHEDULER_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
  },
});

async function runHourlyScheduler() {
  const activeExperiments = await prisma.experiment.findMany({
    where: { status: "active" },
    select: { id: true },
  });

  console.log(
    `[scheduler] enqueuing result refresh for ${activeExperiments.length} active experiments`
  );

  for (const { id: experimentId } of activeExperiments) {
    await resultRefreshQueue.add(
      `refresh-${experimentId}`,
      { experimentId },
      { jobId: `refresh-${experimentId}-${Date.now()}` }
    );
  }
}

async function runNightlyScheduler() {
  const shops = await prisma.shop.findMany({ select: { id: true } });

  console.log(`[scheduler] nightly sync for ${shops.length} shops`);

  for (const { id: shopId } of shops) {
    // 1. Sync data connectors
    await dataSyncQueue.add(`sync-${shopId}`, { shopId });

    // 2. Research synthesis (only if data sync completes — chained via job events
    //    in the worker; here we fire it 10 min after sync to allow time)
    await researchSynthesisQueue.add(
      `research-${shopId}`,
      { shopId },
      { delay: 10 * 60 * 1000 }
    );
  }
}

export function startSchedulerWorker() {
  return new Worker(
    SCHEDULER_QUEUE,
    async (job) => {
      if (job.name === "nightly") {
        await runNightlyScheduler();
      } else {
        await runHourlyScheduler();
      }
    },
    { connection }
  );
}

export async function registerSchedules() {
  const repeatables = await schedulerQueue.getRepeatableJobs();
  const names = new Set(repeatables.map((j) => j.name));

  // Remove stale schedules to prevent duplicates on restart
  for (const job of repeatables) {
    if (job.name === "hourly-result-refresh" || job.name === "hourly" || job.name === "nightly") {
      await schedulerQueue.removeRepeatableByKey(job.key);
    }
  }

  await schedulerQueue.add("hourly", {}, { repeat: { every: ONE_HOUR_MS } });
  await schedulerQueue.add("nightly", {}, { repeat: { every: ONE_DAY_MS } });

  console.log("[scheduler] hourly + nightly schedules registered");
}

/** @deprecated Use registerSchedules */
export const registerHourlySchedule = registerSchedules;

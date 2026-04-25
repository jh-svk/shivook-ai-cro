import { Queue, Worker } from "bullmq";
import { connection, QUEUE_NAMES } from "../lib/queue";
import { resultRefreshQueue } from "./resultRefresh";
import prisma from "../app/db.server";

const SCHEDULER_QUEUE = "scheduler";
const ONE_HOUR_MS = 60 * 60 * 1000;

export const schedulerQueue = new Queue(SCHEDULER_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
  },
});

async function runScheduler() {
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

export function startSchedulerWorker() {
  return new Worker(SCHEDULER_QUEUE, async () => runScheduler(), { connection });
}

export async function registerHourlySchedule() {
  // Remove any existing repeatable job first so we don't stack duplicates on restart
  const repeatables = await schedulerQueue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === "hourly-result-refresh") {
      await schedulerQueue.removeRepeatableByKey(job.key);
    }
  }

  await schedulerQueue.add(
    "hourly-result-refresh",
    {},
    { repeat: { every: ONE_HOUR_MS } }
  );

  console.log("[scheduler] hourly result-refresh schedule registered");
}

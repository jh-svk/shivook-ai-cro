/**
 * Activation gate job.
 *
 * Checks concurrent test limits, then either sets the experiment to
 * pending_approval (REQUIRE_HUMAN_APPROVAL=true) or activates it directly.
 */

import { Queue, Worker, type Job } from "bullmq";
import { connection } from "../lib/queue";
import prisma from "../app/db.server";
import { canActivateExperiment } from "../lib/concurrentTestManager.server";

export const ACTIVATION_GATE_QUEUE = "activation-gate";

export interface ActivationGateJobData {
  shopId: string;
  experimentId: string;
  forceApproval?: boolean;
}

export const activationGateQueue = new Queue<ActivationGateJobData>(ACTIVATION_GATE_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
  },
});

async function logOrchestrator(
  shopId: string,
  runId: string,
  stage: string,
  status: string,
  payload: object
) {
  await prisma.orchestratorLog.create({
    data: { shopId, runId, stage, status, payload, completedAt: new Date() },
  });
}

async function runActivationGate(shopId: string, experimentId: string, forceApproval = false) {
  const check = await canActivateExperiment(experimentId);
  if (!check.allowed) {
    await logOrchestrator(shopId, experimentId, "ACTIVATE", "skipped", { reason: check.reason });
    console.log(`[activationGate] blocked experiment ${experimentId}: ${check.reason}`);
    return;
  }

  const requireApproval = forceApproval || process.env.REQUIRE_HUMAN_APPROVAL !== "false";

  if (requireApproval) {
    await prisma.experiment.update({
      where: { id: experimentId },
      data: { status: "pending_approval" },
    });
    await logOrchestrator(shopId, experimentId, "ACTIVATE", "running", {
      message: "awaiting human approval",
      experimentId,
    });
    console.log(`[activationGate] experiment ${experimentId} awaiting human approval`);
  } else {
    await prisma.experiment.update({
      where: { id: experimentId },
      data: { status: "active", startedAt: new Date() },
    });
    await logOrchestrator(shopId, experimentId, "ACTIVATE", "complete", { experimentId });
    console.log(`[activationGate] experiment ${experimentId} activated automatically`);
  }
}

export function startActivationGateWorker() {
  return new Worker<ActivationGateJobData>(
    ACTIVATION_GATE_QUEUE,
    async (job: Job<ActivationGateJobData>) => {
      await runActivationGate(job.data.shopId, job.data.experimentId, job.data.forceApproval);
    },
    { connection }
  );
}

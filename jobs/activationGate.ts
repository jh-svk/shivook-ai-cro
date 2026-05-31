/**
 * Activation gate job.
 *
 * Checks concurrent test limits, then either sets the experiment to
 * pending_approval (REQUIRE_HUMAN_APPROVAL=true) or activates it directly.
 */

import { getBoss } from "../lib/pgboss.server";
import prisma from "../app/db.server";
import { canActivateExperiment } from "../lib/concurrentTestManager.server";

export const ACTIVATION_GATE_QUEUE = "activation-gate";

export interface ActivationGateJobData {
  shopId: string;
  experimentId: string;
  forceApproval?: boolean;
}

export async function enqueueActivationGate(shopId: string, experimentId: string, forceApproval = false): Promise<void> {
  const boss = await getBoss();
  const id = await boss.send(ACTIVATION_GATE_QUEUE, { shopId, experimentId, forceApproval }, { retryLimit: 3, retryDelay: 15, retryBackoff: true }); // retryDelay in seconds
  if (id === null) console.warn(`[activationGate] send returned null for experiment ${experimentId} — job blocked`);
}

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

export async function runActivationGate(shopId: string, experimentId: string, forceApproval = false) {
  const check = await canActivateExperiment(experimentId);
  if (!check.allowed) {
    await logOrchestrator(shopId, experimentId, "ACTIVATE", "skipped", { reason: check.reason });
    console.log(`[activationGate] blocked experiment ${experimentId}: ${check.reason}`);
    return;
  }

  // Honour the merchant's Settings toggle (shop.requireHumanApproval). forceApproval
  // is a safety override from qaReview for LOW-CONFIDENCE builds — those still pause
  // for review even if the merchant turned approval off.
  const shopRow = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { requireHumanApproval: true },
  });
  const requireApproval = forceApproval || (shopRow?.requireHumanApproval ?? false);

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


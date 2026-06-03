import prisma from "../app/db.server";
import { getPlanConcurrentLimit } from "./planGate.server";
import { segmentSignature } from "./segmentSignature.server";

export async function canActivateExperiment(
  experimentId: string
): Promise<{ allowed: boolean; reason?: string }> {
  const experiment = await prisma.experiment.findUnique({
    where: { id: experimentId },
    select: { shopId: true, pageType: true, segment: true },
  });
  if (!experiment) return { allowed: false, reason: "experiment not found" };

  const { shopId, pageType, segment } = experiment;

  const maxConcurrent = await getPlanConcurrentLimit(shopId);
  if (maxConcurrent === 0) {
    return { allowed: false, reason: "No active subscription — upgrade to activate tests." };
  }
  const activeCount = await prisma.experiment.count({
    where: { shopId, status: "active" },
  });
  if (activeCount >= maxConcurrent) {
    return { allowed: false, reason: "Concurrent test limit reached for your plan." };
  }

  // Mutual exclusion: never run TWO tests on the exact same audience
  // (page type + device + audience + geo) at once — overlapping exposure would
  // contaminate both tests' data.
  const mySig = segmentSignature(pageType, segment);
  const activeOnSamePage = await prisma.experiment.findMany({
    where: { shopId, pageType, status: "active", id: { not: experimentId } },
    select: { id: true, segment: true },
  });
  const clash = activeOnSamePage.find((e) => segmentSignature(pageType, e.segment) === mySig);
  if (clash) {
    return {
      allowed: false,
      reason:
        "Another active test already targets this exact segment (same page type, device, audience, and geo). " +
        "Running two tests on the same segment at once would let overlapping visitors affect both results, " +
        "making the data unreliable. Pause or end that test first, or target a different segment.",
    };
  }

  return { allowed: true };
}

export async function getActiveConcurrentCount(shopId: string): Promise<number> {
  return prisma.experiment.count({ where: { shopId, status: "active" } });
}

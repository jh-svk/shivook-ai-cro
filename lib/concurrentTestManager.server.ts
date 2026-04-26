import prisma from "../app/db.server";
import { getPlanConcurrentLimit } from "./planGate.server";

export async function canActivateExperiment(
  experimentId: string
): Promise<{ allowed: boolean; reason?: string }> {
  const experiment = await prisma.experiment.findUnique({
    where: { id: experimentId },
    select: { shopId: true, pageType: true, elementType: true, segmentId: true },
  });
  if (!experiment) return { allowed: false, reason: "experiment not found" };

  const { shopId, pageType, elementType, segmentId } = experiment;

  const maxConcurrent = await getPlanConcurrentLimit(shopId);
  const activeCount = await prisma.experiment.count({
    where: { shopId, status: "active" },
  });
  if (maxConcurrent === 0) {
    return { allowed: false, reason: "no active subscription — upgrade to activate tests" };
  }
  if (activeCount >= maxConcurrent) {
    return { allowed: false, reason: "concurrent test limit reached" };
  }

  const collision = await prisma.experiment.findFirst({
    where: {
      shopId,
      pageType,
      elementType,
      status: "active",
      id: { not: experimentId },
    },
    select: { id: true, segmentId: true },
  });

  if (collision) {
    const bothSegmented = segmentId && collision.segmentId;
    const sameSegment = segmentId === collision.segmentId;
    if (!bothSegmented || sameSegment) {
      return { allowed: false, reason: "collision: another test is running on this page zone" };
    }
  }

  return { allowed: true };
}

export async function getActiveConcurrentCount(shopId: string): Promise<number> {
  return prisma.experiment.count({ where: { shopId, status: "active" } });
}

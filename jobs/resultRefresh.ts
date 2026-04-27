import { Queue, Worker, type Job } from "bullmq";
import { connection, QUEUE_NAMES } from "../lib/queue";
import { computeStats } from "../lib/stats";
import { writeKnowledgeBaseEntry, writePlatformLearning } from "../lib/knowledgeBase.server";
import prisma from "../app/db.server";

export interface ResultRefreshJobData {
  experimentId: string;
}

export const resultRefreshQueue = new Queue<ResultRefreshJobData>(
  QUEUE_NAMES.RESULT_REFRESH,
  {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
    },
  }
);

const AOV_GUARDRAIL_THRESHOLD = 0.03;

async function processResultRefresh(experimentId: string) {
  const experiment = await prisma.experiment.findUnique({
    where: { id: experimentId },
    include: { variants: true, segment: { select: { deviceType: true } } },
  });

  if (!experiment || experiment.status === "concluded") return;

  const controlVariant = experiment.variants.find((v) => v.type === "control");
  const treatmentVariant = experiment.variants.find((v) => v.type === "treatment");
  if (!controlVariant || !treatmentVariant) return;

  // Visitors = unique visitorIds that received a view event
  const viewEvents = await prisma.event.findMany({
    where: { experimentId, eventType: "view" },
    select: { variantId: true, visitorId: true },
  });

  const controlVisitors = new Set(
    viewEvents.filter((e) => e.variantId === controlVariant.id).map((e) => e.visitorId)
  ).size;
  const treatmentVisitors = new Set(
    viewEvents.filter((e) => e.variantId === treatmentVariant.id).map((e) => e.visitorId)
  ).size;

  // Conversions depend on the target metric
  const conversionEventType =
    experiment.targetMetric === "add_to_cart_rate"
      ? "add_to_cart"
      : "purchase"; // conversion_rate and revenue_per_visitor both key off purchases

  const conversionEvents = await prisma.event.findMany({
    where: { experimentId, eventType: conversionEventType },
    select: { variantId: true, visitorId: true, revenue: true },
  });

  const controlConversions = new Set(
    conversionEvents
      .filter((e) => e.variantId === controlVariant.id)
      .map((e) => e.visitorId)
  ).size;
  const treatmentConversions = new Set(
    conversionEvents
      .filter((e) => e.variantId === treatmentVariant.id)
      .map((e) => e.visitorId)
  ).size;

  // Revenue totals (from purchase events regardless of targetMetric)
  const purchaseEvents = await prisma.event.findMany({
    where: { experimentId, eventType: "purchase" },
    select: { variantId: true, revenue: true },
  });

  const controlRevenue = purchaseEvents
    .filter((e) => e.variantId === controlVariant.id)
    .reduce((s, e) => s + (e.revenue ?? 0), 0);
  const treatmentRevenue = purchaseEvents
    .filter((e) => e.variantId === treatmentVariant.id)
    .reduce((s, e) => s + (e.revenue ?? 0), 0);

  const stats = computeStats(
    { visitors: controlVisitors, conversions: controlConversions },
    { visitors: treatmentVisitors, conversions: treatmentConversions }
  );

  // AOV guardrail: trip if treatment AOV drops > 3% below control AOV
  const controlPurchases = purchaseEvents.filter((e) => e.variantId === controlVariant.id).length;
  const treatmentPurchases = purchaseEvents.filter((e) => e.variantId === treatmentVariant.id).length;
  const controlAov = controlPurchases > 0 ? controlRevenue / controlPurchases : 0;
  const treatmentAov = treatmentPurchases > 0 ? treatmentRevenue / treatmentPurchases : 0;

  const aovTripped =
    controlAov > 0 && treatmentAov > 0 &&
    treatmentAov < controlAov * (1 - AOV_GUARDRAIL_THRESHOLD);
  const guardrailStatus = aovTripped ? "aov_tripped" : "ok";

  const resultData = {
    computedAt: new Date(),
    controlVisitors,
    treatmentVisitors,
    controlConversions,
    treatmentConversions,
    controlRevenue,
    treatmentRevenue,
    controlConversionRate: stats.controlConversionRate,
    treatmentConversionRate: stats.treatmentConversionRate,
    relativeLift: stats.relativeLift,
    pValue: stats.pValue,
    probToBeatControl: stats.probToBeatControl,
    isSignificant: stats.isSignificant,
    guardrailStatus,
  };

  await prisma.result.upsert({
    where: { experimentId },
    create: { experimentId, ...resultData },
    update: resultData,
  });

  // Auto-conclude on guardrail trip or Bayesian decision (95% probability)
  const shouldConclude =
    experiment.status === "active" &&
    (aovTripped || stats.probToBeatControl !== null && stats.probToBeatControl >= 0.95);

  if (shouldConclude) {
    const reason = aovTripped ? "AOV guardrail tripped" : "Bayesian 95% threshold reached";
    await prisma.experiment.update({
      where: { id: experimentId },
      data: { status: "concluded", concludedAt: new Date() },
    });
    console.log(`[resultRefresh] experiment ${experimentId} concluded: ${reason}`);

    await writeKnowledgeBaseEntry(experimentId).catch((err) =>
      console.error("[resultRefresh] knowledgeBase write failed", err)
    );

    const daysRunning = experiment.startedAt
      ? Math.max(1, Math.ceil((Date.now() - experiment.startedAt.getTime()) / (1000 * 60 * 60 * 24)))
      : 1;
    await writePlatformLearning({
      pageType:    experiment.pageType,
      elementType: experiment.elementType,
      targetMetric: experiment.targetMetric,
      hypothesis:  experiment.hypothesis,
      result:      resultData,
      daysRunning,
      segment:     experiment.segment,
    }).catch((err) => console.error("[resultRefresh] platformLearning write failed", err));

    // Slack notification
    const shopRecord = await prisma.shop.findUnique({
      where: { id: experiment.shopId },
      select: { slackWebhookUrl: true },
    });
    if (shopRecord?.slackWebhookUrl) {
      const msg = aovTripped
        ? `⚠️ [Shivook CRO] Experiment "${experiment.name}" paused — AOV guardrail tripped (treatment AOV dropped > 3%).`
        : `✅ [Shivook CRO] Experiment "${experiment.name}" concluded.\n` +
          `Lift: ${((stats.relativeLift ?? 0) * 100).toFixed(1)}% | ` +
          `P(beat control): ${((stats.probToBeatControl ?? 0) * 100).toFixed(1)}%`;
      await fetch(shopRecord.slackWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: msg }),
      }).catch(() => {});
    }
  }
}

export function startResultRefreshWorker() {
  return new Worker<ResultRefreshJobData>(
    QUEUE_NAMES.RESULT_REFRESH,
    async (job: Job<ResultRefreshJobData>) => {
      const { experimentId } = job.data;
      console.log(`[resultRefresh] computing results for ${experimentId}`);
      await processResultRefresh(experimentId);
    },
    { connection }
  );
}

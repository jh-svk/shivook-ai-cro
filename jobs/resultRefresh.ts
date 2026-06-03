import { getBoss } from "../lib/pgboss.server";
import { computeStats, computeMultiArmStats, proportionPValue, poissonRatePValue } from "../lib/stats";
import { writeKnowledgeBaseEntry, writePlatformLearning } from "../lib/knowledgeBase.server";
import prisma from "../app/db.server";

export const RESULT_REFRESH_QUEUE = "result-refresh";

export interface ResultRefreshJobData {
  experimentId: string;
}

export async function enqueueResultRefresh(experimentId: string): Promise<void> {
  const boss = await getBoss();
  await boss.createQueue(RESULT_REFRESH_QUEUE);
  const id = await boss.send(RESULT_REFRESH_QUEUE, { experimentId }, { retryLimit: 3, retryDelay: 5, retryBackoff: true }); // retryDelay in seconds
  if (id === null) console.warn(`[resultRefresh] send returned null for ${experimentId} — job blocked`);
}

const AOV_GUARDRAIL_THRESHOLD = 0.03;

export async function processResultRefresh(experimentId: string) {
  const experiment = await prisma.experiment.findUnique({
    where: { id: experimentId },
    include: {
      variants: true,
      segment: { select: { deviceType: true } },
      shop: { select: { autoConcludeEnabled: true } },
    },
  });

  if (!experiment || experiment.status === "concluded") return;

  const controlVariant = experiment.variants.find((v) => v.type === "control");
  if (!controlVariant) return;
  // Every non-control arm, stable order (createdAt) — supports A/B/n.
  const treatmentVariants = experiment.variants
    .filter((v) => v.id !== controlVariant.id)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  if (treatmentVariants.length === 0) return;

  // Visitors = unique visitorIds per variant (SQL aggregation avoids loading all rows into heap)
  const conversionEventType =
    experiment.targetMetric === "add_to_cart_rate"
      ? "add_to_cart"
      : "purchase";

  type CountRow = { variantid: string; cnt: bigint };
  type SumRow = { variantid: string; total: string | null };

  // One grouped query per metric — returns a row per arm, scales to any N.
  const [viewCounts, conversionCounts, atcCounts, checkoutCounts, purchaseCounts, revenueRows] =
    await Promise.all([
      prisma.$queryRaw<CountRow[]>`SELECT "variantId" AS variantid, COUNT(DISTINCT "visitorId") AS cnt FROM "events" WHERE "experimentId" = ${experimentId} AND "eventType" = 'view' GROUP BY "variantId"`,
      prisma.$queryRaw<CountRow[]>`SELECT "variantId" AS variantid, COUNT(DISTINCT "visitorId") AS cnt FROM "events" WHERE "experimentId" = ${experimentId} AND "eventType" = ${conversionEventType} GROUP BY "variantId"`,
      prisma.$queryRaw<CountRow[]>`SELECT "variantId" AS variantid, COUNT(*) AS cnt FROM "events" WHERE "experimentId" = ${experimentId} AND "eventType" = 'add_to_cart' GROUP BY "variantId"`,
      prisma.$queryRaw<CountRow[]>`SELECT "variantId" AS variantid, COUNT(*) AS cnt FROM "events" WHERE "experimentId" = ${experimentId} AND "eventType" = 'checkout_started' GROUP BY "variantId"`,
      prisma.$queryRaw<CountRow[]>`SELECT "variantId" AS variantid, COUNT(*) AS cnt FROM "events" WHERE "experimentId" = ${experimentId} AND "eventType" = 'purchase' GROUP BY "variantId"`,
      prisma.$queryRaw<SumRow[]>`SELECT "variantId" AS variantid, SUM("revenue") AS total FROM "events" WHERE "experimentId" = ${experimentId} AND "eventType" = 'purchase' GROUP BY "variantId"`,
    ]);

  const cnt = (rows: CountRow[], variantId: string) =>
    Number(rows.find((r) => r.variantid === variantId)?.cnt ?? 0);
  const rev = (variantId: string) =>
    parseFloat(revenueRows.find((r) => r.variantid === variantId)?.total ?? "0");

  type ArmMetrics = {
    variantId: string; visitors: number; conversions: number; conversionRate: number;
    revenue: number; addToCart: number; checkout: number; purchases: number;
    revPerVisitor: number; aov: number;
  };
  const metricsFor = (variantId: string): ArmMetrics => {
    const visitors = cnt(viewCounts, variantId);
    const conversions = cnt(conversionCounts, variantId);
    const purchases = cnt(purchaseCounts, variantId);
    const revenue = rev(variantId);
    return {
      variantId, visitors, conversions,
      conversionRate: visitors > 0 ? conversions / visitors : 0,
      revenue, addToCart: cnt(atcCounts, variantId), checkout: cnt(checkoutCounts, variantId),
      purchases,
      revPerVisitor: visitors > 0 ? revenue / visitors : 0,
      aov: purchases > 0 ? revenue / purchases : 0,
    };
  };

  const controlM = metricsFor(controlVariant.id);
  const treatmentMs = treatmentVariants.map((v) => metricsFor(v.id));

  // Multi-arm Bayesian: per-arm P(beat control) + P(best arm) in one pass.
  const multi = computeMultiArmStats(
    { visitors: controlM.visitors, conversions: controlM.conversions },
    treatmentMs.map((m) => ({ visitors: m.visitors, conversions: m.conversions })),
  );

  // Per-arm AOV guardrail: a treatment trips if its AOV is > 3% below control.
  const trippedByVariant = new Map<string, boolean>();
  for (const m of treatmentMs) {
    trippedByVariant.set(
      m.variantId,
      controlM.aov > 0 && m.aov > 0 && m.aov < controlM.aov * (1 - AOV_GUARDRAIL_THRESHOLD),
    );
  }
  const allTreatmentsTripped = treatmentMs.every((m) => trippedByVariant.get(m.variantId));

  // Primary treatment for the legacy Result summary: the winning arm if there is
  // one, else the current leader by P(best). For a 2-arm test this is always the
  // single treatment → the summary stays identical to before.
  let leaderIdx = 0;
  for (let i = 1; i < treatmentMs.length; i++) {
    if (multi.arms[i + 1].probBestArm > multi.arms[leaderIdx + 1].probBestArm) leaderIdx = i;
  }
  const primaryIdx = multi.winningArmIndex != null ? multi.winningArmIndex - 1 : leaderIdx;
  const primaryM = treatmentMs[primaryIdx];
  const primaryVariant = treatmentVariants[primaryIdx];

  // Legacy pairwise stats (control vs primary treatment) keep every existing
  // Result column populated exactly as before.
  const stats = computeStats(
    { visitors: controlM.visitors, conversions: controlM.conversions },
    { visitors: primaryM.visitors, conversions: primaryM.conversions },
  );

  // ── Map to the existing Result field names (control vs primary treatment) ──
  const controlVisitors = controlM.visitors;
  const treatmentVisitors = primaryM.visitors;
  const controlConversions = controlM.conversions;
  const treatmentConversions = primaryM.conversions;
  const controlRevenue = controlM.revenue;
  const treatmentRevenue = primaryM.revenue;
  const controlAddToCartCount = controlM.addToCart;
  const treatmentAddToCartCount = primaryM.addToCart;
  const controlCheckoutCount = controlM.checkout;
  const treatmentCheckoutCount = primaryM.checkout;
  const controlPurchases = controlM.purchases;
  const treatmentPurchases = primaryM.purchases;
  const controlAov = controlM.aov;
  const treatmentAov = primaryM.aov;
  const controlRevPerVisitor = controlM.revPerVisitor;
  const treatmentRevPerVisitor = primaryM.revPerVisitor;

  // Derived funnel rates (guard divide-by-zero)
  const controlAddToCartRate = controlVisitors > 0 ? controlAddToCartCount / controlVisitors : 0;
  const treatmentAddToCartRate = treatmentVisitors > 0 ? treatmentAddToCartCount / treatmentVisitors : 0;
  const controlCheckoutRate = controlVisitors > 0 ? controlCheckoutCount / controlVisitors : 0;
  const treatmentCheckoutRate = treatmentVisitors > 0 ? treatmentCheckoutCount / treatmentVisitors : 0;

  // Lift metrics (null when control is 0 to avoid meaningless ±∞)
  const liftPct = (treatment: number, control: number) =>
    control > 0 ? ((treatment - control) / control) * 100 : null;

  const conversionRateLift = liftPct(stats.treatmentConversionRate, stats.controlConversionRate);
  const addToCartRateLift = liftPct(treatmentAddToCartRate, controlAddToCartRate);
  const checkoutRateLift = liftPct(treatmentCheckoutRate, controlCheckoutRate);
  const revPerVisitorLift = liftPct(treatmentRevPerVisitor, controlRevPerVisitor);
  const aovLift =
    controlAov > 0 && treatmentAov > 0 ? liftPct(treatmentAov, controlAov) : null;

  // Per-metric frequentist p-values
  const addToCartPValue = proportionPValue(
    controlVisitors, controlAddToCartRate,
    treatmentVisitors, treatmentAddToCartRate
  );
  const checkoutPValue = proportionPValue(
    controlVisitors, controlCheckoutRate,
    treatmentVisitors, treatmentCheckoutRate
  );
  const convRatePValue = proportionPValue(
    controlVisitors, stats.controlConversionRate,
    treatmentVisitors, stats.treatmentConversionRate
  );
  const aovPValue =
    controlPurchases >= 10 && treatmentPurchases >= 10
      ? poissonRatePValue(controlPurchases, controlAov, treatmentPurchases, treatmentAov)
      : null;
  const revPerVisitorPValue = poissonRatePValue(
    controlVisitors, controlRevPerVisitor,
    treatmentVisitors, treatmentRevPerVisitor
  );

  const aovTripped = trippedByVariant.get(primaryVariant.id) ?? false;
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
    // Funnel metrics
    controlAddToCartCount,
    treatmentAddToCartCount,
    controlAddToCartRate,
    treatmentAddToCartRate,
    controlCheckoutCount,
    treatmentCheckoutCount,
    controlCheckoutRate,
    treatmentCheckoutRate,
    // Revenue metrics
    controlAov: controlAov > 0 ? controlAov : null,
    treatmentAov: treatmentAov > 0 ? treatmentAov : null,
    controlRevPerVisitor,
    treatmentRevPerVisitor,
    // Lift metrics
    conversionRateLift,
    addToCartRateLift,
    checkoutRateLift,
    revPerVisitorLift,
    aovLift,
    // Per-metric p-values
    addToCartPValue,
    checkoutPValue,
    convRatePValue,
    aovPValue,
    revPerVisitorPValue,
  };

  await prisma.result.upsert({
    where: { experimentId },
    create: { experimentId, ...resultData },
    update: resultData,
  });

  // Per-arm breakdown rows (control + every treatment). `Result` stays the
  // experiment-level summary; these hold the A/B/n detail.
  const armBreakdown = [
    { m: controlM, arm: multi.arms[0], isControl: true },
    ...treatmentMs.map((m, i) => ({ m, arm: multi.arms[i + 1], isControl: false })),
  ];
  for (const { m, arm, isControl } of armBreakdown) {
    const vrData = {
      shopId: experiment.shopId,
      computedAt: resultData.computedAt,
      visitors: m.visitors,
      conversions: m.conversions,
      conversionRate: m.conversionRate,
      revenue: m.revenue,
      addToCartCount: m.addToCart,
      checkoutCount: m.checkout,
      purchaseCount: m.purchases,
      aov: m.aov > 0 ? m.aov : null,
      relativeLift: arm.relativeLift,
      probToBeatControl: arm.probToBeatControl,
      probBestArm: arm.probBestArm,
      guardrailStatus: !isControl && trippedByVariant.get(m.variantId) ? "aov_tripped" : "ok",
    };
    await prisma.variantResult.upsert({
      where: { experimentId_variantId: { experimentId, variantId: m.variantId } },
      create: { experimentId, variantId: m.variantId, ...vrData },
      update: vrData,
    });
  }

  // Auto-conclude on guardrail trip or Bayesian decision. Guard early peeking:
  // the Bayesian threshold requires minRuntimeDays first.
  const daysSinceStart = experiment.startedAt
    ? (Date.now() - experiment.startedAt.getTime()) / (1000 * 60 * 60 * 24)
    : 0;
  const metMinRuntime = daysSinceStart >= experiment.minRuntimeDays;
  // The AOV guardrail always auto-concludes (loss prevention). The Bayesian
  // "winner found" auto-conclude only fires when the merchant has left
  // autoConcludeEnabled on; if they've chosen to decide themselves, we still
  // compute + store significance but never end the test for them.
  const autoConclude = experiment.shop?.autoConcludeEnabled ?? true;
  // A winner must be the best arm AND beat control at 95% (multi.isSignificant)
  // AND not be AOV-tripped. The whole test concludes for loss-prevention only
  // when EVERY treatment has tripped the guardrail.
  const winningArmTripped =
    multi.winningArmIndex != null &&
    (trippedByVariant.get(treatmentVariants[multi.winningArmIndex - 1].id) ?? false);
  const bayesianWin = metMinRuntime && multi.isSignificant && !winningArmTripped;
  const concludeAsWinner = autoConclude && bayesianWin;
  const shouldConclude =
    experiment.status === "active" && (allTreatmentsTripped || concludeAsWinner);

  if (shouldConclude) {
    const winningVariantId = concludeAsWinner
      ? treatmentVariants[multi.winningArmIndex! - 1].id
      : null;
    const reason = concludeAsWinner ? "Bayesian 95% threshold reached" : "AOV guardrail tripped";
    await prisma.experiment.update({
      where: { id: experimentId },
      data: { status: "concluded", concludedAt: new Date(), winningVariantId },
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
      const msg = concludeAsWinner
        ? `✅ [Shivook CRO] Experiment "${experiment.name}" concluded.\n` +
          `Lift: ${((stats.relativeLift ?? 0) * 100).toFixed(1)}% | ` +
          `P(beat control): ${((stats.probToBeatControl ?? 0) * 100).toFixed(1)}%`
        : `⚠️ [Shivook CRO] Experiment "${experiment.name}" paused — AOV guardrail tripped (all treatment AOVs dropped > 3%).`;
      await fetch(shopRecord.slackWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: msg }),
      }).catch(() => {});
    }
  }
}


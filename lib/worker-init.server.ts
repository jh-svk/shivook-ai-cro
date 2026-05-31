import { getBoss } from "./pgboss.server";
import { registerSchedules } from "../jobs/scheduler";

// Phase 2 jobs
import { runDataSync, DATA_SYNC_QUEUE } from "../jobs/dataSync";
import { runResearchSynthesis, RESEARCH_SYNTHESIS_QUEUE } from "../jobs/researchSynthesis";
import { runHypothesisGenerator, HYPOTHESIS_GENERATOR_QUEUE } from "../jobs/hypothesisGenerator";
import { processResultRefresh, RESULT_REFRESH_QUEUE } from "../jobs/resultRefresh";
import { runAutoBuild, AUTO_BUILD_QUEUE } from "../jobs/autoBuild";

// Phase 3 jobs (disabled until Phase 3 is active)
// import { runActivationGate, ACTIVATION_GATE_QUEUE } from "../jobs/activationGate";
// import { runOrchestrator, ORCHESTRATOR_QUEUE } from "../jobs/orchestrator";
// import { runQaReview, QA_REVIEW_QUEUE } from "../jobs/qaReview";
// import { processPmAgent, PM_AGENT_QUEUE } from "../jobs/pmAgent";
// import { processBuilderAgent, BUILDER_AGENT_QUEUE } from "../jobs/builderAgent";

declare global {
  // eslint-disable-next-line no-var
  var __croWorkersStarted: boolean | undefined;
}

export async function ensureWorkersStarted() {
  if (global.__croWorkersStarted) return;
  global.__croWorkersStarted = true;

  if (!process.env.DATABASE_URL_UNPOOLED) {
    console.warn("[workers] DATABASE_URL_UNPOOLED not set — background workers disabled");
    return;
  }

  try {
    const boss = await getBoss();

    // Phase 2 workers
    await boss.work<{ shopId: string }>(DATA_SYNC_QUEUE, async (jobs) => {
      for (const job of jobs) await runDataSync(job.data.shopId);
    });

    await boss.work<{ shopId: string }>(RESEARCH_SYNTHESIS_QUEUE, async (jobs) => {
      for (const job of jobs) await runResearchSynthesis(job.data.shopId);
    });

    await boss.work<{ shopId: string; reportId: string }>(HYPOTHESIS_GENERATOR_QUEUE, async (jobs) => {
      for (const job of jobs) await runHypothesisGenerator(job.data.shopId, job.data.reportId);
    });

    await boss.work<{ experimentId: string }>(RESULT_REFRESH_QUEUE, async (jobs) => {
      for (const job of jobs) await processResultRefresh(job.data.experimentId);
    });

    await boss.work<{ shopId: string; hypothesisId: string }>(AUTO_BUILD_QUEUE, async (jobs) => {
      for (const job of jobs) await runAutoBuild(job.data.shopId, job.data.hypothesisId);
    });

    // Register scheduled cron jobs
    await registerSchedules();

    console.log("[workers] pg-boss workers started (5 Phase 2 workers + scheduler)");
  } catch (error) {
    console.error("[workers] failed to start workers", error);
    global.__croWorkersStarted = false;
  }
}

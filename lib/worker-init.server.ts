declare global {
  // eslint-disable-next-line no-var
  var __croWorkersStarted: boolean | undefined;
}

export async function ensureWorkersStarted() {
  if (global.__croWorkersStarted) return;
  global.__croWorkersStarted = true;

  if (!process.env.REDIS_URL) {
    console.warn("[workers] REDIS_URL not set — background workers disabled");
    return;
  }

  try {
    // Phase 2 workers + autoBuild (needed for hypothesis promotion).
    // Orchestrator, activationGate, qaReview, pmAgent, builderAgent remain
    // disabled to stay within Upstash free tier (500k commands/day).
    const [
      { startResultRefreshWorker },
      { startSchedulerWorker, registerSchedules },
      { startDataSyncWorker },
      { startResearchSynthesisWorker },
      { startHypothesisGeneratorWorker },
      { startAutoBuildWorker },
    ] = await Promise.all([
      import("../jobs/resultRefresh"),
      import("../jobs/scheduler"),
      import("../jobs/dataSync"),
      import("../jobs/researchSynthesis"),
      import("../jobs/hypothesisGenerator"),
      import("../jobs/autoBuild"),
    ]);

    startResultRefreshWorker();
    startSchedulerWorker();
    startDataSyncWorker();
    startResearchSynthesisWorker();
    startHypothesisGeneratorWorker();
    startAutoBuildWorker();
    await registerSchedules();

    console.log("[workers] Phase 2 BullMQ workers started (6 workers)");
  } catch (error) {
    console.error("[workers] failed to start workers", error);
    global.__croWorkersStarted = false;
  }
}

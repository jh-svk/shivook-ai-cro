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
    // Phase 2 workers only — Phase 3 workers (orchestrator, autoBuild,
    // activationGate, qaReview, pmAgent, builderAgent) disabled to stay
    // within Upstash free tier (500k commands/day). Enable when Phase 3 is active.
    const [
      { startResultRefreshWorker },
      { startSchedulerWorker, registerSchedules },
      { startDataSyncWorker },
      { startResearchSynthesisWorker },
      { startHypothesisGeneratorWorker },
    ] = await Promise.all([
      import("../jobs/resultRefresh"),
      import("../jobs/scheduler"),
      import("../jobs/dataSync"),
      import("../jobs/researchSynthesis"),
      import("../jobs/hypothesisGenerator"),
    ]);

    startResultRefreshWorker();
    startSchedulerWorker();
    startDataSyncWorker();
    startResearchSynthesisWorker();
    startHypothesisGeneratorWorker();
    await registerSchedules();

    console.log("[workers] Phase 2 BullMQ workers started (5 workers)");
  } catch (error) {
    console.error("[workers] failed to start workers", error);
    global.__croWorkersStarted = false;
  }
}

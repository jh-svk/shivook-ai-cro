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

    console.log("[workers] all BullMQ workers started");
  } catch (error) {
    console.error("[workers] failed to start workers", error);
    global.__croWorkersStarted = false;
  }
}

// Starts BullMQ workers once per process, using a global flag to survive
// HMR module reloads in development.
declare global {
  // eslint-disable-next-line no-var
  var __croWorkersStarted: boolean | undefined;
}

export async function ensureWorkersStarted() {
  if (global.__croWorkersStarted) return;
  global.__croWorkersStarted = true;

  // Dynamic imports so Redis/BullMQ is only loaded if REDIS_URL is set.
  // The app still boots without Redis; workers just won't run.
  if (!process.env.REDIS_URL) {
    console.warn("[workers] REDIS_URL not set — background workers disabled");
    return;
  }

  try {
    const { startResultRefreshWorker } = await import("../jobs/resultRefresh");
    const { startSchedulerWorker, registerHourlySchedule } = await import(
      "../jobs/scheduler"
    );

    startResultRefreshWorker();
    startSchedulerWorker();
    await registerHourlySchedule();

    console.log("[workers] BullMQ workers started");
  } catch (error) {
    console.error("[workers] failed to start workers", error);
    global.__croWorkersStarted = false;
  }
}

/**
 * Singleton pg-boss instance.
 * Uses DATABASE_URL_UNPOOLED — pg-boss requires a direct Postgres connection
 * (not PgBouncer) because it uses LISTEN/NOTIFY for job pickup.
 */

import { PgBoss } from "pg-boss";

declare global {
  // eslint-disable-next-line no-var
  var __pgBoss: PgBoss | undefined;
}

let startPromise: Promise<PgBoss> | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (global.__pgBoss) return global.__pgBoss;

  if (!startPromise) {
    const url = process.env.DATABASE_URL_UNPOOLED;
    if (!url) throw new Error("DATABASE_URL_UNPOOLED is required for pg-boss");

    startPromise = (async () => {
      const boss = new PgBoss({
        connectionString: url,
        // Keep polling intervals generous to avoid hammering Neon
        monitorIntervalSeconds: 120,
        maintenanceIntervalSeconds: 120,
      });
      await boss.start();
      global.__pgBoss = boss;
      console.log("[pgboss] started");
      return boss;
    })();
  }

  return startPromise;
}

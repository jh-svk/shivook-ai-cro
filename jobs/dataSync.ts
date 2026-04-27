import { Queue, Worker, type Job } from "bullmq";
import { connection } from "../lib/queue";
import { fetchGA4Snapshot, type GA4Config } from "../lib/connectors/ga4.server";
import { fetchShopifyFunnelSnapshot } from "../lib/connectors/shopifyAdmin.server";
import { fetchClaritySnapshot, type ClarityConfig } from "../lib/connectors/clarity.server";
import { extractStoreBranding } from "../lib/brandExtractor.server";
import prisma from "../app/db.server";

export const DATA_SYNC_QUEUE = "data-sync";

export interface DataSyncJobData {
  shopId: string;
}

export const dataSyncQueue = new Queue<DataSyncJobData>(DATA_SYNC_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
  },
});

async function runDataSync(shopId: string) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: { dataSources: true },
  });
  if (!shop) return;

  const snapshot: Record<string, unknown> = {};

  // Shopify funnel data — always available (we have the access token)
  try {
    snapshot.shopifyFunnel = await fetchShopifyFunnelSnapshot(shop);
  } catch (err) {
    console.error(`[dataSync] Shopify connector failed for ${shop.shopifyDomain}`, err);
  }

  // Our own events funnel (add_to_cart, checkout_started, purchase counts)
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [addToCart, checkoutStarted, purchases] = await Promise.all([
      prisma.event.count({ where: { experiment: { shopId }, eventType: "add_to_cart", occurredAt: { gte: thirtyDaysAgo } } }),
      prisma.event.count({ where: { experiment: { shopId }, eventType: "checkout_started", occurredAt: { gte: thirtyDaysAgo } } }),
      prisma.event.count({ where: { experiment: { shopId }, eventType: "purchase", occurredAt: { gte: thirtyDaysAgo } } }),
    ]);
    snapshot.cro_funnel = { addToCart, checkoutStarted, purchases };
  } catch (err) {
    console.error(`[dataSync] events funnel failed for shop ${shopId}`, err);
  }

  // GA4 — only if a GA4 data source is configured
  const ga4Source = shop.dataSources.find((s) => s.type === "ga4");
  if (ga4Source) {
    try {
      const config = ga4Source.config as unknown as GA4Config;
      snapshot.ga4 = await fetchGA4Snapshot(config);
    } catch (err) {
      console.error(`[dataSync] GA4 connector failed for ${shop.shopifyDomain}`, err);
    }
  }

  // Clarity — only if a Clarity data source is configured
  const claritySource = shop.dataSources.find((s) => s.type === "clarity");
  if (claritySource) {
    try {
      const config = claritySource.config as unknown as ClarityConfig;
      snapshot.clarity = await fetchClaritySnapshot(config);
    } catch (err) {
      console.error(`[dataSync] Clarity connector failed for ${shop.shopifyDomain}`, err);
    }
  }

  // Update lastSyncedAt on all data sources for this shop
  await prisma.dataSource.updateMany({
    where: { shopId },
    data: { lastSyncedAt: new Date() },
  });

  // Store the snapshot in the dedicated dataSnapshot field
  await prisma.shop.update({
    where: { id: shopId },
    data: { dataSnapshot: snapshot as object },
  });

  // Refresh brand tokens from the active theme
  const freshShop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (freshShop) {
    await extractStoreBranding(freshShop).catch((err) =>
      console.error(`[dataSync] brand extraction failed for ${shop.shopifyDomain}`, err)
    );
  }

  console.log(`[dataSync] completed for shop ${shop.shopifyDomain}`);
}

export function startDataSyncWorker() {
  return new Worker<DataSyncJobData>(
    DATA_SYNC_QUEUE,
    async (job: Job<DataSyncJobData>) => {
      await runDataSync(job.data.shopId);
    },
    { connection }
  );
}

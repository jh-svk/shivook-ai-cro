import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  try {
    const shopRecord = await prisma.shop.findUnique({
      where: { shopifyDomain: shop },
      select: { id: true },
    });

    if (shopRecord) {
      // Cancel subscription (prevent post-uninstall billing)
      await prisma.subscription.updateMany({
        where: { shopId: shopRecord.id },
        data: { status: "cancelled", cancelledAt: new Date() },
      });

      // Conclude all active/paused experiments (no ghost experiments)
      const updated = await prisma.experiment.updateMany({
        where: { shopId: shopRecord.id, status: { in: ["active", "paused"] } },
        data: { status: "concluded", concludedAt: new Date() },
      });

      console.log(`[app.uninstalled] shop ${shop}: subscription cancelled, ${updated.count} experiments concluded`);
    }
  } catch (err) {
    console.error("[app.uninstalled] cleanup error", err);
  }

  return new Response();
};

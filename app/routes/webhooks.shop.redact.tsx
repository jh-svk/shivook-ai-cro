import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// GDPR: redact all shop data 48 hours after app uninstall.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`[${topic}] shop redact received for ${shop}`);

  try {
    const shopRecord = await prisma.shop.findUnique({
      where: { shopifyDomain: shop },
      select: { id: true },
    });
    if (shopRecord) {
      // Delete all experiment data for this shop (cascades via FK constraints)
      await prisma.experiment.deleteMany({ where: { shopId: shopRecord.id } });
      await prisma.shop.delete({ where: { id: shopRecord.id } });
    }
    await prisma.session.deleteMany({ where: { shop } });
  } catch (error) {
    console.error(`[${topic}] error during shop redact for ${shop}`, error);
  }

  return new Response(null, { status: 200 });
};

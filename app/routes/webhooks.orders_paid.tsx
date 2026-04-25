import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

interface OrderPayload {
  checkout_token?: string;
  total_price?: string;
  currency?: string;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`[${topic}] webhook received for ${shop}`);

  const order = payload as OrderPayload;
  const checkoutToken = order?.checkout_token;
  const revenue = order?.total_price ? parseFloat(order.total_price) : null;

  if (!checkoutToken) {
    return new Response(null, { status: 200 });
  }

  try {
    // Find checkout_started events that recorded this checkout token.
    // Each row gives us the experiment/variant/visitor/session for the purchase.
    const checkoutEvents = await prisma.event.findMany({
      where: { checkoutToken, eventType: "checkout_started" },
      select: {
        experimentId: true,
        variantId: true,
        visitorId: true,
        sessionId: true,
      },
    });

    if (checkoutEvents.length === 0) {
      return new Response(null, { status: 200 });
    }

    // Create one purchase event per checkout_started row (one per experiment).
    // Revenue is attached only to the first purchase event to avoid double-counting
    // when a visitor was in multiple experiments simultaneously.
    await prisma.event.createMany({
      data: checkoutEvents.map((e, idx) => ({
        experimentId: e.experimentId,
        variantId: e.variantId,
        visitorId: e.visitorId,
        sessionId: e.sessionId,
        eventType: "purchase",
        revenue: idx === 0 ? revenue : null,
        checkoutToken,
      })),
      skipDuplicates: true,
    });
  } catch (error) {
    console.error("[webhooks.orders_paid] error", error);
    // Return 200 so Shopify doesn't retry indefinitely — we'll catch up on next result refresh
    return new Response(null, { status: 200 });
  }

  return new Response(null, { status: 200 });
};

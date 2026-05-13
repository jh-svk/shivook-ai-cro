import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { verifyProxySignature } from "../../lib/proxy.server";

const VALID_EVENT_TYPES = new Set([
  "view",
  "add_to_cart",
  "checkout_started",
  "purchase",
]);

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  const url = new URL(request.url);

  if (!verifyProxySignature(url.searchParams)) {
    return new Response(null, { status: 401 });
  }

  // The proxy signature proves shop identity — resolve to a DB ID to scope event writes
  const shopDomain = url.searchParams.get("shop");
  if (!shopDomain) return new Response(null, { status: 400 });
  const shopRecord = await prisma.shop.findUnique({
    where: { shopifyDomain: shopDomain },
    select: { id: true },
  });
  if (!shopRecord) return new Response(null, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(null, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return new Response(null, { status: 400 });
  }

  const {
    experimentId,
    variantId,
    visitorId,
    sessionId,
    eventType,
    revenue,
    checkoutToken,
  } = body as Record<string, unknown>;

  if (
    typeof experimentId !== "string" ||
    typeof variantId !== "string" ||
    typeof visitorId !== "string" ||
    typeof sessionId !== "string" ||
    typeof eventType !== "string"
  ) {
    return new Response(null, { status: 400 });
  }

  if (!VALID_EVENT_TYPES.has(eventType)) {
    return new Response(null, { status: 400 });
  }

  try {
    // Verify experiment belongs to the signing shop before writing
    const variant = await prisma.variant.findFirst({
      where: { id: variantId, experimentId, experiment: { shopId: shopRecord.id } },
      select: { id: true },
    });

    if (!variant) {
      return new Response(null, { status: 404 });
    }

    await prisma.event.create({
      data: {
        experimentId,
        variantId,
        visitorId,
        sessionId,
        eventType,
        revenue: typeof revenue === "number" ? revenue : null,
        checkoutToken: typeof checkoutToken === "string" ? checkoutToken : null,
      },
    });

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("[api.events] error", error);
    return new Response(null, { status: 500 });
  }
};

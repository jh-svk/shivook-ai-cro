import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

interface SubscriptionPayload {
  app_subscription?: {
    admin_graphql_api_id: string;
    name: string;
    status: string;
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`[${topic}] subscription webhook for ${shop}`);

  const data = payload as SubscriptionPayload;
  const sub = data?.app_subscription;
  if (!sub) return new Response(null, { status: 200 });

  const gid = sub.admin_graphql_api_id;
  const chargeId = gid.split("/").pop() ?? "";

  const statusMap: Record<string, string> = {
    ACTIVE:    "active",
    PENDING:   "pending",
    CANCELLED: "cancelled",
    DECLINED:  "cancelled",
    EXPIRED:   "cancelled",
    FROZEN:    "frozen",
  };

  const dbStatus = statusMap[sub.status.toUpperCase()] ?? "active";

  try {
    await prisma.subscription.updateMany({
      where: { shopifyChargeId: chargeId },
      data: {
        status:      dbStatus,
        cancelledAt: dbStatus === "cancelled" ? new Date() : undefined,
      },
    });
  } catch (err) {
    console.error("[webhooks.app_subscriptions.update] error", err);
  }

  return new Response(null, { status: 200 });
};

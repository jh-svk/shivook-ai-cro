import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { findOrCreateShop } from "../../lib/shop.server";
import prisma from "../db.server";

const SUBSCRIPTION_QUERY = `
  query GetAppSubscription($id: ID!) {
    node(id: $id) {
      ... on AppSubscription {
        id
        status
        name
        createdAt
        trialDays
        currentPeriodEnd
      }
    }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop, session.accessToken ?? "");

  const url = new URL(request.url);
  const chargeId = url.searchParams.get("charge_id");
  const plan = url.searchParams.get("plan") ?? "starter";

  if (!chargeId) {
    return redirect("/app/billing");
  }

  const gid = `gid://shopify/AppSubscription/${chargeId}`;

  try {
    const response = await admin.graphql(SUBSCRIPTION_QUERY, {
      variables: { id: gid },
    });

    const data = await response.json() as {
      data: {
        node: {
          id: string;
          status: string;
          name: string;
          createdAt: string;
          trialDays: number;
          currentPeriodEnd: string | null;
        } | null;
      };
    };

    const sub = data.data.node;
    if (!sub) {
      console.error("[billing.callback] subscription not found:", gid);
      return redirect("/app/billing");
    }

    const statusMap: Record<string, string> = {
      ACTIVE:    "active",
      PENDING:   "pending",
      CANCELLED: "cancelled",
      DECLINED:  "cancelled",
      EXPIRED:   "cancelled",
      FROZEN:    "frozen",
    };

    const dbStatus = statusMap[sub.status] ?? "pending";

    // Trial ends at = createdAt + trialDays
    const createdAt = new Date(sub.createdAt);
    const trialEndsAt =
      sub.trialDays > 0
        ? new Date(createdAt.getTime() + sub.trialDays * 24 * 60 * 60 * 1000)
        : null;

    await prisma.subscription.upsert({
      where: { shopId: shop.id },
      create: {
        shopId:         shop.id,
        shopifyChargeId: chargeId,
        plan,
        status:         dbStatus,
        trialEndsAt,
        activatedAt:    dbStatus === "active" ? new Date() : null,
      },
      update: {
        shopifyChargeId: chargeId,
        plan,
        status:         dbStatus,
        trialEndsAt,
        activatedAt:    dbStatus === "active" ? new Date() : undefined,
        cancelledAt:    dbStatus === "cancelled" ? new Date() : undefined,
      },
    });

    console.log(`[billing.callback] subscription ${gid} → plan=${plan} status=${dbStatus}`);
  } catch (err) {
    console.error("[billing.callback] error", err);
  }

  return redirect("/app");
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

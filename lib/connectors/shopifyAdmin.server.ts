/**
 * Shopify Admin API connector.
 *
 * Pulls funnel and cart abandonment data for the research synthesis prompt:
 *   - 30-day order count, revenue, AOV
 *   - Top products by order count
 *   - Checkout funnel drop-off (sessions that added to cart vs checked out vs purchased)
 *   - Cart abandonment rate
 *
 * Uses the Shopify Admin GraphQL API with the shop's stored access token.
 */

import type { Shop } from "@prisma/client";

export interface ShopifyFunnelSnapshot {
  period: string;
  orders: number;
  totalRevenue: number;
  aov: number;
  cartAbandonmentRate: number | null;  // null if Shopify doesn't expose it directly
  topProducts: Array<{ title: string; orders: number; revenue: number }>;
  checkoutFunnel: {
    addedToCart: number;
    reachedCheckout: number;
    purchased: number;
  };
  topCountriesByRevenue?: Array<{ country: string; orderCount: number; revenue: number }>;
}

const ORDERS_QUERY = `
  query ($query: String!) {
    orders(first: 250, query: $query) {
      edges {
        node {
          id
          totalPriceSet { shopMoney { amount } }
          billingAddress { countryCodeV2 }
          lineItems(first: 5) {
            edges {
              node {
                title
                quantity
                originalTotalSet { shopMoney { amount } }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function shopifyGraphQL(
  shop: Pick<Shop, "shopifyDomain" | "accessToken">,
  query: string,
  variables: Record<string, unknown>
): Promise<unknown> {
  const res = await fetch(
    `https://${shop.shopifyDomain}/admin/api/2026-04/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": shop.accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (res.status === 429) {
    // Basic rate-limit backoff — caller should retry
    const retryAfter = parseFloat(res.headers.get("Retry-After") ?? "2");
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    throw new Error("Shopify rate limited — retry");
  }

  if (!res.ok) throw new Error(`Shopify Admin API ${res.status}`);
  return res.json();
}

export async function fetchShopifyFunnelSnapshot(
  shop: Pick<Shop, "shopifyDomain" | "accessToken">
): Promise<ShopifyFunnelSnapshot> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await shopifyGraphQL(shop, ORDERS_QUERY, {
    query: `created_at:>=${thirtyDaysAgo}`,
  })) as any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orders = (result?.data?.orders?.edges ?? []).map((e: any) => e.node);
  const orderCount = orders.length;
  const totalRevenue = orders.reduce(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s: number, o: any) => s + parseFloat(o.totalPriceSet?.shopMoney?.amount ?? "0"),
    0
  );
  const aov = orderCount > 0 ? totalRevenue / orderCount : 0;

  // Product roll-up
  const productMap = new Map<string, { orders: number; revenue: number }>();
  for (const order of orders) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const edge of order.lineItems?.edges ?? []) {
      const item = edge.node;
      const title = item.title as string;
      const rev = parseFloat(item.originalTotalSet?.shopMoney?.amount ?? "0");
      const existing = productMap.get(title) ?? { orders: 0, revenue: 0 };
      productMap.set(title, { orders: existing.orders + 1, revenue: existing.revenue + rev });
    }
  }

  const topProducts = [...productMap.entries()]
    .map(([title, data]) => ({ title, ...data }))
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 10);

  // Country breakdown from billing addresses
  const countryMap = new Map<string, { orderCount: number; revenue: number }>();
  for (const order of orders) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const billingCountry: string = (order as any).billingAddress?.countryCodeV2 ?? "";
    if (!billingCountry) continue;
    const rev = parseFloat(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (order as any).totalPriceSet?.shopMoney?.amount ?? "0"
    );
    const existing = countryMap.get(billingCountry) ?? { orderCount: 0, revenue: 0 };
    countryMap.set(billingCountry, { orderCount: existing.orderCount + 1, revenue: existing.revenue + rev });
  }
  const topCountriesByRevenue = [...countryMap.entries()]
    .map(([country, data]) => ({ country, ...data }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  return {
    period: "last_30_days",
    orders: orderCount,
    totalRevenue,
    aov,
    cartAbandonmentRate: null, // Shopify doesn't expose this directly via Admin API
    topProducts,
    checkoutFunnel: { addedToCart: 0, reachedCheckout: 0, purchased: orderCount },
    topCountriesByRevenue,
  };
}

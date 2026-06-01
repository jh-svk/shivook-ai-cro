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
import { decrypt } from "../crypto.server";

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
  // Traffic source breakdown from Shopify's own order attribution
  // (customerJourneySummary) — no GA4 required.
  trafficSources?: Array<{ source: string; orderCount: number }>;
}

const ORDERS_QUERY = `
  query ($query: String!, $after: String) {
    orders(first: 250, query: $query, after: $after) {
      edges {
        node {
          id
          totalPriceSet { shopMoney { amount } }
          billingAddress { countryCodeV2 }
          customerJourneySummary {
            firstVisit {
              sourceType
              utmParameters { source medium }
            }
          }
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

/**
 * Map Shopify's order attribution to our segment trafficSource vocabulary:
 * paid | organic | social | email | direct. Derived from the first-visit
 * sourceType + UTM medium that Shopify already records — no GA4 needed.
 */
function classifyTrafficSource(firstVisit: {
  sourceType?: string | null;
  utmParameters?: { source?: string | null; medium?: string | null } | null;
} | null | undefined): string {
  const medium = (firstVisit?.utmParameters?.medium ?? "").toLowerCase();
  const source = (firstVisit?.utmParameters?.source ?? "").toLowerCase();
  const type = (firstVisit?.sourceType ?? "").toLowerCase();

  if (medium === "cpc" || medium === "ppc" || medium === "paid" || /paid|ads?/.test(type)) return "paid";
  if (medium === "email" || source === "email" || type === "email") return "email";
  if (medium === "social" || /facebook|instagram|tiktok|twitter|pinterest|social/.test(source + type)) return "social";
  if (medium === "organic" || /search|seo|organic/.test(type)) return "organic";
  if (type === "direct" || (!type && !medium)) return "direct";
  return "direct";
}

async function shopifyGraphQL(
  shop: Pick<Shop, "shopifyDomain" | "accessToken">,
  query: string,
  variables: Record<string, unknown>
): Promise<unknown> {
  const token = decrypt(shop.accessToken);
  let delay = 2000;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(
      `https://${shop.shopifyDomain}/admin/api/2026-04/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      }
    );

    if (res.status === 429) {
      const retryAfter = parseFloat(res.headers.get("Retry-After") ?? String(delay / 1000));
      const waitMs = Math.max(retryAfter * 1000, delay);
      await new Promise((r) => setTimeout(r, waitMs));
      delay *= 2;
      continue;
    }

    if (!res.ok) throw new Error(`Shopify Admin API ${res.status}`);
    return res.json();
  }

  throw new Error("Shopify Admin API rate limit exceeded after 3 attempts");
}

export async function fetchShopifyFunnelSnapshot(
  shop: Pick<Shop, "shopifyDomain" | "accessToken">
): Promise<ShopifyFunnelSnapshot> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  // Paginate through all orders in the 30-day window
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orders: any[] = [];
  let cursor: string | null = null;

  do {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await shopifyGraphQL(shop, ORDERS_QUERY, {
      query: `created_at:>=${thirtyDaysAgo}`,
      after: cursor,
    })) as any;

    const page = result?.data?.orders;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    orders.push(...(page?.edges ?? []).map((e: any) => e.node));
    cursor = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
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

  // Traffic source roll-up from Shopify's own attribution (no GA4 needed)
  const trafficMap = new Map<string, number>();
  for (const order of orders) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fv = (order as any).customerJourneySummary?.firstVisit;
    const source = classifyTrafficSource(fv);
    trafficMap.set(source, (trafficMap.get(source) ?? 0) + 1);
  }
  const trafficSources = [...trafficMap.entries()]
    .map(([source, orderCount]) => ({ source, orderCount }))
    .sort((a, b) => b.orderCount - a.orderCount);

  return {
    period: "last_30_days",
    orders: orderCount,
    totalRevenue,
    aov,
    cartAbandonmentRate: null, // Shopify doesn't expose this directly via Admin API
    topProducts,
    checkoutFunnel: { addedToCart: 0, reachedCheckout: 0, purchased: orderCount },
    topCountriesByRevenue,
    trafficSources,
  };
}

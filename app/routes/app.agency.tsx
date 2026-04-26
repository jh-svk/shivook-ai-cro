import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { findOrCreateShop } from "../../lib/shop.server";
import { getShopPlan } from "../../lib/planGate.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const currentShop = await findOrCreateShop(session.shop, session.accessToken ?? "");
  const currentPlan = await getShopPlan(currentShop.id);

  if (currentPlan !== "pro") {
    return { allowed: false, shops: [], summary: null, currentPlan };
  }

  const allShops = await prisma.shop.findMany({
    include: {
      subscription: { select: { plan: true, status: true } },
      knowledgeBase: { select: { result: true } },
      _count: { select: { experiments: true } },
    },
  });

  const shopStats = await Promise.all(
    allShops.map(async (s) => {
      const activeCount = await prisma.experiment.count({
        where: { shopId: s.id, status: "active" },
      });
      const wins = s.knowledgeBase.filter((kb) => kb.result === "win").length;
      const concluded = s.knowledgeBase.length;
      return {
        id: s.id,
        domain: s.shopifyDomain,
        plan: s.subscription?.plan ?? "none",
        activeTests: activeCount,
        totalExperiments: s._count.experiments,
        winRate: concluded > 0 ? Math.round((wins / concluded) * 100) : null,
      };
    })
  );

  const totalActive = shopStats.reduce((acc, s) => acc + s.activeTests, 0);
  const totalWins    = allShops.reduce((acc, s) => acc + s.knowledgeBase.filter((kb) => kb.result === "win").length, 0);
  const totalConc    = allShops.reduce((acc, s) => acc + s.knowledgeBase.length, 0);

  return {
    allowed: true,
    shops: shopStats,
    summary: {
      totalStores: allShops.length,
      totalActive,
      portfolioWinRate: totalConc > 0 ? Math.round((totalWins / totalConc) * 100) : null,
    },
    currentPlan,
  };
};

export default function AgencyDashboard() {
  const data = useLoaderData<typeof loader>();

  if (!data.allowed) {
    return (
      <s-page heading="Agency Dashboard">
        <s-section heading="Pro plan required">
          <s-paragraph>
            The agency dashboard is available on the Pro plan ($199/month). It gives you a
            single view of all stores using this app.
          </s-paragraph>
          <s-button type="button" variant="primary" href="/app/billing">
            Upgrade to Pro
          </s-button>
        </s-section>
      </s-page>
    );
  }

  const { shops, summary } = data;

  return (
    <s-page heading="Agency Dashboard">
      <s-button slot="primary-action" type="button" variant="tertiary" href="/app">
        Back
      </s-button>

      {summary && (
        <s-section heading="Portfolio summary">
          <s-stack direction="inline" gap="base">
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small">
                <s-heading>{summary.totalStores}</s-heading>
                <s-text>Total stores</s-text>
              </s-stack>
            </s-box>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small">
                <s-heading>{summary.totalActive}</s-heading>
                <s-text>Active tests</s-text>
              </s-stack>
            </s-box>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small">
                <s-heading>
                  {summary.portfolioWinRate != null ? `${summary.portfolioWinRate}%` : "—"}
                </s-heading>
                <s-text>Portfolio win rate</s-text>
              </s-stack>
            </s-box>
          </s-stack>
        </s-section>
      )}

      <s-section heading={`Stores (${shops.length})`}>
        {shops.length === 0 ? (
          <s-paragraph>No stores installed yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row slot="header">
              <s-table-header>Store</s-table-header>
              <s-table-header>Plan</s-table-header>
              <s-table-header format="numeric">Active tests</s-table-header>
              <s-table-header format="numeric">All-time tests</s-table-header>
              <s-table-header format="numeric">Win rate</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {shops.map((shop) => (
                <s-table-row key={shop.id}>
                  <s-table-cell>
                    <s-link href={`https://${shop.domain}/admin/apps`} target="_blank">
                      {shop.domain}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={shop.plan === "pro" ? "success" : shop.plan === "growth" ? "info" : "neutral"}>
                      {shop.plan}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{shop.activeTests}</s-table-cell>
                  <s-table-cell>{shop.totalExperiments}</s-table-cell>
                  <s-table-cell>{shop.winRate != null ? `${shop.winRate}%` : "—"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

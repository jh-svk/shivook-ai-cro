import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { findOrCreateShop } from "../../lib/shop.server";
import { getSubscriptionStatus } from "../../lib/planGate.server";
import { PLANS } from "../../lib/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop, session.accessToken ?? "");
  const status = await getSubscriptionStatus(shop.id);
  return { shopId: shop.id, status };
};

const PLAN_FEATURES: Record<string, string[]> = {
  starter: ["Up to 5 concurrent A/B tests", "Manual experiment creation", "Results dashboard", "Bayesian stats"],
  growth:  ["Up to 10 concurrent tests", "Everything in Starter", "AI research pipeline", "ICE-scored hypothesis backlog", "One-click promote to experiment"],
  pro:     ["Up to 20 concurrent tests", "Everything in Growth", "Autonomous orchestrator", "AI auto-build variants", "Audience segmentation", "Agency dashboard"],
};

export default function BillingPage() {
  const { status } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Billing & Plans">
      <s-button slot="primary-action" type="button" variant="tertiary" href="/app">
        Back to experiments
      </s-button>

      {status.plan !== "none" && (
        <s-section heading="Current plan">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base">
              <s-badge tone="success">
                {status.plan === "trial" ? "Trial" : String(status.plan).charAt(0).toUpperCase() + String(status.plan).slice(1)}
              </s-badge>
              {status.trialDaysLeft != null && (
                <s-text>{status.trialDaysLeft} day{status.trialDaysLeft !== 1 ? "s" : ""} remaining in trial</s-text>
              )}
            </s-stack>
          </s-stack>
        </s-section>
      )}

      <s-section heading="Plans">
        <s-stack direction="inline" gap="base">
          {(Object.keys(PLANS) as Array<keyof typeof PLANS>).map((planKey) => {
            const plan = PLANS[planKey];
            const isCurrent = status.plan === planKey || (status.plan === "trial" && planKey === "starter");
            return (
              <s-box key={planKey} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="base">
                  <s-stack direction="inline" gap="base">
                    <s-heading>{plan.name}</s-heading>
                    {isCurrent && <s-badge tone="success">Current</s-badge>}
                  </s-stack>
                  <s-heading>${plan.price}/month</s-heading>
                  <s-stack direction="block" gap="small">
                    {PLAN_FEATURES[planKey].map((feature) => (
                      <s-text key={feature}>✓ {feature}</s-text>
                    ))}
                  </s-stack>
                  {!isCurrent && (
                    <form method="post" action="/app/billing/subscribe">
                      <input type="hidden" name="plan" value={planKey} />
                      <s-button type="submit" variant="primary">
                        {status.plan === "none" ? "Start 14-day free trial" : `Switch to ${plan.name}`}
                      </s-button>
                    </form>
                  )}
                </s-stack>
              </s-box>
            );
          })}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

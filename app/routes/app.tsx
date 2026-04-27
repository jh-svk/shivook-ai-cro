import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, redirect, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { findOrCreateShop } from "../../lib/shop.server";
import { getSubscriptionStatus, getShopPlan } from "../../lib/planGate.server";
import { extractStoreBranding } from "../../lib/brandExtractor.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const isOnboarding = url.pathname.startsWith("/app/onboarding");
  const isBillingRoute = url.pathname.startsWith("/app/billing");

  let subStatus: { plan: string; trialDaysLeft: number | null; hasSubscription: boolean } | null = null;
  let isPro = false;

  try {
    const shop = await findOrCreateShop(session.shop, session.accessToken ?? "");

    // Extract brand tokens on first install (fire-and-forget)
    const guardrails = (shop.brandGuardrails as Record<string, unknown>) ?? {};
    if (!guardrails.extractedAt) {
      extractStoreBranding(shop).catch(() => {});
    }

    // Redirect new installs to onboarding
    if (!shop.onboardingCompletedAt && !isOnboarding && !isBillingRoute) {
      throw redirect("/app/onboarding");
    }

    subStatus = await getSubscriptionStatus(shop.id);
    isPro = (await getShopPlan(shop.id)) === "pro";
  } catch (err) {
    if (err instanceof Response) throw err;
    // Non-critical — don't break the layout
  }

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", subStatus, isPro };
};

export default function App() {
  const { apiKey, subStatus, isPro } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Experiments</s-link>
        <s-link href="/app/hypotheses">AI Hypotheses</s-link>
        <s-link href="/app/segments">Segments</s-link>
        {isPro && <s-link href="/app/agency">Agency</s-link>}
        <s-link href="/app/billing">Billing</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>

      {subStatus && !subStatus.hasSubscription && (
        <s-banner tone="warning" heading="No active subscription">
          <s-paragraph>
            Subscribe to unlock A/B testing.{" "}
            <s-link href="/app/billing">Choose a plan →</s-link>
          </s-paragraph>
        </s-banner>
      )}
      {subStatus?.trialDaysLeft != null && subStatus.trialDaysLeft > 0 && (
        <s-banner tone="info" heading={`Trial: ${subStatus.trialDaysLeft} day${subStatus.trialDaysLeft !== 1 ? "s" : ""} remaining`} dismissible>
          <s-paragraph>
            <s-link href="/app/billing">Manage subscription →</s-link>
          </s-paragraph>
        </s-banner>
      )}

      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { findOrCreateShop } from "../../lib/shop.server";
import { PLANS } from "../../lib/plans";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop, session.accessToken ?? "");

  const url = new URL(request.url);
  const step = parseInt(url.searchParams.get("step") ?? "1", 10);

  return {
    shopDomain: shop.shopifyDomain,
    step: Math.min(Math.max(step, 1), 5),
    brandGuardrails: (shop.brandGuardrails as Record<string, unknown>) ?? null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop, session.accessToken ?? "");

  const fd = await request.formData();
  const step = parseInt(String(fd.get("step") ?? "1"), 10);
  const intent = String(fd.get("intent") ?? "next");

  if (intent === "skip" || step >= 5) {
    // Complete onboarding
    await prisma.shop.update({
      where: { id: shop.id },
      data: { onboardingCompletedAt: new Date() },
    });
    return redirect("/app");
  }

  // Step 2: save connector credentials if provided
  if (step === 2) {
    const ga4PropertyId   = String(fd.get("ga4PropertyId") ?? "").trim();
    const clarityProjectId = String(fd.get("clarityProjectId") ?? "").trim();
    const clarityToken     = String(fd.get("clarityBearerToken") ?? "").trim();

    if (ga4PropertyId) {
      await prisma.dataSource.upsert({
        where: { id: `${shop.id}-ga4` },
        create: { id: `${shop.id}-ga4`, shopId: shop.id, type: "ga4", config: { propertyId: ga4PropertyId } },
        update: { config: { propertyId: ga4PropertyId } },
      }).catch(() =>
        prisma.dataSource.create({ data: { shopId: shop.id, type: "ga4", config: { propertyId: ga4PropertyId } } })
      );
    }
    if (clarityProjectId && clarityToken) {
      await prisma.dataSource.create({
        data: { shopId: shop.id, type: "clarity", config: { projectId: clarityProjectId, bearerToken: clarityToken } },
      }).catch(() => {});
    }
  }

  // Step 3: save brand guardrails if provided
  if (step === 3) {
    const raw = String(fd.get("brandGuardrails") ?? "").trim();
    if (raw) {
      try {
        const guardrails = JSON.parse(raw);
        const existing = (shop.brandGuardrails as Record<string, unknown>) ?? {};
        await prisma.shop.update({
          where: { id: shop.id },
          data: { brandGuardrails: { ...existing, ...guardrails } as object },
        });
      } catch {}
    }
  }

  return redirect(`/app/onboarding?step=${step + 1}`);
};

const GUARDRAIL_DEFAULT = JSON.stringify(
  { primary_colors: [], fonts: [], tone_of_voice: "", never_change: [], excluded_pages: [] },
  null,
  2
);

export default function Onboarding() {
  const { shopDomain, step, brandGuardrails } = useLoaderData<typeof loader>();
  const hasExtractedBrand = Boolean(brandGuardrails?.extractedAt);
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <s-page heading="Welcome to Shivook AI CRO">
      <s-stack direction="inline" gap="base" slot="primary-action">
        <s-text>Step {step} of 5</s-text>
      </s-stack>

      {step === 1 && (
        <s-section heading="Let's get started">
          <s-stack direction="block" gap="base">
            <s-paragraph>Shivook AI CRO helps you run autonomous A/B tests on your Shopify storefront.</s-paragraph>
            <s-stack direction="block" gap="small">
              <s-text>✓ AI generates hypotheses from your store data</s-text>
              <s-text>✓ Automatically builds and activates experiments</s-text>
              <s-text>✓ Ships winners, kills losers — no manual work</s-text>
            </s-stack>
            <Form method="post">
              <input type="hidden" name="step" value="1" />
              <input type="hidden" name="intent" value="next" />
              <s-button type="submit" variant="primary" {...(isSubmitting ? { loading: true } : {})}>
                Get started
              </s-button>
            </Form>
          </s-stack>
        </s-section>
      )}

      {step === 2 && (
        <s-section heading="Connect your data (optional)">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Connect GA4 and Clarity to supercharge the AI research pipeline. You can skip this and connect later in Settings.
            </s-paragraph>
            <Form method="post">
              <input type="hidden" name="step" value="2" />
              <input type="hidden" name="intent" value="next" />
              <s-stack direction="block" gap="base">
                <s-text-field name="ga4PropertyId" label="GA4 Property ID" placeholder="123456789" />
                <s-text-field name="clarityProjectId" label="Clarity Project ID" placeholder="abcde12345" />
                <s-text-field name="clarityBearerToken" label="Clarity Bearer Token" placeholder="Bearer token from Clarity dashboard" details="Token is stored encrypted-at-rest and never displayed again" />
                <s-button type="submit" variant="primary" {...(isSubmitting ? { loading: true } : {})}>
                  Save and continue
                </s-button>
              </s-stack>
            </Form>
            <Form method="post">
              <input type="hidden" name="step" value="2" />
              <input type="hidden" name="intent" value="skip" />
              <s-button type="submit" variant="secondary">
                Skip for now
              </s-button>
            </Form>
          </s-stack>
        </s-section>
      )}

      {step === 3 && (
        <s-section heading="Brand guardrails (optional)">
          <s-stack direction="block" gap="base">
            {hasExtractedBrand ? (
              <s-banner tone="success" heading="Brand settings auto-detected">
                <s-paragraph>
                  We automatically extracted your theme's brand settings. Review and adjust below.
                </s-paragraph>
              </s-banner>
            ) : (
              <s-paragraph>
                The AI uses these guardrails to keep generated variants on-brand. You can edit this anytime in Settings.
              </s-paragraph>
            )}
            <Form method="post">
              <input type="hidden" name="step" value="3" />
              <input type="hidden" name="intent" value="next" />
              <s-stack direction="block" gap="base">
                <s-text-area
                  name="brandGuardrails"
                  label="Brand guardrails (JSON)"
                  value={hasExtractedBrand ? JSON.stringify(brandGuardrails, null, 2) : GUARDRAIL_DEFAULT}
                  rows={8}
                />
                <s-button type="submit" variant="primary" {...(isSubmitting ? { loading: true } : {})}>
                  Save and continue
                </s-button>
              </s-stack>
            </Form>
            <Form method="post">
              <input type="hidden" name="step" value="3" />
              <input type="hidden" name="intent" value="skip" />
              <s-button type="submit" variant="secondary">
                Skip for now
              </s-button>
            </Form>
          </s-stack>
        </s-section>
      )}

      {step === 4 && (
        <s-section heading="Choose your plan">
          <s-stack direction="block" gap="base">
            <s-paragraph>All plans include a 14-day free trial. No credit card required until after the trial.</s-paragraph>
            <s-stack direction="inline" gap="base">
              {(Object.keys(PLANS) as Array<keyof typeof PLANS>).map((planKey) => {
                const plan = PLANS[planKey];
                return (
                  <s-box key={planKey} padding="base" borderWidth="base" borderRadius="base">
                    <s-stack direction="block" gap="base">
                      <s-heading>{plan.name}</s-heading>
                      <s-heading>${plan.price}/month</s-heading>
                      <form method="post" action="/app/billing/subscribe">
                        <input type="hidden" name="plan" value={planKey} />
                        <s-button type="submit" variant="primary">
                          Start 14-day free trial
                        </s-button>
                      </form>
                    </s-stack>
                  </s-box>
                );
              })}
            </s-stack>
            <Form method="post">
              <input type="hidden" name="step" value="4" />
              <input type="hidden" name="intent" value="skip" />
              <s-button type="submit" variant="secondary">
                I'll decide later (starts on Starter)
              </s-button>
            </Form>
          </s-stack>
        </s-section>
      )}

      {step === 5 && (
        <s-section heading="Install the theme extension">
          <Form method="post">
            <input type="hidden" name="step" value="5" />
            <s-stack direction="block" gap="base">
              <s-paragraph>
                The CRO Experiment Injector needs to be added to your theme so it can inject variants on your storefront.
              </s-paragraph>
              <s-stack direction="block" gap="small">
                <s-text>1. Open your theme editor:</s-text>
                <s-link href={`https://${shopDomain}/admin/themes/current/editor`} target="_blank">
                  https://{shopDomain}/admin/themes/current/editor
                </s-link>
                <s-text>2. Click "Add section" in the left panel</s-text>
                <s-text>3. Find "CRO Experiment Injector" and add it to the Body section</s-text>
                <s-text>4. Save the theme, then come back here</s-text>
              </s-stack>
              <input type="hidden" name="intent" value="skip" />
              <s-button type="submit" variant="primary" {...(isSubmitting ? { loading: true } : {})}>
                I've done this — take me to the dashboard
              </s-button>
            </s-stack>
          </Form>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

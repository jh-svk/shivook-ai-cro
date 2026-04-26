import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { PLANS } from "../../lib/plans";

type PlanKey = keyof typeof PLANS;

const SUBSCRIPTION_CREATE = `
  mutation AppSubscriptionCreate(
    $name: String!,
    $lineItems: [AppSubscriptionLineItemInput!]!,
    $returnUrl: URL!,
    $trialDays: Int,
    $test: Boolean
  ) {
    appSubscriptionCreate(
      name: $name,
      lineItems: $lineItems,
      returnUrl: $returnUrl,
      trialDays: $trialDays,
      test: $test
    ) {
      userErrors { field message }
      confirmationUrl
      appSubscription { id status }
    }
  }
`;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const fd = await request.formData();
  const plan = String(fd.get("plan")) as PlanKey;

  if (!PLANS[plan]) {
    return new Response("Invalid plan", { status: 400 });
  }

  const planConfig = PLANS[plan];
  const returnUrl = `${process.env.SHOPIFY_APP_URL}/app/billing/callback?plan=${plan}`;

  const response = await admin.graphql(SUBSCRIPTION_CREATE, {
    variables: {
      name: `Shivook AI CRO — ${planConfig.name}`,
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: { amount: planConfig.price, currencyCode: "USD" },
              interval: "EVERY_30_DAYS",
            },
          },
        },
      ],
      returnUrl,
      trialDays: 14,
      test: process.env.NODE_ENV !== "production",
    },
  });

  const data = await response.json() as {
    data: {
      appSubscriptionCreate: {
        userErrors: Array<{ field: string; message: string }>;
        confirmationUrl: string | null;
      };
    };
  };

  const { userErrors, confirmationUrl } = data.data.appSubscriptionCreate;

  if (userErrors.length > 0) {
    console.error("[billing.subscribe] userErrors", userErrors);
    return new Response(userErrors.map((e) => e.message).join(", "), { status: 400 });
  }

  if (!confirmationUrl) {
    return new Response("No confirmation URL returned from Shopify", { status: 500 });
  }

  return redirect(confirmationUrl);
};

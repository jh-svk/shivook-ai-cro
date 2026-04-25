import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { findOrCreateShop } from "../../lib/shop.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop, session.accessToken ?? "");
  return { shop };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop, session.accessToken ?? "");

  const fd = await request.formData();
  const slackWebhookUrl =
    String(fd.get("slackWebhookUrl") ?? "").trim() || null;
  const requireHumanApproval = fd.get("requireHumanApproval") === "true";
  const guardrailsRaw = String(fd.get("brandGuardrails") ?? "").trim();

  let brandGuardrails = null;
  if (guardrailsRaw) {
    try {
      brandGuardrails = JSON.parse(guardrailsRaw);
    } catch {
      return { error: "Brand guardrails must be valid JSON." };
    }
  }

  try {
    await prisma.shop.update({
      where: { id: shop.id },
      data: { slackWebhookUrl, requireHumanApproval, brandGuardrails },
    });
    return { success: true };
  } catch (error) {
    console.error("[settings] action error", error);
    return { error: "Failed to save settings. Please try again." };
  }
};

export default function Settings() {
  const { shop } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <s-page heading="Settings">
      {actionData?.success && (
        <s-banner tone="success" heading="Settings saved" dismissible>
          <s-paragraph>Your settings have been updated.</s-paragraph>
        </s-banner>
      )}
      {actionData?.error && (
        <s-banner tone="critical" heading="Could not save settings">
          <s-paragraph>{actionData.error}</s-paragraph>
        </s-banner>
      )}

      <Form method="post">
        <s-section heading="Notifications">
          <s-url-field
            name="slackWebhookUrl"
            label="Slack webhook URL"
            value={shop.slackWebhookUrl ?? ""}
            placeholder="https://hooks.slack.com/services/…"
            details="Receive experiment alerts and guardrail trips in Slack"
          />
        </s-section>

        <s-section heading="Brand guardrails">
          <s-text-area
            name="brandGuardrails"
            label="Guardrail config (JSON)"
            value={
              shop.brandGuardrails
                ? JSON.stringify(shop.brandGuardrails, null, 2)
                : ""
            }
            placeholder={'{\n  "aov_drop_threshold": 0.03\n}'}
            rows={8}
            details="AOV drop threshold defaults to 3% if not set"
          />
        </s-section>

        <s-section heading="Approvals">
          <s-switch
            name="requireHumanApproval"
            label="Require human approval before launching experiments"
            value="true"
            checked={shop.requireHumanApproval}
            details="Phase 3 feature — set this now to be ready when approval workflows launch"
          />
        </s-section>

        <s-section>
          <s-button
            type="submit"
            variant="primary"
            {...(isSubmitting ? { loading: true } : {})}
          >
            Save settings
          </s-button>
        </s-section>
      </Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

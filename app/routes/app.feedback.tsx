import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { findOrCreateShop } from "../../lib/shop.server";
import { pmAgentQueue } from "../../jobs/pmAgent";
import { useEffect, useState } from "react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop, session.accessToken ?? "");

  const feedbackRequests = await prisma.feedbackRequest.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
  });

  return { feedbackRequests };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop, session.accessToken ?? "");

  const fd = await request.formData();
  const intent = String(fd.get("intent"));

  if (intent === "submit") {
    const requestText = String(fd.get("requestText") ?? "").trim();
    if (!requestText) return { error: "Request text is required." };
    if (requestText.length > 2000)
      return { error: "Request text must be 2000 characters or fewer." };

    const record = await prisma.feedbackRequest.create({
      data: { shopId: shop.id, requestText },
    });

    await pmAgentQueue.add(`pm-${record.id}`, { feedbackId: record.id, shopId: shop.id });

    return { success: true };
  }

  return { error: "Unknown intent." };
};

type BadgeTone = "info" | "success" | "warning" | "critical";

function statusTone(s: string): BadgeTone {
  const map: Record<string, BadgeTone> = {
    submitted: "info",
    pm_analyzing: "info",
    building: "warning",
    testing: "warning",
    deploying: "warning",
    deployed: "success",
    failed: "critical",
  };
  return map[s] ?? "info";
}

function statusLabel(s: string): string {
  const map: Record<string, string> = {
    submitted: "Submitted",
    pm_analyzing: "PM Analyzing",
    building: "Building",
    testing: "Testing",
    deploying: "Deploying",
    deployed: "Deployed",
    failed: "Failed",
  };
  return map[s] ?? s;
}

export default function FeedbackPage() {
  const { feedbackRequests } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [showForm, setShowForm] = useState(false);

  const isSubmitting = navigation.state === "submitting";
  const allSettled =
    feedbackRequests.length === 0 ||
    feedbackRequests.every((r) => r.status === "deployed" || r.status === "failed");

  useEffect(() => {
    if (allSettled) return;
    const id = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 5000);
    return () => clearInterval(id);
  }, [revalidator, allSettled]);

  useEffect(() => {
    if (actionData && "success" in actionData && actionData.success) {
      setShowForm(false);
    }
  }, [actionData]);

  return (
    <s-page heading="Improvement Requests">
      <s-button
        slot="primary-action"
        type="button"
        variant="primary"
        onClick={() => setShowForm(true)}
      >
        Submit request
      </s-button>

      {actionData && "error" in actionData && actionData.error && (
        <s-banner tone="critical" heading="Error">
          <s-paragraph>{actionData.error}</s-paragraph>
        </s-banner>
      )}
      {actionData && "success" in actionData && actionData.success && (
        <s-banner tone="success" heading="Request submitted" dismissible>
          <s-paragraph>Your request is being analyzed by the PM agent.</s-paragraph>
        </s-banner>
      )}

      {showForm && (
        <s-section heading="New improvement request">
          <Form method="post">
            <input type="hidden" name="intent" value="submit" />
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Describe what you want to change, add, or fix. Be specific — the AI will plan and
                build it automatically.
              </s-paragraph>
              <textarea
                name="requestText"
                rows={6}
                maxLength={2000}
                placeholder="e.g. Add a chart showing daily conversion rate over time on the experiment detail page"
                style={{
                  width: "100%",
                  padding: "10px",
                  borderRadius: "6px",
                  border: "1px solid #c9cccf",
                  fontSize: "14px",
                  fontFamily: "inherit",
                  resize: "vertical",
                  boxSizing: "border-box",
                }}
              />
              <s-stack direction="inline" gap="base">
                <s-button
                  type="submit"
                  variant="primary"
                  {...(isSubmitting ? { loading: true } : {})}
                >
                  {isSubmitting ? "Submitting…" : "Submit request"}
                </s-button>
                <s-button type="button" variant="secondary" onClick={() => setShowForm(false)}>
                  Cancel
                </s-button>
              </s-stack>
            </s-stack>
          </Form>
        </s-section>
      )}

      <s-section heading={`Requests (${feedbackRequests.length})`}>
        {feedbackRequests.length === 0 ? (
          <s-paragraph>No improvement requests yet. Submit one above to get started.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {feedbackRequests.map((item) => (
              <s-box key={item.id} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="inline" gap="base">
                  <div style={{ flex: 1 }}>
                    <a href={`/app/feedback/${item.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                      <s-text>
                        {item.requestText.length > 120
                          ? item.requestText.slice(0, 120) + "…"
                          : item.requestText}
                      </s-text>
                    </a>
                    <s-paragraph>
                      {new Date(item.createdAt).toLocaleString()}
                    </s-paragraph>
                  </div>
                  <s-badge tone={statusTone(item.status)}>{statusLabel(item.status)}</s-badge>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(null);
}

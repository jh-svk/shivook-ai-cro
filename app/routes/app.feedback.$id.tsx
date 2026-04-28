import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { findOrCreateShop } from "../../lib/shop.server";
import { useEffect, useState } from "react";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop, session.accessToken ?? "");

  const feedbackRequest = await prisma.feedbackRequest.findFirst({
    where: { id: params.id, shopId: shop.id },
  });

  if (!feedbackRequest) {
    throw new Response("Not found", { status: 404 });
  }

  return { feedbackRequest };
};

const STEPS = [
  { key: "submitted", label: "Request submitted" },
  { key: "pm_analyzing", label: "PM analyzing" },
  { key: "building", label: "Building" },
  { key: "testing", label: "Testing" },
  { key: "deploying", label: "Deploying" },
  { key: "deployed", label: "Deployed" },
] as const;

function getStepIndex(status: string): number {
  const map: Record<string, number> = {
    submitted: 0,
    pm_analyzing: 1,
    building: 2,
    testing: 3,
    deploying: 4,
    deployed: 5,
  };
  return map[status] ?? 0;
}

type StepState = "complete" | "active" | "failed" | "pending";

function stepColor(state: StepState): string {
  if (state === "complete") return "#008060";
  if (state === "failed") return "#d72c0d";
  if (state === "active") return "#ffc453";
  return "#c9cccf";
}

function stepIcon(state: StepState): string {
  if (state === "complete") return "✓";
  if (state === "failed") return "✗";
  if (state === "active") return "●";
  return "○";
}

function resolveStepState(i: number, currentIndex: number, isFailed: boolean): StepState {
  if (isFailed) {
    // Mark "building" (index 2) as failed, prior steps as complete
    if (i < 2) return "complete";
    if (i === 2) return "failed";
    return "pending";
  }
  if (i < currentIndex) return "complete";
  if (i === currentIndex) return "active";
  return "pending";
}

export default function FeedbackDetailPage() {
  const { feedbackRequest } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [directiveOpen, setDirectiveOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const isDone =
    feedbackRequest.status === "deployed" || feedbackRequest.status === "failed";

  useEffect(() => {
    if (isDone) return;
    const id = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 5000);
    return () => clearInterval(id);
  }, [revalidator, isDone]);

  const currentIndex = getStepIndex(feedbackRequest.status);
  const isFailed = feedbackRequest.status === "failed";
  const title =
    feedbackRequest.requestText.length > 60
      ? feedbackRequest.requestText.slice(0, 60) + "…"
      : feedbackRequest.requestText;

  return (
    <s-page heading={title}>
      <s-button slot="primary-action" type="button" variant="secondary" href="/app/feedback">
        All requests
      </s-button>

      {isFailed && feedbackRequest.errorMessage && (
        <s-banner tone="critical" heading="Build failed">
          <s-paragraph>{feedbackRequest.errorMessage}</s-paragraph>
        </s-banner>
      )}

      {feedbackRequest.status === "deployed" && (
        <s-banner tone="success" heading="Deployed" dismissible>
          <s-paragraph>This improvement has been built and merged to main. Railway will deploy it automatically.</s-paragraph>
        </s-banner>
      )}

      <s-section heading="Pipeline status">
        <s-stack direction="block" gap="small">
          {STEPS.map((step, i) => {
            const state = resolveStepState(i, currentIndex, isFailed);
            return (
              <div
                key={step.key}
                style={{ display: "flex", alignItems: "center", gap: 12 }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: stepColor(state),
                    color: state === "active" ? "#202223" : "#fff",
                    fontSize: 13,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {stepIcon(state)}
                </span>
                <s-text>{step.label}</s-text>
              </div>
            );
          })}
        </s-stack>
      </s-section>

      <s-section heading="Request details">
        <s-stack direction="block" gap="small">
          <s-text>{feedbackRequest.requestText}</s-text>
          <s-paragraph>Submitted {new Date(feedbackRequest.createdAt).toLocaleString()}</s-paragraph>
          {feedbackRequest.deployedAt && (
            <s-paragraph>Deployed {new Date(feedbackRequest.deployedAt).toLocaleString()}</s-paragraph>
          )}
        </s-stack>
      </s-section>

      {feedbackRequest.prUrl && (
        <s-section heading="Pull Request">
          <a
            href={feedbackRequest.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#008060", fontWeight: 500 }}
          >
            View pull request →
          </a>
        </s-section>
      )}

      {feedbackRequest.pmDirective && (
        <s-section heading="PM Agent Plan">
          <s-stack direction="block" gap="small">
            <s-button
              type="button"
              variant="secondary"
              onClick={() => setDirectiveOpen((o) => !o)}
            >
              {directiveOpen ? "Hide plan" : "Show plan"}
            </s-button>
            {directiveOpen && (
              <div
                style={{
                  background: "#f6f6f7",
                  borderRadius: 6,
                  padding: 12,
                  overflow: "auto",
                  maxHeight: 400,
                }}
              >
                <pre
                  style={{
                    margin: 0,
                    fontFamily: "monospace",
                    fontSize: 12,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {feedbackRequest.pmDirective}
                </pre>
              </div>
            )}
          </s-stack>
        </s-section>
      )}

      {feedbackRequest.builderReport && (
        <s-section heading="Builder Report">
          <s-stack direction="block" gap="small">
            <s-button
              type="button"
              variant="secondary"
              onClick={() => setReportOpen((o) => !o)}
            >
              {reportOpen ? "Hide report" : "Show report"}
            </s-button>
            {reportOpen && (
              <div
                style={{
                  background: "#f6f6f7",
                  borderRadius: 6,
                  padding: 12,
                  overflow: "auto",
                  maxHeight: 400,
                }}
              >
                <pre
                  style={{
                    margin: 0,
                    fontFamily: "monospace",
                    fontSize: 12,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {feedbackRequest.builderReport}
                </pre>
              </div>
            )}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(null);
}

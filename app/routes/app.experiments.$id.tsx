import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { canActivateExperiment } from "../../lib/concurrentTestManager.server";

type BadgeTone = "info" | "success" | "warning" | "neutral" | "critical";

const STATUS_TONE: Record<string, BadgeTone> = {
  draft: "info",
  active: "success",
  paused: "warning",
  concluded: "neutral",
  pending_approval: "warning",
};

const ALLOWED_ACTIONS: Record<
  string,
  { label: string; intent: string; variant: "primary" | "secondary"; tone?: "critical" }[]
> = {
  draft: [{ label: "Activate", intent: "activate", variant: "primary" }],
  active: [
    { label: "Pause", intent: "pause", variant: "secondary" },
    { label: "End test", intent: "end", variant: "secondary", tone: "critical" },
  ],
  paused: [
    { label: "Resume", intent: "resume", variant: "primary" },
    { label: "End test", intent: "end", variant: "secondary", tone: "critical" },
  ],
  concluded: [],
  pending_approval: [
    { label: "Approve & activate", intent: "approve", variant: "primary" },
    { label: "Reject", intent: "reject_approval", variant: "secondary", tone: "critical" },
  ],
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    const [experiment, shop] = await Promise.all([
      prisma.experiment.findUnique({
        where: { id: params.id },
        include: { variants: true, result: true, segment: true },
      }),
      prisma.shop.findUnique({
        where: { shopifyDomain: session.shop },
        select: { shopifyDomain: true },
      }),
    ]);
    if (!experiment) throw new Response("Not Found", { status: 404 });

    // Load QA log for pending_approval experiments
    const qaLog = experiment.status === "pending_approval"
      ? await prisma.orchestratorLog.findFirst({
          where: { shopId: experiment.shopId, stage: "QA", runId: params.id },
          orderBy: { startedAt: "desc" },
        })
      : null;

    return { experiment, qaLog, shopDomain: shop?.shopifyDomain ?? "" };
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[experiments.$id] loader error", error);
    throw new Response("Server Error", { status: 500 });
  }
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  await authenticate.admin(request);

  const fd = await request.formData();
  const intent = String(fd.get("intent"));

  if (intent === "delete") {
    const experiment = await prisma.experiment.findUnique({
      where: { id: params.id },
      select: { status: true, shopId: true },
    });
    if (!experiment) return { error: "Experiment not found." };
    if (experiment.status === "active") {
      return { error: "End the test before deleting it." };
    }
    try {
      await prisma.event.deleteMany({ where: { experimentId: params.id } });
      await prisma.result.deleteMany({ where: { experimentId: params.id } });
      try {
        await prisma.orchestratorLog.deleteMany({
          where: { payload: { path: ["experimentId"], equals: params.id } },
        });
      } catch { /* best-effort */ }
      await prisma.variant.deleteMany({ where: { experimentId: params.id } });
      await prisma.experiment.delete({ where: { id: params.id } });
      throw redirect("/app");
    } catch (error) {
      if (error instanceof Response) throw error;
      console.error("[experiments.$id] delete error", error);
      return { error: "Failed to delete experiment." };
    }
  }

  if (intent === "activate") {
    const check = await canActivateExperiment(params.id!);
    if (!check.allowed) return { error: check.reason ?? "Cannot activate experiment." };
    try {
      await prisma.experiment.update({
        where: { id: params.id },
        data: { status: "active", startedAt: new Date() },
      });
      return { success: true };
    } catch (error) {
      console.error("[experiments.$id] activate error", error);
      return { error: "Failed to activate experiment." };
    }
  }

  if (intent === "approve") {
    try {
      await prisma.experiment.update({
        where: { id: params.id },
        data: { status: "active", startedAt: new Date() },
      });
      return { success: true };
    } catch (error) {
      console.error("[experiments.$id] approve error", error);
      return { error: "Failed to approve experiment." };
    }
  }

  if (intent === "reject_approval") {
    try {
      await prisma.experiment.update({
        where: { id: params.id },
        data: { status: "draft" },
      });
      return { success: true };
    } catch (error) {
      console.error("[experiments.$id] reject_approval error", error);
      return { error: "Failed to reject experiment." };
    }
  }

  const transitions: Record<string, { status: string; extra?: object }> = {
    pause: { status: "paused" },
    resume: { status: "active" },
    end: { status: "concluded", extra: { concludedAt: new Date() } },
  };

  const transition = transitions[intent];
  if (!transition) return { error: "Invalid action." };

  try {
    await prisma.experiment.update({
      where: { id: params.id },
      data: { status: transition.status, ...transition.extra },
    });
    return { success: true };
  } catch (error) {
    console.error("[experiments.$id] action error", error);
    return { error: "Failed to update experiment status." };
  }
};

function LiftCell({ lift }: { lift: number | null }) {
  if (lift === null) return <td style={{ textAlign: "right", padding: "4px 8px" }}>—</td>;
  const color = lift > 0 ? "#1a7a4a" : lift < 0 ? "#d72c0d" : "#6d7175";
  const sign = lift > 0 ? "+" : "";
  return (
    <td style={{ textAlign: "right", padding: "4px 8px", color, fontWeight: 500 }}>
      {sign}{lift.toFixed(1)}%
    </td>
  );
}

function MetricRow({
  label,
  control,
  treatment,
  lift,
}: {
  label: string;
  control: string;
  treatment: string;
  lift: number | null;
}) {
  return (
    <tr>
      <td style={{ padding: "4px 8px" }}>{label}</td>
      <td style={{ textAlign: "right", padding: "4px 8px" }}>{control}</td>
      <td style={{ textAlign: "right", padding: "4px 8px" }}>{treatment}</td>
      <LiftCell lift={lift} />
    </tr>
  );
}

function CodePreview({ label, code }: { label: string; code: string }) {
  return (
    <s-box>
      <s-text>{label}</s-text>
      <pre
        style={{
          background: "#f6f6f7",
          padding: "8px 12px",
          borderRadius: 8,
          overflowX: "auto",
          fontSize: 12,
          margin: "4px 0 0",
          fontFamily: "monospace",
        }}
      >
        <code>{code}</code>
      </pre>
    </s-box>
  );
}

export default function ExperimentDetail() {
  const { experiment, qaLog, shopDomain } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const control = experiment.variants.find((v) => v.type === "control");
  const treatment = experiment.variants.find((v) => v.type === "treatment");
  const result = experiment.result;
  const actions = ALLOWED_ACTIONS[experiment.status] ?? [];

  return (
    <s-page heading={experiment.name}>
      <s-button slot="primary-action" type="button" variant="tertiary" href="/app">
        All experiments
      </s-button>

      {actionData && "error" in actionData && (
        <s-banner tone="critical" heading="Error">
          <s-paragraph>{(actionData as { error: string }).error}</s-paragraph>
        </s-banner>
      )}

      <s-section heading="Status">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-badge tone={STATUS_TONE[experiment.status] ?? "info"}>
              {experiment.status}
            </s-badge>
          </s-stack>
          <s-paragraph>{experiment.hypothesis}</s-paragraph>
          {actions.length > 0 && (
            <s-stack direction="inline" gap="base">
              {actions.map((a) => (
                <Form method="post" key={a.intent} style={{ display: "inline" }}>
                  <input type="hidden" name="intent" value={a.intent} />
                  <s-button
                    type="submit"
                    variant={a.variant}
                    tone={a.tone}
                    {...(isSubmitting ? { loading: true } : {})}
                  >
                    {a.label}
                  </s-button>
                </Form>
              ))}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {/* QA Review result — shown for pending_approval experiments */}
      {experiment.status === "pending_approval" && qaLog && (() => {
        const payload = qaLog.payload as Record<string, unknown>;
        const confidence = Number(payload.confidence ?? 0);
        const confidenceTone = confidence >= 0.9 ? "success" : confidence >= 0.75 ? "warning" : "critical";
        const confidenceLabel = confidence >= 0.9 ? "High confidence" : confidence >= 0.75 ? "Moderate confidence" : "Review carefully";
        const reasons = (payload.reasons as string[]) ?? [];
        const concerns = (payload.concerns as string[]) ?? [];
        return (
          <s-section heading="AI QA Review">
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base">
                <s-badge tone={confidenceTone}>{confidenceLabel} ({(confidence * 100).toFixed(0)}%)</s-badge>
                <s-badge tone={qaLog.status === "complete" ? "success" : "critical"}>
                  {qaLog.status === "complete" ? "Approved by AI" : "Flagged"}
                </s-badge>
              </s-stack>
              {reasons.length > 0 && (
                <s-stack direction="block" gap="small">
                  <s-text>Reasons:</s-text>
                  {reasons.map((r, i) => <s-text key={i}>• {r}</s-text>)}
                </s-stack>
              )}
              {concerns.length > 0 && (
                <s-stack direction="block" gap="small">
                  <s-text>Minor concerns (did not block approval):</s-text>
                  {concerns.map((c, i) => <s-text key={i}>• {c}</s-text>)}
                </s-stack>
              )}
            </s-stack>
          </s-section>
        );
      })()}

      {/* Ship the winner — shown when experiment concluded with a winner */}
      {experiment.status === "concluded" &&
        (experiment.result?.probToBeatControl ?? 0) >= 0.95 && (() => {
          const treatment = experiment.variants.find((v) => v.type === "treatment");
          if (!treatment) return null;
          return (
            <s-section heading="Ship the winner">
              <s-stack direction="block" gap="base">
                <s-paragraph>
                  Treatment won with {((experiment.result!.probToBeatControl ?? 0) * 100).toFixed(1)}% probability to beat control.
                  To make this permanent, paste the code below into your theme.
                </s-paragraph>
                {treatment.htmlPatch && (
                  <s-stack direction="block" gap="small">
                    <s-stack direction="inline" gap="base">
                      <s-text>HTML patch</s-text>
                      <button type="button" onClick={() => navigator.clipboard.writeText(treatment.htmlPatch!)} style={{ cursor: "pointer" }}>
                        Copy
                      </button>
                    </s-stack>
                    <pre style={{ background: "#f6f6f7", padding: "8px 12px", borderRadius: 8, overflowX: "auto", fontSize: 12, fontFamily: "monospace" }}>
                      {treatment.htmlPatch}
                    </pre>
                  </s-stack>
                )}
                {treatment.cssPatch && (
                  <s-stack direction="block" gap="small">
                    <s-stack direction="inline" gap="base">
                      <s-text>CSS patch</s-text>
                      <button type="button" onClick={() => navigator.clipboard.writeText(treatment.cssPatch!)} style={{ cursor: "pointer" }}>
                        Copy
                      </button>
                    </s-stack>
                    <pre style={{ background: "#f6f6f7", padding: "8px 12px", borderRadius: 8, overflowX: "auto", fontSize: 12, fontFamily: "monospace" }}>
                      {treatment.cssPatch}
                    </pre>
                  </s-stack>
                )}
                {treatment.jsPatch && (
                  <s-stack direction="block" gap="small">
                    <s-stack direction="inline" gap="base">
                      <s-text>JS patch</s-text>
                      <button type="button" onClick={() => navigator.clipboard.writeText(treatment.jsPatch!)} style={{ cursor: "pointer" }}>
                        Copy
                      </button>
                    </s-stack>
                    <pre style={{ background: "#f6f6f7", padding: "8px 12px", borderRadius: 8, overflowX: "auto", fontSize: 12, fontFamily: "monospace" }}>
                      {treatment.jsPatch}
                    </pre>
                  </s-stack>
                )}
                <s-link href={`https://${experiment.shopId}/admin/themes/current/editor`} target="_blank">
                  Open Theme Editor →
                </s-link>
              </s-stack>
            </s-section>
          );
        })()}

      <s-section heading="Results">
        {result ? (
          <s-stack direction="block" gap="base">
            {result.probToBeatControl != null && (
              <s-stack direction="inline" gap="base">
                <s-badge tone={result.isSignificant ? "success" : "info"}>
                  {result.isSignificant ? "Winner — 95% confidence" : "Not yet significant"}
                </s-badge>
                <s-text>
                  P(beat control): {(result.probToBeatControl * 100).toFixed(1)}%
                </s-text>
              </s-stack>
            )}

            {/* Conversion funnel panel */}
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small">
                <s-heading>Conversion funnel</s-heading>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", padding: "4px 8px", borderBottom: "1px solid #e1e3e5" }}>Metric</th>
                      <th style={{ textAlign: "right", padding: "4px 8px", borderBottom: "1px solid #e1e3e5" }}>Control</th>
                      <th style={{ textAlign: "right", padding: "4px 8px", borderBottom: "1px solid #e1e3e5" }}>Treatment</th>
                      <th style={{ textAlign: "right", padding: "4px 8px", borderBottom: "1px solid #e1e3e5" }}>Lift</th>
                    </tr>
                  </thead>
                  <tbody>
                    <MetricRow
                      label="Views"
                      control={result.controlVisitors.toLocaleString()}
                      treatment={result.treatmentVisitors.toLocaleString()}
                      lift={null}
                    />
                    {result.controlAddToCartRate != null && (
                      <MetricRow
                        label="Add to cart rate"
                        control={`${(result.controlAddToCartRate * 100).toFixed(2)}%`}
                        treatment={`${((result.treatmentAddToCartRate ?? 0) * 100).toFixed(2)}%`}
                        lift={result.addToCartRateLift ?? null}
                      />
                    )}
                    {result.controlCheckoutRate != null && (
                      <MetricRow
                        label="Checkout rate"
                        control={`${(result.controlCheckoutRate * 100).toFixed(2)}%`}
                        treatment={`${((result.treatmentCheckoutRate ?? 0) * 100).toFixed(2)}%`}
                        lift={result.checkoutRateLift ?? null}
                      />
                    )}
                    <MetricRow
                      label="Conversion rate"
                      control={`${(result.controlConversionRate * 100).toFixed(2)}%`}
                      treatment={`${(result.treatmentConversionRate * 100).toFixed(2)}%`}
                      lift={result.conversionRateLift ?? null}
                    />
                  </tbody>
                </table>
              </s-stack>
            </s-box>

            {/* Revenue panel — only show when revenue data exists */}
            {(result.controlRevenue > 0 || result.treatmentRevenue > 0) && (
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small">
                  <s-heading>Revenue</s-heading>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", padding: "4px 8px", borderBottom: "1px solid #e1e3e5" }}>Metric</th>
                        <th style={{ textAlign: "right", padding: "4px 8px", borderBottom: "1px solid #e1e3e5" }}>Control</th>
                        <th style={{ textAlign: "right", padding: "4px 8px", borderBottom: "1px solid #e1e3e5" }}>Treatment</th>
                        <th style={{ textAlign: "right", padding: "4px 8px", borderBottom: "1px solid #e1e3e5" }}>Lift</th>
                      </tr>
                    </thead>
                    <tbody>
                      <MetricRow
                        label="Revenue per visitor"
                        control={`$${(result.controlRevPerVisitor ?? 0).toFixed(2)}`}
                        treatment={`$${(result.treatmentRevPerVisitor ?? 0).toFixed(2)}`}
                        lift={result.revPerVisitorLift ?? null}
                      />
                      {result.controlAov != null && (
                        <MetricRow
                          label="Avg order value"
                          control={`$${result.controlAov.toFixed(2)}`}
                          treatment={`$${(result.treatmentAov ?? 0).toFixed(2)}`}
                          lift={result.aovLift ?? null}
                        />
                      )}
                      <MetricRow
                        label="Total revenue"
                        control={`$${result.controlRevenue.toFixed(0)}`}
                        treatment={`$${result.treatmentRevenue.toFixed(0)}`}
                        lift={null}
                      />
                    </tbody>
                  </table>
                </s-stack>
              </s-box>
            )}
          </s-stack>
        ) : (
          <s-paragraph>
            No results yet. Results are computed hourly once the experiment is active.
          </s-paragraph>
        )}
      </s-section>

      <s-section heading="Variants">
        <s-stack direction="block" gap="large">
          {[control, treatment]
            .filter((v): v is NonNullable<typeof v> => Boolean(v))
            .map((variant) => (
              <s-box
                key={variant.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="base">
                  <s-stack direction="inline" gap="base">
                    <s-heading>{variant.name}</s-heading>
                    <s-badge>{variant.type}</s-badge>
                  </s-stack>
                  {variant.description && (
                    <s-paragraph>{variant.description}</s-paragraph>
                  )}
                  {variant.htmlPatch && (
                    <CodePreview label="HTML" code={variant.htmlPatch} />
                  )}
                  {variant.cssPatch && (
                    <CodePreview label="CSS" code={variant.cssPatch} />
                  )}
                  {variant.jsPatch && (
                    <CodePreview label="JS" code={variant.jsPatch} />
                  )}
                  {!variant.htmlPatch &&
                    !variant.cssPatch &&
                    !variant.jsPatch && (
                      <s-paragraph>
                        No patches — serves the storefront as-is.
                      </s-paragraph>
                    )}
                  {shopDomain && (
                    <s-stack direction="block" gap="small">
                      <s-button
                        type="button"
                        variant="secondary"
                        href={`https://${shopDomain}/?cro_preview_experiment=${experiment.id}&cro_preview_variant=${variant.id}`}
                        target="_blank"
                      >
                        Preview on storefront ↗
                      </s-button>
                      <s-text tone="neutral">
                        Opens your storefront in a new tab with this variant applied. No effect on live traffic or results.
                      </s-text>
                      {experiment.pageType !== "homepage" && experiment.pageType !== "any" && (
                        <s-text tone="neutral">
                          Navigate to a {experiment.pageType} page to see the variant in context.
                        </s-text>
                      )}
                    </s-stack>
                  )}
                </s-stack>
              </s-box>
            ))}
        </s-stack>
      </s-section>

      {/* Delete zone — not shown for active experiments */}
      {experiment.status !== "active" && (
        <s-section heading="Danger zone">
          <s-stack direction="block" gap="base">
            {!showDeleteConfirm ? (
              <s-button
                type="button"
                tone="critical"
                variant="secondary"
                onClick={() => setShowDeleteConfirm(true)}
              >
                Delete experiment
              </s-button>
            ) : (
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="base">
                  <s-text>
                    This will permanently delete the experiment and all its data. This cannot be undone.
                  </s-text>
                  <s-stack direction="inline" gap="base">
                    <Form method="post">
                      <input type="hidden" name="intent" value="delete" />
                      <s-button type="submit" tone="critical" variant="primary" {...(isSubmitting ? { loading: true } : {})}>
                        Permanently delete
                      </s-button>
                    </Form>
                    <s-button type="button" variant="secondary" onClick={() => setShowDeleteConfirm(false)}>
                      Cancel
                    </s-button>
                  </s-stack>
                </s-stack>
              </s-box>
            )}
          </s-stack>
        </s-section>
      )}

      <s-section slot="aside" heading="Details">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <s-text>Page type: </s-text>
            {experiment.pageType}
          </s-paragraph>
          <s-paragraph>
            <s-text>Element: </s-text>
            {experiment.elementType}
          </s-paragraph>
          <s-paragraph>
            <s-text>Target metric: </s-text>
            {experiment.targetMetric.replace(/_/g, " ")}
          </s-paragraph>
          <s-paragraph>
            <s-text>Traffic split: </s-text>
            50 / 50
          </s-paragraph>
          <s-paragraph>
            <s-text>Max runtime: </s-text>
            {experiment.maxRuntimeDays} days
          </s-paragraph>
          {experiment.startedAt && (
            <s-paragraph>
              <s-text>Started: </s-text>
              {new Date(experiment.startedAt).toLocaleDateString()}
            </s-paragraph>
          )}
          {experiment.concludedAt && (
            <s-paragraph>
              <s-text>Concluded: </s-text>
              {new Date(experiment.concludedAt).toLocaleDateString()}
            </s-paragraph>
          )}
          {experiment.segment && (
            <s-paragraph>
              <s-text>Segment: </s-text>
              {experiment.segment.name}
            </s-paragraph>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

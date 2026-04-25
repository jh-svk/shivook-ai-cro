import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";

type BadgeTone = "info" | "success" | "warning" | "neutral" | "critical";

const STATUS_TONE: Record<string, BadgeTone> = {
  draft: "info",
  active: "success",
  paused: "warning",
  concluded: "neutral",
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
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  try {
    const experiment = await prisma.experiment.findUnique({
      where: { id: params.id },
      include: { variants: true, result: true },
    });
    if (!experiment) throw new Response("Not Found", { status: 404 });
    return { experiment };
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

  const transitions: Record<string, { status: string; extra?: object }> = {
    activate: { status: "active", extra: { startedAt: new Date() } },
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
  const { experiment } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const control = experiment.variants.find((v) => v.type === "control");
  const treatment = experiment.variants.find((v) => v.type === "treatment");
  const result = experiment.result;
  const actions = ALLOWED_ACTIONS[experiment.status] ?? [];

  return (
    <s-page heading={experiment.name}>
      <s-button slot="primary-action" type="button" variant="tertiary" href="/app">
        All experiments
      </s-button>

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

      <s-section heading="Results">
        {result ? (
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base">
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="base">
                  <s-heading>Control</s-heading>
                  <s-text>
                    {result.controlVisitors.toLocaleString()} visitors
                  </s-text>
                  <s-text>
                    {(result.controlConversionRate * 100).toFixed(2)}% conv. rate
                  </s-text>
                </s-stack>
              </s-box>
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="base">
                  <s-heading>Treatment</s-heading>
                  <s-text>
                    {result.treatmentVisitors.toLocaleString()} visitors
                  </s-text>
                  <s-text>
                    {(result.treatmentConversionRate * 100).toFixed(2)}% conv. rate
                  </s-text>
                </s-stack>
              </s-box>
            </s-stack>
            {result.relativeLift != null && (
              <s-stack direction="inline" gap="base">
                <s-text>
                  Lift: {(result.relativeLift * 100).toFixed(1)}%
                </s-text>
                <s-text>
                  p-value:{" "}
                  {result.pValue != null ? result.pValue.toFixed(4) : "—"}
                </s-text>
                <s-badge tone={result.isSignificant ? "success" : "info"}>
                  {result.isSignificant ? "Significant" : "Not yet significant"}
                </s-badge>
              </s-stack>
            )}
          </s-stack>
        ) : (
          <s-paragraph>
            No results yet. Results are computed hourly once the experiment is
            active.
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
                </s-stack>
              </s-box>
            ))}
        </s-stack>
      </s-section>

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
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

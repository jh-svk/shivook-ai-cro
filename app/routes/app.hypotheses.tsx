import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation, useRevalidator } from "react-router";
import { useEffect, useRef, useState } from "react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { findOrCreateShop } from "../../lib/shop.server";
import { enqueueDataSync } from "../../jobs/dataSync";
import { enqueueResearchSynthesis } from "../../jobs/researchSynthesis";
import { hasPlanFeature } from "../../lib/planGate.server";
import { enqueueAutoBuild } from "../../jobs/autoBuild";
import { formatStatus, titleCase } from "../../lib/formatText";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop, session.accessToken ?? "");

  const [hypotheses, latestReport] = await Promise.all([
    prisma.hypothesis.findMany({
      where: { shopId: shop.id },
      orderBy: { iceScore: "desc" },
    }),
    prisma.researchReport.findFirst({
      where: { shopId: shop.id },
      orderBy: { generatedAt: "desc" },
      select: { id: true, generatedAt: true, status: true },
    }),
  ]);

  return { hypotheses, latestReport, shopId: shop.id };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop, session.accessToken ?? "");

  const fd = await request.formData();
  const intent = String(fd.get("intent"));

  if (intent === "generate") {
    const allowed = await hasPlanFeature(shop.id, "ai_hypotheses");
    if (!allowed) {
      return { error: "AI hypotheses require the Growth or Pro plan. Upgrade at /app/billing." };
    }
    // Kick off nightly pipeline manually: sync → synthesise → generate
    await enqueueDataSync(shop.id);
    await enqueueResearchSynthesis(shop.id);
    return { message: "Research pipeline started. New hypotheses will appear within a few minutes." };
  }

  if (intent === "promote") {
    const hypothesisId = String(fd.get("hypothesisId"));
    const hypothesis = await prisma.hypothesis.findUnique({
      where: { id: hypothesisId, shopId: shop.id },
    });
    if (!hypothesis) return { error: "Hypothesis not found." };

    // Create a DRAFT experiment pre-filled from the hypothesis
    const experiment = await prisma.experiment.create({
      data: {
        shopId: shop.id,
        name: hypothesis.title,
        hypothesis: hypothesis.hypothesis,
        pageType: hypothesis.pageType,
        elementType: hypothesis.elementType,
        targetMetric: hypothesis.targetMetric,
        trafficSplit: 0.5,
        variants: {
          create: [
            { type: "control", name: "Control", description: "Existing experience" },
            { type: "treatment", name: "Treatment", description: "AI-suggested variant — add your code patches" },
          ],
        },
      },
    });

    await prisma.hypothesis.update({
      where: { id: hypothesisId },
      data: { status: "promoted", promotedExperimentId: experiment.id },
    });

    return { promoted: true, experimentId: experiment.id };
  }

  if (intent === "ai_generate") {
    const allowed = await hasPlanFeature(shop.id, "auto_build");
    if (!allowed) {
      return { error: "AI variant generation requires the Pro plan. Upgrade at /app/billing." };
    }
    const hypothesisId = String(fd.get("hypothesisId"));
    const hypothesis = await prisma.hypothesis.findUnique({
      where: { id: hypothesisId, shopId: shop.id },
      select: { id: true },
    });
    if (!hypothesis) return { error: "Hypothesis not found." };

    // Fire the autonomous build: Claude generates brand-native HTML/CSS/JS patches,
    // runs the design critique, creates a draft experiment, then chains to
    // qaReview -> activationGate (which parks it in pending_approval).
    await enqueueAutoBuild(shop.id, hypothesisId);
    return {
      message:
        "AI is generating a brand-native variant for this hypothesis. It will appear as a draft experiment (pending your approval) within a minute or two.",
    };
  }

  if (intent === "reject") {
    const hypothesisId = String(fd.get("hypothesisId"));
    await prisma.hypothesis.update({
      where: { id: hypothesisId, shopId: shop.id },
      data: { status: "rejected" },
    });
    return { success: true };
  }

  if (intent === "delete_all_backlog") {
    const result = await prisma.hypothesis.deleteMany({
      where: { shopId: shop.id, status: "backlog" },
    });
    return { message: `Deleted ${result.count} backlog hypothes${result.count === 1 ? "is" : "es"}.` };
  }

  return { error: "Unknown action." };
};

const ICE_TONE: Record<string, "success" | "warning" | "critical"> = {
  high: "success",
  medium: "warning",
  low: "critical",
};

function iceLabel(score: number): { label: string; tone: "success" | "warning" | "critical" } {
  if (score >= 500) return { label: `ICE ${score} — High`, tone: "success" };
  if (score >= 200) return { label: `ICE ${score} — Medium`, tone: "warning" };
  return { label: `ICE ${score} — Low`, tone: "critical" };
}

export default function HypothesesPage() {
  const { hypotheses, latestReport } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const backlog = hypotheses.filter((h) => h.status === "backlog");
  const promoted = hypotheses.filter((h) => h.status === "promoted");
  const rejected = hypotheses.filter((h) => h.status === "rejected");

  // ── Live research progress (poll the loader so results appear without a manual refresh) ──
  const revalidator = useRevalidator();
  const isGenerating =
    navigation.state !== "idle" && navigation.formData?.get("intent") === "generate";
  const reportPending = latestReport?.status === "pending";

  const [researching, setResearching] = useState(false);
  const [, setTick] = useState(0); // 1s heartbeat to re-render the elapsed timer
  const startRef = useRef<number | null>(null);
  const baselineBacklogRef = useRef<number>(0);

  // Start when a generate is submitted, or when a pending report is observed
  useEffect(() => {
    if ((isGenerating || reportPending) && !researching) {
      setResearching(true);
      startRef.current = Date.now();
      baselineBacklogRef.current = backlog.length;
    }
  }, [isGenerating, reportPending, researching, backlog.length]);

  // While researching: poll the loader every 4s + tick the timer every 1s
  useEffect(() => {
    if (!researching) return;
    const poll = setInterval(() => {
      const elapsed = startRef.current ? (Date.now() - startRef.current) / 1000 : 0;
      if (revalidator.state === "idle" && elapsed < 360) revalidator.revalidate();
    }, 4000);
    const heartbeat = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(heartbeat);
    };
  }, [researching, revalidator]);

  // Stop when new hypotheses arrive, the report fails, or we time out (~6 min)
  useEffect(() => {
    if (!researching) return;
    const grew = backlog.length > baselineBacklogRef.current;
    const failed = latestReport?.status === "failed";
    const elapsed = startRef.current ? (Date.now() - startRef.current) / 1000 : 0;
    if (grew || failed || elapsed > 360) {
      setResearching(false);
      startRef.current = null;
    }
  }, [researching, backlog.length, latestReport?.status]);

  const elapsedSec =
    researching && startRef.current ? Math.floor((Date.now() - startRef.current) / 1000) : 0;
  const tooLong = elapsedSec > 300;
  const mmss = `${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, "0")}`;

  return (
    <s-page heading="Hypothesis Backlog">
      <s-button
        slot="primary-action"
        type="button"
        variant="tertiary"
        href="/app"
      >
        All experiments
      </s-button>

      {!isSubmitting && actionData && "message" in actionData && (
        <s-banner tone="success" heading="Pipeline queued" dismissible>
          <s-paragraph>{(actionData as { message: string }).message}</s-paragraph>
        </s-banner>
      )}
      {!isSubmitting && actionData && "error" in actionData && (
        <s-banner tone="critical" heading="Error">
          <s-paragraph>{(actionData as { error: string }).error}</s-paragraph>
        </s-banner>
      )}

      <s-section heading="AI Research Pipeline">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Trigger a research cycle to analyse your store data and generate
            new A/B test hypotheses ranked by ICE score. Each cycle takes
            1–3 minutes.
          </s-paragraph>
          {researching ? (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="base">
                <s-heading>
                  {tooLong ? "Still working…" : "Researching your store…"}
                </s-heading>
                <s-paragraph>
                  Analysing your store data and generating ranked hypotheses.
                  They’ll appear below automatically — you don’t need to refresh
                  the page.
                </s-paragraph>
                <progress
                  value={Math.min(elapsedSec, 180)}
                  max={180}
                  style={{ width: "100%", height: "10px" }}
                />
                <s-text tone="neutral">
                  {tooLong
                    ? `Elapsed ${mmss} — this is taking longer than usual. It may still finish; if not, you can re-run.`
                    : `Elapsed ${mmss} · usually takes 1–3 minutes`}
                </s-text>
              </s-stack>
            </s-box>
          ) : (
            <>
              {latestReport && (
                <s-paragraph>
                  Last report:{" "}
                  {new Date(latestReport.generatedAt).toLocaleString()} —{" "}
                  <s-badge
                    tone={
                      latestReport.status === "complete"
                        ? "success"
                        : latestReport.status === "failed"
                        ? "critical"
                        : "info"
                    }
                  >
                    {formatStatus(latestReport.status)}
                  </s-badge>
                </s-paragraph>
              )}
              <Form method="post">
                <input type="hidden" name="intent" value="generate" />
                <s-button
                  type="submit"
                  variant="primary"
                  {...(isSubmitting ? { loading: true } : {})}
                >
                  Generate new hypotheses
                </s-button>
              </Form>
            </>
          )}
        </s-stack>
      </s-section>

      {backlog.length === 0 && promoted.length === 0 ? (
        <s-section heading="No hypotheses yet">
          <s-paragraph>
            Click "Generate new hypotheses" above to run the research pipeline.
            Make sure your data connectors are configured in Settings.
          </s-paragraph>
        </s-section>
      ) : null}

      {backlog.length > 0 && (
        <s-section heading={`Backlog (${backlog.length})`}>
          <s-stack direction="block" gap="base">
            <Form
              method="post"
              style={{ alignSelf: "flex-end" }}
              onSubmit={(e) => {
                if (
                  !window.confirm(
                    `Delete all ${backlog.length} backlog hypotheses? This cannot be undone.`
                  )
                ) {
                  e.preventDefault();
                }
              }}
            >
              <input type="hidden" name="intent" value="delete_all_backlog" />
              <s-button
                type="submit"
                variant="secondary"
                tone="critical"
                {...(isSubmitting ? { loading: true } : {})}
              >
                Delete all backlog
              </s-button>
            </Form>
            {backlog.map((h) => {
              const ice = iceLabel(Math.round(h.iceScore));
              return (
                <s-box
                  key={h.id}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                >
                  <s-stack direction="block" gap="base">
                    <s-stack direction="inline" gap="base">
                      <s-heading>{h.title}</s-heading>
                      <s-badge tone={ice.tone}>{ice.label}</s-badge>
                      <s-badge>{h.pageType}</s-badge>
                      <s-badge>{h.elementType}</s-badge>
                    </s-stack>
                    {h.recommendedSegment && (() => {
                      const seg = h.recommendedSegment as {
                        deviceType?: string | null;
                        geoCountry?: string[];
                        trafficSource?: string | null;
                        visitorType?: string | null;
                      };
                      const tags: string[] = [];
                      if (seg.deviceType) tags.push(titleCase(seg.deviceType));
                      if (seg.geoCountry?.length) tags.push(seg.geoCountry.join(", ").toUpperCase());
                      if (seg.trafficSource) tags.push(titleCase(`${seg.trafficSource} traffic`));
                      if (seg.visitorType) tags.push(titleCase(`${seg.visitorType} visitors`));
                      if (tags.length === 0) return null;
                      return (
                        <s-stack direction="inline" gap="small">
                          <s-text tone="neutral">Target:</s-text>
                          {tags.map((t, i) => <s-badge key={i} tone="info">{t}</s-badge>)}
                        </s-stack>
                      );
                    })()}
                    <s-paragraph>{h.hypothesis}</s-paragraph>
                    <s-stack direction="inline" gap="base">
                      <s-text>
                        Impact {h.iceImpact} · Confidence {h.iceConfidence} · Ease{" "}
                        {h.iceEase}
                      </s-text>
                    </s-stack>
                    <s-stack direction="inline" gap="base">
                      <Form method="post" style={{ display: "inline" }}>
                        <input type="hidden" name="intent" value="ai_generate" />
                        <input type="hidden" name="hypothesisId" value={h.id} />
                        <s-button
                          type="submit"
                          variant="primary"
                          {...(isSubmitting ? { loading: true } : {})}
                        >
                          ✨ AI Generate variant
                        </s-button>
                      </Form>
                      <Form method="post" style={{ display: "inline" }}>
                        <input type="hidden" name="intent" value="promote" />
                        <input type="hidden" name="hypothesisId" value={h.id} />
                        <s-button
                          type="submit"
                          variant="secondary"
                          {...(isSubmitting ? { loading: true } : {})}
                        >
                          Promote (hand-code)
                        </s-button>
                      </Form>
                      <Form method="post" style={{ display: "inline" }}>
                        <input type="hidden" name="intent" value="reject" />
                        <input type="hidden" name="hypothesisId" value={h.id} />
                        <s-button
                          type="submit"
                          variant="secondary"
                          tone="critical"
                          {...(isSubmitting ? { loading: true } : {})}
                        >
                          Reject
                        </s-button>
                      </Form>
                    </s-stack>
                  </s-stack>
                </s-box>
              );
            })}
          </s-stack>
        </s-section>
      )}

      {promoted.length > 0 && (
        <s-section heading={`Promoted (${promoted.length})`}>
          <s-stack direction="block" gap="base">
            {promoted.map((h) => (
              <s-box
                key={h.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="inline" gap="base">
                  <s-badge tone="success">Promoted</s-badge>
                  <s-text>{h.title}</s-text>
                  {h.promotedExperimentId && (
                    <s-link href={`/app/experiments/${h.promotedExperimentId}`}>
                      View experiment
                    </s-link>
                  )}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}

      {rejected.length > 0 && (
        <s-section heading={`Rejected (${rejected.length})`}>
          <s-stack direction="block" gap="base">
            {rejected.map((h) => (
              <s-box
                key={h.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="inline" gap="base">
                  <s-badge tone="neutral">Rejected</s-badge>
                  <s-text>{h.title}</s-text>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

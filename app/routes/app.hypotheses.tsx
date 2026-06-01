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
import { formatStatus, titleCase, humanizeMetricsInText } from "../../lib/formatText";

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

  // How many hypotheses belong to the latest report. Used to keep the progress
  // indicator alive across refreshes until the hypotheses are actually written
  // (they're generated in a follow-up job a few seconds after the report finishes).
  const latestReportHypCount = latestReport
    ? hypotheses.filter((h) => h.reportId === latestReport.id).length
    : 0;

  return { hypotheses, latestReport, latestReportHypCount, shopId: shop.id };
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

    // Mark as building BEFORE enqueueing so the worker (which sets "promoted"
    // on success) can't be overwritten by this update, and so the Experiments
    // dashboard can show it in its "Building variants" section.
    await prisma.hypothesis.update({
      where: { id: hypothesisId, shopId: shop.id },
      data: { status: "building" },
    });
    await enqueueAutoBuild(shop.id, hypothesisId);
    return {
      message:
        "AI is generating a brand-native variant. Track its progress in the “Building variants” section of your Experiments dashboard — it'll move into the list automatically when ready.",
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

type BadgeTone = "info" | "success" | "warning" | "critical" | "neutral";

// Color-coded labels — each value gets a stable, distinct tone for quick scanning.
const PAGE_TONE: Record<string, BadgeTone> = {
  product: "info",
  collection: "success",
  cart: "warning",
  homepage: "critical",
  any: "neutral",
};
const DEVICE_TONE: Record<string, BadgeTone> = {
  mobile: "info",
  desktop: "success",
  tablet: "warning",
};
const VISITOR_TONE: Record<string, BadgeTone> = {
  new: "success",
  returning: "info",
  purchaser: "warning",
};
const ELEMENT_TONE: Record<string, BadgeTone> = {
  headline: "info",
  cta: "success",
  trust: "warning",
  price: "critical",
  image: "neutral",
  layout: "neutral",
  other: "neutral",
};

function iceLabel(score: number): { label: string; tone: "success" | "warning" | "critical" } {
  if (score >= 500) return { label: `ICE ${score} — High`, tone: "success" };
  if (score >= 200) return { label: `ICE ${score} — Medium`, tone: "warning" };
  return { label: `ICE ${score} — Low`, tone: "critical" };
}

export default function HypothesesPage() {
  const { hypotheses, latestReport, latestReportHypCount } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const backlog = hypotheses.filter((h) => h.status === "backlog");
  const promoted = hypotheses.filter((h) => h.status === "promoted");
  const failed = hypotheses.filter((h) => h.status === "qa_failed");
  const rejected = hypotheses.filter((h) => h.status === "rejected");

  // ── Live research progress (poll the loader so results appear without a manual refresh) ──
  const revalidator = useRevalidator();
  const isGenerating =
    navigation.state !== "idle" && navigation.formData?.get("intent") === "generate";
  const reportPending = latestReport?.status === "pending";
  const reportFailed = latestReport?.status === "failed";
  const reportFresh =
    !!latestReport &&
    Date.now() - new Date(latestReport.generatedAt).getTime() < 5 * 60 * 1000;
  // The report can finish a few seconds BEFORE its hypotheses are written (they
  // run in a follow-up job). Keep waiting in that window so they don't appear
  // to vanish — this also survives a page refresh because it's derived from the
  // loader, not from in-memory state.
  const awaitingHypotheses = reportFresh && !reportFailed && latestReportHypCount === 0;

  const [researching, setResearching] = useState(false);
  const [, setTick] = useState(0); // 1s heartbeat to re-render the elapsed timer
  // Anchor the timer to a timestamp PERSISTED in localStorage so it keeps
  // counting from the real start across a page refresh (instead of resetting).
  const startRef = useRef<number | null>(null);

  const readStart = (): number | null => {
    try {
      const v = window.localStorage.getItem("cro_research_started_at");
      return v ? parseInt(v, 10) : null;
    } catch { return null; }
  };
  const writeStart = (ts: number | null) => {
    try {
      if (ts == null) window.localStorage.removeItem("cro_research_started_at");
      else window.localStorage.setItem("cro_research_started_at", String(ts));
    } catch { /* private mode */ }
  };

  // Start on submit, while the report is pending, or while we're still waiting
  // for the hypotheses to be written. Reuse a persisted start time if present.
  useEffect(() => {
    if ((isGenerating || reportPending || awaitingHypotheses) && !researching) {
      const existing = readStart();
      const start = existing ?? Date.now();
      if (!existing) writeStart(start);
      startRef.current = start;
      setResearching(true);
    }
  }, [isGenerating, reportPending, awaitingHypotheses, researching]);

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

  // Stop once the hypotheses have actually landed, the report failed, or we time out.
  useEffect(() => {
    if (!researching) return;
    const elapsed = startRef.current ? (Date.now() - startRef.current) / 1000 : 0;
    if (latestReportHypCount > 0 || reportFailed || elapsed > 360) {
      setResearching(false);
      startRef.current = null;
      writeStart(null);
    }
  }, [researching, latestReportHypCount, reportFailed]);

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
                      <s-badge tone={ELEMENT_TONE[h.elementType] ?? "neutral"}>{h.elementType}</s-badge>
                    </s-stack>
                    <s-stack direction="inline" gap="small">
                      <s-text tone="neutral">Page:</s-text>
                      <s-badge tone={PAGE_TONE[h.pageType] ?? "neutral"}>{titleCase(h.pageType)}</s-badge>
                    </s-stack>
                    {h.recommendedSegment && (() => {
                      const seg = h.recommendedSegment as {
                        deviceType?: string | null;
                        geoCountry?: string[];
                        trafficSource?: string | null;
                        visitorType?: string | null;
                      };
                      const tags: { label: string; tone: BadgeTone }[] = [];
                      if (seg.deviceType) tags.push({ label: titleCase(seg.deviceType), tone: DEVICE_TONE[seg.deviceType] ?? "info" });
                      if (seg.geoCountry?.length) tags.push({ label: seg.geoCountry.join(", ").toUpperCase(), tone: "warning" });
                      if (seg.trafficSource) tags.push({ label: titleCase(`${seg.trafficSource} traffic`), tone: "critical" });
                      if (seg.visitorType) tags.push({ label: titleCase(`${seg.visitorType} visitors`), tone: VISITOR_TONE[seg.visitorType] ?? "success" });
                      if (tags.length === 0) return null;
                      return (
                        <s-stack direction="inline" gap="small">
                          <s-text tone="neutral">Target:</s-text>
                          {tags.map((t, i) => <s-badge key={i} tone={t.tone}>{t.label}</s-badge>)}
                        </s-stack>
                      );
                    })()}
                    <s-paragraph>{humanizeMetricsInText(h.hypothesis)}</s-paragraph>
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

      {failed.length > 0 && (
        <s-section heading={`Generation failed (${failed.length})`}>
          <s-stack direction="block" gap="base">
            <s-paragraph>
              The AI couldn’t produce a variant that passed quality checks for
              these. You can retry generation (the AI tries again from scratch)
              or reject them.
            </s-paragraph>
            {failed.map((h) => (
              <s-box
                key={h.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="base">
                  <s-stack direction="inline" gap="base">
                    <s-badge tone="critical">Generation failed</s-badge>
                    <s-text>{h.title}</s-text>
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
                        ✨ Retry AI Generate
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

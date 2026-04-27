/**
 * Auto-build job.
 *
 * Reads a hypothesis, calls Claude to generate variant HTML/CSS/JS patches,
 * runs a lightweight QA gate, then creates a draft experiment.
 *
 * Requires ANTHROPIC_API_KEY in environment.
 */

import { Queue, Worker, type Job } from "bullmq";
import { connection } from "../lib/queue";
import prisma from "../app/db.server";
import Anthropic from "@anthropic-ai/sdk";
import { qaReviewQueue } from "./qaReview";
import { hasPlanFeature } from "../lib/planGate.server";

export const AUTO_BUILD_QUEUE = "auto-build";

export interface AutoBuildJobData {
  shopId: string;
  hypothesisId: string;
}

export const autoBuildQueue = new Queue<AutoBuildJobData>(AUTO_BUILD_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 15_000 },
  },
});

async function logOrchestrator(
  shopId: string,
  runId: string,
  stage: string,
  status: string,
  payload: object
) {
  await prisma.orchestratorLog.create({
    data: { shopId, runId, stage, status, payload, completedAt: new Date() },
  });
}

function buildSystemPrompt(): string {
  return `You are an expert front-end developer specialising in Shopify storefronts and CRO.
Generate minimal, focused HTML/CSS/JS patches.
Patches must not use external resources, must not contain synchronous scripts, and must be under 10kb combined.
Respond ONLY with a valid JSON object — no markdown fences, no explanation.
The JSON must have exactly these keys: htmlPatch, cssPatch, jsPatch, variantDescription.
Each patch value is a string or null. variantDescription is a short string summarising the change.`;
}

function buildUserPrompt(
  title: string,
  hypothesis: string,
  pageType: string,
  elementType: string,
  targetMetric: string,
  brandGuardrails: unknown
): string {
  const guardrails = (brandGuardrails as Record<string, unknown>) ?? {};
  const hasExtractedTokens =
    guardrails.colors != null && typeof guardrails.colors === "object";

  const brandBlock = hasExtractedTokens
    ? `## Brand constraints (MUST follow — non-negotiable)
These are extracted directly from the store's live theme. Your generated code MUST:
- Use ONLY these colors (no other hex values or named colors): ${JSON.stringify(guardrails.colors)}
- Use ONLY these font families: ${JSON.stringify(guardrails.fonts ?? {})}
- Match border radius: ${guardrails.borderRadius ?? "as-is"}
- Never introduce inline styles that conflict with the above
- If a patch requires a color not in this list, use the closest listed color instead

Brand tokens:
${JSON.stringify(guardrails, null, 2)}`
    : `Brand guardrails: ${JSON.stringify(guardrails)}`;

  return `Generate variant patches for this A/B test hypothesis:

Title: ${title}
Hypothesis: ${hypothesis}
Page type: ${pageType}
Element type: ${elementType}
Target metric: ${targetMetric}

${brandBlock}

Return JSON with: htmlPatch, cssPatch, jsPatch, variantDescription.`;
}

function qaGate(htmlPatch: string | null, jsPatch: string | null): { passed: boolean; reason?: string } {
  if (jsPatch && Buffer.byteLength(jsPatch, "utf8") > 10_000) {
    return { passed: false, reason: "JS patch exceeds 10 000 bytes" };
  }
  if (htmlPatch && /<script(?![^>]*\b(?:async|defer)\b)[^>]*>/i.test(htmlPatch)) {
    return { passed: false, reason: "HTML patch contains synchronous <script> tag" };
  }
  return { passed: true };
}

async function runAutoBuild(shopId: string, hypothesisId: string) {
  const runId = hypothesisId;

  const allowed = await hasPlanFeature(shopId, "auto_build");
  if (!allowed) {
    console.log(`[autoBuild] shop ${shopId} does not have auto_build feature — skipping`);
    return;
  }

  const hypothesis = await prisma.hypothesis.findUnique({
    where: { id: hypothesisId, shopId },
    include: { shop: { select: { brandGuardrails: true } } },
  });
  if (!hypothesis) throw new Error(`Hypothesis ${hypothesisId} not found`);

  // Resolve segment from recommendedSegment before generating code
  type RecommendedSeg = {
    deviceType?: string | null;
    geoCountry?: string[];
    trafficSource?: string | null;
    visitorType?: string | null;
  };
  const recSeg = hypothesis.recommendedSegment as RecommendedSeg | null;
  let resolvedSegmentId: string | undefined;

  if (recSeg && (recSeg.deviceType || recSeg.geoCountry?.length || recSeg.trafficSource || recSeg.visitorType)) {
    // Look for an existing segment matching these dimensions
    const shopSegments = await prisma.segment.findMany({ where: { shopId } });
    const match = shopSegments.find(
      (s) =>
        s.deviceType === (recSeg.deviceType ?? null) &&
        s.trafficSource === (recSeg.trafficSource ?? null) &&
        s.visitorType === (recSeg.visitorType ?? null) &&
        JSON.stringify([...(recSeg.geoCountry ?? [])].sort()) ===
          JSON.stringify([...s.geoCountry].sort())
    );

    if (match) {
      resolvedSegmentId = match.id;
    } else {
      const segName = `AI: ${hypothesis.title} — ${recSeg.deviceType ?? "all devices"}`.slice(0, 80);
      const created = await prisma.segment.create({
        data: {
          shopId,
          name: segName,
          deviceType: recSeg.deviceType ?? null,
          geoCountry: recSeg.geoCountry ?? [],
          trafficSource: recSeg.trafficSource ?? null,
          visitorType: recSeg.visitorType ?? null,
          dayOfWeek: [],
          productCategory: [],
        },
      });
      resolvedSegmentId = created.id;
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: buildSystemPrompt(),
    messages: [
      {
        role: "user",
        content: buildUserPrompt(
          hypothesis.title,
          hypothesis.hypothesis,
          hypothesis.pageType,
          hypothesis.elementType,
          hypothesis.targetMetric,
          hypothesis.shop.brandGuardrails
        ),
      },
    ],
  });

  const raw = response.content[0];
  if (raw.type !== "text") throw new Error("Unexpected Claude response type");

  // Strip markdown fences if Claude added them despite instructions
  const jsonStr = raw.text.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  let patches: { htmlPatch: string | null; cssPatch: string | null; jsPatch: string | null; variantDescription: string };
  try {
    patches = JSON.parse(jsonStr);
  } catch {
    await prisma.hypothesis.update({ where: { id: hypothesisId }, data: { status: "qa_failed" } });
    await logOrchestrator(shopId, runId, "BUILD", "failed", {
      error: "Claude returned non-JSON",
      raw: jsonStr.slice(0, 500),
      hypothesisId,
    });
    console.error(`[autoBuild] JSON parse failed for hypothesis ${hypothesisId} — marked qa_failed`);
    return; // complete cleanly, no retry
  }

  const { htmlPatch, cssPatch, jsPatch, variantDescription } = patches;

  const qa = qaGate(htmlPatch ?? null, jsPatch ?? null);
  if (!qa.passed) {
    await prisma.hypothesis.update({
      where: { id: hypothesisId },
      data: { status: "qa_failed" },
    });
    await logOrchestrator(shopId, runId, "QA", "failed", { reason: qa.reason, hypothesisId });
    console.log(`[autoBuild] QA failed for hypothesis ${hypothesisId}: ${qa.reason}`);
    return;
  }

  // Create draft experiment from hypothesis
  const experiment = await prisma.experiment.create({
    data: {
      shopId,
      segmentId: resolvedSegmentId,
      name: hypothesis.title,
      hypothesis: hypothesis.hypothesis,
      pageType: hypothesis.pageType,
      elementType: hypothesis.elementType,
      targetMetric: hypothesis.targetMetric,
      trafficSplit: 0.5,
      variants: {
        create: [
          { type: "control", name: "Control", description: "Existing experience" },
          {
            type: "treatment",
            name: "Treatment",
            description: variantDescription || "AI-generated variant",
            htmlPatch: htmlPatch ?? undefined,
            cssPatch: cssPatch ?? undefined,
            jsPatch: jsPatch ?? undefined,
          },
        ],
      },
    },
  });

  await prisma.hypothesis.update({
    where: { id: hypothesisId },
    data: { status: "promoted", promotedExperimentId: experiment.id },
  });

  await logOrchestrator(shopId, runId, "BUILD", "complete", {
    hypothesisId,
    experimentId: experiment.id,
    message: "static QA passed — chaining to qaReview → activationGate",
  });

  console.log(`[autoBuild] created experiment ${experiment.id} from hypothesis ${hypothesisId}`);

  await qaReviewQueue.add(`qa-${experiment.id}`, {
    shopId,
    experimentId: experiment.id,
    hypothesisId,
  });
}

export function startAutoBuildWorker() {
  return new Worker<AutoBuildJobData>(
    AUTO_BUILD_QUEUE,
    async (job: Job<AutoBuildJobData>) => {
      await runAutoBuild(job.data.shopId, job.data.hypothesisId);
    },
    { connection }
  );
}

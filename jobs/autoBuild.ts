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
import { activationGateQueue } from "./activationGate";
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
  return `Generate variant patches for this A/B test hypothesis:

Title: ${title}
Hypothesis: ${hypothesis}
Page type: ${pageType}
Element type: ${elementType}
Target metric: ${targetMetric}
Brand guardrails: ${JSON.stringify(brandGuardrails ?? {})}

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
    include: { shop: { select: { brandGuardrails: true, shopifyDomain: true } } },
  });
  if (!hypothesis) throw new Error(`Hypothesis ${hypothesisId} not found`);

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
    throw new Error(`Claude returned non-JSON: ${jsonStr.slice(0, 200)}`);
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
  });

  console.log(`[autoBuild] created experiment ${experiment.id} from hypothesis ${hypothesisId}`);

  await activationGateQueue.add(`activate-${experiment.id}`, { shopId, experimentId: experiment.id });
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

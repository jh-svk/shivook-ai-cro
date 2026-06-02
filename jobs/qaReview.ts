/**
 * QA Review job.
 *
 * Claude-powered review of auto-generated variant code before it goes live.
 * Slots between autoBuild (static gate) and activationGate.
 *
 * Requires ANTHROPIC_API_KEY in environment.
 */

import { getBoss } from "../lib/pgboss.server";
import prisma from "../app/db.server";
import Anthropic from "@anthropic-ai/sdk";
import { enqueueActivationGate } from "./activationGate";

export const QA_REVIEW_QUEUE = "qa-review";

export interface QaReviewJobData {
  shopId: string;
  experimentId: string;
  hypothesisId: string;
}

export async function enqueueQaReview(shopId: string, experimentId: string, hypothesisId: string): Promise<void> {
  const boss = await getBoss();
  const id = await boss.send(QA_REVIEW_QUEUE, { shopId, experimentId, hypothesisId }, { retryLimit: 2, retryDelay: 30, retryBackoff: true }); // retryDelay in seconds
  if (id === null) console.warn(`[qaReview] send returned null for experiment ${experimentId} — job blocked`);
}

interface QAResult {
  decision: "approve" | "reject";
  confidence: number;
  reasons: string[];
  concerns: string[];
}

const SYSTEM_PROMPT = `You are a QA reviewer for an autonomous CRO system. Evaluate auto-generated \
A/B test variants before they go live on a Shopify storefront. Be rigorous but not overly conservative \
— reject only variants with clear problems. Approve confidently when the variant is safe, on-brand, and \
logically tests the stated hypothesis.`;

const PLATFORM_CONSTRAINTS = `PLATFORM CONSTRAINTS (enforce strictly):
- No external network requests (no fetch/XHR to third-party domains, no external image URLs)
- Do not modify checkout-related elements
- JS must only manipulate the DOM — no storage writes outside CRO-prefixed keys, no form interception, no redirects
- No synchronous <script> tags
- Combined JS size must be under 10 000 bytes`;

const REJECTION_CRITERIA = `REJECTION CRITERIA (reject if any of these apply):
1. Variant code makes external network requests
2. Variant modifies checkout-related elements
3. Variant contradicts the hypothesis (tests something unrelated to the stated change)
4. Variant conflicts with brand guardrails (wrong colors, tone, fonts if specified)
5. Variant removes critical trust signals (payment badges, security icons, return policy)
6. JS does anything beyond DOM manipulation`;

function buildUserPrompt(
  title: string,
  hypothesis: string,
  pageType: string,
  elementType: string,
  htmlPatch: string | null,
  cssPatch: string | null,
  jsPatch: string | null,
  brandGuardrails: unknown
): string {
  const guardrails = (brandGuardrails as Record<string, unknown>) ?? {};
  const hasExtractedTokens =
    guardrails.colors != null && typeof guardrails.colors === "object";

  const brandComplianceBlock = hasExtractedTokens
    ? `\n## Brand compliance check
The store has extracted brand tokens. When reviewing htmlPatch and cssPatch:
- Extract all hex color values from the code. Flag any that are NOT in: ${JSON.stringify(guardrails.colors)} (allow ±15% lightness variation for hover states).
- Flag any font-family values not in: ${JSON.stringify(guardrails.fonts ?? {})}.
- If there are MORE than 2 violations, treat them as a REJECT criterion.
- If there are 1–2 minor violations, add them to "concerns" instead.`
    : "";

  return `Review this auto-generated A/B test variant:

## Hypothesis
Title: ${title}
Statement: ${hypothesis}
Page type: ${pageType}
Element type: ${elementType}

## Generated variant code
HTML patch: ${htmlPatch ?? "(none)"}

CSS patch: ${cssPatch ?? "(none)"}

JS patch: ${jsPatch ?? "(none)"}

## Brand guardrails
${JSON.stringify(guardrails, null, 2)}
${brandComplianceBlock}

${PLATFORM_CONSTRAINTS}

${REJECTION_CRITERIA}

Respond with ONLY valid JSON (no markdown fences, no explanation):
{
  "decision": "approve" | "reject",
  "confidence": 0.0-1.0,
  "reasons": ["up to 3 bullet points explaining your decision"],
  "concerns": ["minor issues that don't warrant rejection"]
}`;
}

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

export async function runQaReview(shopId: string, experimentId: string, hypothesisId: string) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const [experiment, hypothesis] = await Promise.all([
    prisma.experiment.findUnique({
      where: { id: experimentId },
      include: { variants: true, shop: { select: { brandGuardrails: true } } },
    }),
    prisma.hypothesis.findUnique({ where: { id: hypothesisId } }),
  ]);

  if (!experiment || !hypothesis) {
    console.error(`[qaReview] experiment ${experimentId} or hypothesis ${hypothesisId} not found`);
    return;
  }

  const treatment = experiment.variants.find((v) => v.type === "treatment");

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildUserPrompt(
          hypothesis.title,
          hypothesis.hypothesis,
          hypothesis.pageType,
          hypothesis.elementType,
          treatment?.htmlPatch ?? null,
          treatment?.cssPatch ?? null,
          treatment?.jsPatch ?? null,
          experiment.shop.brandGuardrails
        ),
      },
    ],
  });

  const raw = response.content[0];
  if (raw.type !== "text") throw new Error("Unexpected Claude response type");

  const jsonStr = raw.text.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  let result: QAResult;
  try {
    result = JSON.parse(jsonStr) as QAResult;
  } catch {
    console.error(`[qaReview] Claude returned non-JSON: ${jsonStr.slice(0, 300)}`);
    await prisma.hypothesis.update({ where: { id: hypothesisId }, data: { status: "qa_failed" } });
    await logOrchestrator(shopId, experimentId, "QA", "failed", {
      error: "Claude returned non-JSON",
      raw: jsonStr.slice(0, 500),
    });
    return;
  }

  const isLowConfidence = result.confidence < 0.75;
  const requireApproval = process.env.REQUIRE_HUMAN_APPROVAL !== "false";
  const forceApproval = isLowConfidence && requireApproval;

  if (result.decision === "reject") {
    await prisma.hypothesis.update({
      where: { id: hypothesisId },
      data: { status: "qa_failed", promotedExperimentId: null },
    });
    await logOrchestrator(shopId, experimentId, "QA", "failed", {
      decision: "reject",
      confidence: result.confidence,
      reasons: result.reasons,
      concerns: result.concerns,
      experimentId,
      hypothesisId,
    });
    // Clean up the orphaned draft experiment so it doesn't linger in the
    // dashboard "stuck in draft" (the hypothesis is qa_failed and shown under
    // "Build failed" instead). Only delete if it's still a draft.
    try {
      const exp = await prisma.experiment.findUnique({ where: { id: experimentId }, select: { status: true } });
      if (exp?.status === "draft") {
        await prisma.event.deleteMany({ where: { experimentId } });
        await prisma.result.deleteMany({ where: { experimentId } });
        await prisma.variant.deleteMany({ where: { experimentId } });
        await prisma.experiment.delete({ where: { id: experimentId } });
      }
    } catch (err) {
      console.warn(`[qaReview] failed to clean up rejected draft ${experimentId}:`, err);
    }
    console.log(`[qaReview] rejected experiment ${experimentId}: ${result.reasons.join(", ")}`);
    return;
  }

  // Approved
  await logOrchestrator(shopId, experimentId, "QA", "complete", {
    decision: "approve",
    confidence: result.confidence,
    reasons: result.reasons,
    concerns: result.concerns,
    lowConfidence: isLowConfidence,
    forceApproval,
    experimentId,
    hypothesisId,
  });

  if (isLowConfidence) {
    console.log(`[qaReview] low-confidence approval (${result.confidence}) for experiment ${experimentId}`);
  }

  await enqueueActivationGate(shopId, experimentId, forceApproval);

  console.log(`[qaReview] approved experiment ${experimentId} — chained to activationGate${forceApproval ? " (forceApproval)" : ""}`);
}


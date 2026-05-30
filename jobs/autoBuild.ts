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
Each patch value is a string or null. variantDescription is a short string summarising the change.

Design principles you MUST follow:
- Every spacing decision must be intentional — no arbitrary padding values
- One clear visual focal point per element — clear hierarchy
- Never introduce gradients, drop shadows, pill borders, or animations unless they already exist in the store's design system
- Mobile-first: size all elements for touch targets (min 44px)
- Minimal markup: add only what is needed, nothing decorative that isn't earned`;
}

function buildUserPrompt(
  title: string,
  hypothesis: string,
  pageType: string,
  elementType: string,
  targetMetric: string,
  brandGuardrails: unknown,
  themeTokens: unknown
): string {
  const guardrails = (brandGuardrails as Record<string, unknown>) ?? {};
  const tokens = themeTokens as {
    cssVars?: Record<string, string>;
    componentHtml?: Record<string, string>;
  } | null;

  const hasCssVars =
    tokens?.cssVars != null && Object.keys(tokens.cssVars).length > 0;

  let constraintsBlock: string;

  if (hasCssVars) {
    const componentLines = [
      tokens!.componentHtml?.button
        ? `Button: ${tokens!.componentHtml.button}`
        : null,
      tokens!.componentHtml?.heading
        ? `Heading: ${tokens!.componentHtml.heading}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    constraintsBlock = `## Store design system — NON-NEGOTIABLE constraints
These are extracted directly from the store's live theme.

CSS custom properties (use var(--name) in ALL CSS — never hardcode hex values):
${JSON.stringify(tokens!.cssVars, null, 2)}
${componentLines ? `\nNative component HTML (copy this structure — do not invent your own):\n${componentLines}` : ""}

Rules:
- Every color in your CSS must use var(--token-name)
- Font families must use var(--font-*) tokens or inherit
- Border radius must use var(--buttons--border-radius) or the value from tokens
- If you need a color not in the token set, use the closest listed token
- Do not introduce CSS classes that conflict with theme class names`;
  } else {
    const hasExtractedTokens =
      guardrails.colors != null && typeof guardrails.colors === "object";
    constraintsBlock = hasExtractedTokens
      ? `## Brand constraints (MUST follow — non-negotiable)
Colors: ${JSON.stringify(guardrails.colors)}
Fonts: ${JSON.stringify(guardrails.fonts ?? {})}
Border radius: ${guardrails.borderRadius ?? "as-is"}
Full guardrails: ${JSON.stringify(guardrails, null, 2)}`
      : `Brand guardrails: ${JSON.stringify(guardrails)}`;
  }

  return `Generate variant patches for this A/B test hypothesis:

Title: ${title}
Hypothesis: ${hypothesis}
Page type: ${pageType}
Element type: ${elementType}
Target metric: ${targetMetric}

${constraintsBlock}

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

interface CritiqueResult {
  passed: boolean;
  failedItems: string[];
  specificFixes: string[];
}

async function designCritique(
  htmlPatch: string | null,
  cssPatch: string | null,
  jsPatch: string | null,
  cssVars: Record<string, string>
): Promise<CritiqueResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || (!htmlPatch && !cssPatch)) {
    return { passed: true, failedItems: [], specificFixes: [] };
  }

  const client = new Anthropic({ apiKey });

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: `You are a Shopify front-end design reviewer.
Review this generated variant against the store's design system.
Return ONLY valid JSON — no explanation, no markdown fences.
Shape: { "passed": boolean, "failedItems": string[], "specificFixes": string[] }

Rubric (check each — fail if violated):
1. No hardcoded hex color values in CSS patch
2. No hardcoded font-family strings (must use CSS var or inherit)
3. No introduced box-shadow, text-shadow, gradients, or transitions absent from token set
4. Spacing uses relative units (rem, em, %) or CSS vars — no arbitrary px values
5. No CSS class names that would conflict with Shopify theme namespacing

Store CSS custom properties:
${JSON.stringify(cssVars, null, 2)}

Generated variant:
HTML: ${htmlPatch ?? "null"}
CSS: ${cssPatch ?? "null"}
JS: ${jsPatch ?? "null"}`,
        },
      ],
    });

    const raw = response.content[0];
    if (raw.type !== "text") return { passed: true, failedItems: [], specificFixes: [] };
    const jsonStr = raw.text
      .trim()
      .replace(/^```(?:json)?\n?/, "")
      .replace(/\n?```$/, "");
    return JSON.parse(jsonStr) as CritiqueResult;
  } catch (err) {
    console.error("[autoBuild] designCritique error (failing open):", err);
    return { passed: true, failedItems: [], specificFixes: [] };
  }
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
    include: {
      shop: {
        select: {
          brandGuardrails: true,
          themeTokens: true,
        },
      },
    },
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
          hypothesis.shop.brandGuardrails,
          hypothesis.shop.themeTokens,
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

  const qa = qaGate(patches.htmlPatch ?? null, patches.jsPatch ?? null);
  if (!qa.passed) {
    await prisma.hypothesis.update({
      where: { id: hypothesisId },
      data: { status: "qa_failed" },
    });
    await logOrchestrator(shopId, runId, "QA", "failed", { reason: qa.reason, hypothesisId });
    console.log(`[autoBuild] QA failed for hypothesis ${hypothesisId}: ${qa.reason}`);
    return;
  }

  // ── Design critique pass ──────────────────────────────────────────────────
  const tokens = hypothesis.shop.themeTokens as {
    cssVars?: Record<string, string>;
  } | null;
  const cssVars = tokens?.cssVars ?? {};
  const hasCssVars = Object.keys(cssVars).length > 0;

  if (hasCssVars) {
    let critique = await designCritique(patches.htmlPatch ?? null, patches.cssPatch ?? null, patches.jsPatch ?? null, cssVars);

    if (!critique.passed) {
      console.log(
        `[autoBuild] design critique failed for ${hypothesisId} — retrying with feedback`
      );
      const retryPrompt =
        buildUserPrompt(
          hypothesis.title,
          hypothesis.hypothesis,
          hypothesis.pageType,
          hypothesis.elementType,
          hypothesis.targetMetric,
          hypothesis.shop.brandGuardrails,
          hypothesis.shop.themeTokens
        ) +
        `\n\n## Design critique feedback (MUST fix before responding):\n` +
        critique.failedItems.map((item) => `- ${item}`).join("\n") +
        (critique.specificFixes.length > 0
          ? `\n\nSpecific fixes required:\n` +
            critique.specificFixes.map((f) => `- ${f}`).join("\n")
          : "");

      const retryResponse = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: buildSystemPrompt(),
        messages: [{ role: "user", content: retryPrompt }],
      });

      const retryRaw = retryResponse.content[0];
      if (retryRaw.type === "text") {
        const retryJsonStr = retryRaw.text
          .trim()
          .replace(/^```(?:json)?\n?/, "")
          .replace(/\n?```$/, "");
        try {
          patches = JSON.parse(retryJsonStr);
          critique = await designCritique(patches.htmlPatch ?? null, patches.cssPatch ?? null, patches.jsPatch ?? null, cssVars);
          if (!critique.passed) {
            await prisma.hypothesis.update({
              where: { id: hypothesisId },
              data: { status: "qa_failed" },
            });
            await logOrchestrator(shopId, runId, "DESIGN_CRITIQUE", "failed", {
              hypothesisId,
              failedItems: critique.failedItems,
            });
            console.log(
              `[autoBuild] design critique failed after retry for ${hypothesisId} — marked qa_failed`
            );
            return;
          }
          console.log(`[autoBuild] design critique passed after retry for ${hypothesisId}`);
        } catch {
          console.warn(`[autoBuild] retry JSON parse failed for ${hypothesisId} — using original patches`);
        }
      }
    } else {
      console.log(`[autoBuild] design critique passed on first attempt for ${hypothesisId}`);
    }
  }

  const { htmlPatch, cssPatch, jsPatch, variantDescription } = patches;

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

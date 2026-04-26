/**
 * Hypothesis generator job.
 *
 * Reads the latest research report for a shop and calls Claude to produce
 * 10-20 scored A/B test hypotheses with ICE scores.
 * Writes results to the hypotheses table.
 *
 * Requires ANTHROPIC_API_KEY in environment.
 */

import { Queue, Worker, type Job } from "bullmq";
import { connection } from "../lib/queue";
import prisma from "../app/db.server";
import Anthropic from "@anthropic-ai/sdk";

export const HYPOTHESIS_GENERATOR_QUEUE = "hypothesis-generator";

export interface HypothesisGeneratorJobData {
  shopId: string;
  reportId: string;
}

export const hypothesisGeneratorQueue = new Queue<HypothesisGeneratorJobData>(
  HYPOTHESIS_GENERATOR_QUEUE,
  {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 15_000 },
    },
  }
);

const PAGE_TYPES = ["product", "collection", "cart", "homepage", "any"] as const;
const ELEMENT_TYPES = ["headline", "cta", "image", "layout", "trust", "price", "other"] as const;
const TARGET_METRICS = ["conversion_rate", "add_to_cart_rate", "revenue_per_visitor"] as const;

type RawHypothesis = {
  title: string;
  hypothesis: string;
  pageType: string;
  elementType: string;
  targetMetric: string;
  iceImpact: number;
  iceConfidence: number;
  iceEase: number;
  reasoning: string;
};

const SYSTEM_PROMPT = `You are a senior CRO strategist. Generate specific, testable A/B test hypotheses.
Each hypothesis must follow the format:
"We believe [change] on [page] will [increase/decrease] [metric] because [reasoning]."
ICE scores (1-10 each): Impact = potential conversion uplift, Confidence = evidence strength, Ease = implementation difficulty (10 = easiest).

PLATFORM GUARDRAILS — you must respect these Shopify constraints:
- Never suggest experiments that modify the checkout page (inaccessible on standard Shopify plans)
- Never suggest experiments requiring logged-in customer data (Storefront API not configured)
- All variant code must run as async JS or CSS injection — no synchronous scripts
- Experiments must target product pages, collection pages, cart page, or homepage only
- Keep JS patches under 10kb — suggest lightweight DOM changes, not full component rewrites`;

function buildHypothesisPrompt(reportMd: string, pastTests: string): string {
  return `## Research Report
${reportMd}

## Past Tests (avoid repeating these exactly)
${pastTests || "None yet."}

---

Generate 10-15 specific, testable A/B test hypotheses based on this research.

Return a JSON array. Each object must have these exact keys:
- title: string (short, 5-8 words)
- hypothesis: string (full "We believe..." statement)
- pageType: one of ${JSON.stringify(PAGE_TYPES)}
- elementType: one of ${JSON.stringify(ELEMENT_TYPES)}
- targetMetric: one of ${JSON.stringify(TARGET_METRICS)}
- iceImpact: integer 1-10
- iceConfidence: integer 1-10
- iceEase: integer 1-10
- reasoning: string (1-2 sentences explaining the ICE scores)

Return ONLY the JSON array, no other text.`;
}

async function generateHypotheses(
  shopId: string,
  reportId: string
): Promise<RawHypothesis[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const [report, knowledgeBase] = await Promise.all([
    prisma.researchReport.findUnique({ where: { id: reportId } }),
    prisma.knowledgeBase.findMany({
      where: { shopId },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);
  if (!report) throw new Error(`Report ${reportId} not found`);

  const pastTests = knowledgeBase
    .map((e) => `- ${e.pageType}/${e.elementType}: "${e.hypothesisText}" → ${e.result}`)
    .join("\n");

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildHypothesisPrompt(report.reportMd, pastTests),
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== "text") throw new Error("Unexpected Claude response type");

  // Strip markdown code fences if Claude wraps the JSON
  const raw = content.text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  return JSON.parse(raw) as RawHypothesis[];
}

async function runHypothesisGenerator(shopId: string, reportId: string) {
  const hypotheses = await generateHypotheses(shopId, reportId);

  const rows = hypotheses.map((h) => ({
    shopId,
    reportId,
    title: h.title,
    hypothesis: h.hypothesis,
    pageType: PAGE_TYPES.includes(h.pageType as typeof PAGE_TYPES[number]) ? h.pageType : "any",
    elementType: ELEMENT_TYPES.includes(h.elementType as typeof ELEMENT_TYPES[number]) ? h.elementType : "other",
    targetMetric: TARGET_METRICS.includes(h.targetMetric as typeof TARGET_METRICS[number]) ? h.targetMetric : "conversion_rate",
    iceImpact: Math.min(10, Math.max(1, Math.round(h.iceImpact))),
    iceConfidence: Math.min(10, Math.max(1, Math.round(h.iceConfidence))),
    iceEase: Math.min(10, Math.max(1, Math.round(h.iceEase))),
    iceScore: h.iceImpact * h.iceConfidence * h.iceEase,
    status: "backlog" as const,
  }));

  await prisma.hypothesis.createMany({ data: rows });
  console.log(`[hypothesisGenerator] wrote ${rows.length} hypotheses for shop ${shopId}`);
}

export function startHypothesisGeneratorWorker() {
  return new Worker<HypothesisGeneratorJobData>(
    HYPOTHESIS_GENERATOR_QUEUE,
    async (job: Job<HypothesisGeneratorJobData>) => {
      await runHypothesisGenerator(job.data.shopId, job.data.reportId);
    },
    { connection }
  );
}

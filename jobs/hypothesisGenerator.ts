/**
 * Hypothesis generator job.
 *
 * Reads the latest research report for a shop and calls Claude to produce
 * 10-20 scored A/B test hypotheses with ICE scores.
 * Writes results to the hypotheses table.
 *
 * Requires ANTHROPIC_API_KEY in environment.
 */

import { getBoss } from "../lib/pgboss.server";
import prisma from "../app/db.server";
import Anthropic from "@anthropic-ai/sdk";
import { fetchPlatformInsights } from "../lib/knowledgeBase.server";

export const HYPOTHESIS_GENERATOR_QUEUE = "hypothesis-generator";

export interface HypothesisGeneratorJobData {
  shopId: string;
  reportId: string;
}

export async function enqueueHypothesisGenerator(shopId: string, reportId: string): Promise<void> {
  const boss = await getBoss();
  await boss.createQueue(HYPOTHESIS_GENERATOR_QUEUE);
  const id = await boss.send(HYPOTHESIS_GENERATOR_QUEUE, { shopId, reportId }, { retryLimit: 3, retryDelay: 15, retryBackoff: true }); // retryDelay in seconds
  if (id === null) console.warn(`[hypothesisGenerator] send returned null for shop ${shopId} — job blocked`);
}

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
  recommendedSegment?: {
    deviceType?: string | null;
    geoCountry?: string[];
    trafficSource?: string | null;
    visitorType?: string | null;
  } | null;
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
- Keep JS patches under 10kb — suggest lightweight DOM changes, not full component rewrites

When segment data shows a specific device type or geography underperforming, target that segment in the recommendedSegment field. Set a field to null if the hypothesis applies broadly regardless of that dimension.`;

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
- recommendedSegment: { deviceType: "mobile"|"desktop"|"tablet"|null, geoCountry: string[], trafficSource: "paid"|"organic"|null, visitorType: "new"|"returning"|null } or null if broadly applicable

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

  const platformInsights = await fetchPlatformInsights();
  const userPrompt = buildHypothesisPrompt(report.reportMd, pastTests) +
    (platformInsights
      ? `\n\n${platformInsights}\n\nWhen scoring ICE, use these platform patterns to calibrate Confidence scores. High-performing patterns on the platform should get higher Confidence. Consistent losers should get lower Confidence even if they seem logical locally.`
      : "");

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    // 8192 comfortably fits ~20 detailed hypotheses. 4096 truncated the JSON
    // array mid-string on wordier batches, which made JSON.parse throw and the
    // whole run produced 0 hypotheses (report still showed "complete").
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: userPrompt,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== "text") throw new Error("Unexpected Claude response type");

  // Strip markdown code fences if Claude wraps the JSON
  const raw = content.text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  return parseHypothesisArray(raw, response.stop_reason);
}

/**
 * Parse Claude's hypothesis array. If the JSON is invalid — most commonly
 * because the response was truncated at max_tokens — salvage every COMPLETE
 * object before the cut so we still return usable hypotheses instead of
 * throwing the whole batch away (which previously produced 0 hypotheses).
 */
function parseHypothesisArray(raw: string, stopReason: string | null): RawHypothesis[] {
  try {
    return JSON.parse(raw) as RawHypothesis[];
  } catch (err) {
    const salvaged = salvageJsonArray(raw);
    if (salvaged.length > 0) {
      console.warn(
        `[hypothesisGenerator] response ${stopReason === "max_tokens" ? "truncated" : "unparseable"} — salvaged ${salvaged.length} complete hypotheses`
      );
      return salvaged;
    }
    throw err;
  }
}

/** Extract every complete top-level object from a (possibly truncated) JSON array string. */
function salvageJsonArray(raw: string): RawHypothesis[] {
  const start = raw.indexOf("[");
  if (start === -1) return [];
  const objects: RawHypothesis[] = [];
  let depth = 0;
  let objStart = -1;
  let inStr = false;
  let esc = false;
  for (let i = start + 1; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && objStart !== -1) {
        try {
          objects.push(JSON.parse(raw.slice(objStart, i + 1)) as RawHypothesis);
        } catch {
          /* skip a malformed object */
        }
        objStart = -1;
      }
    }
  }
  return objects;
}

export async function runHypothesisGenerator(shopId: string, reportId: string) {
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
    iceScore: Math.min(10, Math.max(1, Math.round(h.iceImpact))) *
              Math.min(10, Math.max(1, Math.round(h.iceConfidence))) *
              Math.min(10, Math.max(1, Math.round(h.iceEase))),
    status: "backlog" as const,
    recommendedSegment: h.recommendedSegment ?? undefined,
  }));

  await prisma.hypothesis.createMany({ data: rows });
  console.log(`[hypothesisGenerator] wrote ${rows.length} hypotheses for shop ${shopId}`);
}


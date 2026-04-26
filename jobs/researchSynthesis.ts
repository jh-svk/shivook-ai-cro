/**
 * Research synthesis job.
 *
 * Assembles the shop's data snapshot and calls Claude to produce a ranked
 * friction-point report. Stores the result in research_reports.
 *
 * Requires ANTHROPIC_API_KEY in environment.
 */

import { Queue, Worker, type Job } from "bullmq";
import { connection } from "../lib/queue";
import prisma from "../app/db.server";
import Anthropic from "@anthropic-ai/sdk";
import { hypothesisGeneratorQueue } from "./hypothesisGenerator";

export const RESEARCH_SYNTHESIS_QUEUE = "research-synthesis";

export interface ResearchSynthesisJobData {
  shopId: string;
}

export const researchSynthesisQueue = new Queue<ResearchSynthesisJobData>(
  RESEARCH_SYNTHESIS_QUEUE,
  {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 15_000 },
    },
  }
);

function buildSystemPrompt(shopDomain: string): string {
  return `You are a senior conversion rate optimisation analyst for the Shopify store "${shopDomain}".
You have deep expertise in ecommerce UX, buyer psychology, and A/B testing methodology.
Your task is to analyse the provided store data and produce a ranked friction-point report.
Be specific, data-driven, and actionable. Focus on the highest-leverage opportunities.
Output valid markdown.`;
}

function buildDataPrompt(snapshot: Record<string, unknown>, pastTests: string): string {
  const claritySection = snapshot.clarity
    ? `## Heatmap Data (Clarity)\n\`\`\`json\n${JSON.stringify(snapshot.clarity, null, 2)}\n\`\`\`\n\nInterpretation guidance:\n- High rage click count on a page signals user frustration — likely a broken element or confusing CTA\n- Low scroll depth on product pages signals poor content hierarchy — key info may be below the fold\n- High dead click count indicates broken UX expectations — elements that look clickable but aren't\n\n`
    : "## Heatmap Data (Clarity)\nNot connected.\n\n";

  return `## Store Data Snapshot (last 30 days)

\`\`\`json
${JSON.stringify({ ...snapshot, clarity: undefined }, null, 2)}
\`\`\`

${claritySection}## Past Test History
${pastTests || "No prior tests completed yet."}

---

Analyse this data and produce a ranked friction-point report. For each friction point:
1. Describe the problem clearly
2. Cite the specific metric that signals it
3. Estimate the conversion impact if fixed (low / medium / high)
4. Note the page type and element most likely to fix it

Rank the top 5-8 friction points from highest to lowest impact.
Format as clean markdown with a ### heading per friction point.`;
}

async function synthesise(shopId: string): Promise<string> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: { knowledgeBase: { orderBy: { createdAt: "desc" }, take: 10 } },
  });
  if (!shop) throw new Error(`Shop ${shopId} not found`);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const dataSnapshot = (shop.dataSnapshot as Record<string, unknown>) ?? {};

  const pastTests = shop.knowledgeBase
    .map(
      (e) =>
        `- [${e.result.toUpperCase()}] ${e.pageType}/${e.elementType}: "${e.hypothesisText}" ` +
        `(lift: ${e.liftPercentage != null ? `${e.liftPercentage.toFixed(1)}%` : "n/a"})`
    )
    .join("\n");

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: buildSystemPrompt(shop.shopifyDomain),
    messages: [{ role: "user", content: buildDataPrompt(dataSnapshot, pastTests) }],
  });

  const content = response.content[0];
  if (content.type !== "text") throw new Error("Unexpected response type from Claude");
  return content.text;
}

async function runResearchSynthesis(shopId: string) {
  const reportRecord = await prisma.researchReport.create({
    data: {
      shopId,
      status: "pending",
      dataSnapshot: {},
      reportMd: "",
    },
  });

  try {
    const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { dataSnapshot: true } });
    const dataSnapshot = (shop?.dataSnapshot ?? {}) as object;

    const reportMd = await synthesise(shopId);

    await prisma.researchReport.update({
      where: { id: reportRecord.id },
      data: { status: "complete", reportMd, dataSnapshot },
    });

    console.log(`[researchSynthesis] report complete for shop ${shopId}`);

    await hypothesisGeneratorQueue.add(`gen-${shopId}`, {
      shopId,
      reportId: reportRecord.id,
    });
    console.log(`[researchSynthesis] enqueued hypothesis generator for report ${reportRecord.id}`);

    return reportRecord.id;
  } catch (err) {
    await prisma.researchReport.update({
      where: { id: reportRecord.id },
      data: { status: "failed" },
    });
    throw err;
  }
}

export function startResearchSynthesisWorker() {
  return new Worker<ResearchSynthesisJobData>(
    RESEARCH_SYNTHESIS_QUEUE,
    async (job: Job<ResearchSynthesisJobData>) => {
      await runResearchSynthesis(job.data.shopId);
    },
    { connection }
  );
}

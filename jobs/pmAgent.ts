import { Queue, Worker, type Job } from "bullmq";
import { connection } from "../lib/queue";
import prisma from "../app/db.server";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
import path from "path";

export const PM_AGENT_QUEUE = "pm-agent";

export interface PmAgentJobData {
  feedbackId: string;
  shopId: string;
}

export const pmAgentQueue = new Queue<PmAgentJobData>(PM_AGENT_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 10_000 },
  },
});

const PM_SYSTEM_PROMPT = `You are a technical project manager for "Shivook AI CRO" — a Shopify A/B testing app.

Stack: Shopify Remix + Polaris UI, Postgres/Prisma, BullMQ/Redis, Claude API, Railway hosting. TypeScript throughout.

Folder structure:
- /app/routes/ — Remix routes (loader + action + JSX in one file)
- /app/components/ — Reusable Polaris components
- /jobs/ — BullMQ job definitions
- /lib/ — Shared utilities and server-side helpers
- /prisma/schema.prisma — Database schema
- /extensions/ — DO NOT TOUCH — Shopify theme/pixel extensions deployed separately

A merchant has submitted an improvement request. Analyze it and produce a structured build directive.

Respond ONLY with a valid JSON object — no markdown fences, no explanation:
{
  "summary": "One-line description of the change",
  "scope": "ui_only | new_feature | schema_change | job_change | multi_area",
  "files_to_modify": ["relative/path/file.tsx"],
  "files_to_create": ["relative/path/newfile.ts"],
  "needs_migration": false,
  "migration_name": null,
  "implementation_notes": "Detailed step-by-step instructions. Be specific about file paths, function names, Prisma model changes, and UI component choices. The Builder will follow this literally.",
  "test_requirements": "What to verify after building (npm run build + tsc must pass; list any specific UI or logic checks)",
  "estimated_complexity": "low | medium | high"
}

Constraints:
- Never suggest changes to /extensions/, app/shopify.server.ts, or authentication infrastructure.
- Always use Polaris components for UI (never raw HTML or Tailwind).
- Schema changes must use Prisma migrations (npx prisma migrate dev).
- Keep implementation_notes concrete enough that a developer can implement without asking questions.`;

async function getNextMessageNumber(): Promise<number> {
  const messagesPath = path.resolve(process.cwd(), "AGENT_MESSAGES.md");
  try {
    const content = await fs.readFile(messagesPath, "utf-8");
    const lines = content.split("\n").slice(0, 20);
    const numbers: number[] = [];
    for (const line of lines) {
      const m = line.match(/^## MESSAGE (\d+)/);
      if (m) numbers.push(parseInt(m[1], 10));
    }
    return numbers.length > 0 ? Math.max(...numbers) + 1 : 25;
  } catch {
    return 25;
  }
}

async function appendToAgentMessages(content: string): Promise<void> {
  const messagesPath = path.resolve(process.cwd(), "AGENT_MESSAGES.md");
  try {
    const existing = await fs.readFile(messagesPath, "utf-8");
    const headerEnd = existing.indexOf("\n---\n");
    if (headerEnd === -1) {
      await fs.appendFile(messagesPath, "\n" + content);
    } else {
      const before = existing.slice(0, headerEnd + 1);
      const after = existing.slice(headerEnd + 1);
      await fs.writeFile(messagesPath, before + "\n" + content + "\n" + after);
    }
  } catch {
    await fs.appendFile(messagesPath, "\n" + content);
  }
}

async function processPmAgent(job: Job<PmAgentJobData>): Promise<void> {
  const { feedbackId, shopId } = job.data;

  try {
  const feedbackRequest = await prisma.feedbackRequest.findFirst({
    where: { id: feedbackId, shopId },
  });
  if (!feedbackRequest) throw new Error(`FeedbackRequest ${feedbackId} not found`);

  await prisma.feedbackRequest.update({
    where: { id: feedbackId },
    data: { status: "pm_analyzing" },
  });

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: PM_SYSTEM_PROMPT,
    messages: [{ role: "user", content: feedbackRequest.requestText }],
  });

  const text = response.content.find((b) => b.type === "text")?.text ?? "";

  let directive: Record<string, unknown>;
  try {
    directive = JSON.parse(text);
  } catch {
    // One inline retry: ask Claude to fix the JSON
    const fixResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: PM_SYSTEM_PROMPT,
      messages: [
        { role: "user", content: feedbackRequest.requestText },
        { role: "assistant", content: text },
        {
          role: "user",
          content:
            "Your response was not valid JSON. Reply ONLY with the corrected JSON object, no fences or explanation.",
        },
      ],
    });
    const fixedText = fixResponse.content.find((b) => b.type === "text")?.text ?? "";
    directive = JSON.parse(fixedText);
  }

  const pmDirective = JSON.stringify(directive, null, 2);

  await prisma.feedbackRequest.update({
    where: { id: feedbackId },
    data: { pmDirective, status: "building" },
  });

  // Append to AGENT_MESSAGES.md
  const msgNum = await getNextMessageNumber();
  const today = new Date().toISOString().slice(0, 10);
  const messageBlock = `## MESSAGE ${msgNum}
FROM: PM agent (automated)
TO: Builder agent
DATE: ${today}
STATUS: ACTION REQUIRED — Automated from merchant feedback #${feedbackId}

### Merchant request
${feedbackRequest.requestText}

### Directive
\`\`\`json
${pmDirective}
\`\`\`

---
`;
  await appendToAgentMessages(messageBlock);

  // Enqueue builder agent
  const { builderAgentQueue } = await import("./builderAgent");
  await builderAgentQueue.add(`build-${feedbackId}`, { feedbackId, shopId });

  } catch (err: unknown) {
    const errorMessage = (err as Error).message ?? String(err);
    await prisma.feedbackRequest.update({
      where: { id: feedbackId },
      data: { status: "failed", errorMessage },
    }).catch(() => {});
    throw err;
  }
}

export function startPmAgentWorker() {
  return new Worker<PmAgentJobData>(PM_AGENT_QUEUE, processPmAgent, {
    connection,
    concurrency: 2,
  });
}

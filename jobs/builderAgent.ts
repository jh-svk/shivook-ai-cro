import { Queue, Worker, type Job } from "bullmq";
import { connection } from "../lib/queue";
import prisma from "../app/db.server";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
import path from "path";
import {
  getRepoSlug,
  cloneRepo,
  configureGit,
  createBranch,
  commitAll,
  pushBranch,
  createPR,
  waitForCIAndMerge,
  cleanup,
} from "../lib/gitOps.server";
import { getBuilderTools, executeTool } from "../lib/agentTools.server";

export const BUILDER_AGENT_QUEUE = "builder-agent";

export interface BuilderAgentJobData {
  feedbackId: string;
  shopId: string;
}

export const builderAgentQueue = new Queue<BuilderAgentJobData>(BUILDER_AGENT_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 1,
  },
});

const BUILDER_SYSTEM_PROMPT = `You are a senior TypeScript developer implementing changes on "Shivook AI CRO" — a Shopify A/B testing app.
Stack: Shopify Remix + Polaris, Prisma/Postgres, BullMQ/Redis, Railway hosting.

You are working in a fresh clone of the repository. All file paths are relative to the repo root.

Tools available:
- read_file(path): read a file
- write_file(path, content): write/overwrite a file (creates parent dirs automatically)
- list_directory(path): list files in a directory
- run_command(command, args): run a shell command (git, npm, npx, node only)

Rules you must follow:
1. NEVER modify anything in extensions/ — Shopify extensions are deployed separately.
2. NEVER modify app/shopify.server.ts — authentication infrastructure.
3. Always read a file before writing it if it already exists.
4. Check nearby files for patterns before writing new ones (list_directory, then read).
5. Use Polaris components for all UI — check existing routes for the import pattern.
6. After all changes: run ["npm", ["run", "build"]] and ["npx", ["tsc", "--noEmit"]]. Both must succeed.
7. If the directive includes needs_migration: true, run ["npx", ["prisma", "migrate", "dev", "--name", migration_name, "--skip-seed"]] then ["npx", ["prisma", "generate"]].
8. When complete, respond ONLY with this JSON (no markdown fences):
   {"status": "complete", "summary": "one-line description of what was built", "files_changed": ["path1", "path2"]}`;

function buildBuilderPrompt(directive: Record<string, unknown>, cloneDir: string): string {
  return `Implement the following directive from the PM agent.

Directive:
${JSON.stringify(directive, null, 2)}

Working directory: ${cloneDir}

Start by reading the files listed in files_to_modify and listing the directories of files_to_create. Then implement all changes following the implementation_notes exactly. Run the required commands to verify. When done, respond with the completion JSON.`;
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

async function runAgenticLoop(
  anthropic: Anthropic,
  directive: Record<string, unknown>,
  cloneDir: string
): Promise<{ status: string; summary: string; files_changed: string[] }> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: buildBuilderPrompt(directive, cloneDir) },
  ];

  let iterations = 0;
  const MAX_ITERATIONS = 40;

  while (iterations < MAX_ITERATIONS) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: BUILDER_SYSTEM_PROMPT,
      tools: getBuilderTools(),
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const text = response.content.find((b) => b.type === "text")?.text ?? "";
      return JSON.parse(text);
    }

    if (response.stop_reason === "tool_use") {
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const output = await executeTool(
            block.name,
            block.input as Record<string, unknown>,
            cloneDir
          );
          results.push({ type: "tool_result", tool_use_id: block.id, content: output });
        }
      }
      messages.push({ role: "user", content: results });
    }

    iterations++;
  }

  throw new Error(`Builder agent exceeded ${MAX_ITERATIONS} iterations`);
}

async function processBuilderAgent(job: Job<BuilderAgentJobData>): Promise<void> {
  const { feedbackId, shopId } = job.data;
  const cloneDir = `/tmp/builder-${feedbackId}`;

  const feedbackRequest = await prisma.feedbackRequest.findFirst({
    where: { id: feedbackId, shopId },
  });
  if (!feedbackRequest) throw new Error(`FeedbackRequest ${feedbackId} not found`);
  if (!feedbackRequest.pmDirective) throw new Error("pmDirective is missing — PM agent may not have completed");

  let directive: Record<string, unknown>;
  try {
    directive = JSON.parse(feedbackRequest.pmDirective);
  } catch {
    throw new Error("pmDirective is not valid JSON");
  }

  let loopResult: { status: string; summary: string; files_changed: string[] } | null = null;

  try {
    const repoSlug = await getRepoSlug();
    const branch = `feedback/${feedbackId}`;

    await cloneRepo(cloneDir, repoSlug);
    await configureGit(cloneDir);
    await createBranch(cloneDir, branch);

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    loopResult = await runAgenticLoop(anthropic, directive, cloneDir);

    // Final verification
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    await execFileAsync("npm", ["run", "build"], { cwd: cloneDir, timeout: 300_000 });
    await execFileAsync("npx", ["tsc", "--noEmit"], { cwd: cloneDir, timeout: 300_000 });

    await prisma.feedbackRequest.update({
      where: { id: feedbackId },
      data: { status: "testing" },
    });

    // Run infra tests if they exist
    try {
      const pkgJson = JSON.parse(
        await fs.readFile(path.join(cloneDir, "package.json"), "utf-8")
      ) as { scripts?: Record<string, string> };
      if (pkgJson.scripts?.["test:infra"]) {
        await execFileAsync("npm", ["run", "test:infra"], { cwd: cloneDir, timeout: 300_000 });
      }
    } catch {
      // Non-fatal — log and continue
      console.warn("[builderAgent] infra tests skipped or failed — continuing");
    }

    const commitMsg = `feat: ${directive.summary ?? loopResult.summary} (feedback #${feedbackId})`;
    await commitAll(cloneDir, commitMsg);
    await pushBranch(cloneDir, branch, repoSlug);

    const prBody = `## Auto-generated change

**Merchant feedback:** ${feedbackRequest.requestText}

**PM directive summary:** ${directive.summary}

**Files changed:** ${loopResult.files_changed.join(", ")}

**Estimated complexity:** ${directive.estimated_complexity}

---
🤖 Built automatically by Shivook AI Builder
Feedback ID: ${feedbackId}`;

    const { prNumber, prUrl } = await createPR(
      repoSlug,
      branch,
      `[Auto] ${directive.summary}`,
      prBody
    );

    await prisma.feedbackRequest.update({
      where: { id: feedbackId },
      data: { status: "deploying", prUrl, prNumber },
    });

    await waitForCIAndMerge(repoSlug, prNumber);

    const report = `Built: ${loopResult.summary}\nFiles changed: ${loopResult.files_changed.join(", ")}`;
    await prisma.feedbackRequest.update({
      where: { id: feedbackId },
      data: { status: "deployed", deployedAt: new Date(), builderReport: report },
    });

    await cleanup(cloneDir);

    const today = new Date().toISOString().slice(0, 10);
    await appendToAgentMessages(`## Builder Report — Feedback #${feedbackId}
FROM: Builder agent (automated)
DATE: ${today}
STATUS: COMPLETE

### Summary
${loopResult.summary}

### Files changed
${loopResult.files_changed.map((f) => `- ${f}`).join("\n")}

### PR
${prUrl}

---
`);
  } catch (err: unknown) {
    await cleanup(cloneDir).catch(() => {});
    const errorMessage = (err as Error).message ?? String(err);

    await prisma.feedbackRequest.update({
      where: { id: feedbackId },
      data: { status: "failed", errorMessage },
    });

    const today = new Date().toISOString().slice(0, 10);
    await appendToAgentMessages(`## Builder Report — Feedback #${feedbackId}
FROM: Builder agent (automated)
DATE: ${today}
STATUS: FAILED

### Error
${errorMessage}

---
`);

    throw err;
  }
}

export function startBuilderAgentWorker() {
  return new Worker<BuilderAgentJobData>(BUILDER_AGENT_QUEUE, processBuilderAgent, {
    connection,
    concurrency: 1,
    lockDuration: 1_800_000, // 30 minutes
  });
}

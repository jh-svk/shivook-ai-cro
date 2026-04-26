/**
 * Orchestrator job.
 *
 * Runs every 6 hours per shop. Executes stages in sequence:
 * RESEARCH → HYPOTHESIS → BUILD → MONITOR → DECIDE → SHIP
 *
 * Each stage is logged to orchestrator_log. A skipped or failed stage
 * does not abort the run — subsequent stages always execute.
 */

import { Queue, Worker, type Job } from "bullmq";
import { randomUUID } from "crypto";
import { connection } from "../lib/queue";
import prisma from "../app/db.server";
import { dataSyncQueue } from "./dataSync";
import { researchSynthesisQueue } from "./researchSynthesis";
import { autoBuildQueue } from "./autoBuild";
import { writeKnowledgeBaseEntry } from "../lib/knowledgeBase.server";

export const ORCHESTRATOR_QUEUE = "orchestrator";

export interface OrchestratorJobData {
  shopId: string;
}

export const orchestratorQueue = new Queue<OrchestratorJobData>(ORCHESTRATOR_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
  },
});

async function log(
  shopId: string,
  runId: string,
  stage: string,
  status: string,
  payload: object
) {
  try {
    await prisma.orchestratorLog.create({
      data: { shopId, runId, stage, status, payload, completedAt: new Date() },
    });
  } catch (err) {
    console.error(`[orchestrator] failed to log stage ${stage}`, err);
  }
}

async function stageResearch(shopId: string, runId: string) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await prisma.researchReport.findFirst({
    where: { shopId, generatedAt: { gte: cutoff } },
    select: { id: true },
  });

  if (recent) {
    await log(shopId, runId, "RESEARCH", "skipped", { reason: "recent report exists", reportId: recent.id });
    return;
  }

  await dataSyncQueue.add(`orch-sync-${shopId}-${runId}`, { shopId });
  await researchSynthesisQueue.add(
    `orch-research-${shopId}-${runId}`,
    { shopId },
    { delay: 10 * 60 * 1000 }
  );
  await log(shopId, runId, "RESEARCH", "complete", { message: "enqueued dataSync + researchSynthesis" });
}

async function stageHypothesis(shopId: string, runId: string) {
  const count = await prisma.hypothesis.count({ where: { shopId, status: "backlog" } });
  if (count === 0) {
    await log(shopId, runId, "HYPOTHESIS", "skipped", { reason: "no backlog hypotheses" });
    return;
  }
  await log(shopId, runId, "HYPOTHESIS", "complete", { backlogCount: count });
}

async function stageBuild(shopId: string, runId: string) {
  const hypothesis = await prisma.hypothesis.findFirst({
    where: { shopId, status: "backlog" },
    orderBy: { iceScore: "desc" },
    select: { id: true, iceScore: true, title: true },
  });

  if (!hypothesis) {
    await log(shopId, runId, "BUILD", "skipped", { reason: "no backlog hypotheses" });
    return;
  }

  await autoBuildQueue.add(`build-${hypothesis.id}`, { shopId, hypothesisId: hypothesis.id });
  await log(shopId, runId, "BUILD", "complete", {
    hypothesisId: hypothesis.id,
    title: hypothesis.title,
    iceScore: hypothesis.iceScore,
  });
}

async function stageMonitor(shopId: string, runId: string) {
  const activeExperiments = await prisma.experiment.findMany({
    where: { shopId, status: "active" },
    include: { result: true },
  });

  const tripped: string[] = [];
  for (const exp of activeExperiments) {
    if (exp.result?.guardrailStatus === "aov_tripped") {
      await prisma.experiment.update({
        where: { id: exp.id },
        data: { status: "concluded", concludedAt: new Date() },
      });
      tripped.push(exp.id);
    }
  }

  await log(shopId, runId, "MONITOR", "complete", {
    checked: activeExperiments.length,
    guardRailTripped: tripped,
  });
}

async function stageDecide(shopId: string, runId: string) {
  const now = new Date();
  const activeExperiments = await prisma.experiment.findMany({
    where: { shopId, status: "active" },
    include: { result: true },
  });

  const concluded: string[] = [];
  const timedOut: string[] = [];

  for (const exp of activeExperiments) {
    const startedAt = exp.startedAt;
    const daysSinceStart = startedAt
      ? (now.getTime() - startedAt.getTime()) / (1000 * 60 * 60 * 24)
      : 0;

    // Winner: significant + met minimum runtime
    if (
      exp.result?.isSignificant &&
      (exp.result.probToBeatControl ?? 0) >= 0.95 &&
      daysSinceStart >= exp.minRuntimeDays
    ) {
      await prisma.experiment.update({
        where: { id: exp.id },
        data: { status: "concluded", concludedAt: now },
      });
      concluded.push(exp.id);
      continue;
    }

    // Timed out
    if (daysSinceStart >= exp.maxRuntimeDays) {
      await prisma.experiment.update({
        where: { id: exp.id },
        data: { status: "concluded", concludedAt: now },
      });
      timedOut.push(exp.id);
    }
  }

  await log(shopId, runId, "DECIDE", "complete", { concluded, timedOut });
}

async function stageShip(shopId: string, runId: string) {
  const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const recentlyConcluded = await prisma.experiment.findMany({
    where: { shopId, status: "concluded", concludedAt: { gte: cutoff } },
    select: { id: true },
  });

  const written: string[] = [];
  for (const { id } of recentlyConcluded) {
    try {
      await writeKnowledgeBaseEntry(id);
      written.push(id);
    } catch (err) {
      console.error(`[orchestrator] SHIP: failed to write KB for ${id}`, err);
    }
  }

  await log(shopId, runId, "SHIP", "complete", { written });
}

async function runOrchestrator(shopId: string) {
  const runId = randomUUID();
  console.log(`[orchestrator] starting run ${runId} for shop ${shopId}`);

  const stages = [stageResearch, stageHypothesis, stageBuild, stageMonitor, stageDecide, stageShip];

  for (const stage of stages) {
    try {
      await stage(shopId, runId);
    } catch (err) {
      console.error(`[orchestrator] stage error in run ${runId}`, err);
      try {
        await prisma.orchestratorLog.create({
          data: {
            shopId,
            runId,
            stage: stage.name,
            status: "failed",
            payload: { error: String(err) },
            completedAt: new Date(),
          },
        });
      } catch (_) {}
    }
  }

  console.log(`[orchestrator] completed run ${runId} for shop ${shopId}`);
}

export function startOrchestratorWorker() {
  return new Worker<OrchestratorJobData>(
    ORCHESTRATOR_QUEUE,
    async (job: Job<OrchestratorJobData>) => {
      await runOrchestrator(job.data.shopId);
    },
    { connection }
  );
}

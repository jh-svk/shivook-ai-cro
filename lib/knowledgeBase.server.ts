/**
 * Writes a concluded experiment's results to the knowledge_base table.
 * Called by resultRefresh when an experiment is concluded.
 *
 * The embedding column is populated separately by the embeddings job once
 * ANTHROPIC_API_KEY is set — this function writes all text fields immediately
 * so the record is queryable even before the embedding exists.
 */

import prisma from "../app/db.server";

export async function writeKnowledgeBaseEntry(experimentId: string): Promise<void> {
  const experiment = await prisma.experiment.findUnique({
    where: { id: experimentId },
    include: { variants: true, result: true, shop: true },
  });

  if (!experiment || !experiment.result) return;

  // Skip if already written
  const existing = await prisma.knowledgeBase.findUnique({
    where: { experimentId },
  });
  if (existing) return;

  const result = experiment.result;
  const treatmentVariant = experiment.variants.find((v) => v.type === "treatment");

  const resultLabel =
    result.isSignificant && (result.relativeLift ?? 0) > 0
      ? "win"
      : result.isSignificant && (result.relativeLift ?? 0) <= 0
      ? "loss"
      : "inconclusive";

  const variantDescription =
    [
      treatmentVariant?.htmlPatch ? "HTML patch" : null,
      treatmentVariant?.cssPatch ? "CSS patch" : null,
      treatmentVariant?.jsPatch ? "JS patch" : null,
    ]
      .filter(Boolean)
      .join(", ") || treatmentVariant?.description || "No description";

  // Derive tags from element type and result
  const tags: string[] = [experiment.elementType];
  if (result.isSignificant) tags.push(resultLabel);
  if (experiment.targetMetric === "add_to_cart_rate") tags.push("add_to_cart");
  if (experiment.targetMetric === "revenue_per_visitor") tags.push("revenue");

  await prisma.knowledgeBase.create({
    data: {
      shopId: experiment.shopId,
      experimentId,
      hypothesisText: experiment.hypothesis,
      segmentTargeted: null,
      variantDescription,
      result: resultLabel,
      liftPercentage: result.relativeLift != null ? result.relativeLift * 100 : null,
      pageType: experiment.pageType,
      elementType: experiment.elementType,
      tags,
      // embedding populated later by embeddings job
    },
  });

  console.log(`[knowledgeBase] wrote entry for experiment ${experimentId}: ${resultLabel}`);
}

export async function searchKnowledgeBase(
  shopId: string,
  query: string,
  limit = 5
): Promise<Array<{ entry: Awaited<ReturnType<typeof prisma.knowledgeBase.findFirst>>; similarity: number }>> {
  // Without an embedding on the query, fall back to tag/text search.
  // Once ANTHROPIC_API_KEY is set and embeddings are populated, this
  // function should be upgraded to use pgvector cosine similarity:
  //   ORDER BY embedding <=> $queryEmbedding LIMIT $limit
  const entries = await prisma.knowledgeBase.findMany({
    where: {
      shopId,
      OR: [
        { hypothesisText: { contains: query, mode: "insensitive" } },
        { variantDescription: { contains: query, mode: "insensitive" } },
        { tags: { has: query.toLowerCase() } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return entries.map((e) => ({ entry: e, similarity: 1 }));
}

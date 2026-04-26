-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- AlterTable
ALTER TABLE "results" ADD COLUMN     "probToBeatControl" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "data_sources" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_reports" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataSnapshot" JSONB NOT NULL,
    "reportMd" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',

    CONSTRAINT "research_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hypotheses" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "reportId" TEXT,
    "title" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "pageType" TEXT NOT NULL,
    "elementType" TEXT NOT NULL,
    "targetMetric" TEXT NOT NULL,
    "iceImpact" INTEGER NOT NULL,
    "iceConfidence" INTEGER NOT NULL,
    "iceEase" INTEGER NOT NULL,
    "iceScore" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'backlog',
    "promotedExperimentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hypotheses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_base" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "hypothesisText" TEXT NOT NULL,
    "segmentTargeted" TEXT,
    "variantDescription" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "liftPercentage" DOUBLE PRECISION,
    "pageType" TEXT NOT NULL,
    "elementType" TEXT NOT NULL,
    "tags" TEXT[],
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_base_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "data_sources_shopId_idx" ON "data_sources"("shopId");

-- CreateIndex
CREATE INDEX "research_reports_shopId_idx" ON "research_reports"("shopId");

-- CreateIndex
CREATE INDEX "hypotheses_shopId_idx" ON "hypotheses"("shopId");

-- CreateIndex
CREATE INDEX "hypotheses_iceScore_idx" ON "hypotheses"("iceScore");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_base_experimentId_key" ON "knowledge_base"("experimentId");

-- CreateIndex
CREATE INDEX "knowledge_base_shopId_idx" ON "knowledge_base"("shopId");

-- AddForeignKey
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_reports" ADD CONSTRAINT "research_reports_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hypotheses" ADD CONSTRAINT "hypotheses_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hypotheses" ADD CONSTRAINT "hypotheses_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "research_reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hypotheses" ADD CONSTRAINT "hypotheses_promotedExperimentId_fkey" FOREIGN KEY ("promotedExperimentId") REFERENCES "experiments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base" ADD CONSTRAINT "knowledge_base_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base" ADD CONSTRAINT "knowledge_base_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "experiments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

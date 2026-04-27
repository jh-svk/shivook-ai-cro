-- CreateTable
CREATE TABLE "platform_learnings" (
    "id" TEXT NOT NULL,
    "pageType" TEXT NOT NULL,
    "elementType" TEXT NOT NULL,
    "targetMetric" TEXT NOT NULL,
    "hypothesisSummary" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "relativeLift" DOUBLE PRECISION,
    "probToBeatControl" DOUBLE PRECISION,
    "visitorCount" INTEGER NOT NULL,
    "daysRunning" INTEGER NOT NULL,
    "deviceType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_learnings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_learnings_pageType_elementType_idx" ON "platform_learnings"("pageType", "elementType");

-- CreateIndex
CREATE INDEX "platform_learnings_result_idx" ON "platform_learnings"("result");

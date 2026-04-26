-- AlterTable
ALTER TABLE "experiments" ADD COLUMN     "segmentId" TEXT;

-- CreateTable
CREATE TABLE "segments" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "deviceType" TEXT,
    "trafficSource" TEXT,
    "visitorType" TEXT,
    "geoCountry" TEXT[],
    "timeOfDayFrom" INTEGER,
    "timeOfDayTo" INTEGER,
    "dayOfWeek" INTEGER[],
    "productCategory" TEXT[],
    "cartState" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orchestrator_log" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "orchestrator_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "segments_shopId_idx" ON "segments"("shopId");

-- CreateIndex
CREATE INDEX "orchestrator_log_shopId_idx" ON "orchestrator_log"("shopId");

-- CreateIndex
CREATE INDEX "orchestrator_log_runId_idx" ON "orchestrator_log"("runId");

-- AddForeignKey
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "segments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segments" ADD CONSTRAINT "segments_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orchestrator_log" ADD CONSTRAINT "orchestrator_log_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

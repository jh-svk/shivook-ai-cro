-- CreateTable
CREATE TABLE "feedback_requests" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "requestText" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "pmDirective" TEXT,
    "builderReport" TEXT,
    "prUrl" TEXT,
    "prNumber" INTEGER,
    "errorMessage" TEXT,
    "deployedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feedback_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feedback_requests_shopId_idx" ON "feedback_requests"("shopId");

-- AddForeignKey
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

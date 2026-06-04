-- AlterTable
ALTER TABLE "experiments" ADD COLUMN     "winningVariantId" TEXT;

-- CreateTable
CREATE TABLE "variant_results" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "visitors" INTEGER NOT NULL DEFAULT 0,
    "conversions" INTEGER NOT NULL DEFAULT 0,
    "conversionRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "addToCartCount" INTEGER,
    "checkoutCount" INTEGER,
    "purchaseCount" INTEGER,
    "aov" DOUBLE PRECISION,
    "relativeLift" DOUBLE PRECISION,
    "probToBeatControl" DOUBLE PRECISION,
    "probBestArm" DOUBLE PRECISION,
    "guardrailStatus" TEXT NOT NULL DEFAULT 'ok',

    CONSTRAINT "variant_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "variant_results_shopId_idx" ON "variant_results"("shopId");

-- CreateIndex
CREATE INDEX "variant_results_experimentId_idx" ON "variant_results"("experimentId");

-- CreateIndex
CREATE UNIQUE INDEX "variant_results_experimentId_variantId_key" ON "variant_results"("experimentId", "variantId");

-- AddForeignKey
ALTER TABLE "variant_results" ADD CONSTRAINT "variant_results_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "experiments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_results" ADD CONSTRAINT "variant_results_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

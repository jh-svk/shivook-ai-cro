-- AlterTable
ALTER TABLE "hypotheses" ADD COLUMN     "recommendedSegment" JSONB;

-- AlterTable
ALTER TABLE "results" ADD COLUMN     "addToCartRateLift" DOUBLE PRECISION,
ADD COLUMN     "aovLift" DOUBLE PRECISION,
ADD COLUMN     "checkoutRateLift" DOUBLE PRECISION,
ADD COLUMN     "controlAddToCartCount" INTEGER,
ADD COLUMN     "controlAddToCartRate" DOUBLE PRECISION,
ADD COLUMN     "controlAov" DOUBLE PRECISION,
ADD COLUMN     "controlCheckoutCount" INTEGER,
ADD COLUMN     "controlCheckoutRate" DOUBLE PRECISION,
ADD COLUMN     "controlRevPerVisitor" DOUBLE PRECISION,
ADD COLUMN     "conversionRateLift" DOUBLE PRECISION,
ADD COLUMN     "revPerVisitorLift" DOUBLE PRECISION,
ADD COLUMN     "treatmentAddToCartCount" INTEGER,
ADD COLUMN     "treatmentAddToCartRate" DOUBLE PRECISION,
ADD COLUMN     "treatmentAov" DOUBLE PRECISION,
ADD COLUMN     "treatmentCheckoutCount" INTEGER,
ADD COLUMN     "treatmentCheckoutRate" DOUBLE PRECISION,
ADD COLUMN     "treatmentRevPerVisitor" DOUBLE PRECISION;

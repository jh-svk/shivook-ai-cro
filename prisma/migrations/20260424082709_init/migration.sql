-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shops" (
    "id" TEXT NOT NULL,
    "shopifyDomain" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "maxConcurrentTests" INTEGER NOT NULL DEFAULT 5,
    "requireHumanApproval" BOOLEAN NOT NULL DEFAULT false,
    "brandGuardrails" JSONB,
    "slackWebhookUrl" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiments" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "pageType" TEXT NOT NULL,
    "elementType" TEXT NOT NULL,
    "targetMetric" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "trafficSplit" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "minRuntimeDays" INTEGER NOT NULL DEFAULT 7,
    "maxRuntimeDays" INTEGER NOT NULL DEFAULT 28,
    "startedAt" TIMESTAMP(3),
    "concludedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "experiments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variants" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "htmlPatch" TEXT,
    "cssPatch" TEXT,
    "jsPatch" TEXT,
    "themeExtensionHandle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "revenue" DOUBLE PRECISION,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "results" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "controlVisitors" INTEGER NOT NULL DEFAULT 0,
    "treatmentVisitors" INTEGER NOT NULL DEFAULT 0,
    "controlConversions" INTEGER NOT NULL DEFAULT 0,
    "treatmentConversions" INTEGER NOT NULL DEFAULT 0,
    "controlRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "treatmentRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "controlConversionRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "treatmentConversionRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "relativeLift" DOUBLE PRECISION,
    "pValue" DOUBLE PRECISION,
    "isSignificant" BOOLEAN NOT NULL DEFAULT false,
    "guardrailStatus" TEXT NOT NULL DEFAULT 'ok',
    "decision" TEXT,
    "decisionMadeAt" TIMESTAMP(3),

    CONSTRAINT "results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shops_shopifyDomain_key" ON "shops"("shopifyDomain");

-- CreateIndex
CREATE INDEX "experiments_shopId_idx" ON "experiments"("shopId");

-- CreateIndex
CREATE INDEX "events_experimentId_idx" ON "events"("experimentId");

-- CreateIndex
CREATE INDEX "events_occurredAt_idx" ON "events"("occurredAt");

-- CreateIndex
CREATE INDEX "events_visitorId_idx" ON "events"("visitorId");

-- CreateIndex
CREATE UNIQUE INDEX "results_experimentId_key" ON "results"("experimentId");

-- AddForeignKey
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variants" ADD CONSTRAINT "variants_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "experiments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "experiments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "results" ADD CONSTRAINT "results_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "experiments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

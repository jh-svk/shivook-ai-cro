UPDATE "shops"
SET "onboardingCompletedAt" = "installedAt"
WHERE "onboardingCompletedAt" IS NULL;

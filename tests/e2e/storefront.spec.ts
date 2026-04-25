/**
 * End-to-end storefront test.
 *
 * Validates the full CRO pipeline on the live Shopify store:
 *   1. Theme extension injects #cro-injector-root on the page
 *   2. The injector script assigns the visitor to a variant
 *   3. A view event is written to the Railway database
 *
 * Prerequisites:
 *   - App installed on shivook-team.myshopify.com
 *   - "CRO Experiment Injector" app embed enabled in the theme
 *   - DATABASE_URL set in .env (local proxy to Railway Postgres)
 */

import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const STORE_URL = "https://shivook-team.myshopify.com";
const SHOP_DOMAIN = "shivook-team.myshopify.com";

let prisma: PrismaClient;
let testExperimentId: string;
let controlVariantId: string;
let treatmentVariantId: string;

// ── Test data setup / teardown ───────────────────────────────────────────────

test.beforeAll(async () => {
  prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

  const shop = await prisma.shop.findUnique({ where: { shopifyDomain: SHOP_DOMAIN } });
  if (!shop) throw new Error(`Shop ${SHOP_DOMAIN} not found — install the app first.`);

  const experiment = await prisma.experiment.create({
    data: {
      shopId: shop.id,
      name: "[E2E] Homepage injection test",
      hypothesis: "Playwright automated test",
      pageType: "homepage",
      elementType: "headline",
      targetMetric: "conversion_rate",
      status: "active",
      trafficSplit: 0.5,
      startedAt: new Date(),
      variants: {
        create: [
          {
            type: "control",
            name: "Control",
            description: "E2E control variant",
            // Writes a detectable marker to the page title so we can assert
            // the JS patch ran without needing to inspect the DOM deeply.
            jsPatch: `document.body.setAttribute("data-cro-variant", "control");`,
          },
          {
            type: "treatment",
            name: "Treatment",
            description: "E2E treatment variant",
            jsPatch: `document.body.setAttribute("data-cro-variant", "treatment");`,
          },
        ],
      },
    },
    include: { variants: true },
  });

  testExperimentId = experiment.id;
  controlVariantId = experiment.variants.find((v) => v.type === "control")!.id;
  treatmentVariantId = experiment.variants.find((v) => v.type === "treatment")!.id;
});

test.afterAll(async () => {
  if (prisma && testExperimentId) {
    await prisma.event.deleteMany({ where: { experimentId: testExperimentId } });
    await prisma.variant.deleteMany({ where: { experimentId: testExperimentId } });
    await prisma.experiment.delete({ where: { id: testExperimentId } });
  }
  await prisma?.$disconnect();
});

// ── Tests ────────────────────────────────────────────────────────────────────

test("theme extension injects #cro-injector-root with correct attributes", async ({
  page,
}) => {
  await page.goto(STORE_URL, { waitUntil: "domcontentloaded" });

  const root = page.locator("#cro-injector-root");
  await expect(root).toBeAttached({ timeout: 10_000 });

  await expect(root).toHaveAttribute("data-shop", SHOP_DOMAIN);
  // The Liquid block maps 'index' → 'homepage'
  await expect(root).toHaveAttribute("data-page-type", "homepage");
});

test("visitor ID is written to localStorage after injector runs", async ({
  page,
}) => {
  await page.goto(STORE_URL);

  // Wait until the injector script sets the visitor ID
  const visitorId = await page.waitForFunction(
    () => localStorage.getItem("cro_visitor_id"),
    { timeout: 15_000 }
  );

  expect(await visitorId.jsonValue()).toMatch(/^[0-9a-f-]{36}$/);
});

test("variant assignment is persisted in localStorage and is stable", async ({
  page,
}) => {
  await page.goto(STORE_URL);

  const assignmentKey = `cro_assign_${testExperimentId}`;

  const assignment = await page.waitForFunction(
    (key) => localStorage.getItem(key),
    assignmentKey,
    { timeout: 15_000 }
  );

  const value = await assignment.jsonValue();
  expect(["control", "treatment"]).toContain(value);

  // Second visit — same visitor should see the same variant
  await page.reload();
  await page.waitForFunction(
    (key) => localStorage.getItem(key),
    assignmentKey,
    { timeout: 15_000 }
  );
  const valueAfterReload = await page.evaluate(
    (key) => localStorage.getItem(key),
    assignmentKey
  );
  expect(valueAfterReload).toBe(value);
});

test("JS patch runs and sets data-cro-variant on body", async ({ page }) => {
  await page.goto(STORE_URL);

  // Wait for the injector to apply the patch
  const variantAttr = await page.waitForFunction(
    () => document.body.getAttribute("data-cro-variant"),
    { timeout: 15_000 }
  );

  expect(["control", "treatment"]).toContain(await variantAttr.jsonValue());
});

test("view event is recorded in the database within 15 seconds", async ({
  page,
}) => {
  // Clear prior events for a clean assertion
  await prisma.event.deleteMany({ where: { experimentId: testExperimentId } });

  await page.goto(STORE_URL);

  // Wait for localStorage assignment (proxy for injector having run)
  await page.waitForFunction(
    (key) => localStorage.getItem(key),
    `cro_assign_${testExperimentId}`,
    { timeout: 15_000 }
  );

  // Poll the database for up to 15 seconds
  let viewEvent = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    await page.waitForTimeout(1000);
    viewEvent = await prisma.event.findFirst({
      where: { experimentId: testExperimentId, eventType: "view" },
    });
    if (viewEvent) break;
  }

  expect(viewEvent).not.toBeNull();
  expect(viewEvent!.eventType).toBe("view");
  expect(viewEvent!.visitorId).toMatch(/^[0-9a-f-]{36}$/);
  expect([controlVariantId, treatmentVariantId]).toContain(viewEvent!.variantId);
  expect(viewEvent!.experimentId).toBe(testExperimentId);
});

/**
 * Seed data so you can SEE the AI Hypotheses generator produce multi-segment
 * hypotheses (geo × traffic source × device × visitor type × page type), AND so
 * the variant builder produces 3-arm (A/B/n) tests.
 *
 * What it does:
 *  1. Writes a rich shop.dataSnapshot (top countries by revenue + traffic
 *     sources) — this is what unlocks the geo + traffic-source segment
 *     dimensions in the generator (buildAvailableSegments reads exactly this).
 *  2. Seeds historical "DATA ·" concluded experiments with high view-event
 *     volume per page type, so autoBuild's traffic gate (>=450 views/arm/day)
 *     opens up 3-arm generation when you click "AI Generate variant".
 *  3. Creates a research report and RUNS the real AI generator off it, writing
 *     genuine multi-segment hypotheses into the backlog.
 *
 * Why we run the generator here instead of the UI "Generate" button: that button
 * first re-syncs from your live (empty) store, which would overwrite this dummy
 * snapshot. Running it here uses the dummy data directly.
 *
 * Run:    npx -y tsx scripts/seedHypothesisDemo.ts
 *         npx -y tsx scripts/seedHypothesisDemo.ts --clean   (remove seed only)
 */
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { runHypothesisGenerator } from "../jobs/hypothesisGenerator";
import { processResultRefresh } from "../jobs/resultRefresh";

dotenv.config({ override: true });

const prisma = new PrismaClient();
const DATA_PREFIX = "DATA · ";
const DAY = 24 * 60 * 60 * 1000;

// ── Rich analytics snapshot (exact shape buildAvailableSegments reads) ───────
const DATA_SNAPSHOT = {
  shopifyFunnel: {
    topCountriesByRevenue: [
      { country: "US", revenue: 48200, orderCount: 612 },
      { country: "GB", revenue: 18750, orderCount: 233 },
      { country: "CA", revenue: 12400, orderCount: 158 },
      { country: "DE", revenue: 9100, orderCount: 121 },
      { country: "AU", revenue: 7300, orderCount: 96 },
    ],
    trafficSources: [
      { source: "organic", orderCount: 410, revenue: 31200 },
      { source: "paid", orderCount: 280, revenue: 22600 },
      { source: "email", orderCount: 190, revenue: 16100 },
      { source: "social", orderCount: 140, revenue: 9800 },
      { source: "direct", orderCount: 320, revenue: 24000 }, // excluded by the generator (not actionable)
    ],
    totalOrders: 1340,
    totalRevenue: 95700,
    aov: 71.4,
  },
  cro_funnel: { addToCart: 9800, checkoutStarted: 5200, purchases: 1340 },
  ga4: {
    segmentBreakdown: {
      topCountries: [{ country: "US" }, { country: "GB" }, { country: "CA" }, { country: "DE" }, { country: "AU" }],
      deviceSplit: { mobile: 0.68, desktop: 0.29, tablet: 0.03 },
      newVsReturning: { new: 0.74, returning: 0.26 },
    },
  },
};

// A research report written to surface segment-level findings, so the generator
// has real material to target specific (page × geo × source × device × visitor) combos.
const REPORT_MD = `# CRO Research Report — Storefront performance

## Overview
Store does ~$95.7k/mo across 1,340 orders (AOV $71). Traffic is mobile-heavy
(68% mobile, 29% desktop) and 74% new visitors. Top markets by revenue: US, UK,
Canada, Germany, Australia. Acquisition mix: organic, paid, email, social.

## Funnel
Add-to-cart 9.8k → checkout 5.2k → purchase 1.34k. The biggest drop is
add-to-cart → checkout (47% complete), concentrated on mobile.

## Segment-level findings (the actionable part)
- **Mobile, US, paid traffic (product page):** highest bounce on the product
  page; the buy box sits below a long image gallery, so paid mobile landers
  rarely reach the Add to Cart button. Strong candidate for a sticky mobile ATC.
- **Desktop, UK, organic (collection page):** high engagement but low
  product-detail click-through; the collection grid lacks visual hierarchy.
- **Mobile, returning visitors (cart page):** cart abandonment elevated; no
  reassurance (returns/secure-checkout) near the checkout button.
- **Desktop, Germany, email traffic (homepage):** email landers convert below
  average; the hero lacks a clear value proposition for a colder audience.
- **Mobile, new visitors, Canada (product page):** price is shown without any
  trust framing; new CA visitors hesitate at the buy box.
- **Desktop, social, Australia (homepage):** social landers need a stronger,
  single focal CTA above the fold.

## Recommendations
Test segment-tailored changes: sticky mobile ATC for paid mobile landers, trust
framing for new international shoppers, cart reassurance for returning mobile
users, and clearer hero value props for cold email/social audiences. Keep every
change front-end only (copy, layout, trust signals, hierarchy).`;

// ── Historical traffic so the 3-arm gate (>=450 views/arm/day) opens ─────────
// One completed control-vs-treatment test per page type, with a real funnel so
// it DISPLAYS proper numbers (visitors, conversion, lift) — and enough page
// views to open the A/B/n traffic gate. Total views per page = 2 × viewsPerArm.
type TrafficPage = {
  pageType: string; name: string; viewsPerArm: number; atcRate: number; lift: number; aov: number;
};
const TRAFFIC_PAGES: TrafficPage[] = [
  { pageType: "product",   name: "Trust Badges Above Buy Box",   viewsPerArm: 4900, atcRate: 0.11, lift: 0.18, aov: 72 }, // 9.8k views -> 3 arms
  { pageType: "homepage",  name: "Hero Value-Prop Strip",        viewsPerArm: 4550, atcRate: 0.08, lift: 0.06, aov: 68 }, // 9.1k -> 3 arms
  { pageType: "cart",      name: "Free-Shipping Progress Bar",   viewsPerArm: 3640, atcRate: 0.12, lift: 0.10, aov: 65 }, // 7.3k -> 3 arms
  { pageType: "collection",name: "Collection Grid Hierarchy",    viewsPerArm: 2100, atcRate: 0.09, lift: 0.04, aov: 70 }, // 4.2k -> 2 arms
];

const round2 = (n: number) => Math.round(n * 100) / 100;

// Build a monotonic funnel (purchasers ⊆ checkouts ⊆ atc ⊆ viewers) for one arm.
function funnelEvents(
  experimentId: string, variantId: string, prefix: string,
  views: number, atcRate: number, aov: number, startMs: number, endMs: number,
) {
  const at = () => new Date(startMs + Math.random() * (endMs - startMs));
  const atc = Math.round(views * atcRate);
  const checkout = Math.round(atc * 0.55);
  const purchases = Math.round(checkout * 0.62);
  const rows: { experimentId: string; variantId: string; visitorId: string; sessionId: string; eventType: string; revenue?: number | null; checkoutToken?: string | null; occurredAt: Date }[] = [];
  const push = (i: number, eventType: string, extra: Partial<{ revenue: number; checkoutToken: string }> = {}) => {
    const vid = `${prefix}_${i}`;
    rows.push({ experimentId, variantId, visitorId: vid, sessionId: `${vid}_s`, eventType, occurredAt: at(), ...extra });
  };
  for (let i = 0; i < views; i++) push(i, "view");
  for (let i = 0; i < atc; i++) push(i, "add_to_cart");
  for (let i = 0; i < checkout; i++) push(i, "checkout_started", { checkoutToken: `ck_${prefix}_${i}` });
  for (let i = 0; i < purchases; i++) push(i, "purchase", { revenue: round2(aov + (Math.random() * 20 - 10)), checkoutToken: `ck_${prefix}_${i}` });
  return rows;
}

async function cleanSeed(shopId: string) {
  const exps = await prisma.experiment.findMany({
    where: { shopId, name: { startsWith: DATA_PREFIX } }, select: { id: true },
  });
  const ids = exps.map((e) => e.id);
  if (ids.length) {
    await prisma.event.deleteMany({ where: { experimentId: { in: ids } } });
    await prisma.variantResult.deleteMany({ where: { experimentId: { in: ids } } }).catch(() => {});
    await prisma.result.deleteMany({ where: { experimentId: { in: ids } } });
    await prisma.knowledgeBase.deleteMany({ where: { experimentId: { in: ids } } }).catch(() => {});
    await prisma.variant.deleteMany({ where: { experimentId: { in: ids } } });
    await prisma.experiment.deleteMany({ where: { id: { in: ids } } });
  }
  console.log(`  removed ${ids.length} '${DATA_PREFIX}' traffic experiments`);
}

async function seedTraffic(shopId: string) {
  const now = Date.now();
  // Keep all events inside the traffic gate's 14-day lookback so the per-day view
  // counts stay above the 3-arm threshold (>=450/arm/day).
  const startMs = now - 14 * DAY;
  const endMs = now;
  let total = 0;
  for (const tp of TRAFFIC_PAGES) {
    // Started long enough ago that the real engine will conclude a clear winner.
    const exp = await prisma.experiment.create({
      data: {
        shopId, name: `${DATA_PREFIX}${tp.name} (${tp.pageType})`,
        hypothesis: `A/B test on the ${tp.pageType} page (seed data — provides historical traffic + a completed result).`,
        pageType: tp.pageType, elementType: "cta", targetMetric: "add_to_cart_rate",
        status: "active", trafficSplit: 0.5, minRuntimeDays: 7,
        startedAt: new Date(startMs),
        variants: {
          create: [
            { type: "control", name: "Control", description: "Existing experience" },
            { type: "treatment", name: "Treatment", description: tp.name },
          ],
        },
      },
      include: { variants: true },
    });
    const control = exp.variants.find((v) => v.type === "control")!.id;
    const treatment = exp.variants.find((v) => v.type === "treatment")!.id;

    const rows = [
      ...funnelEvents(exp.id, control, `${tp.pageType}c`, tp.viewsPerArm, tp.atcRate, tp.aov, startMs, endMs),
      ...funnelEvents(exp.id, treatment, `${tp.pageType}t`, tp.viewsPerArm, tp.atcRate * (1 + tp.lift), tp.aov, startMs, endMs),
    ];
    for (let i = 0; i < rows.length; i += 2000) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await prisma.event.createMany({ data: rows.slice(i, i + 2000) as any });
    }

    // Compute the real Result via the actual engine, then mark concluded so it
    // reads as a finished historical test (refresh won't run on a concluded row).
    await processResultRefresh(exp.id);
    await prisma.experiment.update({
      where: { id: exp.id },
      data: { status: "concluded", concludedAt: new Date(now) },
    });

    total += rows.length;
    const r = await prisma.result.findUnique({ where: { experimentId: exp.id } });
    console.log(
      `  ${tp.pageType.padEnd(11)} ${rows.length.toLocaleString()} events  ` +
      `visitors ${r?.controlVisitors}/${r?.treatmentVisitors}  ` +
      `conv ${(100 * (r?.controlConversionRate ?? 0)).toFixed(1)}%/${(100 * (r?.treatmentConversionRate ?? 0)).toFixed(1)}%`,
    );
  }
  return total;
}

async function main() {
  const cleanOnly = process.argv.includes("--clean");
  const trafficOnly = process.argv.includes("--traffic-only"); // re-seed traffic + results, keep existing hypotheses
  const shop = await prisma.shop.findFirst({ where: { shopifyDomain: { contains: "shivook" } } });
  if (!shop) throw new Error("Dev shop (shivook-*) not found");
  console.log(`Shop: ${shop.shopifyDomain} (${shop.id})`);

  console.log("Cleaning previous seed traffic…");
  await cleanSeed(shop.id);
  if (cleanOnly) { console.log("✅ Seed cleaned."); return; }

  if (!trafficOnly) {
    console.log("Writing rich dataSnapshot (geo + traffic sources)…");
    await prisma.shop.update({ where: { id: shop.id }, data: { dataSnapshot: DATA_SNAPSHOT as object } });
  }

  console.log("Seeding completed historical tests (real funnels + results)…");
  const totalViews = await seedTraffic(shop.id);
  console.log(`  ${totalViews.toLocaleString()} events total`);

  if (trafficOnly) { console.log("\n✅ Traffic + results reseeded (hypotheses untouched)."); return; }

  console.log("Creating research report…");
  const report = await prisma.researchReport.create({
    data: { shopId: shop.id, status: "complete", reportMd: REPORT_MD, dataSnapshot: DATA_SNAPSHOT as object },
  });

  console.log("Running the REAL AI hypotheses generator (Claude)…");
  await runHypothesisGenerator(shop.id, report.id);

  const hyps = await prisma.hypothesis.findMany({
    where: { shopId: shop.id }, orderBy: { iceScore: "desc" },
    select: { title: true, pageType: true, recommendedSegment: true },
  });
  console.log(`\n✅ Generated ${hyps.length} hypotheses:\n`);
  for (const h of hyps) {
    const s = (h.recommendedSegment ?? {}) as { deviceType?: string; visitorType?: string; trafficSource?: string; geoCountry?: string[] };
    const dims = [
      h.pageType,
      s.deviceType,
      s.visitorType ? `${s.visitorType} visitors` : null,
      s.trafficSource ? `${s.trafficSource} traffic` : null,
      s.geoCountry?.length ? s.geoCountry.join("/") : null,
    ].filter(Boolean).join(" · ");
    console.log(`  • ${h.title}\n      ${dims}`);
  }

  // Coverage summary across the 5 dimensions.
  const withGeo = hyps.filter((h) => ((h.recommendedSegment as any)?.geoCountry?.length ?? 0) > 0).length;
  const withSrc = hyps.filter((h) => (h.recommendedSegment as any)?.trafficSource).length;
  const withVis = hyps.filter((h) => (h.recommendedSegment as any)?.visitorType).length;
  console.log(`\nCoverage → geo-targeted: ${withGeo}, traffic-source-targeted: ${withSrc}, visitor-type-targeted: ${withVis}`);
  console.log(`Page types: ${[...new Set(hyps.map((h) => h.pageType))].join(", ")}`);
  console.log(`\nNext: open /app/hypotheses, then click "AI Generate variant" on a product/homepage`);
  console.log(`hypothesis to watch a 3-arm (A/B/n) test build.`);
}

main()
  .catch((e) => { console.error("FATAL:", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

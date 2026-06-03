/**
 * Seed realistic, HIGH-VOLUME demo data for a run-through of the whole app — the
 * kind of dataset a busy production store would have.
 *
 * What it creates for the dev shop:
 *   • A spread of experiment statuses (active / paused / concluded-winner /
 *     pending-approval / draft).
 *   • "All visitors" experiments with thousands of visitors per arm.
 *   • A SEGMENT MATRIX: experiments scoped to Segment rows that vary by
 *     deviceType × geoCountry × trafficSource × visitorType, so the dashboard's
 *     device filter, segment chips and geo tags all light up the way they would
 *     for a real high-traffic merchant. (Dimensions live on the Segment, not on
 *     the Event — that's how the app models them.)
 *   • Real Event rows, then runs the ACTUAL processResultRefresh engine so every
 *     Result is computed by the real Bayesian stats code (nothing is faked).
 *
 * Volume scales with SCALE (default 1 → thousands per arm). Crank it up:
 *   SCALE=3 npx -y tsx scripts/seedDemo.ts     (~3× the visitors)
 *
 * Run:    npx -y tsx scripts/seedDemo.ts          (clean + reseed)
 *         npx -y tsx scripts/seedDemo.ts --clean  (remove demo data only)
 *
 * All demo experiments AND demo segments are prefixed "DEMO · " so cleanup is
 * exact and safe.
 */
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { processResultRefresh } from "../jobs/resultRefresh";

dotenv.config({ override: true }); // .env must win over the empty shell ANTHROPIC/DB vars

const prisma = new PrismaClient();
const DEMO_PREFIX = "DEMO · ";
const DAY = 24 * 60 * 60 * 1000;
const SCALE = Math.max(0.1, Number(process.env.SCALE ?? "1") || 1);

const STICKY_CSS =
  "@media(max-width:749px){.cro-sticky{position:fixed;bottom:0;left:0;right:0;z-index:200;background:rgb(var(--color-base-background-1));border-top:var(--inputs-border-width) solid rgba(var(--color-base-text),.12);padding:.75rem 1rem;display:flex;gap:.75rem;align-items:center;justify-content:space-between}.cro-sticky__btn{min-height:2.75rem;background:rgb(var(--color-base-accent-1));color:rgb(var(--color-base-solid-button-labels));border-radius:var(--buttons-radius);font-family:var(--font-body-family);padding:0 1.25rem}}";
const STRIP_CSS =
  ".vp-strip{background:rgb(var(--color-base-background-1));border-top:1px solid rgba(var(--color-base-text),.08);border-bottom:1px solid rgba(var(--color-base-text),.08)}.vp-strip__inner{display:flex;justify-content:center;max-width:var(--page-width);margin:0 auto}.vp-strip__item{flex:1;display:flex;flex-direction:column;align-items:center;gap:.5rem;padding:1rem;color:rgb(var(--color-base-accent-2));font-family:var(--font-body-family)}";

// ── Funnel realism knobs ─────────────────────────────────────────────────────
// Per-device base behaviour. Mobile browses more but converts a touch lower.
type Base = { atcRate: number; checkoutOfAtc: number; purchaseOfCheckout: number; aov: number };
const DEVICE_BASE: Record<string, Base> = {
  all:     { atcRate: 0.095, checkoutOfAtc: 0.58, purchaseOfCheckout: 0.62, aov: 65 },
  desktop: { atcRate: 0.110, checkoutOfAtc: 0.62, purchaseOfCheckout: 0.66, aov: 72 },
  mobile:  { atcRate: 0.085, checkoutOfAtc: 0.55, purchaseOfCheckout: 0.58, aov: 58 },
  tablet:  { atcRate: 0.100, checkoutOfAtc: 0.60, purchaseOfCheckout: 0.62, aov: 66 },
};
// Traffic-source intent multiplier on add-to-cart rate.
const SOURCE_MULT: Record<string, number> = {
  organic: 1.0, direct: 1.05, email: 1.2, paid: 0.85, social: 0.7,
};
// Country AOV multiplier (currency-agnostic relative spend).
const GEO_AOV: Record<string, number> = {
  US: 1.0, GB: 1.05, CA: 0.95, AU: 0.98, DE: 0.92,
};
// Returning visitors convert better than new.
const VISITOR_MULT: Record<string, { atc: number; purchase: number }> = {
  new:       { atc: 1.0, purchase: 1.0 },
  returning: { atc: 1.15, purchase: 1.25 },
};

const jitter = () => 1 + (Math.random() * 0.06 - 0.03); // ±3% noise so numbers aren't suspiciously round
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

type Funnel = { views: number; atc: number; checkout: number; purchases: number; aov: number };

/** Build a believable funnel from base rates × segment multipliers × treatment lift. */
function buildFunnel(opts: {
  views: number; device: string; source?: string | null; geo?: string | null;
  visitor?: string | null; atcLift: number; aovMult?: number;
}): Funnel {
  const base = DEVICE_BASE[opts.device] ?? DEVICE_BASE.all;
  const src = SOURCE_MULT[opts.source ?? ""] ?? 1.0;
  const vis = VISITOR_MULT[opts.visitor ?? ""] ?? VISITOR_MULT.new;
  const geo = GEO_AOV[opts.geo ?? ""] ?? 1.0;

  const atcRate = clamp(base.atcRate * src * vis.atc * (1 + opts.atcLift), 0.01, 0.6);
  const atc = Math.round(opts.views * atcRate * jitter());
  const checkout = Math.round(atc * base.checkoutOfAtc * jitter());
  const purchases = Math.round(checkout * base.purchaseOfCheckout * vis.purchase * jitter());
  const aov = round2(base.aov * geo * (opts.aovMult ?? 1));
  return { views: opts.views, atc, checkout, purchases, aov };
}

function makeEvents(
  experimentId: string,
  variantId: string,
  prefix: string,
  f: Funnel,
  startMs: number,
  endMs: number,
) {
  const rows: {
    experimentId: string; variantId: string; visitorId: string; sessionId: string;
    eventType: string; revenue?: number | null; checkoutToken?: string | null; occurredAt: Date;
  }[] = [];
  const at = () => new Date(startMs + Math.random() * (endMs - startMs));
  // Funnel is monotonic: purchasers ⊆ checkouts ⊆ atc ⊆ viewers (by visitor index).
  for (let i = 0; i < f.views; i++) {
    const vid = `${prefix}_${i}`;
    rows.push({ experimentId, variantId, visitorId: vid, sessionId: `${vid}_s`, eventType: "view", occurredAt: at() });
  }
  for (let i = 0; i < f.atc; i++) {
    const vid = `${prefix}_${i}`;
    rows.push({ experimentId, variantId, visitorId: vid, sessionId: `${vid}_s`, eventType: "add_to_cart", occurredAt: at() });
  }
  for (let i = 0; i < f.checkout; i++) {
    const vid = `${prefix}_${i}`;
    rows.push({ experimentId, variantId, visitorId: vid, sessionId: `${vid}_s`, eventType: "checkout_started", checkoutToken: `ck_${prefix}_${i}`, occurredAt: at() });
  }
  for (let i = 0; i < f.purchases; i++) {
    const vid = `${prefix}_${i}`;
    const revenue = Math.round((f.aov + (Math.random() * 20 - 10)) * 100) / 100;
    rows.push({ experimentId, variantId, visitorId: vid, sessionId: `${vid}_s`, eventType: "purchase", revenue, checkoutToken: `ck_${prefix}_${i}`, occurredAt: at() });
  }
  return rows;
}

async function insertEvents(rows: { experimentId: string }[]) {
  const BATCH = 2000;
  for (let i = 0; i < rows.length; i += BATCH) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await prisma.event.createMany({ data: rows.slice(i, i + BATCH) as any });
  }
}

async function cleanDemo(shopId: string) {
  const demos = await prisma.experiment.findMany({
    where: { shopId, name: { startsWith: DEMO_PREFIX } },
    select: { id: true },
  });
  const ids = demos.map((d) => d.id);
  if (ids.length > 0) {
    await prisma.event.deleteMany({ where: { experimentId: { in: ids } } });
    await prisma.result.deleteMany({ where: { experimentId: { in: ids } } });
    await prisma.knowledgeBase.deleteMany({ where: { experimentId: { in: ids } } }).catch(() => {});
    await prisma.variant.deleteMany({ where: { experimentId: { in: ids } } });
    await prisma.experiment.deleteMany({ where: { id: { in: ids } } });
    console.log(`  removed ${ids.length} demo experiments + their events/results/variants`);
  } else {
    console.log("  (no existing demo experiments)");
  }
  // Segments are deleted AFTER experiments so no experiment still references them.
  const segs = await prisma.segment.deleteMany({ where: { shopId, name: { startsWith: DEMO_PREFIX } } });
  if (segs.count > 0) console.log(`  removed ${segs.count} demo segments`);
}

// ── Segment definitions (the dimensional matrix) ─────────────────────────────
type SegDef = {
  key: string; label: string;
  deviceType?: string | null; trafficSource?: string | null;
  visitorType?: string | null; geoCountry?: string[];
};
async function createSegment(shopId: string, s: SegDef) {
  return prisma.segment.create({
    data: {
      shopId,
      name: `${DEMO_PREFIX}${s.label}`,
      deviceType: s.deviceType ?? null,
      trafficSource: s.trafficSource ?? null,
      visitorType: s.visitorType ?? null,
      geoCountry: s.geoCountry ?? [],
    },
  });
}

async function createExperiment(opts: {
  shopId: string; segmentId?: string | null; name: string; hypothesis: string;
  pageType: string; elementType: string; targetMetric: string; status: string;
  startedDaysAgo?: number; concludedDaysAgo?: number; treatmentCss?: string; treatmentDesc: string;
}) {
  const now = Date.now();
  return prisma.experiment.create({
    data: {
      shopId: opts.shopId,
      segmentId: opts.segmentId ?? null,
      name: opts.name,
      hypothesis: opts.hypothesis,
      pageType: opts.pageType,
      elementType: opts.elementType,
      targetMetric: opts.targetMetric,
      status: opts.status,
      trafficSplit: 0.5,
      minRuntimeDays: 7,
      maxRuntimeDays: 28,
      startedAt: opts.startedDaysAgo != null ? new Date(now - opts.startedDaysAgo * DAY) : null,
      concludedAt: opts.concludedDaysAgo != null ? new Date(now - opts.concludedDaysAgo * DAY) : null,
      variants: {
        create: [
          { type: "control", name: "Control", description: "Existing experience" },
          {
            type: "treatment", name: "Treatment", description: opts.treatmentDesc,
            htmlPatch: "<div class=\"cro-demo\">AI-generated variant</div>",
            cssPatch: opts.treatmentCss ?? null,
          },
        ],
      },
    },
    include: { variants: true },
  });
}

// ── Experiment specs (data-driven) ───────────────────────────────────────────
// `seg` references a SegDef.key (null = "All visitors"). `device` picks the
// funnel base; for segment-scoped experiments it mirrors the segment's device.
// `views` is per-arm at SCALE=1. `atcLift` is the treatment's lift on ATC rate.
type Spec = {
  name: string; hypothesis: string; pageType: string; elementType: string; targetMetric: string;
  status: string; startedDaysAgo?: number; concludedDaysAgo?: number;
  seg?: string | null; device: string; source?: string | null; geo?: string | null; visitor?: string | null;
  views: number; atcLift: number; treatmentAovMult?: number; css?: string; desc: string;
  windowEndDaysAgo?: number; // events stop N days ago (for paused/concluded); default 0 (now)
};

const SEGMENTS: SegDef[] = [
  { key: "mob_us_org",  label: "Mobile · US · Organic",            deviceType: "mobile",  geoCountry: ["US"], trafficSource: "organic" },
  { key: "desk_gb_paid", label: "Desktop · UK · Paid",             deviceType: "desktop", geoCountry: ["GB"], trafficSource: "paid" },
  { key: "mob_de_social", label: "Mobile · Germany · Social",      deviceType: "mobile",  geoCountry: ["DE"], trafficSource: "social" },
  { key: "desk_us_email_ret", label: "Desktop · US · Email · Returning", deviceType: "desktop", geoCountry: ["US"], trafficSource: "email", visitorType: "returning" },
  { key: "tab_ca_direct", label: "Tablet · Canada · Direct",       deviceType: "tablet",  geoCountry: ["CA"], trafficSource: "direct" },
  { key: "mob_au_org",  label: "Mobile · Australia · Organic",     deviceType: "mobile",  geoCountry: ["AU"], trafficSource: "organic" },
];

const SPECS: Spec[] = [
  // ── "All visitors", high volume ──
  {
    name: "Sticky Mobile Add-to-Cart Bar",
    hypothesis: "A sticky mobile add-to-cart bar reduces friction and lifts add-to-cart rate.",
    pageType: "product", elementType: "cta", targetMetric: "add_to_cart_rate",
    status: "active", startedDaysAgo: 4, device: "all", views: 5000, atcLift: 0.20,
    css: STICKY_CSS, desc: "Sticky bottom add-to-cart bar on mobile",
  },
  {
    name: "Homepage Value Proposition Strip",
    hypothesis: "A three-icon value-prop strip below the hero increases engagement.",
    pageType: "homepage", elementType: "trust", targetMetric: "add_to_cart_rate",
    status: "active", startedDaysAgo: 3, device: "all", views: 4500, atcLift: 0.02,
    css: STRIP_CSS, desc: "Free Shipping / Easy Returns / Secure Payment strip",
  },
  {
    // Old start + strong data → the real engine CONCLUDES this as a winner.
    name: "Trust Badges Above Add-to-Cart",
    hypothesis: "Trust badges above the add-to-cart button increase purchase rate.",
    pageType: "product", elementType: "trust", targetMetric: "purchase",
    status: "active", startedDaysAgo: 22, windowEndDaysAgo: 1, device: "all", views: 8000, atcLift: 0.18,
    css: STICKY_CSS, desc: "Payment + guarantee trust badges above ATC",
  },
  {
    name: "Free Shipping Threshold Progress Bar",
    hypothesis: "A free-shipping progress bar in the cart raises add-to-cart rate.",
    pageType: "cart", elementType: "banner", targetMetric: "add_to_cart_rate",
    status: "paused", startedDaysAgo: 12, windowEndDaysAgo: 2, device: "all", views: 3500, atcLift: 0.12,
    css: STRIP_CSS, desc: "Cart progress bar toward free-shipping threshold",
  },
  {
    // A LOSER that also drags AOV down → shows a negative lift + guardrail pressure.
    name: "Aggressive Discount Banner",
    hypothesis: "A site-wide discount banner increases add-to-cart rate.",
    pageType: "homepage", elementType: "banner", targetMetric: "add_to_cart_rate",
    status: "active", startedDaysAgo: 6, device: "all", views: 4000, atcLift: -0.07, treatmentAovMult: 0.94,
    css: STRIP_CSS, desc: "Bold percentage-off banner across the storefront",
  },

  // ── Segment-scoped (the dimensional matrix) ──
  {
    name: "PDP Image Gallery Swipe (Mobile US)",
    hypothesis: "A swipeable image gallery improves add-to-cart on mobile.",
    pageType: "product", elementType: "media", targetMetric: "add_to_cart_rate",
    status: "active", startedDaysAgo: 5, seg: "mob_us_org", device: "mobile", source: "organic", geo: "US",
    views: 6000, atcLift: 0.10, css: STICKY_CSS, desc: "Swipeable PDP gallery for touch devices",
  },
  {
    name: "Collection Grid Density (Desktop UK Paid)",
    hypothesis: "A denser collection grid lifts product discovery for paid desktop traffic.",
    pageType: "collection", elementType: "layout", targetMetric: "add_to_cart_rate",
    status: "active", startedDaysAgo: 8, seg: "desk_gb_paid", device: "desktop", source: "paid", geo: "GB",
    views: 3000, atcLift: 0.05, css: STRIP_CSS, desc: "4-up product grid on desktop collections",
  },
  {
    name: "Cart Cross-Sell Upsell (Mobile DE Social)",
    hypothesis: "An in-cart cross-sell increases add-to-cart for social mobile shoppers.",
    pageType: "cart", elementType: "upsell", targetMetric: "add_to_cart_rate",
    status: "active", startedDaysAgo: 4, seg: "mob_de_social", device: "mobile", source: "social", geo: "DE",
    views: 2500, atcLift: 0.15, css: STRIP_CSS, desc: "“Frequently bought together” cart upsell",
  },
  {
    name: "One-Click Reorder CTA (Desktop US Email Returning)",
    hypothesis: "A reorder CTA lifts conversion for returning email visitors.",
    pageType: "homepage", elementType: "cta", targetMetric: "purchase",
    status: "active", startedDaysAgo: 9, seg: "desk_us_email_ret", device: "desktop", source: "email", geo: "US", visitor: "returning",
    views: 2000, atcLift: 0.20, css: STICKY_CSS, desc: "“Reorder your essentials” CTA for return visitors",
  },
  {
    name: "Sticky PDP Summary (Tablet CA Direct)",
    hypothesis: "A sticky product summary lifts add-to-cart on tablet.",
    pageType: "product", elementType: "cta", targetMetric: "add_to_cart_rate",
    status: "active", startedDaysAgo: 6, seg: "tab_ca_direct", device: "tablet", source: "direct", geo: "CA",
    views: 1500, atcLift: 0.08, css: STICKY_CSS, desc: "Sticky price + ATC summary on tablet PDP",
  },
  {
    // Segment-scoped CONCLUDED winner.
    name: "Express Mobile Checkout (Mobile AU Organic)",
    hypothesis: "A one-tap express checkout button lifts purchases for mobile organic traffic.",
    pageType: "product", elementType: "cta", targetMetric: "purchase",
    status: "active", startedDaysAgo: 20, windowEndDaysAgo: 1, seg: "mob_au_org", device: "mobile", source: "organic", geo: "AU",
    views: 5000, atcLift: 0.16, css: STICKY_CSS, desc: "Express “Buy now” button on mobile PDP",
  },
];

async function main() {
  const cleanOnly = process.argv.includes("--clean");

  const shop = await prisma.shop.findFirst({ where: { shopifyDomain: { contains: "shivook" } } });
  if (!shop) throw new Error("Dev shop (shivook-*) not found in DB");
  console.log(`Shop: ${shop.shopifyDomain} (${shop.id})`);

  console.log("Cleaning previous demo data…");
  await cleanDemo(shop.id);
  if (cleanOnly) { console.log("✅ Demo data cleaned. Done."); return; }

  const now = Date.now();
  const variantOf = (exp: { variants: { id: string; type: string }[] }, t: string) =>
    exp.variants.find((v) => v.type === t)!.id;

  console.log(`Seeding demo segments…  (SCALE=${SCALE})`);
  const segIds: Record<string, string> = {};
  for (const s of SEGMENTS) {
    const created = await createSegment(shop.id, s);
    segIds[s.key] = created.id;
  }
  console.log(`  created ${SEGMENTS.length} segments`);

  console.log("Seeding demo experiments + events…");
  const eventBearing: { id: string; name: string }[] = [];
  let totalEvents = 0;

  for (let idx = 0; idx < SPECS.length; idx++) {
    const s = SPECS[idx];
    const exp = await createExperiment({
      shopId: shop.id,
      segmentId: s.seg ? segIds[s.seg] : null,
      name: `${DEMO_PREFIX}${s.name}`,
      hypothesis: s.hypothesis,
      pageType: s.pageType, elementType: s.elementType, targetMetric: s.targetMetric,
      status: s.status, startedDaysAgo: s.startedDaysAgo,
      treatmentCss: s.css, treatmentDesc: s.desc,
    });

    const startMs = now - (s.startedDaysAgo ?? 7) * DAY;
    const endMs = now - (s.windowEndDaysAgo ?? 0) * DAY;
    const views = Math.round(s.views * SCALE);

    const control = buildFunnel({ views, device: s.device, source: s.source, geo: s.geo, visitor: s.visitor, atcLift: 0 });
    const treatment = buildFunnel({ views, device: s.device, source: s.source, geo: s.geo, visitor: s.visitor, atcLift: s.atcLift, aovMult: s.treatmentAovMult });

    const rows = [
      ...makeEvents(exp.id, variantOf(exp, "control"), `e${idx}c`, control, startMs, endMs),
      ...makeEvents(exp.id, variantOf(exp, "treatment"), `e${idx}t`, treatment, startMs, endMs),
    ];
    await insertEvents(rows);
    totalEvents += rows.length;
    eventBearing.push({ id: exp.id, name: exp.name });
    console.log(`  ${s.status.padEnd(8)} ${s.name}  —  ${rows.length.toLocaleString()} events`);
  }

  // PENDING APPROVAL — segment-scoped so the approval UI shows a segment chip. No events.
  await createExperiment({
    shopId: shop.id, segmentId: segIds["mob_us_org"],
    name: `${DEMO_PREFIX}Urgency Scarcity Label on Low Stock`,
    hypothesis: "A low-stock urgency label increases purchase rate.",
    pageType: "product", elementType: "label", targetMetric: "purchase",
    status: "pending_approval", treatmentCss: STRIP_CSS,
    treatmentDesc: "“Only N left” scarcity label (AI-generated, awaiting approval)",
  });

  // DRAFT — no events.
  await createExperiment({
    shopId: shop.id,
    name: `${DEMO_PREFIX}Collection Page Filter Visibility`,
    hypothesis: "Always-visible collection filters improve product discovery.",
    pageType: "collection", elementType: "nav", targetMetric: "add_to_cart_rate",
    status: "draft", treatmentDesc: "Persistent filter sidebar",
  });

  console.log(`\nInserted ${totalEvents.toLocaleString()} events. Computing results via the real stats engine…`);
  for (const e of eventBearing) {
    await processResultRefresh(e.id);
    const exp = await prisma.experiment.findUnique({ where: { id: e.id }, include: { result: true } });
    const r = exp?.result;
    console.log(
      `  ${exp?.status.padEnd(16)} ${exp?.name}\n` +
      `      visitors ${r?.controlVisitors}/${r?.treatmentVisitors}  ` +
      `conv ${(100 * (r?.controlConversionRate ?? 0)).toFixed(1)}%/${(100 * (r?.treatmentConversionRate ?? 0)).toFixed(1)}%  ` +
      `lift ${r?.relativeLift != null ? (100 * r.relativeLift).toFixed(1) + "%" : "—"}  ` +
      `P(beat) ${r?.probToBeatControl != null ? (100 * r.probToBeatControl).toFixed(0) + "%" : "—"}  ` +
      `${r?.isSignificant ? "✅ significant" : ""}`
    );
  }

  console.log("\n✅ High-volume demo data seeded. Open the app and explore.");
  console.log("   Re-run anytime; `--clean` removes it. Crank volume with SCALE=N.");
}

main()
  .catch((e) => { console.error("FATAL:", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

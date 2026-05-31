/**
 * Seed realistic DEMO data for a run-through of the whole app.
 *
 * Creates a spread of experiments (active / paused / concluded-winner /
 * pending-approval / draft) for the dev shop, seeds real Event rows, then runs
 * the ACTUAL processResultRefresh engine so every Result is computed by the real
 * stats code (not faked). Active demos start recently so the hourly job never
 * auto-concludes them; the "winner" starts 21 days ago with strong data so the
 * engine genuinely concludes it.
 *
 * Run:    npx -y tsx scripts/seedDemo.ts          (clean + reseed)
 *         npx -y tsx scripts/seedDemo.ts --clean  (remove demo data only)
 *
 * All demo experiments are prefixed "DEMO · " so cleanup is exact and safe.
 */
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { processResultRefresh } from "../jobs/resultRefresh";

dotenv.config({ override: true }); // .env must win over the empty shell ANTHROPIC/DB vars

const prisma = new PrismaClient();
const DEMO_PREFIX = "DEMO · ";
const DAY = 24 * 60 * 60 * 1000;

const STICKY_CSS =
  "@media(max-width:749px){.cro-sticky{position:fixed;bottom:0;left:0;right:0;z-index:200;background:rgb(var(--color-base-background-1));border-top:var(--inputs-border-width) solid rgba(var(--color-base-text),.12);padding:.75rem 1rem;display:flex;gap:.75rem;align-items:center;justify-content:space-between}.cro-sticky__btn{min-height:2.75rem;background:rgb(var(--color-base-accent-1));color:rgb(var(--color-base-solid-button-labels));border-radius:var(--buttons-radius);font-family:var(--font-body-family);padding:0 1.25rem}}";
const STRIP_CSS =
  ".vp-strip{background:rgb(var(--color-base-background-1));border-top:1px solid rgba(var(--color-base-text),.08);border-bottom:1px solid rgba(var(--color-base-text),.08)}.vp-strip__inner{display:flex;justify-content:center;max-width:var(--page-width);margin:0 auto}.vp-strip__item{flex:1;display:flex;flex-direction:column;align-items:center;gap:.5rem;padding:1rem;color:rgb(var(--color-base-accent-2));font-family:var(--font-body-family)}";

type Funnel = { views: number; atc: number; checkout: number; purchases: number; aov: number };

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
  for (let i = 0; i < rows.length; i += 1000) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await prisma.event.createMany({ data: rows.slice(i, i + 1000) as any });
  }
}

async function cleanDemo(shopId: string) {
  const demos = await prisma.experiment.findMany({
    where: { shopId, name: { startsWith: DEMO_PREFIX } },
    select: { id: true },
  });
  const ids = demos.map((d) => d.id);
  if (ids.length === 0) { console.log("  (no existing demo data)"); return; }
  await prisma.event.deleteMany({ where: { experimentId: { in: ids } } });
  await prisma.result.deleteMany({ where: { experimentId: { in: ids } } });
  await prisma.knowledgeBase.deleteMany({ where: { experimentId: { in: ids } } }).catch(() => {});
  await prisma.variant.deleteMany({ where: { experimentId: { in: ids } } });
  await prisma.experiment.deleteMany({ where: { id: { in: ids } } });
  console.log(`  removed ${ids.length} demo experiments + their events/results/variants`);
}

async function createExperiment(opts: {
  shopId: string; name: string; hypothesis: string; pageType: string; elementType: string;
  targetMetric: string; status: string; startedDaysAgo?: number; concludedDaysAgo?: number;
  treatmentCss?: string; treatmentDesc: string;
}) {
  const now = Date.now();
  return prisma.experiment.create({
    data: {
      shopId: opts.shopId,
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

  console.log("Seeding demo experiments…");

  // 1) ACTIVE, clearly winning (recent start → won't auto-conclude)
  const e1 = await createExperiment({
    shopId: shop.id, name: `${DEMO_PREFIX}Sticky Mobile Add-to-Cart Bar`,
    hypothesis: "A sticky mobile add-to-cart bar reduces friction and lifts add-to-cart rate.",
    pageType: "product", elementType: "cta", targetMetric: "add_to_cart_rate",
    status: "active", startedDaysAgo: 3, treatmentCss: STICKY_CSS,
    treatmentDesc: "Sticky bottom add-to-cart bar on mobile",
  });
  await insertEvents([
    ...makeEvents(e1.id, variantOf(e1, "control"), "e1c", { views: 600, atc: 84, checkout: 46, purchases: 30, aov: 62 }, now - 3 * DAY, now),
    ...makeEvents(e1.id, variantOf(e1, "treatment"), "e1t", { views: 600, atc: 114, checkout: 66, purchases: 42, aov: 64 }, now - 3 * DAY, now),
  ]);

  // 2) ACTIVE, basically flat (recent start)
  const e2 = await createExperiment({
    shopId: shop.id, name: `${DEMO_PREFIX}Homepage Value Proposition Strip`,
    hypothesis: "A three-icon value-prop strip below the hero increases engagement.",
    pageType: "homepage", elementType: "trust", targetMetric: "add_to_cart_rate",
    status: "active", startedDaysAgo: 2, treatmentCss: STRIP_CSS,
    treatmentDesc: "Free Shipping / Easy Returns / Secure Payment strip",
  });
  await insertEvents([
    ...makeEvents(e2.id, variantOf(e2, "control"), "e2c", { views: 500, atc: 70, checkout: 35, purchases: 22, aov: 60 }, now - 2 * DAY, now),
    ...makeEvents(e2.id, variantOf(e2, "treatment"), "e2t", { views: 500, atc: 75, checkout: 38, purchases: 24, aov: 61 }, now - 2 * DAY, now),
  ]);

  // 3) WINNER — old start + strong data → the real engine will CONCLUDE it
  const e3 = await createExperiment({
    shopId: shop.id, name: `${DEMO_PREFIX}Trust Badges Above Add-to-Cart`,
    hypothesis: "Trust badges above the add-to-cart button increase purchase rate.",
    pageType: "product", elementType: "trust", targetMetric: "purchase",
    status: "active", startedDaysAgo: 21, treatmentCss: STICKY_CSS,
    treatmentDesc: "Payment + guarantee trust badges above ATC",
  });
  await insertEvents([
    ...makeEvents(e3.id, variantOf(e3, "control"), "e3c", { views: 4000, atc: 600, checkout: 320, purchases: 200, aov: 65 }, now - 21 * DAY, now - 1 * DAY),
    ...makeEvents(e3.id, variantOf(e3, "treatment"), "e3t", { views: 4000, atc: 760, checkout: 420, purchases: 270, aov: 66 }, now - 21 * DAY, now - 1 * DAY),
  ]);

  // 4) PAUSED (resultRefresh computes but won't conclude non-active)
  const e4 = await createExperiment({
    shopId: shop.id, name: `${DEMO_PREFIX}Free Shipping Threshold Progress Bar`,
    hypothesis: "A free-shipping progress bar in the cart raises add-to-cart rate.",
    pageType: "cart", elementType: "banner", targetMetric: "add_to_cart_rate",
    status: "paused", startedDaysAgo: 10, treatmentCss: STRIP_CSS,
    treatmentDesc: "Cart progress bar toward free-shipping threshold",
  });
  await insertEvents([
    ...makeEvents(e4.id, variantOf(e4, "control"), "e4c", { views: 700, atc: 98, checkout: 52, purchases: 34, aov: 58 }, now - 10 * DAY, now - 2 * DAY),
    ...makeEvents(e4.id, variantOf(e4, "treatment"), "e4t", { views: 700, atc: 120, checkout: 64, purchases: 41, aov: 59 }, now - 10 * DAY, now - 2 * DAY),
  ]);

  // 5) PENDING APPROVAL (shows the approval UI) — no events needed
  await createExperiment({
    shopId: shop.id, name: `${DEMO_PREFIX}Urgency Scarcity Label on Low Stock`,
    hypothesis: "A low-stock urgency label increases purchase rate.",
    pageType: "product", elementType: "label", targetMetric: "purchase",
    status: "pending_approval", treatmentCss: STRIP_CSS,
    treatmentDesc: "“Only N left” scarcity label (AI-generated, awaiting approval)",
  });

  // 6) DRAFT — no events
  await createExperiment({
    shopId: shop.id, name: `${DEMO_PREFIX}Collection Page Filter Visibility`,
    hypothesis: "Always-visible collection filters improve product discovery.",
    pageType: "collection", elementType: "nav", targetMetric: "add_to_cart_rate",
    status: "draft", treatmentDesc: "Persistent filter sidebar",
  });

  console.log("Computing results via the real stats engine…");
  for (const e of [e1, e2, e3, e4]) {
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

  console.log("\n✅ Demo data seeded. Open the app and explore. Re-run anytime; `--clean` removes it.");
}

main()
  .catch((e) => { console.error("FATAL:", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

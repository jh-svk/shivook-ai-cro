/**
 * DRY-RUN harness for brand-native variant generation.
 *
 * Mirrors jobs/autoBuild.ts (Sonnet generate -> Haiku critique -> retry) but
 * WRITES NOTHING to the database. Reads a real shop's themeTokens + an
 * ICE-scored hypothesis from Neon, generates patches, runs the critique, and
 * prints the output plus a local hardcoded-hex scan so we can judge how
 * "brand-native" the result is.
 *
 * Run:  npx -y tsx scripts/dryRunVariant.ts [hypothesisIndex]
 * Env:  DATABASE_URL must point at Neon (injected at run time, NOT from .env),
 *       ANTHROPIC_API_KEY from .env.
 *
 * The prompt builders / qaGate / designCritique below are copied verbatim from
 * jobs/autoBuild.ts so this faithfully reproduces the production pipeline.
 */
import dotenv from "dotenv";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import Anthropic from "@anthropic-ai/sdk";

// override:true is required — the shell profile exports an EMPTY ANTHROPIC_API_KEY,
// and dotenv won't replace already-present env vars unless told to.
dotenv.config({ override: true });

const prisma = new PrismaClient();

interface ThemeTokensShape {
  cssVars?: Record<string, string>;
  componentHtml?: Record<string, string>;
}

// ── copied verbatim from jobs/autoBuild.ts ───────────────────────────────────
function buildSystemPrompt(): string {
  return `You are an expert front-end developer specialising in Shopify storefronts and CRO.
Generate minimal, focused HTML/CSS/JS patches.
Patches must not use external resources, must not contain synchronous scripts, and must be under 10kb combined.
Respond ONLY with a valid JSON object — no markdown fences, no explanation.
The JSON must have exactly these keys: htmlPatch, cssPatch, jsPatch, variantDescription.
Each patch value is a string or null. variantDescription is a short string summarising the change.

Design principles you MUST follow:
- Every spacing decision must be intentional — no arbitrary padding values
- One clear visual focal point per element — clear hierarchy
- Never introduce gradients, drop shadows, pill borders, or animations unless they already exist in the store's design system
- Mobile-first: size all elements for touch targets (min 44px)
- Minimal markup: add only what is needed, nothing decorative that isn't earned`;
}

function buildUserPrompt(
  title: string,
  hypothesis: string,
  pageType: string,
  elementType: string,
  targetMetric: string,
  brandGuardrails: unknown,
  themeTokens: unknown
): string {
  const guardrails = (brandGuardrails as Record<string, unknown>) ?? {};
  const tokens = themeTokens as ThemeTokensShape | null;

  const hasCssVars =
    tokens?.cssVars != null && Object.keys(tokens.cssVars).length > 0;

  let constraintsBlock: string;

  if (hasCssVars) {
    const componentLines = [
      tokens!.componentHtml?.button
        ? `Button: ${tokens!.componentHtml.button}`
        : null,
      tokens!.componentHtml?.heading
        ? `Heading: ${tokens!.componentHtml.heading}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    constraintsBlock = `## Store design system — NON-NEGOTIABLE constraints
These are extracted directly from the store's live theme.

CSS custom properties (use var(--name) in ALL CSS — never hardcode hex values):
${JSON.stringify(tokens!.cssVars, null, 2)}
${componentLines ? `\nNative component HTML (copy this structure — do not invent your own):\n${componentLines}` : ""}

Rules:
- Every color in your CSS must use var(--token-name)
- Font families must use var(--font-*) tokens or inherit
- Border radius must use var(--buttons--border-radius) or the value from tokens
- If you need a color not in the token set, use the closest listed token
- Do not introduce CSS classes that conflict with theme class names`;
  } else {
    const hasExtractedTokens =
      guardrails.colors != null && typeof guardrails.colors === "object";
    constraintsBlock = hasExtractedTokens
      ? `## Brand constraints (MUST follow — non-negotiable)
Colors: ${JSON.stringify(guardrails.colors)}
Fonts: ${JSON.stringify(guardrails.fonts ?? {})}
Border radius: ${guardrails.borderRadius ?? "as-is"}
Full guardrails: ${JSON.stringify(guardrails, null, 2)}`
      : `Brand guardrails: ${JSON.stringify(guardrails)}`;
  }

  return `Generate variant patches for this A/B test hypothesis:

Title: ${title}
Hypothesis: ${hypothesis}
Page type: ${pageType}
Element type: ${elementType}
Target metric: ${targetMetric}

${constraintsBlock}

Return JSON with: htmlPatch, cssPatch, jsPatch, variantDescription.`;
}

function qaGate(htmlPatch: string | null, jsPatch: string | null): { passed: boolean; reason?: string } {
  if (jsPatch && Buffer.byteLength(jsPatch, "utf8") > 10_000) {
    return { passed: false, reason: "JS patch exceeds 10 000 bytes" };
  }
  if (htmlPatch && /<script(?![^>]*\b(?:async|defer)\b)[^>]*>/i.test(htmlPatch)) {
    return { passed: false, reason: "HTML patch contains synchronous <script> tag" };
  }
  return { passed: true };
}

interface CritiqueResult {
  passed: boolean;
  failedItems: string[];
  specificFixes: string[];
  _failedOpenInProd?: boolean;
}

async function designCritique(
  htmlPatch: string | null,
  cssPatch: string | null,
  jsPatch: string | null,
  cssVars: Record<string, string>,
  client: Anthropic,
  maxTokens = 512 // prod default — deliberately faithful so we can observe truncation
): Promise<CritiqueResult> {
  if (!htmlPatch && !cssPatch) {
    return { passed: true, failedItems: [], specificFixes: [] };
  }

  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: maxTokens,
    messages: [
      {
        role: "user",
        content: `You are a Shopify front-end design reviewer.
Review this generated variant against the store's design system.
Return ONLY valid JSON — no explanation, no markdown fences.
Shape: { "passed": boolean, "failedItems": string[], "specificFixes": string[] }

Rubric (check each — fail if violated):
1. No hardcoded hex color values in CSS patch
2. No hardcoded font-family strings (must use CSS var or inherit)
3. No introduced box-shadow, text-shadow, gradients, or transitions absent from token set
4. Spacing uses relative units (rem, em, %) or CSS vars — no arbitrary px values
5. No CSS class names that would conflict with Shopify theme namespacing
6. No use of eval(), document.write(), or other dangerous JS patterns

Store CSS custom properties:
${JSON.stringify(cssVars, null, 2)}

Generated variant:
HTML: ${htmlPatch ?? "null"}
CSS: ${cssPatch ?? "null"}
JS: ${jsPatch ?? "null"}`,
      },
    ],
  });

  const raw = response.content[0];
  if (raw.type !== "text") return { passed: true, failedItems: [], specificFixes: [] };
  const jsonStr = raw.text
    .trim()
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "");
  try {
    return JSON.parse(jsonStr) as CritiqueResult;
  } catch {
    // PROD BEHAVIOUR: jobs/autoBuild.ts wraps this in try/catch and returns
    // { passed:true } on parse failure — i.e. a truncated critique silently PASSES.
    const truncated = response.stop_reason === "max_tokens";
    console.warn(
      `  ⚠️  Haiku critique JSON did not parse (stop_reason=${response.stop_reason}). ` +
        `In production this FAILS OPEN → variant passes UNREVIEWED.`
    );
    if (truncated && maxTokens < 1500) {
      console.warn(`  ↳ retrying critique at max_tokens=1500 to recover the real verdict…`);
      const real = await designCritique(htmlPatch, cssPatch, jsPatch, cssVars, client, 1500);
      return { ...real, _failedOpenInProd: true };
    }
    return { passed: true, failedItems: ["<critique response unparseable>"], specificFixes: [], _failedOpenInProd: true };
  }
}

// ── local diagnostics (not part of prod pipeline) ────────────────────────────
function scanForHardcodedColors(css: string | null): { hexes: string[]; varCount: number } {
  if (!css) return { hexes: [], varCount: 0 };
  const hexes = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  const varCount = (css.match(/var\(\s*--/g) ?? []).length;
  return { hexes, varCount };
}

function hr(label: string) {
  console.log("\n" + "─".repeat(70) + `\n${label}\n` + "─".repeat(70));
}

const EMIT_HTML = process.argv.includes("--html");

/**
 * Render the SAME generated variant under two different brands' tokens to prove
 * it is genuinely brand-native (driven by var(--token), not hardcoded).
 */
function buildPreviewHtml(
  patches: { htmlPatch: string | null; cssPatch: string | null; jsPatch: string | null; variantDescription: string },
  realTokens: Record<string, string>,
  hypothesisTitle: string
): string {
  // A deliberately different brand: deep aubergine bg, gold accent, serif, pills.
  const swapped: Record<string, string> = {
    ...realTokens,
    "--color-base-background-1": "26, 22, 37",
    "--color-base-text": "245, 240, 230",
    "--color-base-accent-1": "212, 175, 55",
    "--color-base-accent-2": "212, 175, 55",
    "--color-base-solid-button-labels": "26, 22, 37",
    "--font-heading-family": "'Playfair Display', Georgia, serif",
    "--font-body-family": "Georgia, serif",
    "--buttons-radius": "999px",
    "--inputs-radius": "999px",
    "--media-radius": "16px",
  };

  // Force the variant to display statically (strip JS-driven hide states).
  const staticHtml = (patches.htmlPatch ?? "")
    .replace(/style="[^"]*display:\s*none[^"]*"/gi, "")
    .replace(/\shidden(=("|')?[^"'>]*("|')?)?/gi, "")
    .replace(/aria-hidden="true"/gi, 'aria-hidden="false"');

  const accentOf = (t: Record<string, string>) =>
    t["--color-base-accent-1"] || t["--color-base-accent-2"] || "0,0,0";

  const panel = (title: string, t: Record<string, string>) => {
    const decls = Object.entries(t).map(([k, v]) => `${k}:${v}`).join(";");
    return `
    <div class="col">
      <div class="label"><span class="swatch" style="background:rgb(${accentOf(t)})"></span>${title}</div>
      <div class="browser">
        <div class="chrome"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span></div>
        <div class="store" style="${decls};background:rgb(var(--color-base-background-1));color:rgb(var(--color-base-text))">
          <div class="hero" style="font-family:var(--font-heading-family)">
            <h2>Aurora Skincare</h2>
            <p style="font-family:var(--font-body-family)">Clean, plant-based essentials for every day</p>
          </div>
          ${staticHtml}
        </div>
      </div>
    </div>`;
  };

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#eef0f3;color:#1a1a1a}
  .wrap{padding:32px}
  h1.title{font-size:22px;margin:0 0 6px}
  p.sub{margin:0 0 6px;color:#444;font-size:14px;max-width:1100px;line-height:1.5}
  p.meta{margin:0 0 24px;color:#777;font-size:12.5px}
  .cols{display:flex;gap:30px;align-items:flex-start}
  .col{flex:0 0 760px}
  .label{font-size:13px;font-weight:600;margin:0 0 10px;display:flex;align-items:center;gap:8px}
  .swatch{display:inline-block;width:14px;height:14px;border-radius:3px;border:1px solid rgba(0,0,0,.2)}
  .browser{border:1px solid #d4d8de;border-radius:10px;overflow:hidden;box-shadow:0 10px 34px rgba(0,0,0,.12);background:#fff}
  .chrome{height:30px;background:#e8ebef;display:flex;align-items:center;gap:6px;padding:0 12px;border-bottom:1px solid #d4d8de}
  .dot{width:10px;height:10px;border-radius:50%}
  .store{min-height:300px}
  .hero{padding:48px 24px;text-align:center}
  .hero h2{margin:0 0 8px;font-size:28px}
  .hero p{margin:0;opacity:.72}
  ${patches.cssPatch ?? ""}
</style></head>
<body>
<div class="wrap">
  <h1 class="title">Same AI-generated variant code — two different brands</h1>
  <p class="sub">Below is the identical variant the AI generated for: <b>${hypothesisTitle}</b>. The only thing different between the two panels is the store's design tokens. Because every color, font, and corner radius uses <code>var(--token)</code> instead of a hardcoded value, the variant automatically re-skins to match each brand. <b>That</b> is the brand-native improvement.</p>
  <p class="meta">Left = shivook-team's real extracted theme (117 tokens). Right = a deliberately different palette (gold / serif / pill buttons). Zero variant-code changes between them.</p>
  <div class="cols">
    ${panel("shivook-team — REAL extracted tokens", realTokens)}
    ${panel("Different brand — swapped palette", swapped)}
  </div>
</div>
</body></html>`;
}

async function main() {
  const numArg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
  const idx = Number(numArg ?? "0");

  hr("STEP 1 — Shops with extracted theme tokens");
  const shops = await prisma.shop.findMany({
    select: { id: true, shopifyDomain: true, themeTokens: true, brandGuardrails: true },
  });
  for (const s of shops) {
    const t = s.themeTokens as ThemeTokensShape | null;
    const n = t?.cssVars ? Object.keys(t.cssVars).length : 0;
    console.log(`  ${s.shopifyDomain}  —  ${n} cssVars  (shopId ${s.id})`);
  }

  const shop = shops.find((s) => {
    const t = s.themeTokens as ThemeTokensShape | null;
    return t?.cssVars && Object.keys(t.cssVars).length > 0;
  });
  if (!shop) {
    console.error("\n❌ No shop has extracted cssVars. Run token extraction (settings → resync) first.");
    return;
  }
  const tokens = shop.themeTokens as ThemeTokensShape;
  console.log(`\n→ Using shop: ${shop.shopifyDomain} (${Object.keys(tokens.cssVars!).length} cssVars)`);
  console.log(`  sample tokens:`, Object.entries(tokens.cssVars!).slice(0, 8));

  hr("STEP 2 — Candidate hypotheses (by ICE score)");
  const hyps = await prisma.hypothesis.findMany({
    where: { shopId: shop.id },
    orderBy: { iceScore: "desc" },
    take: 15,
  });
  if (hyps.length === 0) {
    console.error("❌ No hypotheses for this shop.");
    return;
  }
  hyps.forEach((h, i) =>
    console.log(`  [${i}] ICE ${h.iceScore.toFixed(0).padStart(4)}  ${h.status.padEnd(10)}  ${h.title}`)
  );

  const h = hyps[idx];
  if (!h) {
    console.error(`❌ No hypothesis at index ${idx}.`);
    return;
  }

  hr(`STEP 3 — Generating variant for hypothesis [${idx}]: ${h.title}`);
  console.log(`  page=${h.pageType}  element=${h.elementType}  metric=${h.targetMetric}`);
  console.log(`  hypothesis: ${h.hypothesis}`);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const client = new Anthropic({ apiKey });

  const t0 = Date.now();
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: buildSystemPrompt(),
    messages: [
      {
        role: "user",
        content: buildUserPrompt(
          h.title,
          h.hypothesis,
          h.pageType,
          h.elementType,
          h.targetMetric,
          shop.brandGuardrails,
          shop.themeTokens
        ),
      },
    ],
  });
  const raw = response.content[0];
  if (raw.type !== "text") throw new Error("Unexpected Claude response type");
  const jsonStr = raw.text.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");

  let patches: { htmlPatch: string | null; cssPatch: string | null; jsPatch: string | null; variantDescription: string };
  try {
    patches = JSON.parse(jsonStr);
  } catch {
    console.error("❌ Sonnet returned non-JSON:\n", jsonStr.slice(0, 800));
    return;
  }
  console.log(`  Sonnet generated in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const printPatches = (label: string) => {
    hr(label);
    console.log("variantDescription:", patches.variantDescription);
    console.log("\n--- htmlPatch ---\n" + (patches.htmlPatch ?? "(null)"));
    console.log("\n--- cssPatch ---\n" + (patches.cssPatch ?? "(null)"));
    console.log("\n--- jsPatch ---\n" + (patches.jsPatch ?? "(null)"));
    const scan = scanForHardcodedColors(patches.cssPatch);
    console.log(`\n[local scan] var(--…) uses: ${scan.varCount}   hardcoded hex: ${scan.hexes.length}` +
      (scan.hexes.length ? `  → ${scan.hexes.join(", ")}` : "  ✅ none"));
  };
  printPatches("STEP 4 — First-attempt patches");

  const qa = qaGate(patches.htmlPatch ?? null, patches.jsPatch ?? null);
  console.log(`\n[qaGate] ${qa.passed ? "✅ passed" : "❌ failed — " + qa.reason}`);

  hr("STEP 5 — Haiku design critique");
  const cssVars = tokens.cssVars ?? {};
  let critique = await designCritique(patches.htmlPatch ?? null, patches.cssPatch ?? null, patches.jsPatch ?? null, cssVars, client);
  console.log(`first pass: ${critique.passed ? "✅ PASSED" : "❌ FAILED"}`);
  if (!critique.passed) {
    console.log("  failedItems:", critique.failedItems);
    console.log("  specificFixes:", critique.specificFixes);

    hr("STEP 6 — Retry with critique feedback");
    const retryPrompt =
      buildUserPrompt(h.title, h.hypothesis, h.pageType, h.elementType, h.targetMetric, shop.brandGuardrails, shop.themeTokens) +
      `\n\n## Design critique feedback (MUST fix before responding):\n` +
      critique.failedItems.map((i) => `- ${i}`).join("\n") +
      (critique.specificFixes.length ? `\n\nSpecific fixes required:\n` + critique.specificFixes.map((f) => `- ${f}`).join("\n") : "");
    const retry = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: buildSystemPrompt(),
      messages: [{ role: "user", content: retryPrompt }],
    });
    const rr = retry.content[0];
    if (rr.type === "text") {
      const rjson = rr.text.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      patches = JSON.parse(rjson);
      printPatches("Retry patches");
      critique = await designCritique(patches.htmlPatch ?? null, patches.cssPatch ?? null, patches.jsPatch ?? null, cssVars, client);
      console.log(`\nretry critique: ${critique.passed ? "✅ PASSED" : "❌ FAILED after retry"}`);
      if (!critique.passed) console.log("  failedItems:", critique.failedItems);
    }
  }

  hr("RESULT");
  console.log(critique.passed
    ? "✅ Variant passed design critique. In prod this would create a DRAFT experiment."
    : "❌ Variant failed critique after retry. In prod this would mark hypothesis qa_failed.");
  if (critique._failedOpenInProd) {
    console.log("⚠️  NOTE: production's Haiku critique (max_tokens=512) would have TRUNCATED and");
    console.log("    failed open here — the verdict above came from a higher-token retry in this");
    console.log("    harness. In prod this variant would ship UNREVIEWED regardless of real issues.");
  }
  console.log("(dry run — nothing written to the database)");

  if (EMIT_HTML) {
    const outPath = resolve(process.cwd(), "variant-preview.html");
    writeFileSync(outPath, buildPreviewHtml(patches, tokens.cssVars ?? {}, h.title));
    hr("HTML PREVIEW");
    console.log(`Wrote ${outPath}`);
    console.log("Open it in a browser, or screenshot with:");
    console.log(`  node scripts/screenshot.mjs "${outPath}" variant-preview.png`);
  }
}

main()
  .catch((e) => { console.error("FATAL:", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

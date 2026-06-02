/**
 * Auto-build job.
 *
 * Reads a hypothesis, calls Claude to generate variant HTML/CSS/JS patches,
 * runs a lightweight QA gate, then creates a draft experiment.
 *
 * Requires ANTHROPIC_API_KEY in environment.
 */

import { getBoss } from "../lib/pgboss.server";
import { enqueueQaReview } from "./qaReview";
import prisma from "../app/db.server";
import Anthropic from "@anthropic-ai/sdk";
import { hasPlanFeature } from "../lib/planGate.server";
import { fetchStorefrontHtml } from "../lib/themeTokenExtractor.server";
import { validateVariantAgainstHtml } from "../lib/variantValidator.server";

interface ThemeTokensShape {
  cssVars?: Record<string, string>;
  sampleUrls?: { product?: string | null; collection?: string | null };
  componentHtml?: Record<string, string>;
  domVocabulary?: { classes?: string[]; ids?: string[]; dataAttrs?: string[] };
  realSelectors?: { headings?: string[]; buttons?: string[] };
}

export const AUTO_BUILD_QUEUE = "auto-build";

export interface AutoBuildJobData {
  shopId: string;
  hypothesisId: string;
}

/**
 * Parse a JSON object that Claude may have emitted with RAW newlines/tabs inside
 * string values (common with multi-line CSS/JS), which is invalid JSON. We first
 * try strict parse; on failure, escape control characters that appear INSIDE
 * double-quoted strings and retry. Throws if still unparseable.
 */
export function parsePatchesJson<T>(input: string): T {
  try {
    return JSON.parse(input) as T;
  } catch {
    let out = "";
    let inStr = false;
    let esc = false;
    for (let i = 0; i < input.length; i++) {
      const c = input[i];
      if (inStr) {
        if (esc) { out += c; esc = false; continue; }
        if (c === "\\") { out += c; esc = true; continue; }
        if (c === '"') { out += c; inStr = false; continue; }
        if (c === "\n") { out += "\\n"; continue; }
        if (c === "\r") { out += "\\r"; continue; }
        if (c === "\t") { out += "\\t"; continue; }
        out += c;
        continue;
      }
      if (c === '"') { inStr = true; out += c; continue; }
      out += c;
    }
    return JSON.parse(out) as T;
  }
}

export async function enqueueAutoBuild(shopId: string, hypothesisId: string): Promise<void> {
  const boss = await getBoss();
  await boss.createQueue(AUTO_BUILD_QUEUE);
  const id = await boss.send(AUTO_BUILD_QUEUE, { shopId, hypothesisId }, { retryLimit: 3, retryDelay: 15, retryBackoff: true }); // retryDelay in seconds
  if (id === null) console.warn(`[autoBuild] send returned null for hypothesis ${hypothesisId} — job blocked`);
}

async function logOrchestrator(
  shopId: string,
  runId: string,
  stage: string,
  status: string,
  payload: object
) {
  await prisma.orchestratorLog.create({
    data: { shopId, runId, stage, status, payload, completedAt: new Date() },
  });
}

function buildSystemPrompt(): string {
  return `You are an expert front-end developer specialising in Shopify storefronts and CRO.
Generate minimal, focused HTML/CSS/JS patches.
Patches must not use external resources, must not contain synchronous scripts, and must be under 10kb combined.
Respond ONLY with a valid JSON object — no markdown fences, no explanation.
The JSON must have exactly these keys: htmlPatch, cssPatch, jsPatch, variantDescription.
Each patch value is a string or null. variantDescription is a short string summarising the change.

COPY STYLE: Any visible copy you write (headlines, labels, button text, body)
must NOT use em-dashes (—) or en-dashes (–) — they read as AI-generated. Use a
period, comma, or colon, or rephrase. Avoid the "X — Y" construction entirely.

FRONT-END ONLY: your patch only changes the storefront DOM. You CANNOT change any
Shopify backend setting. Never fabricate a claim that the checkout wouldn't actually
honour — e.g. do NOT inject "free shipping over $X", a discount/price/sale, real stock
counts, or shipping/tax/checkout promises unless that exact rule already truthfully
exists on the store. Stick to copy, layout, hierarchy, styling, and reordering of
content that is already present.

Design principles you MUST follow:
- Every spacing decision must be intentional — no arbitrary padding values
- One clear visual focal point per element — clear hierarchy
- Never introduce gradients, drop shadows, pill borders, or animations unless they already exist in the store's design system
- Mobile-first: size all elements for touch targets (min 44px)
- Minimal markup: add only what is needed, nothing decorative that isn't earned

RESPECT THE PAGE LAYOUT (critical — variants that ignore this look broken):
- The theme wraps page content in a centred container with horizontal padding
  (e.g. .page-width, .container, .shopify-section .page-width). If you insert a
  new full-width element, it must NOT span edge-to-edge with content touching the
  viewport border. Either insert your element INSIDE that existing width-
  constrained container, or give your own wrapper the same horizontal padding the
  page uses (max-width: var(--page-width); margin: 0 auto; with side padding).
- Match the page's existing left/right alignment so your block lines up with the
  content around it. Never let text hug the raw left edge of the screen.

DO NOT REBUILD COMPLEX INTERACTIVE WIDGETS:
- Never clone, re-implement, or rebuild theme-driven interactive systems whose
  behaviour depends on the theme's own JavaScript — e.g. collection FILTER/FACET
  systems, sort controls, cart drawers, product-variant pickers, mega-menus,
  predictive search. Cloned controls look real but their click handlers won't
  work, producing dead buttons.
- If a hypothesis targets such a widget, change only SAFE, self-contained things:
  restyle/reposition the EXISTING control (don't duplicate it), change copy/labels,
  adjust prominence via CSS, or add a static informational element. When in doubt,
  prefer a CSS-only restyle of what's already there over rebuilding it in JS.

NEVER DEPEND ON CONTENT THAT MIGHT BE EMPTY (the variant must ALWAYS produce a
visible change):
- Do NOT build a variant whose only effect is conditional on store data that may
  be missing — e.g. reading meta[name="description"], a product metafield, a
  review count, or an inventory number, and bailing out (return/no-op) when it's
  absent. On many stores that data is empty, so the variant silently does nothing
  and the test is wasted.
- If your idea needs such data, you MUST include a sensible STATIC fallback so the
  variant still renders a real change when the data is missing (e.g. a fixed
  benefit line written from the hypothesis itself). The treatment must visibly
  differ from control on EVERY page load, not just when optional data happens to
  exist.
- Prefer changes that rely only on content guaranteed to be present (the product
  title, price, the existing CTA, the hero image) plus your own added copy.

TARGET ONE ELEMENT, NOT EVERY MATCH (critical):
- A class name is almost always reused across the page (e.g. Dawn uses
  .banner__heading on the hero AND on other promo banners; heading classes like
  .h1/.h2 appear on many sections). If your hypothesis is about ONE element (e.g.
  "the hero headline"), you MUST modify only the SINGLE intended element — never
  loop over querySelectorAll and change every match.
- Use document.querySelector (first match) NOT querySelectorAll-with-forEach when
  the change is meant for one element. The injector already prefers the first
  VISIBLE match. To be safe, also pick the FIRST match and stop.
- Scope to the right region when possible: the homepage hero is the FIRST banner/
  section on the page — prefer a selector anchored to it (e.g. the first
  .banner__heading inside the first relevant section) rather than a bare class
  that matches multiple sections.
- Never let a single-element change cascade into rewriting every heading/section
  on the page.`;
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

  const real = tokens?.realSelectors;
  const vocab = tokens?.domVocabulary;
  let domBlock = "";
  if (real && ((real.headings?.length ?? 0) > 0 || (real.buttons?.length ?? 0) > 0)) {
    domBlock = `

## Real DOM selectors on THIS store — TARGETING IS NON-NEGOTIABLE
To locate an existing element in your JS you MUST use a selector built from the
REAL class names / ids / attributes below. NEVER invent a data-* attribute, id,
or class to FIND an element — an invented selector matches nothing, so the
variant silently does nothing and the test is wasted.

Real heading selectors: ${JSON.stringify(real.headings ?? [])}
Real button / CTA selectors: ${JSON.stringify(real.buttons ?? [])}
${(vocab?.classes?.length ?? 0) > 0 ? `Other real class names you may build selectors from (subset): ${JSON.stringify(vocab!.classes!.slice(0, 120))}` : ""}

Targeting rules:
- Choose the existing element that best matches "${elementType}" on the "${pageType}" page from the real selectors above.
- You MAY create new child elements and give them your OWN ids/classes, but you must FIND the host element via a real selector from this store.
- Standard Shopify selectors (e.g. form[action*="/cart/add"], [name="add"]) are allowed.
- If no suitable real selector exists, return null patches instead of guessing.`;
  }

  return `Generate variant patches for this A/B test hypothesis:

Title: ${title}
Hypothesis: ${hypothesis}
Page type: ${pageType}
Element type: ${elementType}
Target metric: ${targetMetric}

${constraintsBlock}${domBlock}

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

type VariantPatches = {
  htmlPatch: string | null;
  cssPatch: string | null;
  jsPatch: string | null;
  variantDescription: string;
};

/**
 * Normalise <script> tags out of the patches. Claude frequently:
 *  (a) embeds variant JS as a <script> in the HTML patch — which trips the QA
 *      gate and wouldn't run anyway (innerHTML scripts don't execute), and
 *  (b) wraps the JS PATCH itself in <script>…</script> — which is a syntax
 *      error for `new Function(jsPatch)`, so the variant silently does nothing.
 * The theme extension runs jsPatch as raw JS, so we lift HTML scripts into
 * jsPatch and unwrap any <script> wrapper around jsPatch.
 */
function extractInlineScripts(patches: VariantPatches): void {
  // (a) Lift <script> blocks out of the HTML patch into jsPatch.
  if (patches.htmlPatch && /<script/i.test(patches.htmlPatch)) {
    const scripts: string[] = [];
    patches.htmlPatch = patches.htmlPatch
      .replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, (_m, js: string) => {
        if (js && js.trim()) scripts.push(js.trim());
        return "";
      })
      .trim();
    if (scripts.length) {
      patches.jsPatch = [patches.jsPatch, ...scripts].filter(Boolean).join("\n");
    }
  }

  // (b) Unwrap a <script>…</script> wrapper around the JS patch itself.
  if (patches.jsPatch && /<script[\s>]/i.test(patches.jsPatch)) {
    patches.jsPatch = patches.jsPatch
      .replace(/<script[^>]*>/gi, "")
      .replace(/<\/script>/gi, "")
      .trim();
  }
}

/** Selector strings the JS uses to FIND elements (querySelector/getElementById/closest/matches). */
function selectorsUsedInJs(js: string): string[] {
  const out: string[] = [];
  for (const m of js.matchAll(/(?:querySelector|querySelectorAll|closest|matches)\s*\(\s*(['"`])([^'"`]+)\1/g)) {
    out.push(m[2]);
  }
  for (const m of js.matchAll(/getElementById\s*\(\s*(['"`])([^'"`]+)\1/g)) {
    out.push("#" + m[2]);
  }
  return out;
}

/** Classes / ids / data-attrs the variant CREATES itself (so we don't flag them as "not on store"). */
function variantOwnTokens(html: string, js: string) {
  const classes = new Set<string>();
  const ids = new Set<string>();
  const dataAttrs = new Set<string>();
  for (const m of html.matchAll(/\sid\s*=\s*"([^"]+)"/gi)) ids.add(m[1].trim());
  for (const m of html.matchAll(/\sclass\s*=\s*"([^"]+)"/gi)) for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
  for (const m of html.matchAll(/\s(data-[a-z0-9-]+)\s*=/gi)) dataAttrs.add(m[1].toLowerCase());
  for (const m of js.matchAll(/\.id\s*=\s*(['"`])([^'"`]+)\1/g)) ids.add(m[2]);
  for (const m of js.matchAll(/\.className\s*=\s*(['"`])([^'"`]+)\1/g)) for (const c of m[2].split(/\s+/)) if (c) classes.add(c);
  for (const m of js.matchAll(/classList\.add\s*\(([^)]*)\)/g)) for (const lit of m[1].matchAll(/(['"`])([^'"`]+)\1/g)) classes.add(lit[2]);
  for (const m of js.matchAll(/setAttribute\s*\(\s*(['"`])(data-[a-z0-9-]+)\1/gi)) dataAttrs.add(m[2].toLowerCase());
  return { classes, ids, dataAttrs };
}

interface SelectorCheck {
  ok: boolean;
  invalid: { selector: string; unknown: string[] }[];
}

/**
 * Verify every element-finding selector in the JS references classes/ids/data-
 * attrs that ACTUALLY exist on the store (or that the variant itself creates).
 * An invented selector matches nothing → the variant silently no-ops.
 */
export function validateVariantSelectors(
  jsPatch: string | null,
  htmlPatch: string | null,
  vocab: { classes?: string[]; ids?: string[]; dataAttrs?: string[] } | undefined,
): SelectorCheck {
  if (!jsPatch || !vocab || !(vocab.classes?.length || vocab.ids?.length)) {
    return { ok: true, invalid: [] };
  }
  const own = variantOwnTokens(htmlPatch ?? "", jsPatch);
  const knownClasses = new Set([...(vocab.classes ?? []), ...own.classes]);
  const knownIds = new Set([...(vocab.ids ?? []), ...own.ids]);
  const knownData = new Set([...(vocab.dataAttrs ?? []), ...own.dataAttrs]);
  const invalid: { selector: string; unknown: string[] }[] = [];
  for (const sel of selectorsUsedInJs(jsPatch)) {
    const unknown: string[] = [];
    for (const m of sel.matchAll(/\.([A-Za-z0-9_-]+)/g)) if (!knownClasses.has(m[1])) unknown.push("." + m[1]);
    for (const m of sel.matchAll(/#([A-Za-z0-9_-]+)/g)) if (!knownIds.has(m[1])) unknown.push("#" + m[1]);
    for (const m of sel.matchAll(/\[\s*(data-[a-z0-9-]+)/gi)) if (!knownData.has(m[1].toLowerCase())) unknown.push("[" + m[1] + "]");
    if (unknown.length) invalid.push({ selector: sel, unknown });
  }
  return { ok: invalid.length === 0, invalid };
}

interface CritiqueResult {
  passed: boolean;
  failedItems: string[];
  specificFixes: string[];
}

async function designCritique(
  htmlPatch: string | null,
  cssPatch: string | null,
  jsPatch: string | null,
  cssVars: Record<string, string>,
  client: Anthropic,
  maxTokens = 1024,
): Promise<CritiqueResult> {
  if (!htmlPatch && !cssPatch) {
    return { passed: true, failedItems: [], specificFixes: [] };
  }

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: `You are a Shopify front-end design reviewer. Judge whether this variant is
safe to ship and visually on-brand. Be pragmatic — only FAIL for things that would
actually look wrong or break, NOT for stylistic nitpicks.
Return ONLY valid JSON — no explanation, no markdown fences.
Shape: { "passed": boolean, "failedItems": string[], "specificFixes": string[] }

FAIL (set passed=false) ONLY if any of these BLOCKING issues are present:
1. Hardcoded hex/rgb color literals in the CSS that should use a store color token
   (the store exposes color tokens — colors must reference them, not be invented).
2. Hardcoded font-family strings instead of the store's font tokens or inherit.
3. Dangerous JS: eval(), document.write(), new Function on remote input, or network
   calls to non-Shopify origins.
4. Obviously broken: references a CSS var that doesn't exist, or malformed CSS/HTML.

DO NOT FAIL for (these are ACCEPTABLE — never list them):
- px spacing/sizing values (padding, margin, min-height, font-size in px) — fine.
- The variant defining its own new class names or ids — fine and expected, as long
  as they are clearly variant-scoped (e.g. cro-*, ab-*, or a unique prefix).
- box-shadow / transition / border-radius used tastefully.
- Reasonable, self-contained DOM manipulation.

Store CSS custom properties (colors/fonts the variant SHOULD reuse):
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
    } catch (parseErr) {
      // A truncated response (long failedItems/specificFixes list) is the usual
      // cause of unparseable JSON. Retry once with more headroom before falling
      // back — otherwise the MORE broken a variant is, the longer the critique,
      // the more likely it truncates and silently passes unreviewed.
      if (response.stop_reason === "max_tokens" && maxTokens < 1500) {
        console.warn(
          `[autoBuild] designCritique truncated at ${maxTokens} tokens — retrying at 1500`
        );
        return designCritique(htmlPatch, cssPatch, jsPatch, cssVars, client, 1500);
      }
      throw parseErr;
    }
  } catch (err) {
    console.error("[autoBuild] designCritique error (failing open):", err);
    return { passed: true, failedItems: [], specificFixes: [] };
  }
}

export async function runAutoBuild(shopId: string, hypothesisId: string) {
  const runId = hypothesisId;

  const allowed = await hasPlanFeature(shopId, "auto_build");
  if (!allowed) {
    console.log(`[autoBuild] shop ${shopId} does not have auto_build feature — skipping`);
    // Don't leave a manually-triggered hypothesis stuck on the "building" loader.
    await prisma.hypothesis
      .updateMany({ where: { id: hypothesisId, shopId, status: "building" }, data: { status: "backlog" } })
      .catch(() => {});
    return;
  }

  const hypothesis = await prisma.hypothesis.findUnique({
    where: { id: hypothesisId, shopId },
    include: {
      shop: {
        select: {
          shopifyDomain: true,
          brandGuardrails: true,
          themeTokens: true,
        },
      },
    },
  });
  if (!hypothesis) throw new Error(`Hypothesis ${hypothesisId} not found`);

  // Resolve segment from recommendedSegment before generating code
  type RecommendedSeg = {
    deviceType?: string | null;
    geoCountry?: string[];
    trafficSource?: string | null;
    visitorType?: string | null;
  };
  const recSeg = hypothesis.recommendedSegment as RecommendedSeg | null;
  let resolvedSegmentId: string | undefined;

  if (recSeg && (recSeg.deviceType || recSeg.geoCountry?.length || recSeg.trafficSource || recSeg.visitorType)) {
    // Look for an existing segment matching these dimensions
    const shopSegments = await prisma.segment.findMany({ where: { shopId } });
    const match = shopSegments.find(
      (s) =>
        s.deviceType === (recSeg.deviceType ?? null) &&
        s.trafficSource === (recSeg.trafficSource ?? null) &&
        s.visitorType === (recSeg.visitorType ?? null) &&
        JSON.stringify([...(recSeg.geoCountry ?? [])].sort()) ===
          JSON.stringify([...s.geoCountry].sort())
    );

    if (match) {
      resolvedSegmentId = match.id;
    } else {
      const segName = `AI: ${hypothesis.title} — ${recSeg.deviceType ?? "all devices"}`.slice(0, 80);
      const created = await prisma.segment.create({
        data: {
          shopId,
          name: segName,
          deviceType: recSeg.deviceType ?? null,
          geoCountry: recSeg.geoCountry ?? [],
          trafficSource: recSeg.trafficSource ?? null,
          visitorType: recSeg.visitorType ?? null,
          dayOfWeek: [],
          productCategory: [],
        },
      });
      resolvedSegmentId = created.id;
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    system: buildSystemPrompt(),
    messages: [
      {
        role: "user",
        content: buildUserPrompt(
          hypothesis.title,
          hypothesis.hypothesis,
          hypothesis.pageType,
          hypothesis.elementType,
          hypothesis.targetMetric,
          hypothesis.shop.brandGuardrails,
          hypothesis.shop.themeTokens,
        ),
      },
    ],
  });

  const raw = response.content[0];
  if (raw.type !== "text") throw new Error("Unexpected Claude response type");

  // Strip markdown fences if Claude added them despite instructions
  const jsonStr = raw.text.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  let patches: { htmlPatch: string | null; cssPatch: string | null; jsPatch: string | null; variantDescription: string };
  try {
    patches = parsePatchesJson(jsonStr);
  } catch {
    await prisma.hypothesis.update({ where: { id: hypothesisId }, data: { status: "qa_failed" } });
    await logOrchestrator(shopId, runId, "BUILD", "failed", {
      error: "Claude returned non-JSON",
      raw: jsonStr.slice(0, 500),
      hypothesisId,
    });
    console.error(`[autoBuild] JSON parse failed for hypothesis ${hypothesisId} — marked qa_failed`);
    return; // complete cleanly, no retry
  }

  // Recover the common case of Claude embedding JS as an inline <script>.
  extractInlineScripts(patches);

  const qa = qaGate(patches.htmlPatch ?? null, patches.jsPatch ?? null);
  if (!qa.passed) {
    await prisma.hypothesis.update({
      where: { id: hypothesisId },
      data: { status: "qa_failed" },
    });
    await logOrchestrator(shopId, runId, "QA", "failed", { reason: qa.reason, hypothesisId });
    console.log(`[autoBuild] QA failed for hypothesis ${hypothesisId}: ${qa.reason}`);
    return;
  }

  // ── Selector grounding: variants must target elements that EXIST ───────────
  const selTokens = hypothesis.shop.themeTokens as ThemeTokensShape | null;
  const selVocab = selTokens?.domVocabulary;
  let selCheck = validateVariantSelectors(patches.jsPatch ?? null, patches.htmlPatch ?? null, selVocab);
  if (!selCheck.ok) {
    const bad = selCheck.invalid.map((i) => `${i.selector} (unknown: ${i.unknown.join(" ")})`).join("; ");
    console.log(`[autoBuild] invalid selectors for ${hypothesisId}: ${bad} — retrying with real selectors`);
    const retryPrompt =
      buildUserPrompt(
        hypothesis.title,
        hypothesis.hypothesis,
        hypothesis.pageType,
        hypothesis.elementType,
        hypothesis.targetMetric,
        hypothesis.shop.brandGuardrails,
        hypothesis.shop.themeTokens,
      ) +
      `\n\n## Selector errors — MUST fix before responding:\n` +
      `These selectors in your JS target elements that DO NOT EXIST on this store: ${bad}.\n` +
      `Rebuild using ONLY real selectors. Real heading selectors: ${JSON.stringify(selTokens?.realSelectors?.headings ?? [])}. Real button selectors: ${JSON.stringify(selTokens?.realSelectors?.buttons ?? [])}.`;
    const retryResp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: buildSystemPrompt(),
      messages: [{ role: "user", content: retryPrompt }],
    });
    const retryRaw = retryResp.content[0];
    if (retryRaw.type === "text") {
      const retryJson = retryRaw.text.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      try {
        patches = parsePatchesJson(retryJson);
        extractInlineScripts(patches);
        selCheck = validateVariantSelectors(patches.jsPatch ?? null, patches.htmlPatch ?? null, selVocab);
      } catch {
        /* keep original patches; selCheck stays failed */
      }
    }
    if (!selCheck.ok) {
      await prisma.hypothesis.update({ where: { id: hypothesisId }, data: { status: "qa_failed" } });
      await logOrchestrator(shopId, runId, "SELECTOR", "failed", { hypothesisId, invalid: selCheck.invalid });
      console.log(`[autoBuild] selector validation failed after retry for ${hypothesisId} — marked qa_failed`);
      return;
    }
    console.log(`[autoBuild] selectors valid after retry for ${hypothesisId}`);
  }

  // ── Design critique pass ──────────────────────────────────────────────────
  const tokens = hypothesis.shop.themeTokens as ThemeTokensShape | null;
  const cssVars = tokens?.cssVars ?? {};
  const hasCssVars = Object.keys(cssVars).length > 0;

  if (hasCssVars) {
    let critique = await designCritique(patches.htmlPatch ?? null, patches.cssPatch ?? null, patches.jsPatch ?? null, cssVars, client);

    if (!critique.passed) {
      console.log(
        `[autoBuild] design critique failed for ${hypothesisId} — retrying with feedback`
      );
      const retryPrompt =
        buildUserPrompt(
          hypothesis.title,
          hypothesis.hypothesis,
          hypothesis.pageType,
          hypothesis.elementType,
          hypothesis.targetMetric,
          hypothesis.shop.brandGuardrails,
          hypothesis.shop.themeTokens
        ) +
        `\n\n## Design critique feedback (MUST fix before responding):\n` +
        critique.failedItems.map((item) => `- ${item}`).join("\n") +
        (critique.specificFixes.length > 0
          ? `\n\nSpecific fixes required:\n` +
            critique.specificFixes.map((f) => `- ${f}`).join("\n")
          : "");

      const retryResponse = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        system: buildSystemPrompt(),
        messages: [{ role: "user", content: retryPrompt }],
      });

      const retryRaw = retryResponse.content[0];
      if (retryRaw.type === "text") {
        const retryJsonStr = retryRaw.text
          .trim()
          .replace(/^```(?:json)?\n?/, "")
          .replace(/\n?```$/, "");
        try {
          patches = parsePatchesJson(retryJsonStr);
          extractInlineScripts(patches);
          critique = await designCritique(patches.htmlPatch ?? null, patches.cssPatch ?? null, patches.jsPatch ?? null, cssVars, client);
          if (!critique.passed) {
            await prisma.hypothesis.update({
              where: { id: hypothesisId },
              data: { status: "qa_failed" },
            });
            await logOrchestrator(shopId, runId, "DESIGN_CRITIQUE", "failed", {
              hypothesisId,
              failedItems: critique.failedItems,
            });
            console.log(
              `[autoBuild] design critique failed after retry for ${hypothesisId} — marked qa_failed`
            );
            return;
          }
          console.log(`[autoBuild] design critique passed after retry for ${hypothesisId}`);
        } catch {
          await prisma.hypothesis.update({
            where: { id: hypothesisId },
            data: { status: "qa_failed" },
          });
          await logOrchestrator(shopId, runId, "DESIGN_CRITIQUE", "failed", {
            hypothesisId,
            reason: "retry response was not valid JSON",
          });
          console.warn(`[autoBuild] retry JSON parse failed for ${hypothesisId} — marked qa_failed`);
          return;
        }
      }
    } else {
      console.log(`[autoBuild] design critique passed on first attempt for ${hypothesisId}`);
    }
  }

  // ── Render validation: does the variant ACTUALLY change the real page? ─────
  // Structural guards pass code that's well-formed but still no-ops (e.g. targets
  // an element/relationship that doesn't exist on this theme, or gates on missing
  // data). Fetch the real target page, run the variant against a lightweight DOM,
  // and retry once if it produced no change.
  try {
    const sampleUrls = (hypothesis.shop.themeTokens as ThemeTokensShape | null)?.sampleUrls;
    const targetPath =
      hypothesis.pageType === "product" ? sampleUrls?.product ?? "/"
      : hypothesis.pageType === "collection" ? sampleUrls?.collection ?? "/"
      : hypothesis.pageType === "cart" ? "/cart"
      : "/";
    const pageHtml = await fetchStorefrontHtml(hypothesis.shop.shopifyDomain, targetPath);

    let render = validateVariantAgainstHtml({
      htmlPatch: patches.htmlPatch ?? null,
      cssPatch: patches.cssPatch ?? null,
      jsPatch: patches.jsPatch ?? null,
      pageType: hypothesis.pageType,
      deviceType: recSeg?.deviceType ?? null,
      pageHtml,
    });

    if (!render.ok) {
      console.log(`[autoBuild] render validation failed for ${hypothesisId}: ${render.reason} — retrying`);
      const retryPrompt =
        buildUserPrompt(
          hypothesis.title, hypothesis.hypothesis, hypothesis.pageType,
          hypothesis.elementType, hypothesis.targetMetric,
          hypothesis.shop.brandGuardrails, hypothesis.shop.themeTokens,
        ) +
        `\n\n## Render check FAILED — your previous variant produced NO visible change on the real page.\n` +
        `Reason: ${render.detail}\n` +
        `Rewrite so the treatment VISIBLY changes the page on every load. Target elements that actually exist on THIS page, ` +
        `do not scope a lookup inside a wrapper the element isn't part of, and include a static fallback instead of bailing out when optional data is missing.`;
      const retryResp = await client.messages.create({
        model: "claude-sonnet-4-6", max_tokens: 8192, system: buildSystemPrompt(),
        messages: [{ role: "user", content: retryPrompt }],
      });
      const rr = retryResp.content[0];
      if (rr.type === "text") {
        const rjson = rr.text.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
        try {
          const retried = JSON.parse(rjson);
          extractInlineScripts(retried);
          const render2 = validateVariantAgainstHtml({
            htmlPatch: retried.htmlPatch ?? null, cssPatch: retried.cssPatch ?? null,
            jsPatch: retried.jsPatch ?? null, pageType: hypothesis.pageType, deviceType: recSeg?.deviceType ?? null, pageHtml,
          });
          if (render2.ok) { patches = retried; render = render2; }
        } catch { /* keep original; render stays failed */ }
      }
      if (!render.ok) {
        await prisma.hypothesis.update({ where: { id: hypothesisId }, data: { status: "qa_failed" } });
        await logOrchestrator(shopId, runId, "RENDER_CHECK", "failed", { hypothesisId, reason: render.reason, detail: render.detail });
        console.log(`[autoBuild] render validation failed after retry for ${hypothesisId} — marked qa_failed`);
        return;
      }
      console.log(`[autoBuild] render validation passed after retry for ${hypothesisId}`);
    }
  } catch (err) {
    // Never block a build on the validator infra itself failing.
    console.warn(`[autoBuild] render validation skipped for ${hypothesisId}:`, err);
  }

  // Strip em/en-dashes from generated copy (a clear AI tell). Replace " — "
  // with " - " and a bare em/en-dash with a comma-space, in HTML + JS string
  // copy. CSS is left untouched (dashes there are syntactic, e.g. var names).
  const deDash = (s: string | null): string | null =>
    s == null ? s : s.replace(/\s+[—–]\s+/g, " - ").replace(/[—–]/g, ", ");
  patches.htmlPatch = deDash(patches.htmlPatch ?? null);
  patches.jsPatch = deDash(patches.jsPatch ?? null);
  patches.variantDescription = deDash(patches.variantDescription) ?? patches.variantDescription;

  const { htmlPatch, cssPatch, jsPatch, variantDescription } = patches;

  // Create draft experiment from hypothesis
  const experiment = await prisma.experiment.create({
    data: {
      shopId,
      segmentId: resolvedSegmentId,
      name: hypothesis.title,
      hypothesis: hypothesis.hypothesis,
      pageType: hypothesis.pageType,
      elementType: hypothesis.elementType,
      targetMetric: hypothesis.targetMetric,
      trafficSplit: 0.5,
      variants: {
        create: [
          { type: "control", name: "Control", description: "Existing experience" },
          {
            type: "treatment",
            name: "Treatment",
            description: variantDescription || "AI-generated variant",
            htmlPatch: htmlPatch ?? undefined,
            cssPatch: cssPatch ?? undefined,
            jsPatch: jsPatch ?? undefined,
          },
        ],
      },
    },
  });

  await prisma.hypothesis.update({
    where: { id: hypothesisId },
    data: { status: "promoted", promotedExperimentId: experiment.id },
  });

  await logOrchestrator(shopId, runId, "BUILD", "complete", {
    hypothesisId,
    experimentId: experiment.id,
    message: "static QA passed — chaining to qaReview → activationGate",
  });

  console.log(`[autoBuild] created experiment ${experiment.id} from hypothesis ${hypothesisId}`);

  await enqueueQaReview(shopId, experiment.id, hypothesisId);
}


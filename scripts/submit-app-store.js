/**
 * Shivook AI CRO — App Store submission script
 * Run: node scripts/submit-app-store.js
 *
 * Does in sequence:
 *   1. shopify app deploy
 *   2. Railway → set NODE_ENV=production
 *   3. Shopify admin → take 4 App Store screenshots
 *   4. Partners dashboard → Protected Customer Data request
 *   5. Partners dashboard → fill submission form, pause for demo video URL, submit
 *
 * Opens a visible browser so you can handle 2FA / login steps.
 * Browser session is persisted to /tmp/shivook_submit_state.json between runs.
 */

import { chromium } from "@playwright/test";
import { execSync, spawn } from "child_process";
import { createInterface } from "readline/promises";
import { stdin, stdout } from "process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SCREENSHOTS_DIR = "/tmp/app_store_screenshots";
const BROWSER_STATE = "/tmp/shivook_submit_state.json";

const SHOP_DOMAIN = "shivook-team.myshopify.com";
const APP_URL = "https://shivook-ai-cro-production.up.railway.app";
const PRIVACY_URL = `${APP_URL}/privacy`;

const LISTING = {
  tagline:
    "The autonomous A/B testing engine that finds, builds, and ships winning variants for you.",
  shortDesc:
    "AI-powered CRO that generates hypotheses, builds variants, runs A/B tests, and ships winners — automatically.",
  longDesc: `Stop guessing. Start winning.

Shivook AI CRO is the only Shopify app that runs your entire conversion optimisation program autonomously — from research to results, without lifting a finger.

HOW IT WORKS

1. AI Research
Connect your Google Analytics 4 and Microsoft Clarity data. Every night, the AI analyses your store metrics — funnel drop-offs, rage clicks, scroll depth, add-to-cart rates — and produces a prioritised list of friction points ranked by conversion impact.

2. Hypothesis Generation
The AI generates 10–20 specific, testable A/B test hypotheses scored by ICE (Impact × Confidence × Ease). Review the backlog and promote what you like, or let the autonomous loop do it all.

3. Auto-Build Variants
On the Pro plan, the orchestrator picks the highest-scoring hypothesis, calls Claude AI to write the HTML/CSS/JS variant, runs a performance QA gate (no synchronous scripts, under 10kb), and creates the experiment automatically.

4. Variant Injection
Variants are injected via a Shopify Theme App Extension — no Liquid edits required. The injector runs asynchronously (zero impact on LCP), assigns visitors to control or treatment using a stable hash, and fires conversion events via the Shopify Web Pixel.

5. Bayesian Results
Results are computed hourly using Bayesian statistics. Instead of a p-value, you see "Probability to beat control." At 95%, the experiment is flagged as a winner. The guardrail system monitors AOV — if it drops more than 3%, the experiment is concluded immediately.

6. Audience Segmentation
Target experiments at specific visitor segments: mobile vs desktop, paid traffic vs organic, new visitors vs returning customers, specific hours of the day, and more.

PLANS
- Starter ($39/month) — Up to 5 manual A/B tests
- Growth ($99/month) — Up to 10 tests + AI hypothesis generation
- Pro ($199/month) — Up to 20 tests + full autonomous loop, auto-build, segmentation

All plans include a 14-day free trial.`,
};

// ── helpers ──────────────────────────────────────────────────────────────────

const rl = createInterface({ input: stdin, output: stdout });
const ask = (q) => rl.question(q);

function log(step, msg) {
  console.log(`\n[${step}] ${msg}`);
}

async function safe(label, fn) {
  try {
    await fn();
  } catch (err) {
    log("WARN", `${label} failed non-fatally: ${err.message ?? err}`);
  }
}

async function tryFill(page, label, value) {
  const locator = page
    .getByLabel(label, { exact: false })
    .or(page.getByPlaceholder(label, { exact: false }))
    .first();
  if (await locator.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await locator.fill(value);
    log("FORM", `✓ ${label}`);
  } else {
    log("FORM", `⚠ field not found: ${label}`);
  }
}

// ── step 1: shopify app deploy ────────────────────────────────────────────────

async function step1_deploy() {
  log("STEP 1", "Running shopify app deploy...");
  await new Promise((resolve, reject) => {
    const child = spawn("shopify", ["app", "deploy", "--allow-updates"], {
      cwd: PROJECT_ROOT,
      stdio: ["pipe", "inherit", "inherit"],
      shell: true,
    });
    // Answer any "Deploy?" confirmation prompts
    setTimeout(() => child.stdin.write("yes\n"), 3_000);
    setTimeout(() => child.stdin.write("yes\n"), 10_000);
    child.on("close", (code) => {
      if (code === 0) {
        log("STEP 1", "✓ Extensions deployed");
        resolve();
      } else {
        reject(new Error(`shopify app deploy exited with code ${code}`));
      }
    });
  });
}

// ── step 2: railway node_env ──────────────────────────────────────────────────

async function step2_railway(page) {
  log("STEP 2", "Opening Railway dashboard...");
  await page.goto("https://railway.app/dashboard", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3_000);

  // Try to find the project
  const project = page.getByText("shivook-ai-cro", { exact: false }).first();
  if (await project.isVisible({ timeout: 8_000 }).catch(() => false)) {
    await project.click();
    await page.waitForTimeout(3_000);

    // Click the app service
    const service = page.getByText("shivook-ai-cro", { exact: false }).nth(1);
    await safe("service click", () => service.click());
    await page.waitForTimeout(2_000);

    // Click Variables tab
    const varsTab = page.getByRole("tab", { name: /variables/i });
    if (await varsTab.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await varsTab.click();
      await page.waitForTimeout(2_000);

      // Try to find NODE_ENV row and click edit
      const nodeEnvRow = page.getByText("NODE_ENV", { exact: true });
      if (await nodeEnvRow.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await nodeEnvRow.click();
        await page.waitForTimeout(1_000);
        // Find the value input near it and update
        const valueInput = page.locator('input[type="text"]').last();
        await valueInput.selectText();
        await valueInput.fill("production");
        // Save (Enter or save button)
        await page.keyboard.press("Enter");
        await page.waitForTimeout(2_000);
        log("STEP 2", "✓ NODE_ENV set to production — Railway will redeploy automatically");
      } else {
        log("STEP 2", "⚠ NODE_ENV not found in variable list");
      }
    }
  } else {
    log("STEP 2", "⚠ Could not auto-navigate to project");
  }

  await ask(
    "\n[STEP 2] Verify NODE_ENV=production is saved in Railway, then press Enter to continue..."
  );

  // Healthcheck
  log("STEP 2", "Checking /healthz (waiting up to 90s for redeploy)...");
  for (let i = 0; i < 9; i++) {
    try {
      const res = await page.goto(`${APP_URL}/healthz`, { waitUntil: "domcontentloaded", timeout: 10_000 });
      if (res?.status() === 200) {
        log("STEP 2", "✓ /healthz 200 OK");
        break;
      }
    } catch (_) {}
    log("STEP 2", `  Still waiting... (${(i + 1) * 10}s)`);
    await page.waitForTimeout(10_000);
  }
}

// ── step 3: screenshots ───────────────────────────────────────────────────────

async function step3_screenshots(page) {
  log("STEP 3", "Taking App Store screenshots...");
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const base = `https://${SHOP_DOMAIN}/admin/apps/shivook-ai-cro`;

  const snap = async (filename, url, afterLoad) => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4_000);
    if (afterLoad) await safe("post-load action", afterLoad);
    const dest = path.join(SCREENSHOTS_DIR, filename);
    await page.screenshot({ path: dest, fullPage: true });
    log("STEP 3", `✓ ${filename} → ${dest}`);
  };

  // 1 — experiments list
  await snap("screenshot_01_experiments.png", `${base}/app`);

  // 2 — hypotheses backlog
  await snap("screenshot_02_hypotheses.png", `${base}/app/hypotheses`);

  // 3 — experiment detail with results (click first experiment link)
  await page.goto(`${base}/app`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3_000);
  const expLink = page.locator("a[href*='/app/experiments/']").first();
  if (await expLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
    const href = await expLink.getAttribute("href");
    await snap("screenshot_03_results.png", `${base}${href}`);
  } else {
    log("STEP 3", "⚠ No experiment link found — screenshot_03_results.png skipped");
  }

  // 4 — orchestrator activity (home, scrolled down)
  await page.goto(`${base}/app`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3_000);
  await safe("scroll to activity", async () => {
    const section = page.getByText("AI Orchestrator Activity", { exact: false });
    if (await section.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await section.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1_000);
    }
  });
  const dest4 = path.join(SCREENSHOTS_DIR, "screenshot_04_orchestrator.png");
  await page.screenshot({ path: dest4, fullPage: false });
  log("STEP 3", `✓ screenshot_04_orchestrator.png → ${dest4}`);
}

// ── step 4: PCD approval ──────────────────────────────────────────────────────

async function step4_pcd(page) {
  log("STEP 4", "Opening Partners dashboard → Protected Customer Data...");
  await page.goto("https://partners.shopify.com", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3_000);

  // Navigate to the app
  await safe("nav to Apps", async () => {
    await page.getByRole("link", { name: /^apps$/i }).first().click();
    await page.waitForTimeout(2_000);
    await page.getByText("Shivook AI CRO", { exact: false }).first().click();
    await page.waitForTimeout(2_000);
  });

  // App setup link
  await safe("App setup", async () => {
    await page.getByRole("link", { name: /app setup/i }).first().click();
    await page.waitForTimeout(2_000);
  });

  // Scroll to PCD section
  await safe("PCD section", async () => {
    const pcd = page.getByText(/protected customer data/i).first();
    await pcd.scrollIntoViewIfNeeded();
  });

  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "pcd_page.png") });

  console.log(`
[STEP 4] PCD justification copy — paste these into the request form:

orders/paid webhook:
  "Required to attribute completed purchases to A/B test variants for conversion
   rate measurement. Only order value and a hashed session token are stored.
   No customer names, emails, or PII are retained."

Web Pixel lax context:
  "Required to track add-to-cart and checkout events from the Shopify Web Pixel
   for A/B test conversion measurement. Events use hashed visitor UUIDs only —
   not linked to Shopify customer accounts. No PII stored or transmitted."
`);

  await ask("[STEP 4] Submit the PCD request, then press Enter to continue...");
}

// ── step 5: submission form ───────────────────────────────────────────────────

async function step5_submit(page) {
  const demoUrl = await ask(
    "\n[STEP 5] Record a 1–3 min demo video (install → hypotheses → storefront preview → results).\nUpload to YouTube (unlisted) or Loom, then paste the URL here: "
  );

  log("STEP 5", "Opening Partners dashboard → Distribution → Submit for review...");
  await page.goto("https://partners.shopify.com", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3_000);

  await safe("nav to app", async () => {
    await page.getByRole("link", { name: /^apps$/i }).first().click();
    await page.waitForTimeout(2_000);
    await page.getByText("Shivook AI CRO", { exact: false }).first().click();
    await page.waitForTimeout(2_000);
  });

  await safe("Distribution link", async () => {
    await page.getByRole("link", { name: /distribution/i }).first().click();
    await page.waitForTimeout(2_000);
  });

  await safe("Submit for review button", async () => {
    await page.getByRole("button", { name: /submit for review/i }).first().click();
    await page.waitForTimeout(2_000);
  });

  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "form_start.png") });

  // Fill fields
  await tryFill(page, "App URL", APP_URL);
  await tryFill(page, "Privacy policy", PRIVACY_URL);
  await tryFill(page, "Privacy policy URL", PRIVACY_URL);
  await tryFill(page, "Support email", "support@shivook.com");
  await tryFill(page, "Tagline", LISTING.tagline);
  await tryFill(page, "Short description", LISTING.shortDesc);
  await tryFill(page, "Long description", LISTING.longDesc);
  await tryFill(page, "Demo video", demoUrl);
  await tryFill(page, "Video URL", demoUrl);
  await tryFill(page, "Video", demoUrl);

  // Upload screenshots
  const screenshotFiles = ["01_experiments", "02_hypotheses", "03_results", "04_orchestrator"]
    .map((n) => path.join(SCREENSHOTS_DIR, `screenshot_${n}.png`))
    .filter((f) => fs.existsSync(f));

  if (screenshotFiles.length > 0) {
    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await fileInput.setInputFiles(screenshotFiles);
      log("STEP 5", `✓ Uploaded ${screenshotFiles.length} screenshots`);
    } else {
      log("STEP 5", `⚠ File input not found — upload these manually:\n  ${screenshotFiles.join("\n  ")}`);
    }
  }

  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "form_filled.png") });
  log("STEP 5", "Form filled. Review the browser window.");

  const confirm = await ask(
    "[STEP 5] Type YES to click 'Submit for review', or anything else to submit manually: "
  );

  if (confirm.trim().toUpperCase() === "YES") {
    const submitBtn = page
      .getByRole("button", { name: /submit for review/i })
      .or(page.getByRole("button", { name: /submit/i }))
      .last();
    await submitBtn.click();
    await page.waitForTimeout(3_000);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "form_submitted.png") });
    log("STEP 5", "✓ Submitted. See form_submitted.png for confirmation.");
  } else {
    log("STEP 5", "Skipped auto-submit — complete manually in the browser.");
    await ask("Press Enter when done...");
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  // Step 1 — CLI deploy
  await step1_deploy();

  // Launch browser (visible, with persisted session)
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ...(fs.existsSync(BROWSER_STATE) ? { storageState: BROWSER_STATE } : {}),
  });
  const page = await context.newPage();

  try {
    await step2_railway(page);
    await step3_screenshots(page);
    await step4_pcd(page);
    await step5_submit(page);

    // Persist session for next run
    await context.storageState({ path: BROWSER_STATE });
    log("DONE", `All steps complete. Artifacts in ${SCREENSHOTS_DIR}`);
  } finally {
    rl.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error("\nFatal:", err);
  rl.close();
  process.exit(1);
});

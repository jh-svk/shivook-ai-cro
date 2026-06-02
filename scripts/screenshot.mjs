/**
 * Screenshot a local HTML file with Playwright's bundled Chromium.
 * Usage: node scripts/screenshot.mjs <htmlPath> <outPng> [width] [height]
 */
import { chromium } from "@playwright/test";

const [, , htmlPath, outPath = "out.png", width = "1600", height = "1000"] = process.argv;
if (!htmlPath) {
  console.error("usage: node scripts/screenshot.mjs <htmlPath> <outPng> [width] [height]");
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: Number(width), height: Number(height) },
  deviceScaleFactor: 2,
});
await page.goto("file://" + htmlPath, { waitUntil: "networkidle" });
await page.screenshot({ path: outPath, fullPage: true });
await browser.close();
console.log("wrote " + outPath);

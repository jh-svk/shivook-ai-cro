/**
 * Playwright global setup — authenticates through the Shopify storefront
 * password page and saves the resulting auth cookie to disk so every
 * storefront test reuses it without re-logging in.
 */
import { chromium, type FullConfig } from "@playwright/test";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

export const STOREFRONT_AUTH_FILE = "tests/.storefront-auth.json";

export default async function globalSetup(_config: FullConfig) {
  const password = process.env.STOREFRONT_PASSWORD;
  if (!password) throw new Error("STOREFRONT_PASSWORD not set in .env");

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();

  await page.goto("https://shivook-team.myshopify.com/password", {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });

  // Fill and submit the Shopify storefront password form
  await page.fill('input[type="password"]', password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }),
    page.click('button[type="submit"]'),
  ]);

  // Save cookies + localStorage so tests can reuse the session
  await page.context().storageState({ path: STOREFRONT_AUTH_FILE });

  await browser.close();
  console.log("[storefront-auth] authenticated — session saved");
}

import { defineConfig, devices } from "@playwright/test";

const PROD_URL = "https://shivook-ai-cro-production.up.railway.app";
const STORE_URL = "https://shivook-team.myshopify.com";
export const STOREFRONT_AUTH_FILE = "tests/.storefront-auth.json";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: 1,
  reporter: "list",
  globalSetup: "./tests/e2e/storefront-auth.setup.ts",
  use: {
    channel: "chrome",
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      // Fast infrastructure checks — hits our Railway app directly
      name: "infra",
      testMatch: "**/healthcheck.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        baseURL: PROD_URL,
      },
    },
    {
      // Full storefront pipeline — hits the live Shopify store
      name: "storefront",
      testMatch: "**/storefront.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        baseURL: STORE_URL,
        storageState: STOREFRONT_AUTH_FILE,
      },
      timeout: 60_000,
    },
  ],
});

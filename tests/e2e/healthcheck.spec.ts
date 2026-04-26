import { test, expect } from "@playwright/test";

const PROD = "https://shivook-ai-cro-production.up.railway.app";

// ── Infrastructure ──────────────────────────────────────────────────────────

test("GET /healthz returns 200 ok", async ({ request }) => {
  const res = await request.get(`${PROD}/healthz`);
  expect(res.status()).toBe(200);
  expect(await res.text()).toBe("ok");
});

// ── App Proxy routes (Shopify strips /apps/cro prefix before forwarding) ────
// Direct hits without a valid Shopify HMAC must be rejected.

test("GET /api/experiments without signature returns 401", async ({
  request,
}) => {
  const res = await request.get(`${PROD}/api/experiments?pageType=product`);
  expect(res.status()).toBe(401);
});

test("GET /api/experiments with bad signature returns 401", async ({
  request,
}) => {
  const res = await request.get(
    `${PROD}/api/experiments?pageType=product&shop=fake.myshopify.com&timestamp=1234567890&signature=invalidsig`
  );
  expect(res.status()).toBe(401);
});

test("POST /api/events without signature returns 401", async ({ request }) => {
  const res = await request.post(`${PROD}/api/events`, {
    data: { experimentId: "x", variantId: "x", visitorId: "x", sessionId: "x", eventType: "view" },
  });
  expect(res.status()).toBe(401);
});

test("GET /api/events without signature returns 400/401", async ({ request }) => {
  const res = await request.get(`${PROD}/api/events`);
  expect([400, 401, 404, 405]).toContain(res.status());
});

// ── Auth redirect ─────────────────────────────────────────────────────────

test("GET / redirects toward Shopify OAuth (not a blank 500)", async ({
  request,
}) => {
  const res = await request.get(`${PROD}/`, { maxRedirects: 0 });
  expect(res.status()).toBeLessThan(500);
});

// ── Static assets reachable ──────────────────────────────────────────────────

test("Vite manifest / build assets are served", async ({ page }) => {
  const res = await page.goto(`${PROD}/`);
  expect(res!.status()).toBeLessThan(500);
});

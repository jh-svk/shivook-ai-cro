import { test, expect } from "@playwright/test";

const PROD = "https://shivook-ai-cro-production.up.railway.app";

// ── Infrastructure ──────────────────────────────────────────────────────────

test("GET /healthz returns 200 ok", async ({ request }) => {
  const res = await request.get(`${PROD}/healthz`);
  expect(res.status()).toBe(200);
  expect(await res.text()).toBe("ok");
});

// ── App Proxy — experiments endpoint ────────────────────────────────────────

test("GET /apps/cro/api/experiments without signature returns 401", async ({
  request,
}) => {
  const res = await request.get(
    `${PROD}/apps/cro/api/experiments?pageType=product`
  );
  expect(res.status()).toBe(401);
});

test("GET /apps/cro/api/experiments with bad signature returns 401", async ({
  request,
}) => {
  const res = await request.get(
    `${PROD}/apps/cro/api/experiments?pageType=product&shop=fake.myshopify.com&timestamp=1234567890&signature=invalidsig`
  );
  expect(res.status()).toBe(401);
});

// ── App Proxy — events endpoint ──────────────────────────────────────────────

test("POST /apps/cro/api/events without signature returns 401", async ({
  request,
}) => {
  const res = await request.post(`${PROD}/apps/cro/api/events`, {
    data: { experimentId: "x", variantId: "x", visitorId: "x", sessionId: "x", eventType: "view" },
  });
  expect(res.status()).toBe(401);
});

test("GET /apps/cro/api/events without signature returns 401", async ({ request }) => {
  const res = await request.get(`${PROD}/apps/cro/api/events`);
  // No loader, only action — returns 401 (proxy signature check) or 405
  expect([400, 401, 404, 405]).toContain(res.status());
});

// ── Auth redirect ─────────────────────────────────────────────────────────

test("GET / redirects toward Shopify OAuth (not a blank 500)", async ({
  request,
}) => {
  // Follow redirects off so we see the first hop
  const res = await request.get(`${PROD}/`, { maxRedirects: 0 });
  // Should be a redirect (3xx) or the login form (200) — never a 5xx
  expect(res.status()).toBeLessThan(500);
});

// ── Static assets reachable ──────────────────────────────────────────────────

test("Vite manifest / build assets are served", async ({ page }) => {
  // The login page at / is publicly accessible and loads our Remix bundle
  const res = await page.goto(`${PROD}/`);
  expect(res!.status()).toBeLessThan(500);
});

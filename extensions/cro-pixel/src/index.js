// CRO Event Pixel — fires add_to_cart and checkout_started events.
// Runs in Shopify's sandboxed web pixel environment.
//
// Currently deployed with runtime_context = "strict" which does NOT allow
// localStorage/sessionStorage access. In strict mode the handlers subscribe
// to the events but return early because visitor/variant IDs are unavailable.
//
// To fully activate this pixel, complete Shopify's Protected Customer Data
// review (https://shopify.dev/docs/apps/launch/protected-customer-data) and
// change runtime_context to "lax" in shopify.extension.toml.

import { register } from "@shopify/web-pixels-extension";

register(({ analytics, browser, init }) => {
  const shopDomain = init.data.shop.myshopifyDomain;
  const PROXY_BASE = `https://${shopDomain}/apps/cro`;
  const VISITOR_KEY = "cro_visitor_id";
  const SESSION_KEY = "cro_session_id";
  const VID_PFX = "cro_vid_";

  // In "strict" runtime_context, browser.localStorage is unavailable.
  // Return null rather than throwing so callers can bail cleanly.
  function safeLocalStorageGet(key) {
    try {
      return browser.localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function safeLocalStorageLength() {
    try {
      return browser.localStorage.length;
    } catch (_) {
      return 0;
    }
  }

  function safeLocalStorageKey(i) {
    try {
      return browser.localStorage.key(i);
    } catch (_) {
      return null;
    }
  }

  function safeSessionStorageGet(key) {
    try {
      return browser.sessionStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function getAssignments() {
    const result = [];
    const len = safeLocalStorageLength();
    for (let i = 0; i < len; i++) {
      const key = safeLocalStorageKey(i);
      if (!key || !key.startsWith(VID_PFX)) continue;
      const experimentId = key.slice(VID_PFX.length);
      const variantId = safeLocalStorageGet(key);
      if (variantId) result.push({ experimentId, variantId });
    }
    return result;
  }

  function fire(payload) {
    const url = `${PROXY_BASE}/api/events`;
    const body = JSON.stringify(payload);
    try {
      browser.sendBeacon(url, body);
    } catch (_) {
      browser
        .fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        })
        .catch(() => {});
    }
  }

  analytics.subscribe("product_added_to_cart", () => {
    const visitorId = safeLocalStorageGet(VISITOR_KEY);
    const sessionId = safeSessionStorageGet(SESSION_KEY);
    if (!visitorId || !sessionId) return; // no-op in strict mode

    for (const { experimentId, variantId } of getAssignments()) {
      fire({ experimentId, variantId, visitorId, sessionId, eventType: "add_to_cart" });
    }
  });

  analytics.subscribe("checkout_started", (event) => {
    const visitorId = safeLocalStorageGet(VISITOR_KEY);
    const sessionId = safeSessionStorageGet(SESSION_KEY);
    if (!visitorId || !sessionId) return; // no-op in strict mode

    const checkoutToken = event?.data?.checkout?.token ?? null;

    for (const { experimentId, variantId } of getAssignments()) {
      fire({
        experimentId,
        variantId,
        visitorId,
        sessionId,
        eventType: "checkout_started",
        checkoutToken,
      });
    }
  });
});

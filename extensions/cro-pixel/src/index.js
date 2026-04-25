// CRO Event Pixel — fires add_to_cart and checkout_started events.
// Runs in Shopify's sandboxed web pixel environment.
// Experiment assignments written by the theme extension are read from
// localStorage via the browser object.

import { register } from "@shopify/web-pixels-extension";

register(({ analytics, browser, init }) => {
  const shopDomain = init.data.shop.myshopifyDomain;
  const PROXY_BASE = `https://${shopDomain}/apps/cro`;
  const VISITOR_KEY = "cro_visitor_id";
  const SESSION_KEY = "cro_session_id";
  const VID_PFX = "cro_vid_";

  // Collect experiment assignments from localStorage.
  // The theme extension stores cro_vid_{experimentId} = variantId
  // for every experiment the visitor has been bucketed into.
  function getAssignments() {
    const result = [];
    try {
      const len = browser.localStorage.length;
      for (let i = 0; i < len; i++) {
        const key = browser.localStorage.key(i);
        if (!key || !key.startsWith(VID_PFX)) continue;
        const experimentId = key.slice(VID_PFX.length);
        const variantId = browser.localStorage.getItem(key);
        if (variantId) result.push({ experimentId, variantId });
      }
    } catch (_) {}
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
    let visitorId, sessionId;
    try {
      visitorId = browser.localStorage.getItem(VISITOR_KEY);
      sessionId = browser.sessionStorage.getItem(SESSION_KEY);
    } catch (_) {
      return;
    }
    if (!visitorId || !sessionId) return;

    for (const { experimentId, variantId } of getAssignments()) {
      fire({ experimentId, variantId, visitorId, sessionId, eventType: "add_to_cart" });
    }
  });

  analytics.subscribe("checkout_started", (event) => {
    let visitorId, sessionId;
    try {
      visitorId = browser.localStorage.getItem(VISITOR_KEY);
      sessionId = browser.sessionStorage.getItem(SESSION_KEY);
    } catch (_) {
      return;
    }
    if (!visitorId || !sessionId) return;

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

# Shopify Platform Constraints

Reference for builders and AI agents. The hypothesis generator uses a condensed version of the guardrails section to avoid suggesting platform-impossible experiments.

---

## What the Theme App Extension CAN do

- Inject HTML/CSS/JS on any storefront page via async/deferred script (no render blocking)
- Read and write `localStorage` and `sessionStorage` on the storefront
- DOM manipulation after page load (DOMContentLoaded or script defer)
- Fire `fetch` / `sendBeacon` requests back to the app proxy
- Run on all page types: product, collection, cart, homepage

---

## What the Theme App Extension CANNOT do

- **Modify the checkout page** — checkout is a sandboxed Shopify environment. Standard Shopify plans do not allow any storefront injection inside `/checkout`. (Shopify Plus only, via Checkout Extensions — this app targets standard plans.)
- Access Shopify customer session data or logged-in customer tags without a Storefront API call (not yet configured in this app)
- Inject into the Shopify admin
- Run synchronous scripts that block LCP — performance budget: JS ≤ 10 kb, no sync `<script>` tags (async or defer required)
- Persist data server-side directly — all server writes go through the app proxy

---

## Web Pixel Extension limitations

- **`strict` runtime context (current):** no `localStorage`, `sessionStorage`, or cookie access
- **`lax` runtime context:** requires Shopify Protected Customer Data approval — **PENDING for this app**
- Cannot access the DOM directly (runs in a sandboxed iframe)
- Cannot read Shopify customer data without explicit PCD approval
- Event subscriptions available: `product_added_to_cart`, `checkout_started`, `checkout_completed`, and others in the checkout flow

---

## Checkout

- **Standard Shopify plans:** the checkout page (`/checkout`, `/thank_you`) is completely off-limits for injection
- **Shopify Plus only:** Checkout Extensions allow UI modifications inside checkout
- This app targets standard plans — **do NOT generate hypotheses that require checkout modification**

---

## Storefront API

- Available but requires a separate public Storefront API token (not yet configured in this app)
- Could be used in Phase 4 to read cart contents, product metafields, or customer data
- **Phase 3 hypothesis generator must not depend on Storefront API data**

---

## App Proxy constraints

- All proxy requests are HMAC-signed by Shopify — the app verifies the signature on every request
- Cannot set cookies or perform server-side redirects
- Response must be fast (< 500 ms recommended) — used for real-time experiment delivery on every page load

---

## Known approval gates (PENDING)

| Feature | Gate | Status |
|---------|------|--------|
| `orders/paid` webhook | Protected Customer Data approval | PENDING |
| Web Pixel `lax` context | Protected Customer Data approval | PENDING |

Both are unblocked once the PCD review is approved in the Shopify Partners dashboard.

---

## Hypothesis generator guardrails

The following rules are injected into the hypothesis generator system prompt:

1. **Never suggest experiments that modify the checkout page** — it is inaccessible on standard Shopify plans
2. **Never suggest experiments requiring logged-in customer data** — the Storefront API is not yet configured
3. **All variant code must run as async JS or CSS injection** — no synchronous scripts
4. **Experiments must target: product pages, collection pages, cart page, or homepage** — these are the only pages the theme extension runs on
5. **Keep JS patches under 10 kb** — suggest lightweight DOM changes, not full component rewrites

import type { LoaderFunctionArgs } from "react-router";

// Public app proxy endpoint — no HMAC auth required.
// Returns the visitor's 2-letter ISO country code based on request headers.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const headers = request.headers;

  // Cloudflare sets CF-IPCountry; Railway may set X-Shopify-Shop-Geo-Country
  const cfCountry = headers.get("cf-ipcountry");
  const shopifyCountry = headers.get("x-shopify-shop-geo-country");

  if (cfCountry && /^[A-Z]{2}$/.test(cfCountry) && cfCountry !== "XX") {
    return Response.json({ country: cfCountry }, { headers: { "Cache-Control": "no-store" } });
  }

  if (shopifyCountry && /^[A-Z]{2}$/.test(shopifyCountry)) {
    return Response.json({ country: shopifyCountry }, { headers: { "Cache-Control": "no-store" } });
  }

  // Fallback: parse Accept-Language for a locale hint (e.g. "en-US" → "US")
  const acceptLang = headers.get("accept-language") ?? "";
  const match = acceptLang.match(/[a-z]{2}-([A-Z]{2})/);
  if (match) {
    return Response.json({ country: match[1] }, { headers: { "Cache-Control": "no-store" } });
  }

  return Response.json({ country: "XX" }, { headers: { "Cache-Control": "no-store" } });
};

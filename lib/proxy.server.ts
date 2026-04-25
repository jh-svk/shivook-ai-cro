import crypto from "crypto";

/**
 * Validates a Shopify App Proxy HMAC signature.
 * Shopify appends shop, timestamp, signature (and path_prefix) to every
 * proxied request. The signature covers all query params except itself,
 * sorted alphabetically and concatenated with no separator.
 */
export function verifyProxySignature(searchParams: URLSearchParams): boolean {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) return false;

  const signature = searchParams.get("signature");
  if (!signature) return false;

  const message = [...searchParams.entries()]
    .filter(([key]) => key !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("");

  const computed = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed, "hex"),
      Buffer.from(signature, "hex")
    );
  } catch {
    return false;
  }
}

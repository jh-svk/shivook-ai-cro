import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// GDPR: redact customer data — we store only hashed visitor IDs, no PII, nothing to delete.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`[${topic}] redact request received for ${shop} — no PII stored`);
  return new Response(null, { status: 200 });
};

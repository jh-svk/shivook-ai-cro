import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// GDPR: respond to customer data requests — we store no PII, so nothing to return.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`[${topic}] data request received for ${shop} — no PII stored`);
  return new Response(null, { status: 200 });
};

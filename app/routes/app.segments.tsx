import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { findOrCreateShop } from "../../lib/shop.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop, session.accessToken ?? "");

  const segments = await prisma.segment.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "asc" },
  });

  return { segments };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop, session.accessToken ?? "");

  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "create");

  if (intent === "delete") {
    const segmentId = String(fd.get("segmentId"));
    await prisma.segment.delete({ where: { id: segmentId, shopId: shop.id } });
    return { success: true };
  }

  const name = String(fd.get("name") ?? "").trim();
  if (!name) return { error: "Segment name is required." };

  const nullIfEmpty = (v: FormDataEntryValue | null) => {
    const s = String(v ?? "").trim();
    return s && s !== "any" ? s : null;
  };

  const dayOfWeekRaw = fd.getAll("dayOfWeek");
  const dayOfWeek = dayOfWeekRaw.map((d) => parseInt(String(d), 10)).filter((d) => !isNaN(d));

  const timeFromRaw = String(fd.get("timeOfDayFrom") ?? "").trim();
  const timeToRaw   = String(fd.get("timeOfDayTo") ?? "").trim();

  try {
    await prisma.segment.create({
      data: {
        shopId: shop.id,
        name,
        deviceType:    nullIfEmpty(fd.get("deviceType")),
        trafficSource: nullIfEmpty(fd.get("trafficSource")),
        visitorType:   nullIfEmpty(fd.get("visitorType")),
        geoCountry:    [],
        productCategory: [],
        cartState:     nullIfEmpty(fd.get("cartState")),
        timeOfDayFrom: timeFromRaw ? parseInt(timeFromRaw, 10) : null,
        timeOfDayTo:   timeToRaw   ? parseInt(timeToRaw, 10)   : null,
        dayOfWeek,
      },
    });
    return { success: true };
  } catch (error) {
    console.error("[segments] create failed", error);
    return { error: "Failed to create segment. Please try again." };
  }
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function SegmentsPage() {
  const { segments } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <s-page heading="Audience Segments">
      <s-button slot="primary-action" type="button" variant="tertiary" href="/app">
        Experiments
      </s-button>

      {actionData && "error" in actionData && (
        <s-banner tone="critical" heading="Error">
          <s-paragraph>{(actionData as { error: string }).error}</s-paragraph>
        </s-banner>
      )}
      {actionData && "success" in actionData && (
        <s-banner tone="success" heading="Saved" dismissible>
          <s-paragraph>Segment saved.</s-paragraph>
        </s-banner>
      )}

      <s-section heading="Create segment">
        <Form method="post">
          <s-stack direction="block" gap="base">
            <s-text-field name="name" label="Segment name" required placeholder="e.g. Mobile paid traffic" />
            <s-stack direction="inline" gap="base">
              <s-select name="deviceType" label="Device type">
                <s-option value="any">Any</s-option>
                <s-option value="mobile">Mobile</s-option>
                <s-option value="tablet">Tablet</s-option>
                <s-option value="desktop">Desktop</s-option>
              </s-select>
              <s-select name="trafficSource" label="Traffic source">
                <s-option value="any">Any</s-option>
                <s-option value="paid">Paid</s-option>
                <s-option value="organic">Organic</s-option>
                <s-option value="email">Email</s-option>
                <s-option value="direct">Direct</s-option>
                <s-option value="social">Social</s-option>
              </s-select>
              <s-select name="visitorType" label="Visitor type">
                <s-option value="any">Any</s-option>
                <s-option value="new">New</s-option>
                <s-option value="returning">Returning</s-option>
                <s-option value="purchaser">Purchaser</s-option>
              </s-select>
            </s-stack>
            <s-stack direction="inline" gap="base">
              <s-number-field name="timeOfDayFrom" label="Hour from (0–23)" min={0} max={23} />
              <s-number-field name="timeOfDayTo"   label="Hour to (0–23)"   min={0} max={23} />
            </s-stack>
            <s-stack direction="block" gap="small">
              <s-text>Days of week (leave unchecked for any)</s-text>
              <s-stack direction="inline" gap="base">
                {DAYS.map((day, i) => (
                  <label key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <input type="checkbox" name="dayOfWeek" value={String(i)} />
                    <span>{day}</span>
                  </label>
                ))}
              </s-stack>
            </s-stack>
            <s-button type="submit" variant="primary" {...(isSubmitting ? { loading: true } : {})}>
              Create segment
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      {segments.length > 0 && (
        <s-section heading={`Segments (${segments.length})`}>
          <s-stack direction="block" gap="base">
            {segments.map((seg) => (
              <s-box key={seg.id} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="inline" gap="base">
                  <s-text>{seg.name}</s-text>
                  {seg.deviceType    && <s-badge>{seg.deviceType}</s-badge>}
                  {seg.trafficSource && <s-badge>{seg.trafficSource}</s-badge>}
                  {seg.visitorType   && <s-badge>{seg.visitorType}</s-badge>}
                  {seg.dayOfWeek.length > 0 && (
                    <s-badge>{seg.dayOfWeek.map((d) => DAYS[d]).join(", ")}</s-badge>
                  )}
                  {seg.timeOfDayFrom != null && seg.timeOfDayTo != null && (
                    <s-badge>{seg.timeOfDayFrom}:00–{seg.timeOfDayTo}:00</s-badge>
                  )}
                  <Form method="post" style={{ display: "inline" }}>
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="segmentId" value={seg.id} />
                    <s-button type="submit" variant="secondary" tone="critical">
                      Delete
                    </s-button>
                  </Form>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}

      {segments.length === 0 && (
        <s-section heading="No segments yet">
          <s-paragraph>
            Create a segment above to target experiments at specific audiences.
            Experiments without a segment target all visitors.
          </s-paragraph>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

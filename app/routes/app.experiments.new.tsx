import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { findOrCreateShop } from "../../lib/shop.server";
import { CodeEditor } from "../components/CodeEditor";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop, session.accessToken ?? "");
  const segments = await prisma.segment.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  return { segments };
};

const JS_BLOCKLIST = [
  /fetch\s*\(/,
  /XMLHttpRequest/,
  /document\.cookie/,
  /document\.forms/,
  /window\.location\s*=/,
  /navigator\.sendBeacon\s*\(/,
  /eval\s*\(/,
  /Function\s*\(/,
  /importScripts\s*\(/,
  /WebSocket\s*\(/,
];

function validateJsPatch(js: string | null): string | null {
  if (!js) return null;
  for (const pattern of JS_BLOCKLIST) {
    if (pattern.test(js)) {
      return `JS patch contains a disallowed pattern: ${pattern.source}`;
    }
  }
  return null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop, session.accessToken ?? "");

  const fd = await request.formData();
  const get = (key: string) => String(fd.get(key) ?? "").trim();

  const name = get("name");
  const hypothesis = get("hypothesis");
  const pageType = get("pageType");
  const elementType = get("elementType");
  const targetMetric = get("targetMetric");

  if (!name || !hypothesis || !pageType || !elementType || !targetMetric) {
    return { error: "All fields marked required must be filled in." };
  }

  const controlJsError = validateJsPatch(get("controlJsPatch") || null);
  if (controlJsError) return { error: `Control variant: ${controlJsError}` };
  const treatmentJsError = validateJsPatch(get("treatmentJsPatch") || null);
  if (treatmentJsError) return { error: `Treatment variant: ${treatmentJsError}` };

  // Optional third arm (A/B/n). Present only when the merchant added it in the UI.
  const hasVariantC = get("hasVariantC") === "1";
  if (hasVariantC) {
    const v2JsError = validateJsPatch(get("treatment2JsPatch") || null);
    if (v2JsError) return { error: `Variant C: ${v2JsError}` };
  }

  const maxRuntimeDays = Math.max(1, parseInt(get("maxRuntimeDays") || "28", 10));

  const nullIfEmpty = (v: string) => v || null;
  const buildVariant = (prefix: string, type: string, fallbackName: string) => ({
    type,
    name: get(`${prefix}Name`) || fallbackName,
    description: get(`${prefix}Description`),
    htmlPatch: nullIfEmpty(get(`${prefix}HtmlPatch`)),
    cssPatch: nullIfEmpty(get(`${prefix}CssPatch`)),
    jsPatch: nullIfEmpty(get(`${prefix}JsPatch`)),
  });

  try {
    const segmentIdRaw = String(fd.get("segmentId") ?? "").trim();
  const segmentId = segmentIdRaw || null;

  const experiment = await prisma.experiment.create({
      data: {
        shopId: shop.id,
        name,
        hypothesis,
        pageType,
        elementType,
        targetMetric,
        trafficSplit: 0.5,
        maxRuntimeDays,
        segmentId,
        variants: {
          create: [
            buildVariant("control", "control", "Control"),
            buildVariant("treatment", "treatment", "Treatment"),
            ...(hasVariantC ? [buildVariant("treatment2", "treatment", "Variant C")] : []),
          ],
        },
      },
    });
    return redirect(`/app/experiments/${experiment.id}`);
  } catch (error) {
    console.error("[experiments.new] create failed", error);
    return { error: "Failed to create experiment. Please try again." };
  }
};

const PAGE_TYPES = [
  { label: "Select page type", value: "" },
  { label: "Product", value: "product" },
  { label: "Collection", value: "collection" },
  { label: "Cart", value: "cart" },
  { label: "Homepage", value: "homepage" },
  { label: "Any page", value: "any" },
];

const ELEMENT_TYPES = [
  { label: "Select element type", value: "" },
  { label: "Headline", value: "headline" },
  { label: "Call to action", value: "cta" },
  { label: "Image", value: "image" },
  { label: "Layout", value: "layout" },
  { label: "Trust signal", value: "trust" },
  { label: "Price", value: "price" },
  { label: "Other", value: "other" },
];

const TARGET_METRICS = [
  { label: "Select target metric", value: "" },
  { label: "Conversion rate", value: "conversion_rate" },
  { label: "Add to cart rate", value: "add_to_cart_rate" },
  { label: "Revenue per visitor", value: "revenue_per_visitor" },
];

export default function NewExperiment() {
  const { segments } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [controlHtml, setControlHtml] = useState("");
  const [controlCss, setControlCss] = useState("");
  const [controlJs, setControlJs] = useState("");
  const [treatmentHtml, setTreatmentHtml] = useState("");
  const [treatmentCss, setTreatmentCss] = useState("");
  const [treatmentJs, setTreatmentJs] = useState("");

  // Optional third arm (A/B/n). Cap at 3 arms total.
  const [showVariantC, setShowVariantC] = useState(false);
  const [variantCHtml, setVariantCHtml] = useState("");
  const [variantCCss, setVariantCCss] = useState("");
  const [variantCJs, setVariantCJs] = useState("");

  return (
    <s-page heading="New experiment">
      <s-button slot="primary-action" type="button" variant="tertiary" href="/app">
        Cancel
      </s-button>

      {actionData?.error && (
        <s-banner tone="critical" heading="Could not create experiment">
          <s-paragraph>{actionData.error}</s-paragraph>
        </s-banner>
      )}

      <Form method="post">
        <s-section heading="Experiment details">
          <s-stack direction="block" gap="base">
            <s-text-field
              name="name"
              label="Experiment name"
              required
              placeholder="e.g. Homepage hero headline test"
            />
            <s-text-area
              name="hypothesis"
              label="Hypothesis"
              required
              placeholder="We believe that changing X will cause Y because Z"
              rows={3}
            />
            <s-stack direction="inline" gap="base">
              <s-select name="pageType" label="Page type" required>
                {PAGE_TYPES.map((o) => (
                  <s-option key={o.value} value={o.value}>
                    {o.label}
                  </s-option>
                ))}
              </s-select>
              <s-select name="elementType" label="Element type" required>
                {ELEMENT_TYPES.map((o) => (
                  <s-option key={o.value} value={o.value}>
                    {o.label}
                  </s-option>
                ))}
              </s-select>
            </s-stack>
            <s-stack direction="inline" gap="base">
              <s-select name="targetMetric" label="Target metric" required>
                {TARGET_METRICS.map((o) => (
                  <s-option key={o.value} value={o.value}>
                    {o.label}
                  </s-option>
                ))}
              </s-select>
              <s-number-field
                name="maxRuntimeDays"
                label="Max runtime (days)"
                value="28"
                min={1}
                max={90}
              />
            </s-stack>
            {segments.length > 0 && (
              <s-select name="segmentId" label="Audience segment (optional)">
                <s-option value="">All visitors</s-option>
                {segments.map((seg) => (
                  <s-option key={seg.id} value={seg.id}>
                    {seg.name}
                  </s-option>
                ))}
              </s-select>
            )}
            <s-banner tone="info" heading="Traffic split">
              <s-paragraph>
                Traffic is split evenly across all arms — 50/50 for a 2-arm test,
                or roughly a third each when you add a third variant.
              </s-paragraph>
            </s-banner>
          </s-stack>
        </s-section>

        <s-section heading="Control variant">
          <s-stack direction="block" gap="base">
            <s-text-field
              name="controlName"
              label="Variant name"
              value="Control"
            />
            <s-text-area
              name="controlDescription"
              label="Description"
              placeholder="Describe what the control shows (the existing experience)"
              rows={2}
            />
            <CodeEditor
              value={controlHtml}
              onChange={setControlHtml}
              language="html"
              label="HTML patch"
              name="controlHtmlPatch"
            />
            <CodeEditor
              value={controlCss}
              onChange={setControlCss}
              language="css"
              label="CSS patch"
              name="controlCssPatch"
            />
            <CodeEditor
              value={controlJs}
              onChange={setControlJs}
              language="javascript"
              label="JS patch"
              name="controlJsPatch"
            />
          </s-stack>
        </s-section>

        <s-section heading="Treatment variant">
          <s-stack direction="block" gap="base">
            <s-text-field
              name="treatmentName"
              label="Variant name"
              value="Treatment"
            />
            <s-text-area
              name="treatmentDescription"
              label="Description"
              placeholder="Describe what this variant changes"
              rows={2}
            />
            <CodeEditor
              value={treatmentHtml}
              onChange={setTreatmentHtml}
              language="html"
              label="HTML patch"
              name="treatmentHtmlPatch"
            />
            <CodeEditor
              value={treatmentCss}
              onChange={setTreatmentCss}
              language="css"
              label="CSS patch"
              name="treatmentCssPatch"
            />
            <CodeEditor
              value={treatmentJs}
              onChange={setTreatmentJs}
              language="javascript"
              label="JS patch"
              name="treatmentJsPatch"
            />
          </s-stack>
        </s-section>

        {showVariantC ? (
          <s-section heading="Variant C">
            <s-stack direction="block" gap="base">
              <input type="hidden" name="hasVariantC" value="1" />
              <s-text-field
                name="treatment2Name"
                label="Variant name"
                value="Variant C"
              />
              <s-text-area
                name="treatment2Description"
                label="Description"
                placeholder="Describe what this second variant changes"
                rows={2}
              />
              <CodeEditor
                value={variantCHtml}
                onChange={setVariantCHtml}
                language="html"
                label="HTML patch"
                name="treatment2HtmlPatch"
              />
              <CodeEditor
                value={variantCCss}
                onChange={setVariantCCss}
                language="css"
                label="CSS patch"
                name="treatment2CssPatch"
              />
              <CodeEditor
                value={variantCJs}
                onChange={setVariantCJs}
                language="javascript"
                label="JS patch"
                name="treatment2JsPatch"
              />
              <s-button
                type="button"
                variant="tertiary"
                tone="critical"
                onClick={() => setShowVariantC(false)}
              >
                Remove Variant C
              </s-button>
            </s-stack>
          </s-section>
        ) : (
          <s-section>
            <s-stack direction="block" gap="base">
              <s-button type="button" variant="tertiary" onClick={() => setShowVariantC(true)}>
                + Add a third variant (A/B/n test)
              </s-button>
              <s-text tone="neutral">
                Up to 3 arms. A 3-arm test splits traffic three ways, so it needs
                roughly 450+ views/day on this page to reach a decision in a
                reasonable window.
              </s-text>
            </s-stack>
          </s-section>
        )}

        <s-section>
          <s-button type="submit" variant="primary" {...(isSubmitting ? { loading: true } : {})}>
            Create experiment
          </s-button>
        </s-section>
      </Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

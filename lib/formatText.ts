/**
 * Display formatters — convert internal snake_case / lowercase identifiers
 * into human-readable Title Case for the UI. DO NOT mutate stored values
 * (logic still compares against the raw lowercase strings).
 */

/**
 * "pending_approval" -> "Pending Approval"
 * "active"           -> "Active"
 * "qa_failed"        -> "Qa Failed"   (good enough — these are display-only)
 */
export function formatStatus(status: string | null | undefined): string {
  if (!status) return "";
  return titleCase(String(status).replace(/_/g, " "));
}

/**
 * "paid traffic" -> "Paid Traffic"
 * "new visitors" -> "New Visitors"
 * "mobile"       -> "Mobile"
 */
export function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

/** Readable labels for the internal targetMetric enums. */
const METRIC_LABELS: Record<string, string> = {
  conversion_rate: "conversion rate",
  add_to_cart_rate: "add-to-cart rate",
  revenue_per_visitor: "revenue per visitor",
};

/** "add_to_cart_rate" -> "add-to-cart rate" (for a single metric value). */
export function humanizeMetric(metric: string | null | undefined): string {
  if (!metric) return "";
  return METRIC_LABELS[metric] ?? String(metric).replace(/_/g, " ");
}

/**
 * Replace any raw metric enum that leaked into prose (e.g. an AI-written
 * hypothesis "...will increase add_to_cart_rate because...") with its
 * readable form. Safe to run on any display string.
 */
export function humanizeMetricsInText(text: string | null | undefined): string {
  if (!text) return "";
  let out = String(text);
  for (const [enumValue, label] of Object.entries(METRIC_LABELS)) {
    out = out.split(enumValue).join(label);
  }
  return out;
}

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

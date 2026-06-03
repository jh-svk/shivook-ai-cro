type SegmentLike = {
  deviceType?: string | null;
  trafficSource?: string | null;
  visitorType?: string | null;
  geoCountry?: string[];
} | null | undefined;

/** Canonical "page + segment" dedup key. Used in hypothesisGenerator and concurrentTestManager. */
export function segmentSignature(pageType: string, s: SegmentLike): string {
  const d = s?.deviceType || "any";
  const t = s?.trafficSource || "any";
  const v = s?.visitorType || "any";
  const g = (s?.geoCountry ?? []).slice().sort().join(",") || "any";
  return `${pageType}|${d}|${t}|${v}|${g}`;
}

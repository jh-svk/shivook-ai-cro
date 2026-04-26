/**
 * GA4 Data API connector.
 *
 * Fetches a 30-day rolling snapshot of key metrics:
 *   - Sessions, bounce rate, pages/session, avg session duration
 *   - Top landing pages by sessions
 *   - Device category breakdown
 *   - Session source / medium breakdown
 *
 * Authentication: uses a service account JSON key stored in the data_sources
 * config field as { serviceAccountKey: <base64-encoded JSON> }.
 *
 * The Google Analytics Data API v1 does not require an npm package —
 * we call it directly via fetch to keep the bundle lean.
 */

export interface GA4Config {
  propertyId: string;          // e.g. "properties/123456789"
  serviceAccountKey: string;   // base64-encoded service account JSON
}

export interface GA4Snapshot {
  period: string;              // "last_30_days"
  sessions: number;
  bounceRate: number;
  pagesPerSession: number;
  avgSessionDurationSecs: number;
  topLandingPages: Array<{ page: string; sessions: number; bounceRate: number }>;
  deviceBreakdown: Array<{ device: string; sessions: number; pct: number }>;
  sourceBreakdown: Array<{ source: string; sessions: number; pct: number }>;
}

async function getAccessToken(serviceAccountKeyB64: string): Promise<string> {
  const key = JSON.parse(Buffer.from(serviceAccountKeyB64, "base64").toString());

  // Build JWT for Google OAuth2
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claims = btoa(
    JSON.stringify({
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/analytics.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );

  const { createSign } = await import("crypto");
  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${claims}`);
  const signature = sign.sign(key.private_key, "base64");
  const jwt = `${header}.${claims}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) throw new Error(`GA4 auth failed: ${res.status}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function runReport(
  propertyId: string,
  token: string,
  body: object
): Promise<unknown> {
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(`GA4 runReport failed: ${res.status}`);
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cell(row: any, idx: number): string {
  return row?.dimensionValues?.[idx]?.value ?? row?.metricValues?.[idx]?.value ?? "";
}

export async function fetchGA4Snapshot(config: GA4Config): Promise<GA4Snapshot> {
  const token = await getAccessToken(config.serviceAccountKey);

  const dateRange = [{ startDate: "30daysAgo", endDate: "yesterday" }];

  // Overview metrics
  const overviewRaw = (await runReport(config.propertyId, token, {
    dateRanges: dateRange,
    metrics: [
      { name: "sessions" },
      { name: "bounceRate" },
      { name: "screenPageViewsPerSession" },
      { name: "averageSessionDuration" },
    ],
  })) as { rows?: unknown[] };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const overviewRow = (overviewRaw.rows?.[0] as any) ?? {};
  const sessions = parseInt(overviewRow?.metricValues?.[0]?.value ?? "0");
  const bounceRate = parseFloat(overviewRow?.metricValues?.[1]?.value ?? "0");
  const pagesPerSession = parseFloat(overviewRow?.metricValues?.[2]?.value ?? "0");
  const avgSessionDurationSecs = parseFloat(overviewRow?.metricValues?.[3]?.value ?? "0");

  // Top 10 landing pages
  const landingRaw = (await runReport(config.propertyId, token, {
    dateRanges: dateRange,
    dimensions: [{ name: "landingPage" }],
    metrics: [{ name: "sessions" }, { name: "bounceRate" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 10,
  })) as { rows?: unknown[] };

  const topLandingPages = ((landingRaw.rows ?? []) as unknown[]).map((r) => ({
    page: cell(r, 0),
    sessions: parseInt(cell(r, 0) || "0"),
    bounceRate: parseFloat(cell(r, 1) || "0"),
  }));

  // Device breakdown
  const deviceRaw = (await runReport(config.propertyId, token, {
    dateRanges: dateRange,
    dimensions: [{ name: "deviceCategory" }],
    metrics: [{ name: "sessions" }],
  })) as { rows?: unknown[] };

  const deviceRows = (deviceRaw.rows ?? []) as unknown[];
  const deviceTotal = deviceRows.reduce((sum: number, r) => sum + parseInt(cell(r, 0) || "0"), 0);
  const deviceBreakdown = deviceRows.map((r) => {
    const count = parseInt(cell(r, 0) || "0");
    return { device: cell(r, 0), sessions: count, pct: deviceTotal > 0 ? count / deviceTotal : 0 };
  });

  // Source/medium breakdown (top 8)
  const sourceRaw = (await runReport(config.propertyId, token, {
    dateRanges: dateRange,
    dimensions: [{ name: "sessionSourceMedium" }],
    metrics: [{ name: "sessions" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 8,
  })) as { rows?: unknown[] };

  const sourceRows = (sourceRaw.rows ?? []) as unknown[];
  const sourceTotal = sessions || 1;
  const sourceBreakdown = sourceRows.map((r) => {
    const s = parseInt(cell(r, 0) || "0");
    return { source: cell(r, 0), sessions: s, pct: s / sourceTotal };
  });

  return {
    period: "last_30_days",
    sessions,
    bounceRate,
    pagesPerSession,
    avgSessionDurationSecs,
    topLandingPages,
    deviceBreakdown,
    sourceBreakdown,
  };
}

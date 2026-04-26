/**
 * Microsoft Clarity data connector.
 *
 * Fetches engagement metrics from the Clarity Data Export API.
 * API docs: https://learn.microsoft.com/en-us/clarity/setup-and-installation/api-usage
 *
 * Note: The exact endpoint paths may need verification against the current
 * Clarity API docs. The shape of ClaritySnapshot matches what the research
 * synthesis prompt expects.
 */

export interface ClarityConfig {
  projectId: string;
  bearerToken: string;
}

export interface ClarityPageMetrics {
  url: string;
  sessions: number;
  avgSessionDurationSeconds: number;
  avgScrollDepthPercent: number;
  rageClicks: number;
  deadClicks: number;
  topClickedElements: Array<{ selector: string; clicks: number }>;
}

export interface ClaritySnapshot {
  fetchedAt: string;
  pages: ClarityPageMetrics[];
}

const BASE_URL = "https://www.clarity.ms/export";

function dateRange(): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  return { startDate: fmt(start), endDate: fmt(end) };
}

export async function fetchClaritySnapshot(config: ClarityConfig): Promise<ClaritySnapshot> {
  const { projectId, bearerToken } = config;
  const { startDate, endDate } = dateRange();

  const url = new URL(`${BASE_URL}/data`);
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
  url.searchParams.set("type", "metrics");

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Clarity API returned ${response.status}: ${await response.text()}`);
  }

  const raw = await response.json() as Record<string, unknown>;

  // Normalise the raw response into our ClarityPageMetrics shape.
  // The exact field names depend on the Clarity API version — adjust if needed.
  const pages: ClarityPageMetrics[] = [];
  const rows = Array.isArray(raw.data) ? raw.data as Record<string, unknown>[] : [];

  for (const row of rows) {
    pages.push({
      url:                        String(row.url ?? row.pageUrl ?? ""),
      sessions:                   Number(row.sessions ?? row.sessionCount ?? 0),
      avgSessionDurationSeconds:  Number(row.avgSessionDuration ?? 0),
      avgScrollDepthPercent:      Number(row.avgScrollDepth ?? row.scrollDepth ?? 0),
      rageClicks:                 Number(row.rageClicks ?? row.rageClickCount ?? 0),
      deadClicks:                 Number(row.deadClicks ?? row.deadClickCount ?? 0),
      topClickedElements:         [],
    });
  }

  return { fetchedAt: new Date().toISOString(), pages };
}

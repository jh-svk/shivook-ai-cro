import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { findOrCreateShop } from "../../lib/shop.server";

type BadgeTone = "info" | "success" | "warning" | "neutral" | "critical";

const STATUS_TONE: Record<string, BadgeTone> = {
  draft: "info",
  active: "success",
  paused: "warning",
  concluded: "neutral",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop, session.accessToken ?? "");

  try {
    const [experiments, orchestratorLogs] = await Promise.all([
      prisma.experiment.findMany({
        where: { shopId: shop.id },
        orderBy: { createdAt: "desc" },
        include: { result: true },
      }),
      prisma.orchestratorLog.findMany({
        where: { shopId: shop.id },
        orderBy: { startedAt: "desc" },
        take: 20,
      }),
    ]);
    return { experiments, orchestratorLogs };
  } catch (error) {
    console.error("[app._index] failed to load experiments", error);
    return {
      experiments: [] as Awaited<
        ReturnType<
          typeof prisma.experiment.findMany<{ include: { result: true } }>
        >
      >,
      orchestratorLogs: [] as Awaited<ReturnType<typeof prisma.orchestratorLog.findMany>>,
    };
  }
};

const STAGE_TONE: Record<string, "info" | "success" | "warning" | "critical" | "neutral"> = {
  complete: "success",
  failed: "critical",
  skipped: "neutral",
  running: "info",
};

function relativeTime(date: string): string {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function ExperimentsIndex() {
  const { experiments, orchestratorLogs } = useLoaderData<typeof loader>();

  return (
    <s-page heading="A/B Experiments">
      <s-button
        slot="primary-action"
        type="button"
        variant="primary"
        href="/app/experiments/new"
      >
        New experiment
      </s-button>
      <s-button
        slot="primary-action"
        type="button"
        variant="secondary"
        href="/app/hypotheses"
      >
        AI hypotheses
      </s-button>

      {experiments.length === 0 ? (
        <s-section heading="No experiments yet">
          <s-paragraph>
            Create your first A/B experiment to start optimizing your
            storefront.
          </s-paragraph>
          <s-button type="button" variant="primary" href="/app/experiments/new">
            New experiment
          </s-button>
        </s-section>
      ) : (
        <s-section>
          <s-table>
            <s-table-header-row slot="header">
              <s-table-header>Name</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Page type</s-table-header>
              <s-table-header format="numeric">Visitors</s-table-header>
              <s-table-header format="numeric">Control conv.</s-table-header>
              <s-table-header format="numeric">Treatment conv.</s-table-header>
              <s-table-header format="numeric">Lift</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {experiments.map((exp) => (
                <s-table-row key={exp.id}>
                  <s-table-cell>
                    <s-link href={`/app/experiments/${exp.id}`}>
                      {exp.name}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS_TONE[exp.status] ?? "info"}>
                      {exp.status}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{exp.pageType}</s-table-cell>
                  <s-table-cell>
                    {exp.result
                      ? (
                          exp.result.controlVisitors +
                          exp.result.treatmentVisitors
                        ).toLocaleString()
                      : "—"}
                  </s-table-cell>
                  <s-table-cell>
                    {exp.result
                      ? `${(exp.result.controlConversionRate * 100).toFixed(2)}%`
                      : "—"}
                  </s-table-cell>
                  <s-table-cell>
                    {exp.result
                      ? `${(exp.result.treatmentConversionRate * 100).toFixed(2)}%`
                      : "—"}
                  </s-table-cell>
                  <s-table-cell>
                    {exp.result?.relativeLift != null
                      ? `${(exp.result.relativeLift * 100).toFixed(1)}%`
                      : "—"}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}

      {orchestratorLogs.length > 0 && (
        <s-section heading="AI Orchestrator Activity">
          <s-stack direction="block" gap="base">
            {orchestratorLogs.map((log) => (
              <details key={log.id} style={{ borderBottom: "1px solid #e1e3e5", paddingBottom: 8 }}>
                <summary style={{ cursor: "pointer", listStyle: "none", display: "flex", alignItems: "center", gap: 8 }}>
                  <s-badge tone={STAGE_TONE[log.status] ?? "info"}>{log.stage}</s-badge>
                  <s-badge>{log.status}</s-badge>
                  <s-text>
                    {relativeTime(String(log.startedAt))} — run {String(log.runId).slice(-8)}
                  </s-text>
                </summary>
                <pre style={{ background: "#f6f6f7", padding: "8px 12px", borderRadius: 4, fontSize: 11, marginTop: 4, overflowX: "auto" }}>
                  {JSON.stringify(log.payload, null, 2)}
                </pre>
              </details>
            ))}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

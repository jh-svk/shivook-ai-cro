import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { useState } from "react";
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

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop, session.accessToken ?? "");
  const fd = await request.formData();
  const intent = fd.get("intent");
  if (intent !== "bulk_delete") return { error: "Invalid action." };

  const ids = fd.getAll("ids[]").map(String).filter(Boolean);
  if (ids.length === 0) return { error: "No experiments selected." };

  // Guard: only delete experiments belonging to this shop that are not active
  const experiments = await prisma.experiment.findMany({
    where: { id: { in: ids }, shopId: shop.id },
    select: { id: true, status: true },
  });
  const deletable = experiments
    .filter((e) => e.status !== "active" && e.status !== "paused")
    .map((e) => e.id);

  if (deletable.length === 0) return { error: "No deletable experiments selected (active/paused tests cannot be deleted)." };

  try {
    await prisma.event.deleteMany({ where: { experimentId: { in: deletable } } });
    await prisma.result.deleteMany({ where: { experimentId: { in: deletable } } });
    try {
      for (const id of deletable) {
        await prisma.orchestratorLog.deleteMany({
          where: { payload: { path: ["experimentId"], equals: id } },
        });
      }
    } catch { /* best-effort */ }
    await prisma.variant.deleteMany({ where: { experimentId: { in: deletable } } });
    await prisma.experiment.deleteMany({ where: { id: { in: deletable } } });
    return { deleted: deletable.length };
  } catch (error) {
    console.error("[app._index] bulk delete error", error);
    return { error: "Failed to delete experiments." };
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

const DELETABLE = new Set(["draft", "concluded"]);

export default function ExperimentsIndex() {
  const { experiments, orchestratorLogs } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const deletableIds = experiments
    .filter((e) => DELETABLE.has(e.status))
    .map((e) => e.id);

  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleAll = () => {
    if (selected.size === deletableIds.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(deletableIds));
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = deletableIds.length > 0 && selected.size === deletableIds.length;
  const someSelected = selected.size > 0 && !allSelected;

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
          {selected.size > 0 && (
            <Form
              method="post"
              onSubmit={(e) => {
                if (!window.confirm(`Permanently delete ${selected.size} experiment${selected.size > 1 ? "s" : ""} and all their data? This cannot be undone.`)) {
                  e.preventDefault();
                }
              }}
              style={{ marginBottom: 12 }}
            >
              <input type="hidden" name="intent" value="bulk_delete" />
              {Array.from(selected).map((id) => (
                <input key={id} type="hidden" name="ids[]" value={id} />
              ))}
              <s-button
                type="submit"
                tone="critical"
                variant="secondary"
                disabled={isSubmitting || undefined}
              >
                Delete selected ({selected.size})
              </s-button>
            </Form>
          )}
          <s-table>
            <s-table-header-row slot="header">
              <s-table-header>
                {deletableIds.length > 0 && (
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = someSelected; }}
                    onChange={toggleAll}
                    aria-label="Select all deletable experiments"
                  />
                )}
              </s-table-header>
              <s-table-header>Name</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Page type</s-table-header>
              <s-table-header format="numeric">Visitors</s-table-header>
              <s-table-header format="numeric">Control conv.</s-table-header>
              <s-table-header format="numeric">Treatment conv.</s-table-header>
              <s-table-header format="numeric">Lift</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {experiments.map((exp) => {
                const isDeletable = DELETABLE.has(exp.status);
                return (
                  <s-table-row key={exp.id}>
                    <s-table-cell>
                      {isDeletable && (
                        <input
                          type="checkbox"
                          checked={selected.has(exp.id)}
                          onChange={() => toggle(exp.id)}
                          aria-label={`Select ${exp.name}`}
                        />
                      )}
                    </s-table-cell>
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
                    <s-table-cell>
                      {isDeletable && (
                        <Form
                          method="post"
                          action={`/app/experiments/${exp.id}`}
                          onSubmit={(e) => {
                            if (!window.confirm("Permanently delete this experiment and all its data?")) {
                              e.preventDefault();
                            }
                          }}
                        >
                          <input type="hidden" name="intent" value="delete" />
                          <s-button type="submit" tone="critical" variant="tertiary">
                            Delete
                          </s-button>
                        </Form>
                      )}
                    </s-table-cell>
                  </s-table-row>
                );
              })}
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

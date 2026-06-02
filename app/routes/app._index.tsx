import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation, useRevalidator } from "react-router";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { findOrCreateShop } from "../../lib/shop.server";
import { formatStatus, titleCase } from "../../lib/formatText";
import { enqueueAutoBuild } from "../../jobs/autoBuild";

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
    const [experiments, orchestratorLogs, buildingHypotheses, shopRow] = await Promise.all([
      prisma.experiment.findMany({
        where: { shopId: shop.id },
        orderBy: { createdAt: "desc" },
        include: {
          result: true,
          segment: true,
          variants: { select: { id: true, type: true } },
        },
      }),
      prisma.orchestratorLog.findMany({
        where: { shopId: shop.id },
        orderBy: { startedAt: "desc" },
        take: 20,
      }),
      // Hypotheses whose AI variant is currently being built.
      prisma.hypothesis.findMany({
        where: { shopId: shop.id, status: "building" },
        orderBy: { createdAt: "desc" },
        select: { id: true, title: true },
      }),
      prisma.shop.findUnique({ where: { id: shop.id }, select: { shopifyDomain: true, themeTokens: true } }),
    ]);
    // Builds that failed quality checks — surfaced here so they're visible from
    // the Experiments page too, not only on the AI Hypotheses tab.
    const failedBuilds = await prisma.hypothesis.findMany({
      where: { shopId: shop.id, status: "qa_failed" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, title: true },
    });

    // Build a direct storefront preview URL per experiment so the merchant can
    // QA the treatment variant in a NEW TAB without opening the embedded admin
    // detail page (which triggers a Shopify re-auth loop in a raw new tab).
    const domain = shopRow?.shopifyDomain ?? "";
    const sampleUrls = (shopRow?.themeTokens as { sampleUrls?: { product?: string | null; collection?: string | null } } | null)?.sampleUrls;
    const pathFor = (pageType: string) =>
      pageType === "product" ? sampleUrls?.product ?? "/"
      : pageType === "collection" ? sampleUrls?.collection ?? "/"
      : pageType === "cart" ? "/cart"
      : "/";
    const previewUrls: Record<string, { control?: string; treatment?: string }> = {};
    for (const e of experiments) {
      if (!domain) continue;
      const path = pathFor(e.pageType);
      const base = `https://${domain}${path}${path.includes("?") ? "&" : "?"}cro_preview_experiment=${e.id}&cro_preview_variant=`;
      const control = e.variants.find((v) => v.type === "control");
      const treatment = e.variants.find((v) => v.type === "treatment");
      previewUrls[e.id] = {
        control: control ? base + control.id : undefined,
        treatment: treatment ? base + treatment.id : undefined,
      };
    }

    return { experiments, orchestratorLogs, buildingHypotheses, failedBuilds, previewUrls };
  } catch (error) {
    console.error("[app._index] failed to load experiments", error);
    return {
      experiments: [] as Awaited<
        ReturnType<
          typeof prisma.experiment.findMany<{ include: { result: true; segment: true; variants: { select: { id: true; type: true } } } }>
        >
      >,
      orchestratorLogs: [] as Awaited<ReturnType<typeof prisma.orchestratorLog.findMany>>,
      buildingHypotheses: [] as { id: string; title: string }[],
      failedBuilds: [] as { id: string; title: string }[],
      previewUrls: {} as Record<string, { control?: string; treatment?: string }>,
    };
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop, session.accessToken ?? "");
  const fd = await request.formData();
  const intent = fd.get("intent");

  if (intent === "reset_build") {
    const hid = String(fd.get("hypothesisId"));
    await prisma.hypothesis.updateMany({
      where: { id: hid, shopId: shop.id, status: "building" },
      data: { status: "backlog" },
    });
    return { reset: true };
  }

  if (intent === "retry_build") {
    const hid = String(fd.get("hypothesisId"));
    const updated = await prisma.hypothesis.updateMany({
      where: { id: hid, shopId: shop.id, status: "qa_failed" },
      data: { status: "building" },
    });
    if (updated.count > 0) await enqueueAutoBuild(shop.id, hid);
    return { retried: true };
  }

  if (intent === "dismiss_build") {
    const hid = String(fd.get("hypothesisId"));
    await prisma.hypothesis.updateMany({
      where: { id: hid, shopId: shop.id, status: "qa_failed" },
      data: { status: "rejected" },
    });
    return { dismissed: true };
  }

  if (intent !== "bulk_delete") return { error: "Invalid action." };

  const ids = fd.getAll("ids[]").map(String).filter(Boolean);
  if (ids.length === 0) return { error: "No experiments selected." };

  // Guard: only delete experiments belonging to this shop that are not active
  const experiments = await prisma.experiment.findMany({
    where: { id: { in: ids }, shopId: shop.id },
    select: { id: true, status: true },
  });
  // Any experiment the shop owns can be deleted, regardless of status.
  const deletable = experiments.map((e) => e.id);

  if (deletable.length === 0) return { error: "No experiments selected." };

  try {
    // Clear all rows referencing these experiments before deleting (FK order).
    await prisma.hypothesis.updateMany({
      where: { promotedExperimentId: { in: deletable } },
      data: { promotedExperimentId: null },
    });
    await prisma.event.deleteMany({ where: { experimentId: { in: deletable } } });
    await prisma.result.deleteMany({ where: { experimentId: { in: deletable } } });
    await prisma.knowledgeBase.deleteMany({ where: { experimentId: { in: deletable } } });
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

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "2px 10px",
        borderRadius: 999,
        border: "1px solid",
        borderColor: active ? "#000" : "#d0d0d0",
        background: active ? "#000" : "#fff",
        color: active ? "#fff" : "#333",
        fontSize: 12,
        cursor: "pointer",
        lineHeight: 1.8,
      }}
    >
      {label}
    </button>
  );
}

export default function ExperimentsIndex() {
  const { experiments, orchestratorLogs, buildingHypotheses, failedBuilds, previewUrls } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  // Quick segment filter for the experiments table.
  const [segFilter, setSegFilter] = useState<{ key: string; value: string } | null>(null);
  const matchesFilter = (exp: (typeof experiments)[number]) => {
    if (!segFilter) return true;
    const seg = exp.segment;
    if (segFilter.key === "pageType") return exp.pageType === segFilter.value;
    if (segFilter.key === "device") return (seg?.deviceType ?? "") === segFilter.value;
    if (segFilter.key === "audience") return (seg?.visitorType ?? "") === segFilter.value;
    return true;
  };
  // Collect the distinct filter chips present across experiments.
  const pageTypes = [...new Set(experiments.map((e) => e.pageType))].sort();
  const devices = [...new Set(experiments.map((e) => e.segment?.deviceType).filter(Boolean) as string[])].sort();
  const audiences = [...new Set(experiments.map((e) => e.segment?.visitorType).filter(Boolean) as string[])].sort();

  // Poll while variants are building so they appear in the list automatically.
  const revalidator = useRevalidator();
  useEffect(() => {
    if (buildingHypotheses.length === 0) return;
    const t = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 4000);
    return () => clearInterval(t);
  }, [buildingHypotheses.length, revalidator]);

  const deletableIds = experiments.map((e) => e.id);

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

      {buildingHypotheses.length > 0 && (
        <s-section heading={`Building variants (${buildingHypotheses.length})`}>
          <s-stack direction="block" gap="base">
            <s-paragraph>
              The AI is generating brand-native variants for these hypotheses
              (about a minute each). They’ll move into the experiments list below
              automatically when ready — no need to refresh.
            </s-paragraph>
            {buildingHypotheses.map((h) => (
              <s-box key={h.id} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small">
                  <s-stack direction="inline" gap="base">
                    <s-badge tone="info">Building…</s-badge>
                    <s-text>{h.title}</s-text>
                  </s-stack>
                  <progress style={{ width: "100%", height: "8px" }} />
                  <Form method="post" style={{ display: "inline" }}>
                    <input type="hidden" name="intent" value="reset_build" />
                    <input type="hidden" name="hypothesisId" value={h.id} />
                    <s-button type="submit" variant="tertiary">
                      Cancel &amp; return to backlog
                    </s-button>
                  </Form>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}

      {failedBuilds.length > 0 && (
        <s-section heading={`Build failed (${failedBuilds.length})`}>
          <s-stack direction="block" gap="base">
            <s-paragraph>
              These variants couldn’t pass quality checks. Retry (the AI tries
              again from scratch) or dismiss them.
            </s-paragraph>
            {failedBuilds.map((h) => (
              <s-box key={h.id} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small">
                  <s-stack direction="inline" gap="base">
                    <s-badge tone="critical">Build failed</s-badge>
                    <s-text>{h.title}</s-text>
                  </s-stack>
                  <s-stack direction="inline" gap="base">
                    <Form method="post" style={{ display: "inline" }}>
                      <input type="hidden" name="intent" value="retry_build" />
                      <input type="hidden" name="hypothesisId" value={h.id} />
                      <s-button type="submit" variant="primary">
                        ✨ Retry
                      </s-button>
                    </Form>
                    <Form method="post" style={{ display: "inline" }}>
                      <input type="hidden" name="intent" value="dismiss_build" />
                      <input type="hidden" name="hypothesisId" value={h.id} />
                      <s-button type="submit" variant="secondary" tone="critical">
                        Dismiss
                      </s-button>
                    </Form>
                  </s-stack>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}

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
          {(pageTypes.length + devices.length + audiences.length) > 1 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 12 }}>
              <s-text tone="neutral">Filter:</s-text>
              <FilterChip label="All" active={!segFilter} onClick={() => setSegFilter(null)} />
              {pageTypes.map((pt) => (
                <FilterChip key={"p-" + pt} label={titleCase(pt)} active={segFilter?.key === "pageType" && segFilter.value === pt} onClick={() => setSegFilter({ key: "pageType", value: pt })} />
              ))}
              {devices.map((d) => (
                <FilterChip key={"d-" + d} label={titleCase(d)} active={segFilter?.key === "device" && segFilter.value === d} onClick={() => setSegFilter({ key: "device", value: d })} />
              ))}
              {audiences.map((a) => (
                <FilterChip key={"a-" + a} label={titleCase(a) + " visitors"} active={segFilter?.key === "audience" && segFilter.value === a} onClick={() => setSegFilter({ key: "audience", value: a })} />
              ))}
            </div>
          )}
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
              <s-table-header>Device</s-table-header>
              <s-table-header>Audience</s-table-header>
              <s-table-header>Geo</s-table-header>
              <s-table-header format="numeric">Visitors</s-table-header>
              <s-table-header format="numeric">Control conv.</s-table-header>
              <s-table-header format="numeric">Treatment conv.</s-table-header>
              <s-table-header format="numeric">Lift</s-table-header>
              <s-table-header>Preview</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {experiments.filter(matchesFilter).map((exp) => {
                const isDeletable = true;
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
                        {formatStatus(exp.status)}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>{titleCase(exp.pageType)}</s-table-cell>
                    <s-table-cell>
                      {exp.segment?.deviceType ? titleCase(exp.segment.deviceType) : "All"}
                    </s-table-cell>
                    <s-table-cell>
                      {exp.segment?.visitorType
                        ? titleCase(exp.segment.visitorType) + " visitors"
                        : exp.segment?.trafficSource
                        ? titleCase(exp.segment.trafficSource) + " traffic"
                        : "All"}
                    </s-table-cell>
                    <s-table-cell>
                      {exp.segment?.geoCountry && exp.segment.geoCountry.length > 0
                        ? exp.segment.geoCountry.join(", ")
                        : "All"}
                    </s-table-cell>
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
                      {previewUrls[exp.id]?.control || previewUrls[exp.id]?.treatment ? (
                        <span style={{ whiteSpace: "nowrap", display: "inline-flex", gap: 10 }}>
                          {previewUrls[exp.id]?.control && (
                            <a href={previewUrls[exp.id].control} target="_blank" rel="noreferrer">
                              Control ↗
                            </a>
                          )}
                          {previewUrls[exp.id]?.treatment && (
                            <a href={previewUrls[exp.id].treatment} target="_blank" rel="noreferrer">
                              Variant ↗
                            </a>
                          )}
                        </span>
                      ) : (
                        "—"
                      )}
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
                  <s-badge>{formatStatus(log.status)}</s-badge>
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

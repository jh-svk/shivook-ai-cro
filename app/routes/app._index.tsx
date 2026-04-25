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
    const experiments = await prisma.experiment.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "desc" },
      include: { result: true },
    });
    return { experiments };
  } catch (error) {
    console.error("[app._index] failed to load experiments", error);
    return {
      experiments: [] as Awaited<
        ReturnType<
          typeof prisma.experiment.findMany<{ include: { result: true } }>
        >
      >,
    };
  }
};

export default function ExperimentsIndex() {
  const { experiments } = useLoaderData<typeof loader>();

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
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

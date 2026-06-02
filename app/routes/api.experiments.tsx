import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { verifyProxySignature } from "../../lib/proxy.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (!verifyProxySignature(url.searchParams)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopDomain = url.searchParams.get("shop");
  const pageType = url.searchParams.get("pageType") ?? "";
  const isPreview = url.searchParams.get("preview") === "1";

  if (!shopDomain) {
    return Response.json({ error: "Missing shop parameter" }, { status: 400 });
  }

  try {
    const shop = await prisma.shop.findUnique({
      where: { shopifyDomain: shopDomain },
    });

    if (!shop) {
      return Response.json({ experiments: [] }, { status: 200 });
    }

    const statusFilter = isPreview
      ? { in: ["active", "paused", "draft", "pending_approval"] }
      : { equals: "active" };

    const experiments = await prisma.experiment.findMany({
      where: {
        shopId: shop.id,
        status: statusFilter,
        OR: [{ pageType }, { pageType: "any" }],
      },
      select: {
        id: true,
        trafficSplit: true,
        segment: {
          select: {
            deviceType: true,
            geoCountry: true,
            trafficSource: true,
            visitorType: true,
            timeOfDayFrom: true,
            timeOfDayTo: true,
            dayOfWeek: true,
            productCategory: true,
            cartState: true,
          },
        },
        variants: {
          select: {
            id: true,
            type: true,
            htmlPatch: true,
            cssPatch: true,
            jsPatch: true,
          },
        },
      },
    });

    // All currently-active experiments (lightweight) so the storefront can
    // enforce one-test-per-visitor across overlapping segments — and release a
    // visitor whose enrolled test has concluded. Not needed in preview mode.
    const allActive = isPreview
      ? []
      : await prisma.experiment.findMany({
          where: { shopId: shop.id, status: "active" },
          select: {
            id: true,
            pageType: true,
            segment: {
              select: {
                deviceType: true,
                geoCountry: true,
                trafficSource: true,
                visitorType: true,
                timeOfDayFrom: true,
                timeOfDayTo: true,
                dayOfWeek: true,
                productCategory: true,
                cartState: true,
              },
            },
          },
        });

    return Response.json(
      { experiments, allActive },
      {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("[api.experiments] error", error);
    return Response.json({ experiments: [] }, { status: 200 });
  }
};

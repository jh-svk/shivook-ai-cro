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

    const experiments = await prisma.experiment.findMany({
      where: {
        shopId: shop.id,
        status: "active",
        OR: [{ pageType }, { pageType: "any" }],
      },
      select: {
        id: true,
        trafficSplit: true,
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

    return Response.json(
      { experiments },
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

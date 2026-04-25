import prisma from "../app/db.server";

export async function findOrCreateShop(shopDomain: string, accessToken: string) {
  return prisma.shop.upsert({
    where: { shopifyDomain: shopDomain },
    create: { shopifyDomain: shopDomain, accessToken },
    update: { accessToken },
  });
}

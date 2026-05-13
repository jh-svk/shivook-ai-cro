import prisma from "../app/db.server";
import { encrypt, decrypt } from "./crypto.server";

export async function findOrCreateShop(shopDomain: string, accessToken: string) {
  const encryptedToken = encrypt(accessToken);
  return prisma.shop.upsert({
    where: { shopifyDomain: shopDomain },
    create: { shopifyDomain: shopDomain, accessToken: encryptedToken },
    update: { accessToken: encryptedToken },
  });
}

export function decryptShopToken(shop: { accessToken: string }): string {
  return decrypt(shop.accessToken);
}

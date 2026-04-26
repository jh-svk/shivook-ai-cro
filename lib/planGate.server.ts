import prisma from "../app/db.server";
import { PLANS } from "./plans";

export { PLANS };
export type PlanHandle = "starter" | "growth" | "pro" | "trial" | "none";
type FeatureKey = "ai_hypotheses" | "auto_build" | "orchestrator";

const FEATURE_PLANS: Record<FeatureKey, PlanHandle[]> = {
  ai_hypotheses: ["growth", "pro", "trial"],
  auto_build:    ["pro"],
  orchestrator:  ["pro"],
};

const PLAN_LIMITS: Record<PlanHandle, number> = {
  starter: 5,
  growth:  10,
  pro:     20,
  trial:   5,
  none:    0,
};

export async function getShopPlan(shopId: string): Promise<PlanHandle> {
  const sub = await prisma.subscription.findUnique({ where: { shopId } });
  if (!sub) return "none";
  if (sub.status === "cancelled" || sub.status === "frozen") return "none";
  if (sub.trialEndsAt && sub.trialEndsAt > new Date() && sub.status === "active") return "trial";
  if (sub.status === "active" || sub.status === "pending") {
    return sub.plan as PlanHandle;
  }
  return "none";
}

export async function getPlanConcurrentLimit(shopId: string): Promise<number> {
  const plan = await getShopPlan(shopId);
  return PLAN_LIMITS[plan];
}

export async function hasPlanFeature(shopId: string, feature: FeatureKey): Promise<boolean> {
  const plan = await getShopPlan(shopId);
  return FEATURE_PLANS[feature].includes(plan);
}

export async function assertPlanFeature(shopId: string, feature: FeatureKey): Promise<void> {
  const allowed = await hasPlanFeature(shopId, feature);
  if (!allowed) {
    throw new Response(`Feature '${feature}' requires an upgraded plan.`, { status: 403 });
  }
}

export async function getSubscriptionStatus(
  shopId: string
): Promise<{ plan: PlanHandle; trialDaysLeft: number | null; hasSubscription: boolean }> {
  const sub = await prisma.subscription.findUnique({ where: { shopId } });
  const plan = await getShopPlan(shopId);

  let trialDaysLeft: number | null = null;
  if (sub?.trialEndsAt && sub.trialEndsAt > new Date()) {
    trialDaysLeft = Math.ceil((sub.trialEndsAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  }

  return {
    plan,
    trialDaysLeft,
    hasSubscription: !!sub && sub.status !== "cancelled",
  };
}

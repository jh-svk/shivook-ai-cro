export const PLANS = {
  starter: { name: "Starter",  price: 39,  concurrentTests: 5  },
  growth:  { name: "Growth",   price: 99,  concurrentTests: 10 },
  pro:     { name: "Pro",      price: 199, concurrentTests: 20 },
} as const;

export type PlanKey = keyof typeof PLANS;

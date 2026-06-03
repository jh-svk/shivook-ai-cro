/**
 * Bayesian stats engine — Phase 2.
 *
 * Uses Beta-Binomial conjugate model:
 *   Prior:     Beta(1, 1)  — uniform, non-informative
 *   Posterior: Beta(1 + conversions, 1 + visitors - conversions)
 *
 * P(treatment beats control) is estimated via Monte Carlo over the two
 * posterior distributions.  10 000 samples gives ±1% accuracy which is
 * more than sufficient for CRO decisions.
 *
 * Phase 3 swap point: replace probToBeatControl with a closed-form
 * calculation using the regularised incomplete beta function if you need
 * sub-millisecond performance at high sample counts.
 */

export interface VariantStats {
  visitors: number;
  conversions: number;
}

export interface StatsResult {
  controlConversionRate: number;
  treatmentConversionRate: number;
  relativeLift: number | null;
  /** Null in Bayesian mode — kept for schema compatibility. */
  pValue: null;
  /** True when probToBeatControl >= 0.95. */
  isSignificant: boolean;
  /** P(treatment conversion rate > control conversion rate). */
  probToBeatControl: number | null;
  /** 95% credible interval lower bound on the treatment lift. */
  credibleIntervalLower: number | null;
  /** 95% credible interval upper bound on the treatment lift. */
  credibleIntervalUpper: number | null;
}

const SAMPLES = 10_000;
const SIGNIFICANCE_THRESHOLD = 0.95;

// ── Beta distribution sampler (Gamma-ratio method) ──────────────────────────

function sampleGamma(shape: number): number {
  // Marsaglia–Tsang "squeeze" method for shape >= 1.
  // For shape < 1: use the Ahrens–Dieter transformation.
  if (shape < 1) {
    return sampleGamma(1 + shape) * Math.random() ** (1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = randNorm();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function randNorm(): number {
  // Box-Muller
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  return x / (x + y);
}

// ── Main export ──────────────────────────────────────────────────────────────

export function computeStats(
  control: VariantStats,
  treatment: VariantStats
): StatsResult {
  const controlRate =
    control.visitors > 0 ? control.conversions / control.visitors : 0;
  const treatmentRate =
    treatment.visitors > 0 ? treatment.conversions / treatment.visitors : 0;

  const relativeLift =
    controlRate > 0 ? (treatmentRate - controlRate) / controlRate : null;

  if (control.visitors === 0 || treatment.visitors === 0) {
    return {
      controlConversionRate: controlRate,
      treatmentConversionRate: treatmentRate,
      relativeLift,
      pValue: null,
      isSignificant: false,
      probToBeatControl: null,
      credibleIntervalLower: null,
      credibleIntervalUpper: null,
    };
  }

  // Beta posteriors: Beta(1 + conversions, 1 + non-conversions)
  const ctrlAlpha = 1 + control.conversions;
  const ctrlBeta = 1 + (control.visitors - control.conversions);
  const trtAlpha = 1 + treatment.conversions;
  const trtBeta = 1 + (treatment.visitors - treatment.conversions);

  // Monte Carlo
  let wins = 0;
  const lifts: number[] = new Array(SAMPLES);

  for (let i = 0; i < SAMPLES; i++) {
    const c = sampleBeta(ctrlAlpha, ctrlBeta);
    const t = sampleBeta(trtAlpha, trtBeta);
    if (t > c) wins++;
    lifts[i] = c > 0 ? (t - c) / c : 0;
  }

  const probToBeatControl = wins / SAMPLES;

  // 95% credible interval on relative lift
  lifts.sort((a, b) => a - b);
  const lo = Math.floor(0.025 * SAMPLES);
  const hi = Math.floor(0.975 * SAMPLES);
  const credibleIntervalLower = lifts[lo];
  const credibleIntervalUpper = lifts[hi];

  return {
    controlConversionRate: controlRate,
    treatmentConversionRate: treatmentRate,
    relativeLift,
    pValue: null,
    isSignificant: probToBeatControl >= SIGNIFICANCE_THRESHOLD,
    probToBeatControl,
    credibleIntervalLower,
    credibleIntervalUpper,
  };
}

// ── Frequentist p-value helpers (supplementary per-metric signals) ────────────

/** Abramowitz & Stegun normal CDF approximation (error < 7.5e-8). */
function normalCdf(z: number): number {
  if (z < 0) return 1 - normalCdf(-z);
  const t = 1 / (1 + 0.2316419 * z);
  const poly =
    t * (0.319381530 +
    t * (-0.356563782 +
    t * (1.781477937 +
    t * (-1.821255978 +
    t * 1.330274429))));
  return 1 - 0.39894228 * Math.exp(-0.5 * z * z) * poly;
}

/**
 * Two-proportion z-test, two-tailed.
 * n1/n2: sample sizes, p1/p2: observed proportions (0–1).
 * Returns null when sample is too small (< 10) or edge-case proportions.
 */
export function proportionPValue(
  n1: number, p1: number,
  n2: number, p2: number
): number | null {
  if (n1 < 10 || n2 < 10) return null;
  const pPool = (p1 * n1 + p2 * n2) / (n1 + n2);
  if (pPool <= 0 || pPool >= 1) return null;
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (se === 0) return null;
  const z = Math.abs((p2 - p1) / se);
  return 2 * (1 - normalCdf(z));
}

/**
 * Poisson rate test — used for revenue-per-visitor and AOV where we don't
 * have per-order variance. Treats variance ≈ mean (Poisson assumption).
 * n1/n2: denominators (visitors or purchases), r1/r2: rates (revenue/n).
 * Returns null when sample is too small (< 10).
 */
export function poissonRatePValue(
  n1: number, r1: number,
  n2: number, r2: number
): number | null {
  if (n1 < 10 || n2 < 10) return null;
  const se = Math.sqrt(r1 / n1 + r2 / n2);
  if (se === 0) return null;
  const z = Math.abs((r2 - r1) / se);
  return 2 * (1 - normalCdf(z));
}

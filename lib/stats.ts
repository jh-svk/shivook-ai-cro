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

// ── Multi-arm (A/B/n) Bayesian engine ────────────────────────────────────────

export interface MultiArmStat {
  /** Point-estimate conversion rate. */
  conversionRate: number;
  /** Relative lift vs control (null on the control row, or when control rate is 0). */
  relativeLift: number | null;
  /** Pairwise P(this arm > control). Null on the control row, or in degenerate cases. */
  probToBeatControl: number | null;
  /** Joint P(this arm is the best of ALL arms, control included). 0 in degenerate cases. */
  probBestArm: number;
  /** 95% credible interval on relative lift vs control (treatments only). */
  credibleIntervalLower: number | null;
  credibleIntervalUpper: number | null;
}

export interface MultiArmResult {
  /** arms[0] is the control; arms[1..] are the treatments in input order. */
  arms: MultiArmStat[];
  /** Index into `arms` of the highest probBestArm (0 = control wins). */
  bestArmIndex: number;
  /**
   * True when some TREATMENT is simultaneously the best arm and beats control,
   * both at the 95% threshold. This Bayesian joint-probability framing IS the
   * multiple-comparison correction — do NOT bolt on Bonferroni/Šidák, which
   * would double-count the penalty already baked into probBestArm.
   */
  isSignificant: boolean;
  /** Index into `arms` of the winning treatment when isSignificant, else null. */
  winningArmIndex: number | null;
}

/**
 * N-arm Beta-Binomial / Monte-Carlo engine. Each iteration draws one posterior
 * sample per arm at once, so a single pass yields both the pairwise
 * P(arm > control) and the joint P(arm is best of the field).
 */
export function computeMultiArmStats(
  control: VariantStats,
  treatments: VariantStats[],
): MultiArmResult {
  const all = [control, ...treatments];
  const rate = (v: VariantStats) => (v.visitors > 0 ? v.conversions / v.visitors : 0);
  const controlRate = rate(control);

  const degenerate =
    control.visitors === 0 || treatments.some((t) => t.visitors === 0);

  if (degenerate) {
    return {
      arms: all.map((v, i) => ({
        conversionRate: rate(v),
        relativeLift:
          i === 0 || controlRate === 0 ? null : (rate(v) - controlRate) / controlRate,
        probToBeatControl: null,
        probBestArm: 0,
        credibleIntervalLower: null,
        credibleIntervalUpper: null,
      })),
      bestArmIndex: 0,
      isSignificant: false,
      winningArmIndex: null,
    };
  }

  // Beta posteriors per arm: Beta(1 + conversions, 1 + non-conversions)
  const alphas = all.map((v) => 1 + v.conversions);
  const betas = all.map((v) => 1 + (v.visitors - v.conversions));

  const bestWins = new Array(all.length).fill(0);
  const beatControlWins = new Array(all.length).fill(0);
  // Per-arm lift samples (index 0 = control, unused).
  const liftSamples: number[][] = all.map(() => []);

  for (let i = 0; i < SAMPLES; i++) {
    let bestArm = 0;
    let bestDraw = -1;
    const draws = new Array(all.length);
    for (let a = 0; a < all.length; a++) {
      const d = sampleBeta(alphas[a], betas[a]);
      draws[a] = d;
      if (d > bestDraw) { bestDraw = d; bestArm = a; }
    }
    bestWins[bestArm]++;

    const c = draws[0];
    for (let a = 1; a < all.length; a++) {
      if (draws[a] > c) beatControlWins[a]++;
      liftSamples[a].push(c > 0 ? (draws[a] - c) / c : 0);
    }
  }

  const lo = Math.floor(0.025 * SAMPLES);
  const hi = Math.floor(0.975 * SAMPLES);

  const arms: MultiArmStat[] = all.map((v, a) => {
    if (a === 0) {
      return {
        conversionRate: controlRate,
        relativeLift: null,
        probToBeatControl: null,
        probBestArm: bestWins[0] / SAMPLES,
        credibleIntervalLower: null,
        credibleIntervalUpper: null,
      };
    }
    const sorted = liftSamples[a].slice().sort((x, y) => x - y);
    return {
      conversionRate: rate(v),
      relativeLift: controlRate > 0 ? (rate(v) - controlRate) / controlRate : null,
      probToBeatControl: beatControlWins[a] / SAMPLES,
      probBestArm: bestWins[a] / SAMPLES,
      credibleIntervalLower: sorted[lo],
      credibleIntervalUpper: sorted[hi],
    };
  });

  // Best arm overall (control included).
  let bestArmIndex = 0;
  for (let a = 1; a < arms.length; a++) {
    if (arms[a].probBestArm > arms[bestArmIndex].probBestArm) bestArmIndex = a;
  }

  // A treatment wins only if it is BOTH the best arm and beats control at 95%.
  const winner =
    bestArmIndex > 0 &&
    arms[bestArmIndex].probBestArm >= SIGNIFICANCE_THRESHOLD &&
    (arms[bestArmIndex].probToBeatControl ?? 0) >= SIGNIFICANCE_THRESHOLD;

  return {
    arms,
    bestArmIndex,
    isSignificant: winner,
    winningArmIndex: winner ? bestArmIndex : null,
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

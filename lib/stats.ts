export interface VariantStats {
  visitors: number;
  conversions: number;
}

export interface StatsResult {
  controlConversionRate: number;
  treatmentConversionRate: number;
  relativeLift: number | null;
  pValue: number | null;
  isSignificant: boolean;
}

/**
 * Chi-squared p-value approximation using Wilson-Hilferty normal approximation.
 * Sufficient for 1 degree of freedom (2x2 contingency table).
 */
function chiSquaredPValue(chiSq: number): number {
  if (chiSq <= 0) return 1;
  // Normal approximation: z = sqrt(2*chiSq) - sqrt(2*df - 1), df=1
  const z = Math.sqrt(2 * chiSq) - Math.sqrt(1);
  return 1 - standardNormalCDF(z);
}

function standardNormalCDF(z: number): number {
  const t = 1 / (1 + 0.2315419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return z > 0 ? 1 - p : p;
}

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
    };
  }

  const total = control.visitors + treatment.visitors;
  const totalConversions = control.conversions + treatment.conversions;
  const expectedControl = (control.visitors * totalConversions) / total;
  const expectedTreatment = (treatment.visitors * totalConversions) / total;
  const expectedControlNon =
    (control.visitors * (total - totalConversions)) / total;
  const expectedTreatmentNon =
    (treatment.visitors * (total - totalConversions)) / total;

  if (
    expectedControl === 0 ||
    expectedTreatment === 0 ||
    expectedControlNon === 0 ||
    expectedTreatmentNon === 0
  ) {
    return {
      controlConversionRate: controlRate,
      treatmentConversionRate: treatmentRate,
      relativeLift,
      pValue: null,
      isSignificant: false,
    };
  }

  const chiSq =
    Math.pow(control.conversions - expectedControl, 2) / expectedControl +
    Math.pow(treatment.conversions - expectedTreatment, 2) / expectedTreatment +
    Math.pow(
      control.visitors - control.conversions - expectedControlNon,
      2
    ) /
      expectedControlNon +
    Math.pow(
      treatment.visitors - treatment.conversions - expectedTreatmentNon,
      2
    ) /
      expectedTreatmentNon;

  const pValue = chiSquaredPValue(chiSq);

  return {
    controlConversionRate: controlRate,
    treatmentConversionRate: treatmentRate,
    relativeLift,
    pValue,
    isSignificant: pValue < 0.05,
  };
}

/**
 * RF exposure estimate: a far field power density from a transmitter's
 * radiated power and a distance, compared against the FCC maximum permissible
 * exposure limit (47 CFR 1.1310) and the routine evaluation exemption
 * (47 CFR 1.1307(b)). Pure math over the tables in rules.ts.
 *
 * This is an educational estimate, not a compliance evaluation. The far field
 * formula ignores ground reflection, antenna pattern, near field behavior and
 * everything else a real evaluation accounts for. The panel says so on screen.
 */

import { C } from "./data";
import {
  exemptionThresholdAt,
  isExemptFromEvaluation,
  mpeAt,
  type ExemptionResult,
  type MpeEnvironment,
  type MpeResult,
} from "./rules";

/** How the visitor states the transmitter's power. */
export type PowerKind = "eirp" | "erp" | "tx";

/** Gain of a half wave dipole over isotropic, the ERP to EIRP factor. */
export const DIPOLE_GAIN_LINEAR = 1.64;
export const DIPOLE_GAIN_DBI = 2.15;

export interface ExposureInput {
  freqHz: number;
  /** Power in watts, interpreted per `powerKind`. */
  powerW: number;
  powerKind: PowerKind;
  /** Antenna gain in dBi, used only when powerKind is "tx". */
  gainDbi?: number;
  /** Closest approach to the antenna, in meters. */
  distanceM: number;
  environment: MpeEnvironment;
  /** Fraction of time transmitting, 0 to 1. Defaults to 1 (continuous). */
  dutyCycle?: number;
}

export interface ExposureEstimate {
  eirpW: number;
  erpW: number;
  /** Time averaged EIRP after the duty cycle. */
  averagedEirpW: number;
  wavelengthM: number;
  /** Estimated power density at the distance, in mW/cm2 and W/m2. */
  powerDensityMwCm2: number;
  powerDensityWm2: number;
  /** The FCC limit at this frequency, or null outside 300 kHz to 100 GHz. */
  limit: MpeResult | null;
  /** Estimate as a percentage of the limit, or null with no limit. */
  percentOfLimit: number | null;
  /** True when the estimate is at or under the limit; null with no limit. */
  pass: boolean | null;
  /** Distance at which the estimate meets the limit, or null with no limit. */
  complianceDistanceM: number | null;
  /** True when the distance is inside the reactive near field (under lambda over 2 pi). */
  nearField: boolean;
  /** The routine evaluation exemption threshold for a single source. */
  exemption: ExemptionResult | null;
  /** True when this source is exempt from a routine evaluation. */
  exempt: boolean;
  /** The assumptions behind the number, for display beside it. */
  assumptions: string[];
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 10);
}

/** EIRP in watts from the stated power. */
export function toEirpWatts(powerW: number, kind: PowerKind, gainDbi = 0): number {
  switch (kind) {
    case "eirp":
      return powerW;
    case "erp":
      return powerW * DIPOLE_GAIN_LINEAR;
    case "tx":
      return powerW * dbToLinear(gainDbi);
  }
}

/** Far field power density in W/m2 from EIRP and distance. */
export function farFieldPowerDensityWm2(eirpW: number, distanceM: number): number {
  return eirpW / (4 * Math.PI * distanceM * distanceM);
}

/** Distance in meters at which EIRP produces a given power density in W/m2. */
export function distanceForPowerDensity(eirpW: number, limitWm2: number): number {
  return Math.sqrt(eirpW / (4 * Math.PI * limitWm2));
}

/**
 * Estimate the exposure for one transmitter. Returns null for inputs that
 * cannot produce a number (non positive power or distance, bad frequency).
 */
export function estimateExposure(input: ExposureInput): ExposureEstimate | null {
  const { freqHz, powerW, powerKind, distanceM, environment } = input;
  const gainDbi = Number.isFinite(input.gainDbi) ? (input.gainDbi as number) : 0;
  const duty = Math.min(1, Math.max(0, input.dutyCycle ?? 1));
  if (!Number.isFinite(freqHz) || freqHz <= 0) return null;
  if (!Number.isFinite(powerW) || powerW <= 0) return null;
  if (!Number.isFinite(distanceM) || distanceM <= 0) return null;

  const eirpW = toEirpWatts(powerW, powerKind, gainDbi);
  const erpW = eirpW / DIPOLE_GAIN_LINEAR;
  const averagedEirpW = eirpW * duty;
  const wavelengthM = C / freqHz;
  const powerDensityWm2 = farFieldPowerDensityWm2(averagedEirpW, distanceM);
  const powerDensityMwCm2 = powerDensityWm2 / 10;

  const limit = mpeAt(freqHz, environment);
  const percentOfLimit = limit ? (powerDensityMwCm2 / limit.powerDensityMwCm2) * 100 : null;
  const pass = percentOfLimit === null ? null : percentOfLimit <= 100;
  const complianceDistanceM =
    limit && averagedEirpW > 0
      ? distanceForPowerDensity(averagedEirpW, limit.powerDensityWm2)
      : null;

  const nearField = distanceM < wavelengthM / (2 * Math.PI);
  const exemption = exemptionThresholdAt(freqHz, distanceM);
  const exempt = isExemptFromEvaluation(freqHz, erpW * duty, distanceM);

  const assumptions = [
    "Far field power density S = EIRP / (4 pi R^2), with no ground reflection, so real values near the ground can be up to four times higher.",
    powerKind === "erp"
      ? "ERP was converted to EIRP by multiplying by 1.64 (a half wave dipole is 2.15 dBi)."
      : powerKind === "tx"
        ? `Transmitter power was multiplied by the antenna gain of ${gainDbi} dBi; feedline loss is not subtracted.`
        : "EIRP was used as entered.",
    duty < 1
      ? `Power was time averaged with a ${Math.round(duty * 100)}% duty cycle. The FCC averages over ${limit ? limit.averagingMinutes : 6} minutes.`
      : "Continuous transmission was assumed (100% duty cycle).",
    "The antenna is treated as a point source radiating its EIRP toward the person, which is the worst case direction.",
  ];
  if (nearField) {
    assumptions.push(
      "The distance is inside the reactive near field (under one wavelength over 2 pi), where the far field formula does not apply and field strength, not power density, is what the rule limits.",
    );
  }

  return {
    eirpW,
    erpW,
    averagedEirpW,
    wavelengthM,
    powerDensityMwCm2,
    powerDensityWm2,
    limit,
    percentOfLimit,
    pass,
    complianceDistanceM,
    nearField,
    exemption,
    exempt,
    assumptions,
  };
}

/** Format a power density with a sensible unit prefix. */
export function formatPowerDensity(mwCm2: number): string {
  if (!Number.isFinite(mwCm2)) return "n/a";
  if (mwCm2 >= 1) return `${trim(mwCm2, 3)} mW/cm2`;
  if (mwCm2 >= 1e-3) return `${trim(mwCm2 * 1e3, 3)} uW/cm2`;
  return `${trim(mwCm2 * 1e6, 3)} nW/cm2`;
}

/** Format watts with a prefix. */
export function formatWatts(w: number): string {
  if (!Number.isFinite(w)) return "n/a";
  if (w >= 1e3) return `${trim(w / 1e3, 3)} kW`;
  if (w >= 1) return `${trim(w, 3)} W`;
  if (w >= 1e-3) return `${trim(w * 1e3, 3)} mW`;
  return `${trim(w * 1e6, 3)} uW`;
}

/** Format meters, switching to centimeters and kilometers when it reads better. */
export function formatMeters(m: number): string {
  if (!Number.isFinite(m)) return "n/a";
  if (m >= 1e3) return `${trim(m / 1e3, 3)} km`;
  if (m >= 1) return `${trim(m, 3)} m`;
  if (m >= 1e-2) return `${trim(m * 100, 3)} cm`;
  return `${trim(m * 1e3, 3)} mm`;
}

function trim(value: number, digits: number): string {
  return Number(value.toPrecision(digits)).toString();
}

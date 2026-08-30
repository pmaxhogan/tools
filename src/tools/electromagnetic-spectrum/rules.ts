/**
 * FCC radio frequency exposure limits, as pure data plus pure evaluators.
 *
 * Two independent regulatory pieces live here:
 *
 *   1. The maximum permissible exposure (MPE) limits of 47 CFR 1.1310, which
 *      say how strong a field a person may stand in.
 *   2. The routine evaluation exemption thresholds of 47 CFR 1.1307(b), the
 *      2019 rules that replaced the old service by service categorical
 *      exclusions and that every amateur station now has to work through.
 *
 * This module imports nothing and touches nothing. `allocations.ts` re-exports
 * everything here so callers have a single entry point.
 *
 * Source: 47 CFR 1.1310 and 47 CFR 1.1307(b), retrieved 2026-08-30 from the
 * Cornell Legal Information Institute mirror of the Code of Federal
 * Regulations (https://www.law.cornell.edu/cfr/text/47/1.1310 and
 * https://www.law.cornell.edu/cfr/text/47/1.1307).
 *
 * This is an educational summary. The Code of Federal Regulations governs.
 */

/** Which of the two exposure populations a limit applies to. */
export type MpeEnvironment = "controlled" | "uncontrolled";

/** One row of the 47 CFR 1.1310 Table 1 limits. */
export interface MpeSegment {
  /** Which population this row limits. */
  environment: MpeEnvironment;
  /** Lower edge of the row, in hertz (inclusive). */
  lowHz: number;
  /** Upper edge of the row, in hertz (exclusive, except the very top row). */
  highHz: number;
  /** Electric field limit in volts per meter, as a function of frequency in MHz. */
  electricFieldVm: (freqMHz: number) => number;
  /** Magnetic field limit in amperes per meter, or null where the table has none. */
  magneticFieldAm: ((freqMHz: number) => number) | null;
  /** Power density limit in milliwatts per square centimeter. */
  powerDensityMwCm2: (freqMHz: number) => number;
  /**
   * True where the printed power density is a plane wave equivalent value
   * (the asterisked rows below 30 MHz), which is informational rather than a
   * separate limit you can measure directly in the near field.
   */
  planeWaveEquivalent: boolean;
  /** Averaging time in minutes. */
  averagingMinutes: number;
  /** The formula as printed in the CFR, for display. */
  formula: string;
}

/**
 * The impedance of free space, in ohms, used only to restate a power density
 * limit as an equivalent far field electric field. 377 ohms times 10 gives the
 * conversion from mW/cm2 to V/m squared.
 */
const FREE_SPACE_IMPEDANCE_X10 = 3770;

/**
 * 47 CFR 1.1310 Table 1, part (A): occupational / controlled exposure.
 * f is frequency in megahertz throughout.
 */
const CONTROLLED: MpeSegment[] = [
  {
    environment: "controlled",
    lowHz: 300_000,
    highHz: 3_000_000,
    electricFieldVm: () => 614,
    magneticFieldAm: () => 1.63,
    powerDensityMwCm2: () => 100,
    planeWaveEquivalent: true,
    averagingMinutes: 6,
    formula: "E = 614 V/m, H = 1.63 A/m, plane wave equivalent 100 mW/cm2",
  },
  {
    environment: "controlled",
    lowHz: 3_000_000,
    highHz: 30_000_000,
    electricFieldVm: (f) => 1842 / f,
    magneticFieldAm: (f) => 4.89 / f,
    powerDensityMwCm2: (f) => 900 / (f * f),
    planeWaveEquivalent: true,
    averagingMinutes: 6,
    formula: "E = 1842/f V/m, H = 4.89/f A/m, plane wave equivalent 900/f^2 mW/cm2",
  },
  {
    environment: "controlled",
    lowHz: 30_000_000,
    highHz: 300_000_000,
    electricFieldVm: () => 61.4,
    magneticFieldAm: () => 0.163,
    powerDensityMwCm2: () => 1,
    planeWaveEquivalent: false,
    averagingMinutes: 6,
    formula: "E = 61.4 V/m, H = 0.163 A/m, S = 1.0 mW/cm2",
  },
  {
    environment: "controlled",
    lowHz: 300_000_000,
    highHz: 1_500_000_000,
    electricFieldVm: (f) => Math.sqrt((f / 300) * FREE_SPACE_IMPEDANCE_X10),
    magneticFieldAm: null,
    powerDensityMwCm2: (f) => f / 300,
    planeWaveEquivalent: false,
    averagingMinutes: 6,
    formula: "S = f/300 mW/cm2",
  },
  {
    environment: "controlled",
    lowHz: 1_500_000_000,
    highHz: 100_000_000_000,
    electricFieldVm: () => Math.sqrt(5 * FREE_SPACE_IMPEDANCE_X10),
    magneticFieldAm: null,
    powerDensityMwCm2: () => 5,
    planeWaveEquivalent: false,
    averagingMinutes: 6,
    formula: "S = 5 mW/cm2",
  },
];

/**
 * 47 CFR 1.1310 Table 1, part (B): general population / uncontrolled exposure.
 * Note the first break is at 1.34 MHz, not 3 MHz, so the two halves of the
 * table do not share their boundaries.
 */
const UNCONTROLLED: MpeSegment[] = [
  {
    environment: "uncontrolled",
    lowHz: 300_000,
    highHz: 1_340_000,
    electricFieldVm: () => 614,
    magneticFieldAm: () => 1.63,
    powerDensityMwCm2: () => 100,
    planeWaveEquivalent: true,
    averagingMinutes: 30,
    formula: "E = 614 V/m, H = 1.63 A/m, plane wave equivalent 100 mW/cm2",
  },
  {
    environment: "uncontrolled",
    lowHz: 1_340_000,
    highHz: 30_000_000,
    electricFieldVm: (f) => 824 / f,
    magneticFieldAm: (f) => 2.19 / f,
    powerDensityMwCm2: (f) => 180 / (f * f),
    planeWaveEquivalent: true,
    averagingMinutes: 30,
    formula: "E = 824/f V/m, H = 2.19/f A/m, plane wave equivalent 180/f^2 mW/cm2",
  },
  {
    environment: "uncontrolled",
    lowHz: 30_000_000,
    highHz: 300_000_000,
    electricFieldVm: () => 27.5,
    magneticFieldAm: () => 0.073,
    powerDensityMwCm2: () => 0.2,
    planeWaveEquivalent: false,
    averagingMinutes: 30,
    formula: "E = 27.5 V/m, H = 0.073 A/m, S = 0.2 mW/cm2",
  },
  {
    environment: "uncontrolled",
    lowHz: 300_000_000,
    highHz: 1_500_000_000,
    electricFieldVm: (f) => Math.sqrt((f / 1500) * FREE_SPACE_IMPEDANCE_X10),
    magneticFieldAm: null,
    powerDensityMwCm2: (f) => f / 1500,
    planeWaveEquivalent: false,
    averagingMinutes: 30,
    formula: "S = f/1500 mW/cm2",
  },
  {
    environment: "uncontrolled",
    lowHz: 1_500_000_000,
    highHz: 100_000_000_000,
    electricFieldVm: () => Math.sqrt(1 * FREE_SPACE_IMPEDANCE_X10),
    magneticFieldAm: null,
    powerDensityMwCm2: () => 1,
    planeWaveEquivalent: false,
    averagingMinutes: 30,
    formula: "S = 1.0 mW/cm2",
  },
];

/** One row of the 47 CFR 1.1307(b)(3)(i)(C) exemption threshold table. */
export interface ExemptionThresholdSegment {
  lowHz: number;
  highHz: number;
  /** Threshold effective radiated power in watts, given R in meters and f in MHz. */
  thresholdErpWatts: (separationM: number, freqMHz: number) => number;
  /** The formula as printed in the CFR, for display. */
  formula: string;
}

/**
 * 47 CFR 1.1307(b)(3)(i)(C), Table 1. R is the minimum separation distance in
 * meters between the radiating structure and any person, f is frequency in
 * megahertz, and the result is a threshold effective radiated power in watts.
 * A single transmitter at or below the threshold is exempt from a routine
 * evaluation.
 */
const EXEMPTION_THRESHOLDS: ExemptionThresholdSegment[] = [
  {
    lowHz: 300_000,
    highHz: 1_340_000,
    thresholdErpWatts: (r) => 1920 * r * r,
    formula: "1920 * R^2 watts",
  },
  {
    lowHz: 1_340_000,
    highHz: 30_000_000,
    thresholdErpWatts: (r, f) => (3450 * r * r) / (f * f),
    formula: "3450 * R^2 / f^2 watts",
  },
  {
    lowHz: 30_000_000,
    highHz: 300_000_000,
    thresholdErpWatts: (r) => 3.83 * r * r,
    formula: "3.83 * R^2 watts",
  },
  {
    lowHz: 300_000_000,
    highHz: 1_500_000_000,
    thresholdErpWatts: (r, f) => 0.0128 * r * r * f,
    formula: "0.0128 * R^2 * f watts",
  },
  {
    lowHz: 1_500_000_000,
    highHz: 100_000_000_000,
    thresholdErpWatts: (r) => 19.2 * r * r,
    formula: "19.2 * R^2 watts",
  },
];

/** Speed of light in vacuum, meters per second, for the lambda over 2 pi floor. */
const C_MPS = 299_792_458;

/**
 * The whole RF exposure dataset in one object, so a panel can render the two
 * MPE tables and the exemption table without reaching for three exports.
 */
export const RF_EXPOSURE = {
  /** The 47 CFR 1.1310 maximum permissible exposure rows, both populations. */
  limits: [...CONTROLLED, ...UNCONTROLLED] as MpeSegment[],
  /** The 47 CFR 1.1307(b)(3)(i)(C) routine evaluation exemption thresholds. */
  exemptionThresholds: EXEMPTION_THRESHOLDS,
  /** The flat exemption that needs no arithmetic at all, in milliwatts. */
  alwaysExemptMilliwatts: 1,
  /** Plain English notes a station operator actually needs. */
  notes: [
    "Controlled exposure covers people who know they are being exposed and can act to limit it, such as the operator and the operator's household. Uncontrolled exposure covers everybody else, including neighbors and passers by.",
    "Limits are averaged over time: 6 minutes for controlled exposure, 30 minutes for uncontrolled exposure. A low duty cycle mode such as CW or SSB therefore buys real headroom over a constant carrier.",
    "Below 30 MHz the printed power density is a plane wave equivalent figure. Close to an antenna at those frequencies the electric and magnetic field limits are the ones that bind.",
    "Since 3 May 2021 every amateur station must either qualify for an exemption or perform and keep a routine RF exposure evaluation. There is no longer a blanket power based exclusion for amateur stations.",
    "A single source of 1 mW or less is exempt at any distance. Above that, compare effective radiated power against the threshold for your band and your minimum separation distance.",
  ],
  source:
    "47 CFR 1.1310 and 47 CFR 1.1307(b), retrieved 2026-08-30 from https://www.law.cornell.edu/cfr/text/47/1.1310 and https://www.law.cornell.edu/cfr/text/47/1.1307",
} as const;

/** What `mpeAt` returns: the evaluated limit at one frequency. */
export interface MpeResult {
  freqHz: number;
  environment: MpeEnvironment;
  /** The matched row edges, in hertz. */
  lowHz: number;
  highHz: number;
  /** Electric field limit, volts per meter. */
  electricFieldVm: number;
  /** Magnetic field limit, amperes per meter, or null where the row has none. */
  magneticFieldAm: number | null;
  /** Power density limit, milliwatts per square centimeter. */
  powerDensityMwCm2: number;
  /** Power density limit restated in watts per square meter (1 mW/cm2 is 10 W/m2). */
  powerDensityWm2: number;
  /** True where the power density figure is plane wave equivalent only. */
  planeWaveEquivalent: boolean;
  /** Averaging time in minutes. */
  averagingMinutes: number;
  /** The CFR formula for this row. */
  formula: string;
  source: string;
}

/** Pick the row of a table that contains a frequency, top row inclusive of its edge. */
function rowAt<T extends { lowHz: number; highHz: number }>(
  rows: T[],
  freqHz: number,
): T | undefined {
  const last = rows[rows.length - 1];
  const hit = rows.find((r) => freqHz >= r.lowHz && freqHz < r.highHz);
  if (hit) return hit;
  return freqHz === last.highHz ? last : undefined;
}

/**
 * The maximum permissible exposure limit at one frequency, per 47 CFR 1.1310.
 *
 * Returns null below 300 kHz or above 100 GHz, where the FCC table simply has
 * no limit rather than an unlimited one. Rows are half open, so 30 MHz exactly
 * lands in the 30 to 300 MHz row, and the final row includes its upper edge so
 * 100 GHz exactly still resolves.
 */
export function mpeAt(
  freqHz: number,
  environment: MpeEnvironment = "uncontrolled",
): MpeResult | null {
  if (!Number.isFinite(freqHz) || freqHz <= 0) return null;
  const rows = environment === "controlled" ? CONTROLLED : UNCONTROLLED;
  const row = rowAt(rows, freqHz);
  if (!row) return null;
  const f = freqHz / 1e6;
  const powerDensityMwCm2 = row.powerDensityMwCm2(f);
  return {
    freqHz,
    environment,
    lowHz: row.lowHz,
    highHz: row.highHz,
    electricFieldVm: row.electricFieldVm(f),
    magneticFieldAm: row.magneticFieldAm ? row.magneticFieldAm(f) : null,
    powerDensityMwCm2,
    powerDensityWm2: powerDensityMwCm2 * 10,
    planeWaveEquivalent: row.planeWaveEquivalent,
    averagingMinutes: row.averagingMinutes,
    formula: row.formula,
    source: RF_EXPOSURE.source,
  };
}

/** What `exemptionThresholdAt` returns. */
export interface ExemptionResult {
  freqHz: number;
  /** The separation distance actually used, in meters, after the lambda over 2 pi floor. */
  separationM: number;
  /** The lambda over 2 pi floor for this frequency, in meters. */
  minSeparationM: number;
  /** True when the requested distance was below the floor and was raised to it. */
  clampedToMinimum: boolean;
  /** Threshold effective radiated power in watts. At or below this, one source is exempt. */
  thresholdErpWatts: number;
  /** The CFR formula for this row. */
  formula: string;
  source: string;
}

/**
 * The routine evaluation exemption threshold for a single RF source, per
 * 47 CFR 1.1307(b)(3)(i)(C).
 *
 * `separationM` is the closest a person can get to the radiating structure.
 * The rule requires R to be at least lambda over 2 pi; a smaller value is
 * raised to that floor and flagged, rather than silently producing a threshold
 * the rule does not support.
 *
 * Returns null outside 300 kHz to 100 GHz.
 */
export function exemptionThresholdAt(freqHz: number, separationM: number): ExemptionResult | null {
  if (!Number.isFinite(freqHz) || freqHz <= 0) return null;
  if (!Number.isFinite(separationM) || separationM <= 0) return null;
  const row = rowAt(EXEMPTION_THRESHOLDS, freqHz);
  if (!row) return null;
  const minSeparationM = C_MPS / freqHz / (2 * Math.PI);
  const clampedToMinimum = separationM < minSeparationM;
  const r = clampedToMinimum ? minSeparationM : separationM;
  return {
    freqHz,
    separationM: r,
    minSeparationM,
    clampedToMinimum,
    thresholdErpWatts: row.thresholdErpWatts(r, freqHz / 1e6),
    formula: row.formula,
    source: RF_EXPOSURE.source,
  };
}

/**
 * True when a single transmitter of `erpWatts` at `freqHz`, with people no
 * closer than `separationM`, is exempt from a routine RF exposure evaluation.
 *
 * Anything at or below 1 mW is exempt at any distance and any frequency.
 */
export function isExemptFromEvaluation(
  freqHz: number,
  erpWatts: number,
  separationM: number,
): boolean {
  if (!Number.isFinite(erpWatts) || erpWatts < 0) return false;
  if (erpWatts * 1000 <= RF_EXPOSURE.alwaysExemptMilliwatts) return true;
  const threshold = exemptionThresholdAt(freqHz, separationM);
  if (!threshold) return false;
  return erpWatts <= threshold.thresholdErpWatts;
}

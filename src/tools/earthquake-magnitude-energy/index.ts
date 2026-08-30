import { ToolError, type ToolLogic } from "../types";

/**
 * Earthquake magnitude, seismic moment and radiated energy.
 *
 * Moment magnitude, seismic moment, and radiated energy are three different
 * quantities related by two independent empirical/theoretical relations, not
 * one. This tool moves between all three.
 *
 * Moment magnitude (Hanks and Kanamori, 1979), M0 in newton meters:
 *
 *   log10(M0) = 1.5 Mw + 9.1
 *
 * which is the SI form of the original Kanamori (1977) definition. Seismic
 * moment is a physical quantity: fault rigidity times rupture area times
 * average slip. It is what modern "magnitude" almost always means (Mw); the
 * historical Richter local magnitude (ML) is a different, older scale, close
 * to Mw for shallow crustal earthquakes in the magnitude 3 to 7 range but not
 * identical to it.
 *
 * Radiated seismic energy (Gutenberg and Richter, 1956, restated in SI units
 * by Choy and Boatwright, 1995), E in joules:
 *
 *   log10(E) = 1.5 M + 4.8
 *
 * This has the same 1.5 slope as the moment relation, which is why a
 * one-unit increase in magnitude means both quantities grow by the same
 * factor of about 31.6 (10^1.5), and why seismic moment and radiated energy
 * are proportional to each other to within the scatter of real earthquakes,
 * not identical. Radiated energy is a small, variable fraction of the total
 * energy a fault releases; most goes to heat and permanent rock deformation.
 *
 * TNT equivalent uses 1 ton of TNT = 4.184 x 10^9 J (the conventional
 * thermochemical definition), applied to the radiated energy figure, which
 * is why an earthquake compared to nuclear weapon yields this way is really
 * being compared only on the small radiated-energy slice of its total
 * output.
 *
 * The Modified Mercalli Intensity table here is a rough correlation between
 * magnitude and the maximum intensity typically felt near the epicenter of a
 * shallow earthquake. Real intensity depends heavily on depth, distance,
 * and local geology, so this is a rule of thumb, not a substitute for a
 * ShakeMap.
 */

/** log10(M0) = 1.5 Mw + 9.1, M0 in newton meters. */
export function momentFromMagnitude(mw: number): number {
  return Math.pow(10, 1.5 * mw + 9.1);
}

/** The inverse: Mw from a seismic moment in newton meters. */
export function magnitudeFromMoment(momentNm: number): number {
  if (!(momentNm > 0))
    throw new ToolError(
      "bad-moment",
      "Seismic moment has to be greater than zero.",
      "Enter a moment in newton meters, such as 3.9e22 for a magnitude 8 earthquake.",
    );
  return (Math.log10(momentNm) - 9.1) / 1.5;
}

/** log10(E) = 1.5 M + 4.8, E in joules. */
export function energyFromMagnitude(magnitude: number): number {
  return Math.pow(10, 1.5 * magnitude + 4.8);
}

/** The inverse: magnitude from radiated energy in joules. */
export function magnitudeFromEnergy(energyJ: number): number {
  if (!(energyJ > 0))
    throw new ToolError(
      "bad-energy",
      "Radiated energy has to be greater than zero.",
      "Enter an energy in joules, such as 2e15 for a magnitude 7 earthquake.",
    );
  return (Math.log10(energyJ) - 4.8) / 1.5;
}

/** Joules per ton of TNT (thermochemical convention). */
export const JOULES_PER_TON_TNT = 4.184e9;

/** Radiated energy as tons of TNT equivalent. */
export function tntTons(energyJ: number): number {
  return energyJ / JOULES_PER_TON_TNT;
}

/** How many times more energy a magnitude m2 event radiates than m1. */
export function energyRatio(m1: number, m2: number): number {
  return Math.pow(10, 1.5 * (m2 - m1));
}

/** How many times larger the ground motion amplitude is at m2 than m1. */
export function amplitudeRatio(m1: number, m2: number): number {
  return Math.pow(10, m2 - m1);
}

export interface ReferenceEvent {
  name: string;
  magnitude: number;
}

/** A few well known earthquakes to compare against. */
export const REFERENCE_EVENTS: readonly ReferenceEvent[] = [
  { name: "2011 Tohoku, Japan", magnitude: 9.1 },
  { name: "1906 San Francisco", magnitude: 7.9 },
  { name: "1994 Northridge, California", magnitude: 6.7 },
];

interface MmiRow {
  min: number;
  numeral: string;
  label: string;
}

const MMI_TABLE: MmiRow[] = [
  { min: 8.0, numeral: "X or higher", label: "Extreme: near total destruction" },
  { min: 7.0, numeral: "VIII to IX", label: "Severe to violent: considerable damage to buildings" },
  {
    min: 6.0,
    numeral: "VII to VIII",
    label: "Very strong to severe: moderate to considerable damage",
  },
  { min: 5.0, numeral: "VI to VII", label: "Strong: felt by all, some damage" },
  { min: 4.0, numeral: "IV to V", label: "Light to moderate: felt indoors, rattling" },
  { min: 3.0, numeral: "II to III", label: "Weak: felt by some, especially upper floors" },
  { min: -Infinity, numeral: "I", label: "Not felt, or felt only by instruments" },
];

/** Rough maximum Modified Mercalli Intensity typically felt near the epicenter. */
export function mmiEstimate(magnitude: number): MmiRow {
  return MMI_TABLE.find((row) => magnitude >= row.min)!;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                           */
/* ------------------------------------------------------------------ */

function sig(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return "not a number";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1e6 || abs < 1e-3) return value.toExponential(Math.max(2, digits - 2));
  return Number(value.toPrecision(digits)).toLocaleString("en-US", {
    maximumFractionDigits: 10,
    useGrouping: true,
  });
}

function fmtTons(tons: number): string {
  if (tons >= 1e9) return `${sig(tons / 1e9)} gigatons`;
  if (tons >= 1e6) return `${sig(tons / 1e6)} megatons`;
  if (tons >= 1e3) return `${sig(tons / 1e3)} kilotons`;
  return `${sig(tons)} tons`;
}

function fmtFactor(ratio: number): string {
  if (ratio >= 1) return `${sig(ratio)} times as much`;
  return `1/${sig(1 / ratio)}, or ${sig(ratio)} times as much`;
}

/* ------------------------------------------------------------------ */
/* The tool                                                             */
/* ------------------------------------------------------------------ */

export interface EarthquakeOpts {
  mode: string; // "magnitude" | "energy" | "moment" | "compare"
  magnitude: number;
  energy: number;
  energyUnit: string; // "J" | "kt" | "Mt"
  moment: number;
  momentUnit: string; // "N-m" | "dyne-cm"
  magnitudeA: number;
  magnitudeB: number;
  [key: string]: unknown;
}

export type EarthquakeResult = Record<string, string>;

function num(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function magnitudeReport(magnitude: number): EarthquakeResult {
  const moment = momentFromMagnitude(magnitude);
  const energy = energyFromMagnitude(magnitude);
  const tons = tntTons(energy);
  const mmi = mmiEstimate(magnitude);

  const out: EarthquakeResult = {
    Magnitude: `Mw ${sig(magnitude, 4)}`,
    "Seismic moment": `${sig(moment)} N*m (${sig(moment * 1e7)} dyne*cm)`,
    "Radiated energy": `${sig(energy)} J`,
    "TNT equivalent": fmtTons(tons),
    "Typical maximum Modified Mercalli Intensity": `${mmi.numeral}: ${mmi.label}`,
  };

  for (const ref of REFERENCE_EVENTS) {
    if (Math.abs(ref.magnitude - magnitude) < 1e-9) continue;
    const ratio = energyRatio(ref.magnitude, magnitude);
    out[`Compared to ${ref.name} (Mw ${sig(ref.magnitude, 3)})`] =
      `This releases ${fmtFactor(ratio)} energy.`;
  }

  return out;
}

export function run(_input: string, opts: Partial<EarthquakeOpts> = {}): EarthquakeResult {
  const mode = String(opts.mode ?? "magnitude");

  if (mode === "compare") {
    const a = num(opts.magnitudeA, 6.0);
    const b = num(opts.magnitudeB, 7.0);
    const eRatio = energyRatio(a, b);
    const aRatio = amplitudeRatio(a, b);
    const higher = b >= a ? b : a;
    const lower = b >= a ? a : b;
    const out: EarthquakeResult = {
      "Magnitude A": `Mw ${sig(a, 4)}`,
      "Magnitude B": `Mw ${sig(b, 4)}`,
      "Energy ratio (B over A)": fmtFactor(eRatio),
      "Ground motion amplitude ratio (B over A)": fmtFactor(aRatio),
      Summary: `Magnitude ${sig(higher, 3)} releases about ${sig(energyRatio(lower, higher))} times the energy and shakes the ground with about ${sig(amplitudeRatio(lower, higher))} times the amplitude of magnitude ${sig(lower, 3)}.`,
    };
    return out;
  }

  if (mode === "energy") {
    const raw = num(opts.energy, 2e15);
    const unit = String(opts.energyUnit ?? "J");
    const energyJ =
      unit === "kt"
        ? raw * 1000 * JOULES_PER_TON_TNT
        : unit === "Mt"
          ? raw * 1e6 * JOULES_PER_TON_TNT
          : raw;
    const magnitude = magnitudeFromEnergy(energyJ);
    const out = magnitudeReport(magnitude);
    out["Derived from"] =
      `${sig(energyJ)} J of radiated energy (${unit === "J" ? "entered directly" : `${sig(raw)} ${unit === "kt" ? "kilotons" : "megatons"} TNT`})`;
    return out;
  }

  if (mode === "moment") {
    const raw = num(opts.moment, 3.9e22);
    const unit = String(opts.momentUnit ?? "N-m");
    const momentNm = unit === "dyne-cm" ? raw * 1e-7 : raw;
    const magnitude = magnitudeFromMoment(momentNm);
    const out = magnitudeReport(magnitude);
    out["Derived from"] =
      `${sig(momentNm)} N*m of seismic moment (${unit === "N-m" ? "entered directly" : `${sig(raw)} dyne*cm`})`;
    return out;
  }

  const magnitude = num(opts.magnitude, 6.7);
  return magnitudeReport(magnitude);
}

export default { run } satisfies ToolLogic<string, EarthquakeResult, Partial<EarthquakeOpts>>;

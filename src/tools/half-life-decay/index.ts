import { ToolError, type ToolLogic } from "../types";

/**
 * Radioactive decay: remaining quantity, activity and elapsed time.
 *
 * Everything is derived from one time constant. A half-life, a decay constant
 * or a mean lifetime are three ways of writing the same number, so the tool
 * accepts whichever one you have and prints the other two:
 *
 *   lambda = ln 2 / t_half,   tau = 1 / lambda = t_half / ln 2
 *   N(t) = N0 * exp(-lambda * t) = N0 * 2^(-t / t_half)
 *   A(t) = lambda * N(t)
 *
 * Activity needs a count of nuclei, so it is only reported when the starting
 * amount was given as a mass, an amount of substance, a nuclei count or an
 * activity. A bare number or a percentage is treated as a relative amount and
 * the activity rows are left out rather than invented.
 *
 * Preset half-lives are the recommended values from the NUBASE and ENSDF
 * evaluations as published in the Nuclear Wallet Cards and the IAEA Live Chart
 * of Nuclides. They are quoted to the precision given there, and a preset never
 * overrides a half-life you type yourself.
 */

/** Avogadro constant, exact since the 2019 SI redefinition, in per mole. */
const AVOGADRO = 6.02214076e23;
/** One curie in becquerels, by definition. */
const CURIE = 3.7e10;
const LN2 = Math.LN2;

/** Seconds per time unit. */
const TIME_UNITS: Record<string, number> = {
  ns: 1e-9,
  us: 1e-6,
  µs: 1e-6,
  μs: 1e-6,
  ms: 1e-3,
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
  wk: 604800,
  week: 604800,
  weeks: 604800,
  y: 31557600,
  yr: 31557600,
  yrs: 31557600,
  year: 31557600,
  years: 31557600,
  a: 31557600,
  ky: 31557600e3,
  kyr: 31557600e3,
  my: 31557600e6,
  myr: 31557600e6,
  gy: 31557600e9,
  gyr: 31557600e9,
};

/** The units offered for display, largest label first when auto picking. */
const DISPLAY_UNITS: { id: string; label: string; seconds: number }[] = [
  { id: "s", label: "s", seconds: 1 },
  { id: "min", label: "min", seconds: 60 },
  { id: "h", label: "h", seconds: 3600 },
  { id: "d", label: "d", seconds: 86400 },
  { id: "y", label: "y", seconds: 31557600 },
];

/** Grams per mass unit. */
const MASS_UNITS: Record<string, number> = {
  ng: 1e-9,
  ug: 1e-6,
  µg: 1e-6,
  μg: 1e-6,
  mg: 1e-3,
  g: 1,
  gram: 1,
  grams: 1,
  kg: 1e3,
  t: 1e6,
};

/** Moles per amount unit. */
const MOLE_UNITS: Record<string, number> = {
  nmol: 1e-9,
  umol: 1e-6,
  µmol: 1e-6,
  μmol: 1e-6,
  mmol: 1e-3,
  mol: 1,
  mole: 1,
  moles: 1,
  kmol: 1e3,
};

/** Becquerels per activity unit. */
const ACTIVITY_UNITS: Record<string, number> = {
  bq: 1,
  kbq: 1e3,
  mbq: 1e6,
  gbq: 1e9,
  tbq: 1e12,
  ci: CURIE,
  mci: CURIE * 1e-3,
  uci: CURIE * 1e-6,
  µci: CURIE * 1e-6,
  nci: CURIE * 1e-9,
};

/** Counts per nuclei unit. */
const COUNT_UNITS: Record<string, number> = {
  atom: 1,
  atoms: 1,
  nuclei: 1,
  nucleus: 1,
  count: 1,
  counts: 1,
};

export interface IsotopePreset {
  id: string;
  label: string;
  /** Half-life in seconds. */
  halfLife: number;
  /** How the half-life is normally quoted, for the output. */
  quoted: string;
  /** Mass number, used as the approximate molar mass in grams per mole. */
  massNumber: number;
}

export const ISOTOPES: IsotopePreset[] = [
  { id: "c-14", label: "Carbon 14", halfLife: 5700 * 31557600, quoted: "5700 y", massNumber: 14 },
  { id: "h-3", label: "Tritium (hydrogen 3)", halfLife: 12.32 * 31557600, quoted: "12.32 y", massNumber: 3 },
  { id: "i-131", label: "Iodine 131", halfLife: 8.0252 * 86400, quoted: "8.0252 d", massNumber: 131 },
  { id: "i-125", label: "Iodine 125", halfLife: 59.4 * 86400, quoted: "59.4 d", massNumber: 125 },
  { id: "tc-99m", label: "Technetium 99m", halfLife: 6.0067 * 3600, quoted: "6.0067 h", massNumber: 99 },
  { id: "f-18", label: "Fluorine 18", halfLife: 109.77 * 60, quoted: "109.77 min", massNumber: 18 },
  { id: "p-32", label: "Phosphorus 32", halfLife: 14.268 * 86400, quoted: "14.268 d", massNumber: 32 },
  { id: "co-60", label: "Cobalt 60", halfLife: 5.2711 * 31557600, quoted: "5.2711 y", massNumber: 60 },
  { id: "sr-90", label: "Strontium 90", halfLife: 28.79 * 31557600, quoted: "28.79 y", massNumber: 90 },
  { id: "cs-137", label: "Cesium 137", halfLife: 30.08 * 31557600, quoted: "30.08 y", massNumber: 137 },
  { id: "po-210", label: "Polonium 210", halfLife: 138.376 * 86400, quoted: "138.376 d", massNumber: 210 },
  { id: "ra-226", label: "Radium 226", halfLife: 1600 * 31557600, quoted: "1600 y", massNumber: 226 },
  { id: "am-241", label: "Americium 241", halfLife: 432.6 * 31557600, quoted: "432.6 y", massNumber: 241 },
  { id: "pu-239", label: "Plutonium 239", halfLife: 24110 * 31557600, quoted: "24110 y", massNumber: 239 },
  { id: "k-40", label: "Potassium 40", halfLife: 1.248e9 * 31557600, quoted: "1.248e9 y", massNumber: 40 },
  { id: "u-235", label: "Uranium 235", halfLife: 7.04e8 * 31557600, quoted: "7.04e8 y", massNumber: 235 },
  { id: "u-238", label: "Uranium 238", halfLife: 4.468e9 * 31557600, quoted: "4.468e9 y", massNumber: 238 },
  { id: "th-232", label: "Thorium 232", halfLife: 1.405e10 * 31557600, quoted: "1.405e10 y", massNumber: 232 },
];

const ISOTOPE_BY_ID: Record<string, IsotopePreset> = {};
for (const iso of ISOTOPES) ISOTOPE_BY_ID[iso.id] = iso;

export interface HalfLifeOpts {
  /** An isotope id from ISOTOPES, or "none". */
  isotope: string;
  /** "remaining" solves for what is left; "time" solves for how long it takes. */
  mode: string;
  /** A DISPLAY_UNITS id, or "auto". */
  timeUnit: string;
  /** Include the 1 to 10 half-life table. */
  showTable: boolean;
  decimals: number;
  [key: string]: unknown;
}

type AmountKind = "mass" | "mole" | "count" | "activity" | "relative";

export interface AmountValue {
  /** The value in the canonical unit for its kind: g, mol, nuclei, Bq or a bare number. */
  value: number;
  kind: AmountKind;
  /** The unit as typed, for the output. */
  unit: string;
}

export interface DecayFields {
  halfLife?: number;
  decayConstant?: number;
  meanLife?: number;
  elapsed?: number;
  initial?: AmountValue;
  remaining?: AmountValue;
  molarMass?: number;
}

const KEY_ALIASES: Record<string, keyof DecayFields> = {
  halflife: "halfLife",
  "half-life": "halfLife",
  t12: "halfLife",
  thalf: "halfLife",
  th: "halfLife",
  lambda: "decayConstant",
  decayconstant: "decayConstant",
  k: "decayConstant",
  meanlife: "meanLife",
  "mean-life": "meanLife",
  lifetime: "meanLife",
  tau: "meanLife",
  t: "elapsed",
  time: "elapsed",
  elapsed: "elapsed",
  age: "elapsed",
  n0: "initial",
  a0: "initial",
  initial: "initial",
  start: "initial",
  starting: "initial",
  amount: "initial",
  n: "remaining",
  nt: "remaining",
  at: "remaining",
  remaining: "remaining",
  left: "remaining",
  final: "remaining",
  fraction: "remaining",
  molarmass: "molarMass",
  "molar-mass": "molarMass",
  m: "molarMass",
  massnumber: "molarMass",
};

function num(token: string): number | null {
  const n = Number(token);
  return Number.isFinite(n) ? n : null;
}

/** Split "5700 y" or "5700y" into a number and a unit. */
function splitValueUnit(raw: string): { value: number; unit: string } {
  const m = /^(-?[\d.]+(?:[eE][+-]?\d+)?)\s*(.*)$/.exec(raw.trim());
  if (!m || num(m[1]!) === null)
    throw new ToolError(
      "bad-number",
      `"${raw.trim()}" is not a number with an optional unit.`,
      'Write a value as a number then a unit, such as "5700 y" or "10 g".',
    );
  return { value: Number(m[1]), unit: m[2]!.trim() };
}

/** Convert a "number unit" token to seconds. */
export function parseTime(raw: string, field: string): number {
  const { value, unit } = splitValueUnit(raw);
  const key = unit.toLowerCase();
  const factor = unit === "" ? 1 : TIME_UNITS[key];
  if (factor === undefined)
    throw new ToolError(
      "unknown-time-unit",
      `"${unit}" in ${field} is not a time unit this tool reads.`,
      "Use s, min, h, d, wk, y, ky, My or Gy. Leaving the unit off means seconds.",
    );
  if (value < 0)
    throw new ToolError(
      "negative-time",
      `${field} cannot be negative.`,
      "Times here run forward from the moment the sample was measured.",
    );
  return value * factor;
}

/**
 * Convert a "number unit" token to a decay constant in per second. The unit is
 * a reciprocal time written any of the usual ways: "/y", "per year", "1/y",
 * "y^-1" or "y-1".
 */
export function parseRate(raw: string, field: string): number {
  const { value, unit } = splitValueUnit(raw);
  let key = unit
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^per/, "")
    .replace(/^1\//, "")
    .replace(/^\//, "")
    .replace(/\^?-1$/, "");
  if (key === "") key = "s";
  const factor = TIME_UNITS[key];
  if (factor === undefined)
    throw new ToolError(
      "unknown-rate-unit",
      `"${unit}" in ${field} is not a reciprocal time unit this tool reads.`,
      'Write a decay constant as a rate, such as "1.21e-4 /y" or "0.0001 per year". Leaving the unit off means per second.',
    );
  if (value <= 0)
    throw new ToolError(
      "bad-constant",
      "The decay constant has to be greater than zero.",
      "A decay constant of zero describes a stable nuclide, which never decays.",
    );
  return value / factor;
}

/** Convert a "number unit" token to a canonical amount. */
export function parseAmount(raw: string, field: string): AmountValue {
  const text = raw.trim();
  if (text.endsWith("%")) {
    const value = num(text.slice(0, -1).trim());
    if (value === null)
      throw new ToolError(
        "bad-number",
        `"${text}" in ${field} is not a percentage.`,
        'Write a percentage as a number then a percent sign, such as "25%".',
      );
    return { value: value / 100, kind: "relative", unit: "%" };
  }
  const { value, unit } = splitValueUnit(text);
  if (value < 0)
    throw new ToolError(
      "negative-amount",
      `${field} cannot be negative.`,
      "An amount of a substance starts at zero.",
    );
  const key = unit.toLowerCase();
  if (unit === "") return { value, kind: "relative", unit: "" };
  if (MASS_UNITS[unit] !== undefined) return { value: value * MASS_UNITS[unit]!, kind: "mass", unit };
  if (MOLE_UNITS[key] !== undefined) return { value: value * MOLE_UNITS[key]!, kind: "mole", unit };
  if (COUNT_UNITS[key] !== undefined) return { value, kind: "count", unit };
  if (ACTIVITY_UNITS[key] !== undefined)
    return { value: value * ACTIVITY_UNITS[key]!, kind: "activity", unit };
  throw new ToolError(
    "unknown-amount-unit",
    `"${unit}" in ${field} is not an amount unit this tool reads.`,
    "Use a mass (g, mg, kg), an amount (mol, mmol), a count (atoms), an activity (Bq, kBq, MBq, Ci, mCi) or a percentage.",
  );
}

/**
 * Read the free-form input: whitespace or comma separated key=value pairs,
 * where the value may carry a unit. A colon works in place of the equals sign.
 */
export function parseFields(raw: string): DecayFields {
  const text = (raw ?? "").trim();
  const fields: DecayFields = {};
  if (!text) return fields;

  const PAIR =
    /([A-Za-z][A-Za-z0-9_-]*)\s*[=:]\s*([^,;\n]*?)(?=[,;\n]|\s+[A-Za-z][A-Za-z0-9_-]*\s*[=:]|$)/g;
  const pairs = [...text.matchAll(PAIR)];
  if (!pairs.length)
    throw new ToolError(
      "bad-input",
      "Nothing in that input looks like a value.",
      'Write values as name=value pairs, for example "halfLife=5700 y, t=11400 y, N0=100 g".',
    );

  for (const pair of pairs) {
    const key = pair[1]!.trim().toLowerCase();
    const value = pair[2]!.trim();
    const field = KEY_ALIASES[key];
    if (!field)
      throw new ToolError(
        "unknown-field",
        `"${pair[1]}" is not a value this tool knows.`,
        "Use halfLife, lambda, meanLife, t, N0 or N. A molarMass may be added when the amount is a mass.",
      );
    if (field === "initial" || field === "remaining") fields[field] = parseAmount(value, field);
    else if (field === "decayConstant") fields.decayConstant = parseRate(value, field);
    else if (field === "molarMass") {
      const parsed = splitValueUnit(value);
      if (parsed.value <= 0)
        throw new ToolError(
          "bad-molar-mass",
          "The molar mass has to be greater than zero.",
          "Use the mass number of the isotope, such as 137 for cesium 137.",
        );
      fields.molarMass = parsed.value;
    } else fields[field] = parseTime(value, field);
  }
  return fields;
}

function pickUnit(seconds: number, requested: string): { label: string; seconds: number } {
  const chosen = DISPLAY_UNITS.find((u) => u.id === requested);
  if (chosen) return { label: chosen.label, seconds: chosen.seconds };
  for (let i = DISPLAY_UNITS.length - 1; i >= 0; i--) {
    const unit = DISPLAY_UNITS[i]!;
    if (seconds >= unit.seconds) return { label: unit.label, seconds: unit.seconds };
  }
  return { label: "s", seconds: 1 };
}

function fmt(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs < 10 ** -decimals || abs >= 1e7) return value.toExponential(Math.max(2, decimals - 1));
  return value.toFixed(decimals);
}

function fmtTime(seconds: number, unit: { label: string; seconds: number }, decimals: number): string {
  return `${fmt(seconds / unit.seconds, decimals)} ${unit.label}`;
}

function clampDecimals(value: unknown, fallback = 4): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(8, Math.max(0, Math.round(n)));
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export interface DecaySolution {
  halfLife: number;
  decayConstant: number;
  meanLife: number;
  /** The isotope preset that supplied the half-life, when one did. */
  preset?: IsotopePreset;
  /** Elapsed time in seconds, for the remaining mode. */
  elapsed: number;
  /** Fraction of the sample still undecayed, 0 to 1. */
  remainingFraction: number;
  halfLivesElapsed: number;
  initial?: AmountValue;
  /** Starting nuclei count, when it could be worked out. */
  initialNuclei?: number;
  mode: "remaining" | "time";
}

/** Resolve the time constant and solve for either the remainder or the time. */
export function solveDecay(input: string, opts?: Partial<HalfLifeOpts>): DecaySolution {
  const fields = parseFields(input);
  const presetId = String(opts?.isotope ?? "none");
  const preset = ISOTOPE_BY_ID[presetId];
  const mode = String(opts?.mode ?? "remaining") === "time" ? "time" : "remaining";

  const given = [fields.halfLife, fields.decayConstant, fields.meanLife].filter(
    (v) => v !== undefined,
  );
  if (given.length > 1)
    throw new ToolError(
      "too-many-constants",
      "A half-life, a decay constant and a mean lifetime are three ways of writing the same number, and more than one was given.",
      "Keep whichever one you actually measured and delete the others.",
    );

  let halfLife: number | undefined;
  if (fields.halfLife !== undefined) halfLife = fields.halfLife;
  else if (fields.decayConstant !== undefined) halfLife = LN2 / fields.decayConstant;
  else if (fields.meanLife !== undefined) halfLife = fields.meanLife * LN2;
  else if (preset) halfLife = preset.halfLife;

  if (halfLife === undefined)
    throw new ToolError(
      "no-half-life",
      "No half-life was given, so there is no decay to compute.",
      'Add a half-life such as "halfLife=5700 y", give a decay constant or a mean lifetime instead, or pick an isotope preset.',
    );
  if (halfLife <= 0)
    throw new ToolError(
      "bad-half-life",
      "The half-life has to be greater than zero.",
      "A half-life of zero would mean the sample is gone the instant it exists.",
    );

  const decayConstant = LN2 / halfLife;
  const meanLife = 1 / decayConstant;
  const initial = fields.initial;

  let elapsed: number;
  let remainingFraction: number;

  if (mode === "time") {
    const remaining = fields.remaining;
    if (!remaining)
      throw new ToolError(
        "no-remaining",
        "Solving for time needs the amount that is left.",
        'Add a remaining amount, such as "remaining=25%" or "N=2.5 g" alongside "N0=10 g".',
      );
    if (remaining.kind === "relative" && remaining.unit === "%") remainingFraction = remaining.value;
    else if (initial) {
      if (initial.kind !== remaining.kind)
        throw new ToolError(
          "mismatched-units",
          "The starting amount and the remaining amount are in different kinds of unit.",
          "Give both as masses, both as moles, both as counts, or both as activities.",
        );
      if (initial.value <= 0)
        throw new ToolError(
          "bad-initial",
          "The starting amount has to be greater than zero.",
          "There is nothing to decay from an empty sample.",
        );
      remainingFraction = remaining.value / initial.value;
    } else if (remaining.kind === "relative") remainingFraction = remaining.value;
    else
      throw new ToolError(
        "no-initial",
        "A remaining amount on its own does not say what fraction is left.",
        'Add the starting amount as well, such as "N0=10 g", or give the remainder as a percentage.',
      );

    if (remainingFraction <= 0)
      throw new ToolError(
        "zero-remaining",
        "Decay never reaches exactly zero, so the time to get there is infinite.",
        "Ask for a small but non zero remainder, such as 0.1%.",
      );
    if (remainingFraction > 1)
      throw new ToolError(
        "grew",
        "The remaining amount is larger than the starting amount, which decay cannot do.",
        "Check that the two amounts are the right way round and in the same unit.",
      );
    elapsed = -Math.log(remainingFraction) / decayConstant;
  } else {
    if (fields.elapsed === undefined)
      throw new ToolError(
        "no-time",
        "No elapsed time was given, so there is nothing to decay over.",
        'Add a time such as "t=11400 y", or switch the mode to solve for the time instead.',
      );
    elapsed = fields.elapsed;
    remainingFraction = Math.exp(-decayConstant * elapsed);
  }

  const molarMass = fields.molarMass ?? preset?.massNumber;
  let initialNuclei: number | undefined;
  if (initial) {
    if (initial.kind === "count") initialNuclei = initial.value;
    else if (initial.kind === "mole") initialNuclei = initial.value * AVOGADRO;
    else if (initial.kind === "activity") initialNuclei = initial.value / decayConstant;
    else if (initial.kind === "mass" && molarMass) initialNuclei = (initial.value / molarMass) * AVOGADRO;
  }

  const solution: DecaySolution = {
    halfLife,
    decayConstant,
    meanLife,
    elapsed,
    remainingFraction,
    halfLivesElapsed: elapsed / halfLife,
    mode,
  };
  if (preset) solution.preset = preset;
  if (initial) solution.initial = initial;
  if (initialNuclei !== undefined) solution.initialNuclei = initialNuclei;
  return solution;
}

function amountLabel(amount: AmountValue): string {
  switch (amount.kind) {
    case "mass":
      return "g";
    case "mole":
      return "mol";
    case "count":
      return "nuclei";
    case "activity":
      return "Bq";
    default:
      return "";
  }
}

export function run(input: string, opts?: Partial<HalfLifeOpts>): Record<string, string> {
  const s = solveDecay(input, opts);
  const d = clampDecimals(opts?.decimals ?? 4);
  const unit = pickUnit(s.halfLife, String(opts?.timeUnit ?? "auto"));
  const showTable = bool(opts?.showTable, true);

  const out: Record<string, string> = {};
  if (s.preset) out["Isotope"] = `${s.preset.label}, half-life ${s.preset.quoted}`;
  out["Half-life"] = `${fmtTime(s.halfLife, unit, d)} (${fmt(s.halfLife, d)} s)`;
  out["Decay constant"] =
    `${fmt(s.decayConstant * unit.seconds, d)} per ${unit.label} (${fmt(s.decayConstant, d)} per s)`;
  out["Mean lifetime"] = `${fmtTime(s.meanLife, unit, d)} (${fmt(s.meanLife, d)} s)`;
  out["Elapsed time"] = `${fmtTime(s.elapsed, unit, d)} (${fmt(s.elapsed, d)} s)`;
  out["Half-lives elapsed"] = fmt(s.halfLivesElapsed, d);
  out["Remaining fraction"] = `${(s.remainingFraction * 100).toFixed(Math.max(2, d))}%`;
  out["Decayed fraction"] = `${((1 - s.remainingFraction) * 100).toFixed(Math.max(2, d))}%`;

  if (s.initial) {
    const label = amountLabel(s.initial);
    const suffix = label ? ` ${label}` : "";
    const remaining = s.initial.value * s.remainingFraction;
    out["Starting amount"] = `${fmt(s.initial.value, d)}${suffix}`;
    out["Remaining amount"] = `${fmt(remaining, d)}${suffix}`;
    out["Decayed amount"] = `${fmt(s.initial.value - remaining, d)}${suffix}`;
  }

  if (s.initialNuclei !== undefined) {
    const nuclei = s.initialNuclei * s.remainingFraction;
    out["Starting nuclei"] = fmt(s.initialNuclei, d);
    out["Remaining nuclei"] = fmt(nuclei, d);
    out["Starting activity"] =
      `${fmt(s.decayConstant * s.initialNuclei, d)} Bq (${fmt((s.decayConstant * s.initialNuclei) / CURIE, d)} Ci)`;
    out["Activity now"] =
      `${fmt(s.decayConstant * nuclei, d)} Bq (${fmt((s.decayConstant * nuclei) / CURIE, d)} Ci)`;
  } else if (s.initial && s.initial.kind === "mass") {
    out["Activity"] =
      "Not shown: a mass turns into a nuclei count only with a molar mass. Add molarMass=137 or pick an isotope preset.";
  }

  if (showTable) {
    for (let n = 1; n <= 10; n++) {
      const fraction = 2 ** -n;
      const amount = s.initial ? `, ${fmt(s.initial.value * fraction, d)}${amountLabel(s.initial) ? ` ${amountLabel(s.initial)}` : ""}` : "";
      out[`After ${n} half-${n === 1 ? "life" : "lives"}`] =
        `${fmtTime(s.halfLife * n, unit, d)}, ${(fraction * 100).toFixed(4)}% left${amount}`;
    }
  }

  return out;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, Partial<HalfLifeOpts>>;

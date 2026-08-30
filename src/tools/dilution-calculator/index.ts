import { ToolError, type ToolLogic } from "../types";

/**
 * Dilution math: C1 V1 = C2 V2, and serial dilution series.
 *
 * Concentrations are grouped into three families that can be compared without
 * extra information: molar (M, mM, uM), mass per volume (g/L, mg/mL, ppm, and
 * percent weight in volume), and fold (the X of a 10X buffer). Inside a family
 * the conversion is a fixed factor. Crossing from the mass family to the molar
 * family needs a molar mass, which the input can supply, and the tool says so
 * rather than guessing.
 *
 * Percent is read as weight in volume, so 1% is 1 gram in 100 millilitres,
 * which is 10 g/L. Parts per million is read as the aqueous convention of one
 * milligram per liter. Both are stated in the output so a volume in volume
 * percentage is never silently treated as weight in volume.
 *
 * This tool is a calculation aid for teaching and lab planning, not a protocol.
 * Concentrated acids and bases release a lot of heat on mixing: always add the
 * acid to the water, never the water to the acid, and follow the safety data
 * sheet for the material you actually have.
 */

export interface DilutionOpts {
  /** "solve" for C1 V1 = C2 V2, "serial" for a dilution series. */
  mode: string;
  decimals: number;
  [key: string]: unknown;
}

type Family = "molar" | "mass" | "fold";

interface UnitSpec {
  family: Family;
  /** Multiplier to the family's canonical unit: mol/L, g/L, or plain folds. */
  factor: number;
}

/** Case sensitive concentration units, where capitalization carries meaning. */
const CONC_EXACT: Record<string, UnitSpec> = {
  M: { family: "molar", factor: 1 },
  mM: { family: "molar", factor: 1e-3 },
  uM: { family: "molar", factor: 1e-6 },
  µM: { family: "molar", factor: 1e-6 },
  μM: { family: "molar", factor: 1e-6 },
  nM: { family: "molar", factor: 1e-9 },
  pM: { family: "molar", factor: 1e-12 },
  N: { family: "molar", factor: 1 },
  X: { family: "fold", factor: 1 },
};

/** Concentration units whose spelling is unambiguous in lower case. */
const CONC_LOWER: Record<string, UnitSpec> = {
  molar: { family: "molar", factor: 1 },
  "mol/l": { family: "molar", factor: 1 },
  "mmol/l": { family: "molar", factor: 1e-3 },
  "umol/l": { family: "molar", factor: 1e-6 },
  "µmol/l": { family: "molar", factor: 1e-6 },
  "nmol/l": { family: "molar", factor: 1e-9 },
  "g/l": { family: "mass", factor: 1 },
  "g/ml": { family: "mass", factor: 1000 },
  "mg/ml": { family: "mass", factor: 1 },
  "mg/l": { family: "mass", factor: 1e-3 },
  "mg/dl": { family: "mass", factor: 1e-2 },
  "ug/ml": { family: "mass", factor: 1e-3 },
  "µg/ml": { family: "mass", factor: 1e-3 },
  "ug/l": { family: "mass", factor: 1e-6 },
  "ng/ul": { family: "mass", factor: 1e-3 },
  "ng/ml": { family: "mass", factor: 1e-6 },
  ppm: { family: "mass", factor: 1e-3 },
  ppb: { family: "mass", factor: 1e-6 },
  "%": { family: "mass", factor: 10 },
  "%w/v": { family: "mass", factor: 10 },
  "% w/v": { family: "mass", factor: 10 },
  x: { family: "fold", factor: 1 },
  fold: { family: "fold", factor: 1 },
};

/** Liters per volume unit. */
const VOLUME_UNITS: Record<string, number> = {
  l: 1,
  liter: 1,
  liters: 1,
  litre: 1, // spelling: allow
  litres: 1, // spelling: allow
  dl: 0.1,
  cl: 0.01,
  ml: 1e-3,
  ul: 1e-6,
  "µl": 1e-6,
  "μl": 1e-6,
  nl: 1e-9,
  kl: 1e3,
  cc: 1e-3,
  "cm3": 1e-3,
};

export interface Concentration {
  /** Value in mol/L, g/L, or folds, depending on the family. */
  canonical: number;
  family: Family;
  /** The unit as typed, for the output. */
  unit: string;
  factor: number;
}

export interface Volume {
  /** Value in liters. */
  liters: number;
  unit: string;
  factor: number;
}

export interface DilutionFields {
  c1?: Concentration;
  c2?: Concentration;
  v1?: Volume;
  v2?: Volume;
  molarMass?: number;
  factor?: number;
  steps?: number;
  /** Final volume in each tube of a serial dilution, in liters. */
  tubeVolume?: Volume;
}

const KEY_ALIASES: Record<string, string> = {
  c1: "c1",
  m1: "c1",
  stock: "c1",
  from: "c1",
  c2: "c2",
  m2: "c2",
  target: "c2",
  final: "c2",
  to: "c2",
  v1: "v1",
  volume1: "v1",
  aliquot: "v1",
  v2: "v2",
  volume2: "v2",
  finalvolume: "v2",
  molarmass: "molarMass",
  "molar-mass": "molarMass",
  mw: "molarMass",
  fw: "molarMass",
  factor: "factor",
  dilution: "factor",
  ratio: "factor",
  steps: "steps",
  tubes: "steps",
  n: "steps",
  tubevolume: "tubeVolume",
  each: "tubeVolume",
  volume: "tubeVolume",
};

function splitValueUnit(raw: string, field: string): { value: number; unit: string } {
  const m = /^(-?[\d.]+(?:[eE][+-]?\d+)?)\s*(.*)$/.exec(raw.trim());
  if (!m || !Number.isFinite(Number(m[1])))
    throw new ToolError(
      "bad-number",
      `"${raw.trim()}" in ${field} is not a number with an optional unit.`,
      'Write a value as a number then a unit, such as "2 M" or "50 mL".',
    );
  return { value: Number(m[1]), unit: m[2]!.trim() };
}

/** Read a concentration such as "2 M", "0.5 mg/mL", "70%" or "10X". */
export function parseConcentration(raw: string, field: string): Concentration {
  const { value, unit } = splitValueUnit(raw, field);
  if (value < 0)
    throw new ToolError(
      "negative-concentration",
      `${field} cannot be negative.`,
      "A concentration starts at zero.",
    );
  if (unit === "")
    throw new ToolError(
      "no-unit",
      `${field} has no unit, so there is nothing to convert against.`,
      "Add a unit such as M, mM, uM, mg/mL, ppm, % or X.",
    );
  const spec = CONC_EXACT[unit] ?? CONC_LOWER[unit.toLowerCase().replace(/\s+/g, "")];
  if (!spec)
    throw new ToolError(
      "unknown-concentration-unit",
      `"${unit}" in ${field} is not a concentration unit this tool reads.`,
      "Use M, mM, uM, nM, mol/L, g/L, mg/mL, ug/mL, mg/L, ppm, ppb, % or X.",
    );
  return { canonical: value * spec.factor, family: spec.family, unit, factor: spec.factor };
}

/** Read a volume such as "50 mL" or "1 L". */
export function parseVolume(raw: string, field: string): Volume {
  const { value, unit } = splitValueUnit(raw, field);
  if (value < 0)
    throw new ToolError(
      "negative-volume",
      `${field} cannot be negative.`,
      "A volume starts at zero.",
    );
  const key = unit.toLowerCase();
  const factor = unit === "" ? 1e-3 : VOLUME_UNITS[key];
  if (factor === undefined)
    throw new ToolError(
      "unknown-volume-unit",
      `"${unit}" in ${field} is not a volume unit this tool reads.`,
      "Use L, dL, cL, mL, uL or nL. Leaving the unit off means millilitres.",
    );
  return { liters: value * factor, unit: unit || "mL", factor };
}

/** Read the free-form name=value input. */
export function parseFields(raw: string): DilutionFields {
  const text = (raw ?? "").trim();
  if (!text)
    throw new ToolError(
      "empty-input",
      "No values to work from.",
      'Write the values you have as name=value pairs, such as "C1=2 M, C2=0.1 M, V2=100 mL".',
    );
  const PAIR =
    /([A-Za-z][A-Za-z0-9_-]*)\s*[=:]\s*([^,;\n]*?)(?=[,;\n]|\s+[A-Za-z][A-Za-z0-9_-]*\s*[=:]|$)/g;
  const pairs = [...text.matchAll(PAIR)];
  if (!pairs.length)
    throw new ToolError(
      "bad-input",
      "Nothing in that input looks like a value.",
      'Write values as name=value pairs, for example "C1=2 M, C2=0.1 M, V2=100 mL".',
    );

  const fields: DilutionFields = {};
  for (const pair of pairs) {
    const key = pair[1]!.trim().toLowerCase();
    const value = pair[2]!.trim();
    const field = KEY_ALIASES[key];
    if (!field)
      throw new ToolError(
        "unknown-field",
        `"${pair[1]}" is not a value this tool knows.`,
        "Use C1, V1, C2, V2, and for a series factor, steps and volume. A molarMass may be added to cross between molar and mass units.",
      );
    switch (field) {
      case "c1":
      case "c2":
        fields[field] = parseConcentration(value, field.toUpperCase());
        break;
      case "v1":
      case "v2":
        fields[field] = parseVolume(value, field.toUpperCase());
        break;
      case "tubeVolume":
        fields.tubeVolume = parseVolume(value, "volume");
        break;
      case "molarMass": {
        const parsed = splitValueUnit(value, "molarMass");
        if (parsed.value <= 0)
          throw new ToolError(
            "bad-molar-mass",
            "The molar mass has to be greater than zero.",
            "Use the compound's formula weight in grams per mole, such as 58.44 for sodium chloride.",
          );
        fields.molarMass = parsed.value;
        break;
      }
      case "factor": {
        // A ratio may be written 1:10, 1/10 or just 10.
        const ratio = /^1\s*[:/]\s*([\d.]+)$/.exec(value);
        const n = ratio ? Number(ratio[1]) : Number(splitValueUnit(value, "factor").value);
        if (!Number.isFinite(n) || n <= 1)
          throw new ToolError(
            "bad-factor",
            `"${value}" is not a dilution factor greater than one.`,
            'Write the factor as a number such as 10, or as a ratio such as "1:10".',
          );
        fields.factor = n;
        break;
      }
      case "steps": {
        const n = Number(splitValueUnit(value, "steps").value);
        if (!Number.isInteger(n) || n < 1 || n > 40)
          throw new ToolError(
            "bad-steps",
            `"${value}" is not a whole number of steps between 1 and 40.`,
            "Serial dilutions here run at most 40 tubes; split a longer series into two runs.",
          );
        fields.steps = n;
        break;
      }
    }
  }
  return fields;
}

function fmt(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs < 10 ** -decimals || abs >= 1e7) return value.toExponential(Math.max(2, decimals - 1));
  return value.toFixed(decimals);
}

function clampDecimals(value: unknown, fallback = 4): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(8, Math.max(0, Math.round(n)));
}

function showVolume(liters: number, like: Volume, decimals: number): string {
  return `${fmt(liters / like.factor, decimals)} ${like.unit}`;
}

function showConcentration(canonical: number, like: Concentration, decimals: number): string {
  return `${fmt(canonical / like.factor, decimals)} ${like.unit}`;
}

/**
 * Put two concentrations on the same scale. Same family is a straight
 * comparison; a mass and a molar value need a molar mass to bridge them.
 */
function ratioOf(a: Concentration, b: Concentration, molarMass?: number): number {
  if (a.family === b.family) return a.canonical / b.canonical;
  if (a.family === "fold" || b.family === "fold")
    throw new ToolError(
      "incompatible-units",
      "An X fold concentration cannot be compared with a molar or mass concentration.",
      "Write both concentrations in the same kind of unit, or work the fold value out yourself first.",
    );
  if (!molarMass)
    throw new ToolError(
      "need-molar-mass",
      "One concentration is molar and the other is a mass per volume, which only convert through the compound's molar mass.",
      'Add the molar mass, such as "molarMass=58.44", or write both concentrations in the same family of unit.',
    );
  const toMolar = (c: Concentration) => (c.family === "mass" ? c.canonical / molarMass : c.canonical);
  return toMolar(a) / toMolar(b);
}

/** The permanent safety line that rides along with every result. */
export const SAFETY_NOTE =
  "Educational reference, not a protocol. Concentrated acids and bases release a lot of heat when they mix with water: always add the acid to the water, never the water to the acid, and work from the safety data sheet for the material you actually have.";

export interface SolveResult {
  c1: Concentration;
  c2: Concentration;
  v1: Volume;
  v2: Volume;
  /** Which of the four the tool worked out. */
  solvedFor: "C1" | "V1" | "C2" | "V2" | "none";
  dilutionFactor: number;
}

/** Solve C1 V1 = C2 V2 for whichever one of the four is missing. */
export function solveDilution(fields: DilutionFields): SolveResult {
  const present = (["c1", "v1", "c2", "v2"] as const).filter((k) => fields[k] !== undefined);
  if (present.length < 3)
    throw new ToolError(
      "not-enough-values",
      `C1 V1 = C2 V2 needs three of the four values, and ${present.length} ${present.length === 1 ? "was" : "were"} given.`,
      'Add the missing values, for example "C1=2 M, C2=0.1 M, V2=100 mL" to get V1.',
    );

  const molarMass = fields.molarMass;
  let { c1, c2, v1, v2 } = fields;
  let solvedFor: SolveResult["solvedFor"] = "none";

  if (!v1) {
    // V1 = C2 V2 / C1
    const ratio = ratioOf(c2!, c1!, molarMass);
    if (c1!.canonical === 0)
      throw new ToolError(
        "zero-stock",
        "A stock concentration of zero can never be diluted into anything.",
        "Give the stock concentration you are actually diluting from.",
      );
    v1 = { liters: ratio * v2!.liters, unit: v2!.unit, factor: v2!.factor };
    solvedFor = "V1";
  } else if (!v2) {
    const ratio = ratioOf(c1!, c2!, molarMass);
    if (c2!.canonical === 0)
      throw new ToolError(
        "zero-target",
        "A target concentration of zero would need an infinite volume.",
        "Give a target concentration greater than zero.",
      );
    v2 = { liters: ratio * v1.liters, unit: v1.unit, factor: v1.factor };
    solvedFor = "V2";
  } else if (!c1) {
    if (v1.liters === 0)
      throw new ToolError(
        "zero-volume",
        "A starting volume of zero carries no solute, so no stock concentration fits.",
        "Give the volume of stock you are actually measuring out.",
      );
    const scale = (v2.liters / v1.liters) * c2!.canonical;
    c1 = { canonical: scale, family: c2!.family, unit: c2!.unit, factor: c2!.factor };
    solvedFor = "C1";
  } else if (!c2) {
    if (v2.liters === 0)
      throw new ToolError(
        "zero-volume",
        "A final volume of zero has no concentration.",
        "Give the final volume you are making up to.",
      );
    const scale = (v1.liters / v2.liters) * c1.canonical;
    c2 = { canonical: scale, family: c1.family, unit: c1.unit, factor: c1.factor };
    solvedFor = "C2";
  }

  const dilutionFactor = ratioOf(c1!, c2!, molarMass);
  return { c1: c1!, c2: c2!, v1: v1!, v2: v2!, solvedFor, dilutionFactor };
}

export interface SerialStep {
  step: number;
  /** Concentration in the family and unit of the stock. */
  canonical: number;
  /** Volume carried forward into this tube, in liters. */
  transfer: number;
  /** Diluent already in the tube, in liters. */
  diluent: number;
}

/** Build the tube by tube plan for a serial dilution. */
export function serialDilution(fields: DilutionFields): {
  stock: Concentration;
  factor: number;
  steps: SerialStep[];
  tube: Volume;
} {
  const stock = fields.c1;
  if (!stock)
    throw new ToolError(
      "no-stock",
      "A serial dilution starts from a stock concentration.",
      'Add the stock, such as "C1=1 M", along with the factor and the number of steps.',
    );
  const factor = fields.factor;
  if (!factor)
    throw new ToolError(
      "no-factor",
      "A serial dilution needs a dilution factor for each step.",
      'Add the factor, such as "factor=10" for a one in ten series, or "factor=1:2" for a two fold series.',
    );
  const count = fields.steps ?? 5;
  const tube = fields.tubeVolume ?? { liters: 1e-3, unit: "mL", factor: 1e-3 };
  if (tube.liters <= 0)
    throw new ToolError(
      "zero-tube",
      "The volume in each tube has to be greater than zero.",
      'Add a tube volume, such as "volume=1 mL".',
    );

  const transfer = tube.liters / factor;
  const steps: SerialStep[] = [];
  let canonical = stock.canonical;
  for (let i = 1; i <= count; i++) {
    canonical /= factor;
    steps.push({ step: i, canonical, transfer, diluent: tube.liters - transfer });
  }
  return { stock, factor, steps, tube };
}

export function run(input: string, opts?: Partial<DilutionOpts>): Record<string, string> {
  const fields = parseFields(input);
  const d = clampDecimals(opts?.decimals ?? 4);
  const mode = String(opts?.mode ?? "solve") === "serial" ? "serial" : "solve";

  if (mode === "serial") {
    const plan = serialDilution(fields);
    const out: Record<string, string> = {
      "Stock concentration": showConcentration(plan.stock.canonical, plan.stock, d),
      "Dilution factor per step": `${fmt(plan.factor, d)} fold (1 to ${fmt(plan.factor, d)})`,
      "Tube volume": showVolume(plan.tube.liters, plan.tube, d),
      "Transfer each step": showVolume(plan.steps[0]!.transfer, plan.tube, d),
      "Diluent in each tube": showVolume(plan.steps[0]!.diluent, plan.tube, d),
      "How to prepare": `Put ${showVolume(plan.steps[0]!.diluent, plan.tube, d)} of diluent in each of ${plan.steps.length} tubes. Transfer ${showVolume(plan.steps[0]!.transfer, plan.tube, d)} of the stock into tube 1 and mix, then carry the same volume forward from each tube into the next.`,
    };
    for (const step of plan.steps) {
      out[`Tube ${step.step}`] =
        `${showConcentration(step.canonical, plan.stock, d)} (1 in ${fmt(plan.factor ** step.step, d)} of the stock)`;
    }
    const last = plan.steps[plan.steps.length - 1]!;
    out["Final concentration"] = showConcentration(last.canonical, plan.stock, d);
    out["Safety"] = SAFETY_NOTE;
    return out;
  }

  const r = solveDilution(fields);
  const diluent = r.v2.liters - r.v1.liters;
  const out: Record<string, string> = {
    "Solved for": r.solvedFor === "none" ? "nothing, all four values were given" : r.solvedFor,
    "C1 (stock concentration)": showConcentration(r.c1.canonical, r.c1, d),
    "V1 (stock volume)": showVolume(r.v1.liters, r.v1, d),
    "C2 (final concentration)": showConcentration(r.c2.canonical, r.c2, d),
    "V2 (final volume)": showVolume(r.v2.liters, r.v2, d),
    "Dilution factor": `${fmt(r.dilutionFactor, d)} fold (1 to ${fmt(r.dilutionFactor, d)})`,
    "Solvent to add":
      diluent >= 0
        ? `${showVolume(diluent, r.v2, d)} (assuming the volumes add)`
        : "none, the final volume is smaller than the stock volume you gave",
    "How to prepare": `Measure ${showVolume(r.v1.liters, r.v1, d)} of the ${showConcentration(r.c1.canonical, r.c1, d)} stock, then add solvent up to a final volume of ${showVolume(r.v2.liters, r.v2, d)} and mix.`,
    Equation: `C1 V1 = C2 V2, so ${showConcentration(r.c1.canonical, r.c1, d)} x ${showVolume(r.v1.liters, r.v1, d)} = ${showConcentration(r.c2.canonical, r.c2, d)} x ${showVolume(r.v2.liters, r.v2, d)}`,
  };
  if (r.c1.unit === "%" || r.c2.unit === "%")
    out["Percent reading"] = "Percent is read as weight in volume: 1% is 1 gram in 100 millilitres.";
  if (r.c1.unit.toLowerCase() === "ppm" || r.c2.unit.toLowerCase() === "ppm")
    out["Parts per million reading"] =
      "Parts per million is read as the aqueous convention of 1 milligram per liter.";
  if (r.solvedFor === "none") {
    const check = (r.dilutionFactor * r.v1.liters) / r.v2.liters;
    out["Consistency check"] =
      Math.abs(check - 1) < 1e-6
        ? "All four values were given and they agree."
        : `All four values were given and they disagree by a factor of ${fmt(check, d)}.`;
  }
  out["Safety"] = SAFETY_NOTE;
  return out;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, Partial<DilutionOpts>>;

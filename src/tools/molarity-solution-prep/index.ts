import { ELEMENTS } from "../_generated/elements";
import { ToolError, type ToolLogic } from "../types";

/**
 * The chemical formula parser below is a copy of the one in
 * src/tools/molar-mass-calculator. Tool logic never imports across tool
 * directories, because every tool has to stay independently deletable, so the
 * parser is duplicated on purpose rather than shared.
 *
 * Molar mass and percent composition from a chemical formula.
 *
 * The parser understands element symbols, nested parentheses and brackets,
 * hydrate segments joined with a dot, leading coefficients such as the 5 in
 * CuSO4.5H2O, unicode sub and superscripts, physical state labels, and ionic
 * charges. A charge is reported but never changes the mass: the mass of an ion
 * here is the mass of its neutral formula, because electron mass sits far below
 * the precision of the published atomic weights.
 *
 * Atomic weights come from the PubChem periodic table snapshot in
 * src/tools/_generated/elements.ts, which publishes rounded standard atomic
 * weights (copper 63.55, sulfur 32.07). A value computed here can therefore sit
 * a few thousandths away from one computed with full precision IUPAC weights.
 *
 * Isotope notation is not supported: there is no D, no T and no [2H]. Those
 * raise an unknown element error with a hint saying so.
 */

const MASS: Record<string, number> = {};
const ELEMENT_NAME: Record<string, string> = {};
for (const el of ELEMENTS) {
  if (el.atomicMass !== undefined) MASS[el.symbol] = el.atomicMass;
  ELEMENT_NAME[el.symbol] = el.name;
}

const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";
const SUPERSCRIPTS = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const OPEN = "([{";
const CLOSE = ")]}";
const MATCHING: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** The largest atom count the parser accepts, so a typo stays cheap. */
const MAX_ATOMS = 1_000_000;

export interface ElementShare {
  symbol: string;
  name: string;
  atoms: number;
  /** Total mass this element contributes, in grams per mole. */
  mass: number;
  /** Share of the molar mass, 0 to 100. */
  percent: number;
}

export interface ParsedFormula {
  /** The formula after normalization: the exact string the parser read. */
  formula: string;
  /** Atom counts keyed by element symbol, in order of first appearance. */
  counts: Record<string, number>;
  totalAtoms: number;
  /** The charge that was stripped, such as "2-", or undefined when neutral. */
  charge?: string;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isUpper(ch: string): boolean {
  return ch >= "A" && ch <= "Z";
}

function isLower(ch: string): boolean {
  return ch >= "a" && ch <= "z";
}

/**
 * Fold unicode digits, alternate hydrate separators, state labels and
 * whitespace into the plain ASCII the parser reads, and lift any ionic charge
 * out of the string. Returns the cleaned formula and the charge it removed.
 */
export function normalizeFormula(raw: string): { formula: string; charge?: string } {
  let s = (raw ?? "").trim();
  if (!s)
    throw new ToolError(
      "empty-input",
      "No formula to read.",
      'Type a formula such as "CuSO4.5H2O" or "Ca(OH)2".',
    );

  // Subscript digits are ordinary counts; superscript digits and signs are a charge.
  s = s.replace(/[₀-₉]/g, (ch) => String(SUBSCRIPTS.indexOf(ch)));
  s = s.replace(/[⁰¹²³⁴-⁹⁺⁻]+/g, (run) => {
    let out = "^";
    for (const ch of run) {
      if (ch === "⁺") out += "+";
      else if (ch === "⁻") out += "-";
      else out += String(SUPERSCRIPTS.indexOf(ch));
    }
    return out;
  });

  s = s.replace(/−/g, "-");
  s = s.replace(/[·•∙⋅×*]/g, ".");
  s = s.replace(/\s+/g, "");
  // Lowercase state labels only, so the sulfur group "(S)" survives untouched.
  s = s.replace(/\((?:s|l|g|aq)\)/g, "");

  const charges: string[] = [];
  s = s.replace(/\^\d*[+-]+/g, (m) => {
    charges.push(m.slice(1));
    return "";
  });
  const trailing = /(\d*[+-]+)$/.exec(s);
  if (trailing) {
    charges.push(trailing[1]!);
    s = s.slice(0, -trailing[1]!.length);
  }

  s = s.replace(/\.{2,}/g, ".").replace(/^\.+|\.+$/g, "");
  if (!s)
    throw new ToolError(
      "empty-input",
      "That input has no formula left once the charge and state labels are removed.",
      'Type a formula such as "CuSO4.5H2O" or "Ca(OH)2".',
    );

  const charge = charges.length ? normalizeCharge(charges[charges.length - 1]!) : undefined;
  return charge ? { formula: s, charge } : { formula: s };
}

/** Turn "2-", "-2" or "--" into the canonical "2-". */
function normalizeCharge(raw: string): string | undefined {
  const sign = raw.includes("-") ? "-" : "+";
  const digits = raw.replace(/[^0-9]/g, "");
  const repeats = raw.replace(/[^+-]/g, "").length;
  const size = digits ? Number(digits) : repeats;
  if (!size) return undefined;
  return size === 1 ? sign : `${size}${sign}`;
}

function unknownElementError(symbol: string, formula: string): ToolError {
  const isotope = symbol === "D" || symbol === "T";
  return new ToolError(
    "unknown-element",
    `"${symbol}" in ${formula} is not an element symbol.`,
    isotope
      ? "Isotope shorthand is not supported. Write heavy water as H2O; every mass here is a standard atomic weight."
      : "Element symbols are one capital letter, optionally followed by one lowercase letter, like Na, Cl and Fe. Check the capitalization.",
  );
}

/**
 * Parse a formula into atom counts. Throws ToolError for an unknown symbol, an
 * unbalanced bracket, an empty group, a zero subscript or a stray character.
 */
export function parseFormula(raw: string): ParsedFormula {
  const { formula, charge } = normalizeFormula(raw);
  const counts: Record<string, number> = {};

  const add = (symbol: string, n: number) => {
    counts[symbol] = (counts[symbol] ?? 0) + n;
  };

  let i = 0;

  const readCount = (): number => {
    let digits = "";
    while (i < formula.length && isDigit(formula[i]!)) digits += formula[i++]!;
    if (!digits) return 1;
    const n = Number(digits);
    if (n === 0)
      throw new ToolError(
        "invalid-count",
        `A subscript of 0 in ${formula} leaves nothing to weigh.`,
        "Remove the 0, or drop that part of the formula entirely.",
      );
    if (n > MAX_ATOMS)
      throw new ToolError(
        "count-too-large",
        `The subscript ${n} in ${formula} is past the ${MAX_ATOMS.toLocaleString("en-US")} atom limit.`,
        "Check for a typo, or split the calculation into smaller pieces.",
      );
    return n;
  };

  // Parses one run of units, multiplying each element into `sink`.
  const parseUnits = (
    sink: (symbol: string, n: number) => void,
    depth: number,
    opener?: string,
  ) => {
    let sawUnit = false;
    while (i < formula.length) {
      const ch = formula[i]!;

      if (ch === ".") {
        if (depth > 0)
          throw new ToolError(
            "misplaced-separator",
            `The hydrate dot inside the brackets of ${formula} has no meaning.`,
            "Move the dot outside the brackets, as in CuSO4.5H2O.",
          );
        break;
      }

      if (OPEN.includes(ch)) {
        i++;
        const inner: Record<string, number> = {};
        parseUnits(
          (symbol, n) => {
            inner[symbol] = (inner[symbol] ?? 0) + n;
          },
          depth + 1,
          ch,
        );
        const closer = formula[i];
        if (closer === undefined || !CLOSE.includes(closer))
          throw new ToolError(
            "unbalanced-parentheses",
            `${formula} opens a "${ch}" that is never closed.`,
            "Add the missing closing bracket, or delete the opening one.",
          );
        if (MATCHING[closer] !== ch)
          throw new ToolError(
            "unbalanced-parentheses",
            `${formula} opens with "${ch}" but closes with "${closer}".`,
            "Match every bracket with the same kind: ( with ), [ with ], { with }.",
          );
        i++;
        const mult = readCount();
        for (const [symbol, n] of Object.entries(inner)) sink(symbol, n * mult);
        sawUnit = true;
        continue;
      }

      if (CLOSE.includes(ch)) {
        if (depth === 0)
          throw new ToolError(
            "unbalanced-parentheses",
            `${formula} closes a "${ch}" that was never opened.`,
            "Add the matching opening bracket, or delete this one.",
          );
        if (MATCHING[ch] !== opener)
          throw new ToolError(
            "unbalanced-parentheses",
            `${formula} opens with "${opener}" but closes with "${ch}".`,
            "Match every bracket with the same kind: ( with ), [ with ], { with }.",
          );
        break;
      }

      if (isUpper(ch)) {
        const next = formula[i + 1];
        // A lowercase letter only ever belongs to a two letter symbol, so when
        // the pair is not an element the pair is the typo, not the capital.
        const two = next !== undefined && isLower(next) ? ch + next : undefined;
        let symbol: string;
        if (two !== undefined) {
          if (MASS[two] === undefined) throw unknownElementError(two, formula);
          symbol = two;
        } else {
          if (MASS[ch] === undefined) throw unknownElementError(ch, formula);
          symbol = ch;
        }
        i += symbol.length;
        sink(symbol, readCount());
        sawUnit = true;
        continue;
      }

      if (isDigit(ch))
        throw new ToolError(
          "misplaced-number",
          `The number at position ${i + 1} of ${formula} follows nothing it can count.`,
          "A count goes after an element or a bracket group; a coefficient goes at the very start of a segment, as in 2H2O.",
        );

      throw new ToolError(
        "unexpected-character",
        `${formula} contains "${ch}", which is not part of a chemical formula.`,
        "Use element symbols, digits, brackets, and a dot for hydrates. Nothing else is read.",
      );
    }

    if (!sawUnit)
      throw new ToolError(
        "empty-group",
        `Part of ${formula} holds no atoms.`,
        "Check for an empty bracket pair or a stray dot.",
      );
  };

  while (i < formula.length) {
    let coefficient = 1;
    let digits = "";
    let j = i;
    while (j < formula.length && isDigit(formula[j]!)) digits += formula[j++]!;
    if (digits) {
      coefficient = Number(digits);
      if (coefficient === 0)
        throw new ToolError(
          "invalid-count",
          `A coefficient of 0 in ${formula} leaves nothing to weigh.`,
          "Remove the 0, or drop that segment of the formula.",
        );
      if (coefficient > MAX_ATOMS)
        throw new ToolError(
          "count-too-large",
          `The coefficient ${coefficient} in ${formula} is past the ${MAX_ATOMS.toLocaleString("en-US")} atom limit.`,
          "Check for a typo, or split the calculation into smaller pieces.",
        );
      i = j;
    }
    parseUnits((symbol, n) => add(symbol, n * coefficient), 0);
    if (i < formula.length && formula[i] === ".") i++;
  }

  const totalAtoms = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!totalAtoms)
    throw new ToolError(
      "empty-input",
      `${formula} holds no atoms.`,
      'Type a formula such as "Ca(OH)2".',
    );
  if (totalAtoms > MAX_ATOMS)
    throw new ToolError(
      "count-too-large",
      `${formula} works out to ${totalAtoms.toLocaleString("en-US")} atoms, past the ${MAX_ATOMS.toLocaleString("en-US")} limit.`,
      "Check for a typo, or split the calculation into smaller pieces.",
    );

  return charge ? { formula, counts, totalAtoms, charge } : { formula, counts, totalAtoms };
}

/** Molar mass in grams per mole, from a formula string or parsed atom counts. */
export function molarMass(input: string | Record<string, number>): number {
  const counts = typeof input === "string" ? parseFormula(input).counts : input;
  let total = 0;
  for (const [symbol, n] of Object.entries(counts)) {
    const m = MASS[symbol];
    if (m === undefined) throw unknownElementError(symbol, symbol);
    total += m * n;
  }
  return total;
}

/** Per element mass and percent share, heaviest share first. */
export function percentComposition(counts: Record<string, number>): ElementShare[] {
  const total = molarMass(counts);
  const shares = Object.entries(counts).map(([symbol, atoms]) => {
    const mass = MASS[symbol]! * atoms;
    return {
      symbol,
      name: ELEMENT_NAME[symbol] ?? symbol,
      atoms,
      mass,
      percent: total ? (mass / total) * 100 : 0,
    };
  });
  shares.sort(
    (a, b) => b.percent - a.percent || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
  );
  return shares;
}

/**
 * Hill notation: carbon first, hydrogen second, everything else alphabetical.
 * The carbon convention only applies when carbon is present; otherwise every
 * symbol is alphabetical.
 */
export function hillFormula(counts: Record<string, number>): string {
  const symbols = Object.keys(counts);
  const rest = symbols.filter((s) => s !== "C" && s !== "H").sort();
  const ordered = counts["C"]
    ? ["C", ...(counts["H"] ? ["H"] : []), ...rest]
    : symbols.slice().sort();
  return ordered.map((s) => (counts[s] === 1 ? s : `${s}${counts[s]}`)).join("");
}

/* ------------------------------------------------------------------ */
/* Solution preparation                                                */
/* ------------------------------------------------------------------ */

/**
 * Turn a target concentration, a volume and a compound into a weighing recipe,
 * or run any of those backwards.
 *
 * The three quantities are tied together by n = C V and m = n M, so giving any
 * two of concentration, mass and volume fixes the third once a molar mass is
 * known. The molar mass comes from the formula you type, or from a molarMass
 * override when the compound is not something the formula parser can read.
 *
 * Molality and the mass percentages need the density of the finished solution,
 * because molality counts kilograms of solvent rather than liters of solution.
 * Without a density those rows are left out rather than approximated at 1 g/mL.
 *
 * This tool is a calculation aid for teaching and lab planning, not a protocol.
 * Follow the safety data sheet for the material you actually have, and when a
 * concentrated acid is involved add the acid to the water, never the other way
 * round.
 */

export interface MolarityOpts {
  /** Equivalents per mole, for the normality row. */
  equivalents: number;
  decimals: number;
  [key: string]: unknown;
}

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
  cc: 1e-3,
};

/** Moles per liter, per concentration unit. */
const CONC_EXACT: Record<string, number> = {
  M: 1,
  mM: 1e-3,
  uM: 1e-6,
  "µM": 1e-6,
  "μM": 1e-6,
  nM: 1e-9,
  pM: 1e-12,
};

const CONC_LOWER: Record<string, number> = {
  molar: 1,
  "mol/l": 1,
  "mmol/l": 1e-3,
  "umol/l": 1e-6,
  "mol/dm3": 1,
};

/** Grams per mass unit. */
const MASS_UNITS: Record<string, number> = {
  ng: 1e-9,
  ug: 1e-6,
  "µg": 1e-6,
  "μg": 1e-6,
  mg: 1e-3,
  g: 1,
  gram: 1,
  grams: 1,
  kg: 1e3,
};

/** Grams per millilitre, per density unit. */
const DENSITY_UNITS: Record<string, number> = {
  "g/ml": 1,
  "g/cm3": 1,
  "kg/l": 1,
  "g/l": 1e-3,
  "kg/m3": 1e-3,
};

export interface PrepFields {
  formula?: string;
  molarMass?: number;
  /** Target concentration in mol/L. */
  concentration?: number;
  concentrationUnit?: string;
  concentrationFactor?: number;
  /** Volume in liters. */
  volume?: number;
  volumeUnit?: string;
  volumeFactor?: number;
  /** Solute mass in grams. */
  mass?: number;
  massUnit?: string;
  massFactor?: number;
  /** Density of the finished solution, in grams per millilitre. */
  density?: number;
  /** Assay purity as a fraction, 1 when not given. */
  purity?: number;
}

const KEY_ALIASES: Record<string, string> = {
  formula: "formula",
  compound: "formula",
  solute: "formula",
  chemical: "formula",
  molarmass: "molarMass",
  "molar-mass": "molarMass",
  mw: "molarMass",
  fw: "molarMass",
  c: "concentration",
  m: "concentration",
  conc: "concentration",
  concentration: "concentration",
  molarity: "concentration",
  target: "concentration",
  v: "volume",
  vol: "volume",
  volume: "volume",
  mass: "mass",
  grams: "mass",
  weight: "mass",
  g: "mass",
  density: "density",
  rho: "density",
  d: "density",
  purity: "purity",
  assay: "purity",
};

function splitValueUnit(raw: string, field: string): { value: number; unit: string } {
  const m = /^(-?[\d.]+(?:[eE][+-]?\d+)?)\s*(.*)$/.exec(raw.trim());
  if (!m || !Number.isFinite(Number(m[1])))
    throw new ToolError(
      "bad-number",
      `"${raw.trim()}" in ${field} is not a number with an optional unit.`,
      'Write a value as a number then a unit, such as "0.5 M" or "250 mL".',
    );
  const value = Number(m[1]);
  if (value < 0)
    throw new ToolError(
      "negative-value",
      `${field} cannot be negative.`,
      "Concentrations, masses and volumes all start at zero.",
    );
  return { value, unit: m[2]!.trim() };
}

/**
 * Read the free-form input. A leading token with no equals sign is taken as the
 * formula, so "NaCl, C=0.5 M, V=250 mL" works as well as the fully named form.
 */
export function parseFields(raw: string): PrepFields {
  const text = (raw ?? "").trim();
  if (!text)
    throw new ToolError(
      "empty-input",
      "No solution to prepare.",
      'Write the compound and the values you have, such as "NaCl, C=0.5 M, V=250 mL".',
    );

  const fields: PrepFields = {};
  let body = text;
  const lead = /^([^=:,;\n]+?)\s*(?:[,;\n]|$)/.exec(text);
  if (lead && !/[=:]/.test(lead[1]!)) {
    fields.formula = lead[1]!.trim();
    body = text.slice(lead[0]!.length);
  }

  const PAIR =
    /([A-Za-z][A-Za-z0-9_-]*)\s*[=:]\s*([^,;\n]*?)(?=[,;\n]|\s+[A-Za-z][A-Za-z0-9_-]*\s*[=:]|$)/g;
  for (const pair of body.matchAll(PAIR)) {
    const key = pair[1]!.trim().toLowerCase();
    const value = pair[2]!.trim();
    const field = KEY_ALIASES[key];
    if (!field)
      throw new ToolError(
        "unknown-field",
        `"${pair[1]}" is not a value this tool knows.`,
        "Use formula, C, V, mass, molarMass, density or purity.",
      );
    switch (field) {
      case "formula":
        fields.formula = value;
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
      case "concentration": {
        const parsed = splitValueUnit(value, "concentration");
        const factor =
          CONC_EXACT[parsed.unit] ??
          CONC_LOWER[parsed.unit.toLowerCase().replace(/\s+/g, "")] ??
          (parsed.unit === "" ? 1 : undefined);
        if (factor === undefined)
          throw new ToolError(
            "unknown-concentration-unit",
            `"${parsed.unit}" is not a concentration unit this tool reads.`,
            "Use M, mM, uM, nM or mol/L. Leaving the unit off means molar.",
          );
        fields.concentration = parsed.value * factor;
        fields.concentrationUnit = parsed.unit || "M";
        fields.concentrationFactor = factor;
        break;
      }
      case "volume": {
        const parsed = splitValueUnit(value, "volume");
        const factor = parsed.unit === "" ? 1e-3 : VOLUME_UNITS[parsed.unit.toLowerCase()];
        if (factor === undefined)
          throw new ToolError(
            "unknown-volume-unit",
            `"${parsed.unit}" is not a volume unit this tool reads.`,
            "Use L, dL, cL, mL, uL or nL. Leaving the unit off means millilitres.",
          );
        fields.volume = parsed.value * factor;
        fields.volumeUnit = parsed.unit || "mL";
        fields.volumeFactor = factor;
        break;
      }
      case "mass": {
        const parsed = splitValueUnit(value, "mass");
        const factor = parsed.unit === "" ? 1 : MASS_UNITS[parsed.unit.toLowerCase()];
        if (factor === undefined)
          throw new ToolError(
            "unknown-mass-unit",
            `"${parsed.unit}" is not a mass unit this tool reads.`,
            "Use g, mg, ug, ng or kg. Leaving the unit off means grams.",
          );
        fields.mass = parsed.value * factor;
        fields.massUnit = parsed.unit || "g";
        fields.massFactor = factor;
        break;
      }
      case "density": {
        const parsed = splitValueUnit(value, "density");
        const factor = parsed.unit === "" ? 1 : DENSITY_UNITS[parsed.unit.toLowerCase()];
        if (factor === undefined)
          throw new ToolError(
            "unknown-density-unit",
            `"${parsed.unit}" is not a density unit this tool reads.`,
            "Use g/mL, g/cm3, kg/L, g/L or kg/m3. Leaving the unit off means grams per millilitre.",
          );
        if (parsed.value <= 0)
          throw new ToolError(
            "bad-density",
            "The density has to be greater than zero.",
            "Water is about 1 g/mL; look the density of your solution up if it is concentrated.",
          );
        fields.density = parsed.value * factor;
        break;
      }
      case "purity": {
        const parsed = splitValueUnit(value.replace(/%$/, ""), "purity");
        const fraction = parsed.value > 1 ? parsed.value / 100 : parsed.value;
        if (fraction <= 0 || fraction > 1)
          throw new ToolError(
            "bad-purity",
            "Purity has to be greater than zero and no more than 100%.",
            'Write the assay as a percentage, such as "purity=98%".',
          );
        fields.purity = fraction;
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

export interface PrepResult {
  /** The formula as the parser read it, when a formula was given. */
  formula?: string;
  molarMass: number;
  /** Where the molar mass came from. */
  molarMassSource: "formula" | "override";
  concentration: number;
  volume: number;
  mass: number;
  moles: number;
  /** Which quantity the tool worked out. */
  solvedFor: "mass" | "concentration" | "volume";
  purity: number;
  density?: number;
}

/** Resolve the molar mass, then solve for whichever quantity is missing. */
export function solvePrep(fields: PrepFields): PrepResult {
  let mm = fields.molarMass;
  let molarMassSource: "formula" | "override" = "override";
  let formula: string | undefined;
  if (fields.formula) {
    const parsed = parseFormula(fields.formula);
    formula = parsed.formula;
    if (mm === undefined) {
      mm = molarMass(parsed.counts);
      molarMassSource = "formula";
    }
  }
  if (mm === undefined)
    throw new ToolError(
      "no-molar-mass",
      "Nothing in the input says what the compound weighs.",
      'Add the formula, such as "formula=NaCl", or the molar mass, such as "molarMass=58.44".',
    );

  const given = [fields.concentration, fields.volume, fields.mass].filter((v) => v !== undefined);
  if (given.length < 2)
    throw new ToolError(
      "not-enough-values",
      `Two of concentration, volume and mass are needed, and ${given.length} ${given.length === 1 ? "was" : "were"} given.`,
      'Add the missing value, for example "C=0.5 M, V=250 mL" to get the mass to weigh.',
    );

  const purity = fields.purity ?? 1;
  let concentration = fields.concentration;
  let volume = fields.volume;
  let mass = fields.mass;
  let solvedFor: PrepResult["solvedFor"];

  if (mass === undefined) {
    mass = concentration! * volume! * mm;
    solvedFor = "mass";
  } else if (concentration === undefined) {
    if (volume! <= 0)
      throw new ToolError(
        "zero-volume",
        "A volume of zero has no concentration.",
        "Give the volume the solute is dissolved in.",
      );
    concentration = mass / mm / volume!;
    solvedFor = "concentration";
  } else {
    if (concentration <= 0)
      throw new ToolError(
        "zero-concentration",
        "A concentration of zero would need an infinite volume.",
        "Give a target concentration greater than zero.",
      );
    volume = mass / mm / concentration;
    solvedFor = "volume";
  }

  const result: PrepResult = {
    molarMass: mm,
    molarMassSource,
    concentration: concentration!,
    volume: volume!,
    mass,
    moles: mass / mm,
    solvedFor,
    purity,
  };
  if (formula) result.formula = formula;
  if (fields.density !== undefined) result.density = fields.density;
  return result;
}

/** The permanent safety line that rides along with every result. */
export const SAFETY_NOTE =
  "Educational reference, not a protocol. Work from the safety data sheet for the material you actually have, and when a concentrated acid is involved add the acid to the water, never the water to the acid.";

export function run(input: string, opts?: Partial<MolarityOpts>): Record<string, string> {
  const fields = parseFields(input);
  const r = solvePrep(fields);
  const d = clampDecimals(opts?.decimals ?? 4);
  const equivalents = Number(opts?.equivalents ?? 1);
  const n = Number.isFinite(equivalents) && equivalents > 0 ? equivalents : 1;

  const volumeUnit = fields.volumeUnit ?? "mL";
  const volumeFactor = fields.volumeFactor ?? 1e-3;
  const massUnit = fields.massUnit ?? "g";
  const massFactor = fields.massFactor ?? 1;
  const concUnit = fields.concentrationUnit ?? "M";
  const concFactor = fields.concentrationFactor ?? 1;

  const weighOut = r.mass / r.purity;
  const out: Record<string, string> = {};
  if (r.formula) out["Compound"] = r.formula;
  out["Molar mass"] =
    `${r.molarMass.toFixed(3)} g/mol (${r.molarMassSource === "formula" ? "from the formula" : "from the molarMass you gave"})`;
  out["Solved for"] = r.solvedFor;
  out["Concentration"] =
    `${fmt(r.concentration / concFactor, d)} ${concUnit} (${fmt(r.concentration, d)} mol/L)`;
  out["Volume"] = `${fmt(r.volume / volumeFactor, d)} ${volumeUnit} (${fmt(r.volume, d)} L)`;
  out["Moles of solute"] = `${fmt(r.moles, d)} mol`;
  out["Mass of solute"] = `${fmt(r.mass / massFactor, d)} ${massUnit} (${fmt(r.mass, d)} g)`;
  if (r.purity !== 1)
    out["Mass to weigh out"] =
      `${fmt(weighOut, d)} g at ${(r.purity * 100).toFixed(2)}% assay (${fmt(r.mass, d)} g of pure compound)`;

  out["Normality"] = `${fmt(r.concentration * n, d)} N at ${n} equivalent${n === 1 ? "" : "s"} per mole`;
  out["Percent weight in volume"] = `${fmt((r.mass / (r.volume * 1000)) * 100, d)}% w/v`;
  out["Parts per million"] = `${fmt((r.mass * 1000) / r.volume, d)} ppm (mg per liter)`;
  out["Mass concentration"] = `${fmt(r.mass / r.volume, d)} g/L`;

  if (r.density !== undefined) {
    const solutionGrams = r.volume * 1000 * r.density;
    const solventGrams = solutionGrams - r.mass;
    if (solventGrams <= 0) {
      out["Molality"] =
        "Not shown: at that density the solute would weigh more than the whole solution, so check the density.";
    } else {
      out["Solution mass"] = `${fmt(solutionGrams, d)} g at ${fmt(r.density, d)} g/mL`;
      out["Solvent mass"] = `${fmt(solventGrams, d)} g`;
      out["Molality"] = `${fmt(r.moles / (solventGrams / 1000), d)} mol/kg`;
      out["Percent weight in weight"] = `${fmt((r.mass / solutionGrams) * 100, d)}% w/w`;
      out["Mole fraction of solute"] = `${fmt(r.moles / (r.moles + solventGrams / 18.015), d)} (taking the solvent as water)`;
    }
  } else {
    out["Molality"] =
      "Not shown: molality counts kilograms of solvent, so it needs the density of the finished solution. Add density=1.02 g/mL.";
  }

  out["Step 1"] = `Weigh ${fmt(weighOut, d)} g of ${r.formula ?? "the compound"}.`;
  out["Step 2"] =
    `Dissolve it in roughly ${fmt((r.volume * 0.6) / volumeFactor, d)} ${volumeUnit} of solvent, which is about 60% of the final volume.`;
  out["Step 3"] =
    `Once it has fully dissolved, make the solution up to ${fmt(r.volume / volumeFactor, d)} ${volumeUnit} and mix.`;
  out["Safety"] = SAFETY_NOTE;
  return out;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, Partial<MolarityOpts>>;

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
/* Empirical and molecular formulas                                    */
/* ------------------------------------------------------------------ */

/**
 * Percent composition to an empirical formula, and back again.
 *
 * The forward direction is the classroom recipe done carefully. Percentages are
 * read as grams in a 100 gram sample, each is divided by the element's atomic
 * weight to get moles, the smallest result is divided out to get a ratio, and
 * the ratio is multiplied by the smallest whole number from 1 to 12 that lands
 * every element within a tenth of an integer. That last step is what turns a
 * ratio of 1 to 1.5 into the formula C2H3 rather than an unhelpful CH1.5.
 *
 * A molar mass turns the empirical formula into the molecular formula, by
 * rounding the ratio of the molar mass to the empirical formula mass.
 *
 * The reverse direction takes a formula and reports the mass percent of every
 * element in it, which is what a combustion analysis is checked against.
 */

export interface EmpiricalOpts {
  /** "auto", "composition" or "percent" for the reverse direction. */
  mode: string;
  /** How close a scaled ratio has to sit to a whole number, as a fraction. */
  tolerance: number;
  decimals: number;
  [key: string]: unknown;
}

/** The largest multiplier tried when clearing a fractional mole ratio. */
const MAX_MULTIPLIER = 12;

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

export interface CompositionEntry {
  symbol: string;
  /** The value as typed, before any conversion. */
  value: number;
  /** "percent" or "mass". */
  kind: "percent" | "mass";
  /** Grams in the reference sample. */
  grams: number;
  moles: number;
}

/** The atomic weight of one element, from the same table the parser uses. */
export function atomicWeight(symbol: string): number {
  return molarMass({ [symbol]: 1 });
}

/**
 * Read a composition: "C: 40.0%, H: 6.7%, O: 53.3%", one entry per line or
 * separated by commas or semicolons. Masses work too, as in "C: 1.20 g".
 */
export function parseComposition(raw: string): {
  entries: CompositionEntry[];
  molarMass?: number;
} {
  const text = (raw ?? "").trim();
  if (!text)
    throw new ToolError(
      "empty-input",
      "No composition to work from.",
      'List the elements and their shares, such as "C: 40.0%, H: 6.7%, O: 53.3%".',
    );

  const parts = text
    .split(/[,;\n]+/)
    .map((p) => p.trim())
    .filter((p) => p !== "" && !p.startsWith("#"));

  const entries: CompositionEntry[] = [];
  const seen = new Set<string>();
  let molar: number | undefined;

  for (const part of parts) {
    const m = /^([A-Za-z][A-Za-z-]*)\s*[:=]?\s*(-?[\d.]+(?:[eE][+-]?\d+)?)\s*(\S*)$/.exec(part);
    if (!m)
      throw new ToolError(
        "bad-entry",
        `Cannot read "${part}" as an element and a share.`,
        'Write one entry per element as "symbol: number unit", for example "C: 40.0%" or "C: 1.20 g".',
      );
    const name = m[1]!;
    const value = Number(m[2]);
    const unit = (m[3] ?? "").trim();

    const lowered = name.toLowerCase();
    if (lowered === "molarmass" || lowered === "mw" || lowered === "fw" || lowered === "m") {
      if (!(value > 0))
        throw new ToolError(
          "bad-molar-mass",
          "The molar mass has to be greater than zero.",
          'Write it as "molarMass: 180.16".',
        );
      molar = value;
      continue;
    }

    if (!Number.isFinite(value))
      throw new ToolError(
        "bad-number",
        `"${m[2]}" in "${part}" is not a number.`,
        "Use a plain decimal number, such as 40.0.",
      );
    if (value < 0)
      throw new ToolError(
        "negative-share",
        `The share for ${name} in "${part}" is negative.`,
        "A percentage or a mass starts at zero.",
      );

    // Throws a clear unknown-element error when the symbol is not real.
    const weight = atomicWeight(name);
    if (seen.has(name))
      throw new ToolError(
        "duplicate-element",
        `${name} appears more than once.`,
        "Add the shares together and give each element one line.",
      );
    seen.add(name);

    let kind: "percent" | "mass";
    let grams: number;
    if (unit === "%" || unit === "") {
      kind = "percent";
      grams = value;
    } else {
      const factor = MASS_UNITS[unit.toLowerCase()];
      if (factor === undefined)
        throw new ToolError(
          "unknown-unit",
          `"${unit}" in "${part}" is not a unit this tool reads.`,
          "Use a percent sign for a percentage, or a mass unit (g, mg, ug, kg). Leaving the unit off means a percentage.",
        );
      kind = "mass";
      grams = value * factor;
    }
    entries.push({ symbol: name, value, kind, grams, moles: grams / weight });
  }

  if (!entries.length)
    throw new ToolError(
      "no-elements",
      "No elements were found in that input.",
      'List at least two elements, such as "C: 40.0%, H: 6.7%, O: 53.3%".',
    );
  if (entries.every((e) => e.grams === 0))
    throw new ToolError(
      "all-zero",
      "Every share is zero, so there is no compound to describe.",
      "Give each element the percentage or the mass you measured.",
    );

  return molar !== undefined ? { entries, molarMass: molar } : { entries };
}

export interface EmpiricalResult {
  entries: CompositionEntry[];
  /** Raw mole ratios, before scaling to whole numbers. */
  rawRatios: Record<string, number>;
  /** The whole number multiplier that cleared the fractions. */
  multiplier: number;
  /** The empirical formula's subscripts. */
  subscripts: Record<string, number>;
  empiricalFormula: string;
  empiricalMass: number;
  /** Sum of the percentages given, when percentages were given. */
  percentTotal?: number;
  molecularFormula?: string;
  /** How many empirical units make up the molecule. */
  molecularMultiple?: number;
  molarMass?: number;
  /** How far the molar mass ratio sat from a whole number, as a fraction. */
  molecularError?: number;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/** Work the empirical formula out from a parsed composition. */
export function empiricalFormula(
  parsed: { entries: CompositionEntry[]; molarMass?: number },
  tolerance = 0.1,
): EmpiricalResult {
  const entries = parsed.entries.filter((e) => e.grams > 0);
  if (!entries.length)
    throw new ToolError(
      "all-zero",
      "Every share is zero, so there is no compound to describe.",
      "Give each element the percentage or the mass you measured.",
    );

  const smallest = Math.min(...entries.map((e) => e.moles));
  const rawRatios: Record<string, number> = {};
  for (const e of entries) rawRatios[e.symbol] = e.moles / smallest;

  const tol = Number.isFinite(tolerance) && tolerance > 0 ? Math.min(0.4, tolerance) : 0.1;
  let multiplier = 0;
  for (let n = 1; n <= MAX_MULTIPLIER; n++) {
    const ok = entries.every((e) => {
      const scaled = rawRatios[e.symbol]! * n;
      return Math.abs(scaled - Math.round(scaled)) <= tol && Math.round(scaled) >= 1;
    });
    if (ok) {
      multiplier = n;
      break;
    }
  }
  if (!multiplier)
    throw new ToolError(
      "no-whole-ratio",
      `No multiplier up to ${MAX_MULTIPLIER} turns these mole ratios into whole numbers.`,
      "Check the percentages for a typo, make sure every element in the compound is listed, or raise the rounding tolerance option if your data is rough.",
    );

  const subscripts: Record<string, number> = {};
  for (const e of entries) subscripts[e.symbol] = Math.round(rawRatios[e.symbol]! * multiplier);
  let divisor = 0;
  for (const n of Object.values(subscripts)) divisor = gcd(divisor, n);
  if (divisor > 1) for (const key of Object.keys(subscripts)) subscripts[key]! /= divisor;

  const empiricalMass = molarMass(subscripts);
  const result: EmpiricalResult = {
    entries,
    rawRatios,
    multiplier,
    subscripts,
    empiricalFormula: hillFormula(subscripts),
    empiricalMass,
  };

  if (parsed.entries.every((e) => e.kind === "percent"))
    result.percentTotal = parsed.entries.reduce((a, e) => a + e.value, 0);

  if (parsed.molarMass !== undefined) {
    const ratio = parsed.molarMass / empiricalMass;
    const multiple = Math.max(1, Math.round(ratio));
    const molecular: Record<string, number> = {};
    for (const [symbol, count] of Object.entries(subscripts)) molecular[symbol] = count * multiple;
    result.molarMass = parsed.molarMass;
    result.molecularMultiple = multiple;
    result.molecularFormula = hillFormula(molecular);
    result.molecularError = Math.abs(ratio - multiple) / multiple;
  }

  return result;
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

/** True when the input reads as a single chemical formula rather than a composition. */
export function looksLikeFormula(raw: string): boolean {
  const text = (raw ?? "").trim();
  if (!text) return false;
  if (/[%:=]/.test(text)) return false;
  if (/[,;\n]/.test(text)) return false;
  return /^[A-Za-z0-9().[\]{}·.\s]+$/.test(text) && /[A-Z]/.test(text);
}

export function run(input: string, opts?: Partial<EmpiricalOpts>): Record<string, string> {
  const d = clampDecimals(opts?.decimals ?? 4);
  const requested = String(opts?.mode ?? "auto");
  const reverse = requested === "percent" || (requested === "auto" && looksLikeFormula(input));

  if (reverse) {
    const parsed = parseFormula(input);
    const shares = percentComposition(parsed.counts);
    const total = shares.reduce((a, s) => a + s.mass, 0);
    const out: Record<string, string> = {
      Formula: parsed.formula,
      "Hill formula": hillFormula(parsed.counts),
      "Molar mass": `${total.toFixed(3)} g/mol`,
      "Percent composition": shares.map((s) => `${s.symbol} ${s.percent.toFixed(2)}%`).join(", "),
    };
    for (const s of shares) {
      out[`${s.symbol} (${s.name})`] =
        `${s.percent.toFixed(Math.max(2, d))}% by mass, ${s.atoms} atom${s.atoms === 1 ? "" : "s"}, ${fmt(s.mass, d)} g/mol`;
    }
    out["Reading"] =
      "These percentages are what a 100 gram sample of this compound would contain, which is what a combustion analysis is compared against.";
    return out;
  }

  const parsed = parseComposition(input);
  const r = empiricalFormula(parsed, Number(opts?.tolerance ?? 0.1));
  const out: Record<string, string> = {
    "Empirical formula": r.empiricalFormula,
    "Empirical formula mass": `${r.empiricalMass.toFixed(3)} g/mol`,
  };

  if (r.molecularFormula) {
    out["Molecular formula"] = r.molecularFormula;
    out["Molecular mass"] =
      `${r.empiricalMass.toFixed(3)} g/mol times ${r.molecularMultiple} = ${(r.empiricalMass * r.molecularMultiple!).toFixed(3)} g/mol`;
    out["Empirical units per molecule"] = String(r.molecularMultiple);
    out["Molar mass given"] = `${fmt(r.molarMass!, d)} g/mol`;
    if (r.molecularError! > 0.05)
      out["Molar mass check"] =
        `The molar mass you gave is ${(r.molecularError! * 100).toFixed(1)}% away from a whole multiple of the empirical formula mass, which usually means a typo in the composition or in the molar mass.`;
  } else {
    out["Molecular formula"] =
      "Not shown: the molecular formula needs the compound's molar mass. Add a line such as \"molarMass: 180.16\".";
  }

  out["Scaling multiplier"] =
    r.multiplier === 1
      ? "1, the mole ratios were already whole numbers"
      : `${r.multiplier}, which is what turned the fractional mole ratio into whole subscripts`;

  if (r.percentTotal !== undefined) {
    out["Percentages given"] = `${r.percentTotal.toFixed(2)}%`;
    if (Math.abs(r.percentTotal - 100) > 1)
      out["Percentage check"] =
        `Those percentages add up to ${r.percentTotal.toFixed(2)}% rather than 100%. The ratio still works, because only the relative amounts matter, but an element may be missing from the list.`;
  }

  for (const e of r.entries) {
    out[`${e.symbol}`] =
      `${fmt(e.value, d)}${e.kind === "percent" ? "%" : " g"}, ${fmt(e.moles, d)} mol, ratio ${fmt(r.rawRatios[e.symbol]!, d)}, subscript ${r.subscripts[e.symbol]}`;
  }

  out["Method"] =
    "Percentages are read as grams in a 100 gram sample, each is divided by the element's atomic weight to get moles, the smallest is divided out, and the ratio is scaled by the smallest whole number that lands every element on an integer.";
  return out;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, Partial<EmpiricalOpts>>;

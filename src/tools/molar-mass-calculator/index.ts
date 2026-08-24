import { ELEMENTS } from "../_generated/elements";
import { ToolError, type ToolLogic } from "../types";

/**
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

export interface MolarMassOpts {
  decimals: number;
  [key: string]: unknown;
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

function clampDecimals(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 3;
  return Math.min(6, Math.max(0, Math.round(n)));
}

export function run(input: string, opts?: Partial<MolarMassOpts>): Record<string, string> {
  const parsed = parseFormula(input);
  const decimals = clampDecimals(opts?.decimals ?? 3);
  const shares = percentComposition(parsed.counts);
  const mass = shares.reduce((a, s) => a + s.mass, 0);

  const out: Record<string, string> = {
    Formula: parsed.formula,
    "Hill formula": hillFormula(parsed.counts),
    "Molar mass": `${mass.toFixed(decimals)} g/mol`,
    "Total atoms": String(parsed.totalAtoms),
    "Percent composition": shares.map((s) => `${s.symbol} ${s.percent.toFixed(2)}%`).join(", "),
    "Atom counts": shares
      .slice()
      .sort((a, b) => (a.symbol < b.symbol ? -1 : 1))
      .map((s) => `${s.symbol} ${s.atoms}`)
      .join(", "),
  };
  if (parsed.charge)
    out["Charge"] = `${parsed.charge} (ignored: the mass shown is that of the neutral formula)`;
  for (const s of shares) {
    out[`${s.symbol} (${s.name})`] =
      `${s.atoms} ${s.atoms === 1 ? "atom" : "atoms"}, ${s.mass.toFixed(decimals)} g/mol, ${s.percent.toFixed(2)}%`;
  }
  return out;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, Partial<MolarMassOpts>>;

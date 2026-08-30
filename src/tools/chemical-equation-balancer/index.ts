import { ELEMENTS } from "../_generated/elements";
import { ToolError, type ToolLogic } from "../types";

/**
 * Balance a chemical equation by solving the element conservation matrix.
 *
 * The equation is split on an arrow (->, =>, =, and the unicode arrows), each
 * side is split into species on the plus signs, and every species is parsed
 * into atom counts, an ionic charge and an optional state label. One matrix row
 * per element, plus one row for net charge whenever any species carries one,
 * gives a homogeneous system whose nullspace holds the coefficients.
 *
 * The elimination runs over exact rationals backed by BigInt, so there is no
 * floating point drift and the answer is either exactly right or an honest
 * error. A nullspace of dimension 0 means the equation cannot be balanced at
 * all; dimension 2 or more means the input is really two independent reactions
 * written as one, which has infinitely many answers.
 *
 * Atomic weights come from the PubChem snapshot in
 * src/tools/_generated/elements.ts and are only used for the optional molar
 * mass column, never for the balancing itself.
 */

const MASS: Record<string, number> = {};
for (const el of ELEMENTS) {
  if (el.atomicMass !== undefined) MASS[el.symbol] = el.atomicMass;
}

const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";
const SUPERSCRIPTS = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const OPEN = "([{";
const CLOSE = ")]}";
const MATCHING: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const STATES = new Set(["s", "l", "g", "aq"]);

/** Cap on a single subscript or coefficient, so a typo stays cheap. */
const MAX_COUNT = 100000;
/** Cap on the number of species, so the elimination stays instant. */
const MAX_SPECIES = 30;

export interface BalancerOpts {
  /** "arrow" | "unicode" | "equals" */
  arrow: string;
  /** Keep (s), (l), (g) and (aq) labels in the balanced output. */
  keepStates: boolean;
  /** Add a molar mass column to the coefficient table. */
  showMasses: boolean;
  [key: string]: unknown;
}

export interface Species {
  /** The formula with no coefficient, charge or state attached. */
  formula: string;
  /** The species as it will be printed, charge and state included. */
  display: string;
  counts: Record<string, number>;
  /** Net ionic charge, 0 when neutral. */
  charge: number;
  /** "s", "l", "g" or "aq" when the input carried one. */
  state?: string;
  /** The coefficient the input already carried, 1 when absent. */
  given: number;
  side: "left" | "right";
}

export interface BalancedEquation {
  species: Species[];
  /** One coefficient per species, in the same order, all positive integers. */
  coefficients: number[];
  elements: string[];
  reactionType: string;
  redoxHint: string;
}

/* ------------------------------------------------------------------ */
/* Exact rational arithmetic over BigInt                               */
/* ------------------------------------------------------------------ */

interface Frac {
  n: bigint;
  d: bigint;
}

function gcdBig(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function frac(n: bigint, d: bigint = 1n): Frac {
  if (d === 0n) throw new Error("division by zero in the balancer");
  let nn = n;
  let dd = d;
  if (dd < 0n) {
    nn = -nn;
    dd = -dd;
  }
  const g = gcdBig(nn, dd);
  if (g > 1n) {
    nn /= g;
    dd /= g;
  }
  return { n: nn, d: dd };
}

const ZERO: Frac = { n: 0n, d: 1n };

function isZero(a: Frac): boolean {
  return a.n === 0n;
}

function sub(a: Frac, b: Frac): Frac {
  return frac(a.n * b.d - b.n * a.d, a.d * b.d);
}

function mul(a: Frac, b: Frac): Frac {
  return frac(a.n * b.n, a.d * b.d);
}

function div(a: Frac, b: Frac): Frac {
  if (isZero(b)) throw new Error("division by zero in the balancer");
  return frac(a.n * b.d, a.d * b.n);
}

/* ------------------------------------------------------------------ */
/* Formula parsing                                                     */
/* ------------------------------------------------------------------ */

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isUpper(ch: string): boolean {
  return ch >= "A" && ch <= "Z";
}

function isLower(ch: string): boolean {
  return ch >= "a" && ch <= "z";
}

/** Fold unicode digits, arrows, dot variants and minus signs into plain ASCII. */
export function normalizeEquation(raw: string): string {
  let s = (raw ?? "").trim();
  if (!s)
    throw new ToolError(
      "empty-input",
      "No equation to balance.",
      'Type an equation such as "Fe + O2 -> Fe2O3".',
    );
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
  s = s.replace(/[−–—]/g, "-");
  s = s.replace(/[·•∙⋅]/g, ".");
  s = s.replace(/[→⟶⇒⟹⇌⇄↔⟷]/g, ">>");
  s = s.replace(/<=>|<->|<-->|=>|-->|->/g, ">>");
  s = s.replace(/\byields\b|\bgives\b/gi, ">>");
  // An equals sign is only an arrow when no real arrow was written.
  if (!s.includes(">>")) s = s.replace(/=/g, ">>");
  return s;
}

/**
 * Read an ionic charge off the end of a species.
 *
 * Charge notation is genuinely ambiguous once superscript formatting is lost:
 * MnO4- is permanganate with a single minus, while Fe2+ is iron with a charge
 * of two. The caret form (SO4^2-) is always read literally. Without a caret the
 * rule that matches how people actually write formulas is:
 *
 * - repeated signs carry the magnitude, so Ca++ is 2+ and the digits stay
 *   subscripts;
 * - a run of two or more digits before one sign splits, so Cr2O72- is
 *   dichromate with a charge of two;
 * - a single digit before one sign is the charge only when what is left is a
 *   lone element symbol, so Fe2+ is iron(II) but MnO4- keeps its four oxygens.
 */
export function readCharge(body: string): { formula: string; charge: number } {
  const caret = /\^(\d*)([+-]+)$/.exec(body);
  if (caret) {
    return {
      formula: body.slice(0, -caret[0]!.length),
      charge: chargeValue(caret[1]!, caret[2]!),
    };
  }
  const tail = /(\d*)([+-]+)$/.exec(body);
  if (!tail || !tail[2]) return { formula: body, charge: 0 };
  const digits = tail[1]!;
  const signs = tail[2]!;
  const sign = signs.includes("-") ? -1 : 1;
  const stem = body.slice(0, body.length - tail[0]!.length);

  if (signs.length > 1) return { formula: stem + digits, charge: sign * signs.length };
  if (!digits) return { formula: stem, charge: sign };
  if (digits.length > 1) {
    return {
      formula: stem + digits.slice(0, -1),
      charge: sign * Number(digits.slice(-1)),
    };
  }
  const loneElement = /^[A-Z][a-z]?$/.test(stem) && MASS[stem] !== undefined;
  return loneElement
    ? { formula: stem, charge: sign * Number(digits) }
    : { formula: stem + digits, charge: sign };
}

function unknownElementError(symbol: string, formula: string): ToolError {
  const isotope = symbol === "D" || symbol === "T";
  return new ToolError(
    "unknown-element",
    `"${symbol}" in ${formula} is not an element symbol.`,
    isotope
      ? "Isotope shorthand is not supported. Write heavy water as H2O and balance the ordinary equation."
      : "Element symbols are one capital letter, optionally followed by one lowercase letter, like Na, Cl and Fe. Check the capitalization.",
  );
}

/**
 * Parse one compound, with no coefficient, charge or state attached. Hydrate
 * segments joined by a dot are summed, and a segment may carry its own leading
 * coefficient as the 5 does in CuSO4.5H2O.
 */
export function parseCompound(formula: string): Record<string, number> {
  const counts: Record<string, number> = {};
  let i = 0;

  const readCount = (): number => {
    let digits = "";
    while (i < formula.length && isDigit(formula[i]!)) digits += formula[i++]!;
    if (!digits) return 1;
    const n = Number(digits);
    if (n === 0)
      throw new ToolError(
        "invalid-count",
        `A subscript of 0 in ${formula} leaves nothing to balance.`,
        "Remove the 0, or drop that part of the formula.",
      );
    if (n > MAX_COUNT)
      throw new ToolError(
        "count-too-large",
        `The subscript ${n} in ${formula} is past the ${MAX_COUNT.toLocaleString("en-US")} limit.`,
        "Check for a typo in the formula.",
      );
    return n;
  };

  const parseUnits = (
    sink: (symbol: string, n: number) => void,
    depth: number,
    opener?: string,
  ): void => {
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
        parseUnits((symbol, n) => {
          inner[symbol] = (inner[symbol] ?? 0) + n;
        }, depth + 1, ch);
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
          "A subscript goes after an element or a bracket group, and a coefficient goes at the very start of the species.",
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
          `A coefficient of 0 in ${formula} leaves nothing to balance.`,
          "Remove the 0, or drop that segment of the formula.",
        );
      i = j;
    }
    parseUnits((symbol, n) => {
      counts[symbol] = (counts[symbol] ?? 0) + n * coefficient;
    }, 0);
    if (i < formula.length && formula[i] === ".") i++;
  }

  if (!Object.keys(counts).length)
    throw new ToolError("empty-group", `${formula} holds no atoms.`, "Write a formula like H2O.");
  return counts;
}

/**
 * Split one side of the equation into species. A plus sign is a separator when
 * whitespace comes before it, or when the next character starts a new species.
 * A plus sign written tight against the species and followed by the end of the
 * side, whitespace, or another plus sign is an ionic charge instead.
 */
export function splitSide(side: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let chargeTaken = false;
  for (let i = 0; i < side.length; i++) {
    const ch = side[i]!;
    if (ch !== "+") {
      buf += ch;
      continue;
    }
    const before = side[i - 1];
    const wsBefore = before !== undefined && /\s/.test(before);
    const after = side[i + 1];
    // A caret charge always takes the sign that follows it, as in Fe^3+.
    const caretPending = /\^\d*$/.test(buf);
    const chargeShaped =
      caretPending ||
      (!wsBefore &&
        !chargeTaken &&
        buf.trim() !== "" &&
        (after === undefined || /\s/.test(after) || after === "+"));
    if (chargeShaped) {
      buf += "+";
      chargeTaken = true;
      continue;
    }
    parts.push(buf);
    buf = "";
    chargeTaken = false;
  }
  parts.push(buf);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** Pull the leading coefficient, trailing state label and ionic charge off one species. */
export function parseSpecies(raw: string, side: "left" | "right"): Species {
  let s = raw.replace(/\s+/g, "");
  if (!s)
    throw new ToolError(
      "empty-species",
      "One side of the equation has an empty term.",
      "Remove the stray plus sign, or fill in the missing formula.",
    );

  let given = 1;
  const coeff = /^(\d+)(?=[A-Za-z([{])/.exec(s);
  if (coeff) {
    given = Number(coeff[1]);
    if (given === 0)
      throw new ToolError(
        "invalid-count",
        `A coefficient of 0 on "${raw.trim()}" removes the species entirely.`,
        "Delete the species, or give it a coefficient of 1 or more.",
      );
    if (given > MAX_COUNT)
      throw new ToolError(
        "count-too-large",
        `The coefficient ${given} on "${raw.trim()}" is past the ${MAX_COUNT.toLocaleString("en-US")} limit.`,
        "Check for a typo. The balancer works out the coefficients for you anyway.",
      );
    s = s.slice(coeff[1]!.length);
  }

  let state: string | undefined;
  const stateMatch = /\(([A-Za-z]{1,2})\)$/.exec(s);
  if (stateMatch && STATES.has(stateMatch[1]!.toLowerCase())) {
    state = stateMatch[1]!.toLowerCase();
    s = s.slice(0, -stateMatch[0]!.length);
  }

  const read = readCharge(s);
  const charge = read.charge;
  s = read.formula;

  if (!s)
    throw new ToolError(
      "empty-species",
      `"${raw.trim()}" has no formula once the coefficient, charge and state are removed.`,
      "Write the species as a formula, such as SO4^2- or Fe3+.",
    );

  const counts = parseCompound(s);
  const display = `${s}${chargeLabel(charge)}${state ? `(${state})` : ""}`;
  return state !== undefined
    ? { formula: s, display, counts, charge, state, given, side }
    : { formula: s, display, counts, charge, given, side };
}

function chargeValue(digits: string, signs: string): number {
  const sign = signs.includes("-") ? -1 : 1;
  const size = digits ? Number(digits) : signs.length;
  return sign * size;
}

function chargeLabel(charge: number): string {
  if (charge === 0) return "";
  const sign = charge < 0 ? "-" : "+";
  const size = Math.abs(charge);
  return size === 1 ? sign : `${size}${sign}`;
}

/* ------------------------------------------------------------------ */
/* Balancing                                                           */
/* ------------------------------------------------------------------ */

/** Parse the whole equation into species without balancing it. */
export function parseEquation(raw: string): Species[] {
  const normalized = normalizeEquation(raw);
  const pieces = normalized.split(">>");
  if (pieces.length === 1)
    throw new ToolError(
      "no-arrow",
      "That equation has no arrow, so there is nothing to balance across.",
      'Separate reactants from products with an arrow: "Fe + O2 -> Fe2O3". An = sign works too.',
    );
  if (pieces.length > 2)
    throw new ToolError(
      "too-many-arrows",
      "That equation has more than one arrow.",
      "Balance one reaction at a time. Split a multi step scheme into separate equations.",
    );

  const left = splitSide(pieces[0]!);
  const right = splitSide(pieces[1]!);
  if (!left.length)
    throw new ToolError(
      "empty-side",
      "The reactant side of the arrow is empty.",
      'Write the reactants before the arrow, as in "Fe + O2 -> Fe2O3".',
    );
  if (!right.length)
    throw new ToolError(
      "empty-side",
      "The product side of the arrow is empty.",
      'Write the products after the arrow, as in "Fe + O2 -> Fe2O3".',
    );
  if (left.length + right.length > MAX_SPECIES)
    throw new ToolError(
      "too-many-species",
      `That equation has ${left.length + right.length} species, past the limit of ${MAX_SPECIES}.`,
      "Split the scheme into separate equations and balance them one at a time.",
    );

  return [
    ...left.map((p) => parseSpecies(p, "left")),
    ...right.map((p) => parseSpecies(p, "right")),
  ];
}

/**
 * Solve the conservation matrix and return one positive integer coefficient
 * per species, scaled to the smallest whole numbers.
 */
export function balance(species: Species[]): number[] {
  const elements = Array.from(
    new Set(species.flatMap((sp) => Object.keys(sp.counts))),
  ).sort();
  const charged = species.some((sp) => sp.charge !== 0);

  const rows: Frac[][] = [];
  for (const el of elements) {
    rows.push(
      species.map((sp) => {
        const n = sp.counts[el] ?? 0;
        return frac(BigInt(sp.side === "left" ? n : -n));
      }),
    );
  }
  if (charged) {
    rows.push(
      species.map((sp) => frac(BigInt(sp.side === "left" ? sp.charge : -sp.charge))),
    );
  }

  const cols = species.length;
  // Gauss-Jordan to reduced row echelon form over exact rationals.
  const pivotOfCol: number[] = new Array(cols).fill(-1);
  let row = 0;
  for (let col = 0; col < cols && row < rows.length; col++) {
    let pivot = -1;
    for (let r = row; r < rows.length; r++) {
      if (!isZero(rows[r]![col]!)) {
        pivot = r;
        break;
      }
    }
    if (pivot === -1) continue;
    const tmp = rows[row]!;
    rows[row] = rows[pivot]!;
    rows[pivot] = tmp;
    const lead = rows[row]![col]!;
    for (let c = 0; c < cols; c++) rows[row]![c] = div(rows[row]![c]!, lead);
    for (let r = 0; r < rows.length; r++) {
      if (r === row) continue;
      const factor = rows[r]![col]!;
      if (isZero(factor)) continue;
      for (let c = 0; c < cols; c++) {
        rows[r]![c] = sub(rows[r]![c]!, mul(factor, rows[row]![c]!));
      }
    }
    pivotOfCol[col] = row;
    row++;
  }

  const freeCols: number[] = [];
  for (let c = 0; c < cols; c++) if (pivotOfCol[c] === -1) freeCols.push(c);

  if (freeCols.length === 0)
    throw new ToolError(
      "not-balanceable",
      "This equation cannot be balanced: no set of whole number coefficients conserves every element.",
      "Check that every element on the left appears on the right and the other way round, and that no formula has a typo.",
    );
  if (freeCols.length > 1)
    throw new ToolError(
      "ambiguous-equation",
      `This equation has ${freeCols.length} independent solutions, so there is no single right answer.`,
      "That usually means two separate reactions are written as one, or a species is redundant. Split them and balance each on its own.",
    );

  const free = freeCols[0]!;
  const solution: Frac[] = new Array(cols).fill(ZERO);
  solution[free] = frac(1n);
  for (let c = 0; c < cols; c++) {
    const pr = pivotOfCol[c];
    if (pr === -1) continue;
    // x_c = -(coefficient of the free column in that pivot row)
    solution[c] = sub(ZERO, rows[pr]![free]!);
  }

  // Scale to whole numbers: multiply by the lcm of the denominators.
  let lcm = 1n;
  for (const f of solution) lcm = (lcm / gcdBig(lcm, f.d)) * f.d;
  const ints = solution.map((f) => (f.n * lcm) / f.d);
  let g = 0n;
  for (const v of ints) g = gcdBig(g, v);
  if (g === 0n)
    throw new ToolError(
      "not-balanceable",
      "This equation cannot be balanced: every coefficient works out to zero.",
      "Check that the reactants and the products are genuinely different species.",
    );
  let scaled = ints.map((v) => v / g);
  if (scaled.every((v) => v <= 0n)) scaled = scaled.map((v) => -v);

  if (scaled.some((v) => v <= 0n))
    throw new ToolError(
      "wrong-side",
      "This equation only balances if one of the species moves to the other side of the arrow.",
      "A species that would need a negative coefficient belongs on the opposite side. Move it and balance again.",
    );

  return scaled.map((v) => Number(v));
}

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

function isFreeElement(sp: Species): boolean {
  return Object.keys(sp.counts).length === 1;
}

function formulaKey(counts: Record<string, number>): string {
  return Object.keys(counts)
    .sort()
    .map((k) => `${k}${counts[k]}`)
    .join("");
}

/** A one line guess at the reaction family. */
export function classify(species: Species[]): string {
  const left = species.filter((s) => s.side === "left");
  const right = species.filter((s) => s.side === "right");
  const hasO2 = left.some((s) => s.formula === "O2" || formulaKey(s.counts) === "O2");
  const co2 = right.some((s) => formulaKey(s.counts) === "C1O2");
  const water = right.some((s) => formulaKey(s.counts) === "H2O1");

  if (hasO2 && (co2 || water) && left.length >= 2) return "Combustion";
  if (left.length >= 2 && right.length === 1) return "Synthesis (combination)";
  if (left.length === 1 && right.length >= 2) return "Decomposition";
  if (left.length === 2 && right.length === 2) {
    const freeLeft = left.filter(isFreeElement).length;
    const freeRight = right.filter(isFreeElement).length;
    if (freeLeft === 1 && freeRight === 1) return "Single replacement (displacement)";
    if (freeLeft === 0 && freeRight === 0) {
      if (water) return "Double replacement (neutralization)";
      return "Double replacement (metathesis)";
    }
  }
  return "No standard family matched";
}

/**
 * A heuristic redox flag. An element that appears uncombined on one side and
 * combined on the other has changed oxidation state, which is enough to call
 * the reaction redox without computing oxidation numbers for everything.
 */
export function redoxHint(species: Species[]): string {
  const freeOn: Record<string, Set<string>> = {};
  const boundOn: Record<string, Set<string>> = {};
  for (const sp of species) {
    const free = isFreeElement(sp) && sp.charge === 0;
    for (const el of Object.keys(sp.counts)) {
      const target = free ? freeOn : boundOn;
      (target[el] ??= new Set()).add(sp.side);
    }
  }
  const changed: string[] = [];
  for (const el of Object.keys(freeOn)) {
    for (const side of freeOn[el]!) {
      const other = side === "left" ? "right" : "left";
      if (boundOn[el]?.has(other)) {
        changed.push(el);
        break;
      }
    }
  }
  if (changed.length)
    return `Likely redox: ${changed.join(", ")} appears uncombined on one side and combined on the other, so its oxidation state changes.`;
  return "No element appears both free and combined, so a redox call here needs oxidation numbers worked out by hand.";
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

const ARROWS: Record<string, string> = {
  arrow: "->",
  unicode: "→",
  equals: "=",
};

function renderSide(
  species: Species[],
  coefficients: number[],
  side: "left" | "right",
  keepStates: boolean,
): string {
  const parts: string[] = [];
  species.forEach((sp, idx) => {
    if (sp.side !== side) return;
    const c = coefficients[idx]!;
    const body = keepStates
      ? sp.display
      : `${sp.formula}${chargeLabel(sp.charge)}`;
    parts.push(c === 1 ? body : `${c} ${body}`);
  });
  return parts.join(" + ");
}

/** The balanced equation as one line of text. */
export function renderEquation(
  result: BalancedEquation,
  arrow = "->",
  keepStates = true,
): string {
  const left = renderSide(result.species, result.coefficients, "left", keepStates);
  const right = renderSide(result.species, result.coefficients, "right", keepStates);
  return `${left} ${arrow} ${right}`;
}

/** Molar mass of one species, in grams per mole. */
export function speciesMass(sp: Species): number {
  let total = 0;
  for (const [symbol, n] of Object.entries(sp.counts)) total += (MASS[symbol] ?? 0) * n;
  return total;
}

/** Parse, balance and classify in one call. */
export function balanceEquation(raw: string): BalancedEquation {
  const species = parseEquation(raw);
  const coefficients = balance(species);
  const elements = Array.from(new Set(species.flatMap((sp) => Object.keys(sp.counts)))).sort();
  return {
    species,
    coefficients,
    elements,
    reactionType: classify(species),
    redoxHint: redoxHint(species),
  };
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function run(input: string, opts?: Partial<BalancerOpts>): Record<string, string> {
  const result = balanceEquation(input);
  const arrow = ARROWS[String(opts?.arrow ?? "arrow")] ?? "->";
  const keepStates = bool(opts?.keepStates, true);
  const showMasses = bool(opts?.showMasses, false);

  const out: Record<string, string> = {
    "Balanced equation": renderEquation(result, arrow, keepStates),
    "Reaction type": result.reactionType,
    "Redox hint": result.redoxHint,
    Coefficients: result.species
      .map((sp, i) => `${result.coefficients[i]} ${sp.formula}`)
      .join(", "),
  };

  const inputCoefficients = result.species.map((sp) => sp.given);
  if (inputCoefficients.some((c) => c !== 1)) {
    const matched = inputCoefficients.every((c, i) => c === result.coefficients[i]);
    out["Coefficients you typed"] = matched
      ? "Your coefficients were already the smallest whole number set."
      : `${inputCoefficients.join(", ")} (ignored: the balancer works them out from scratch)`;
  }

  result.species.forEach((sp, i) => {
    const label = `${sp.side === "left" ? "Reactant" : "Product"}: ${sp.display}`;
    const mass = showMasses ? `, ${speciesMass(sp).toFixed(3)} g/mol` : "";
    out[label] = `coefficient ${result.coefficients[i]}${mass}`;
  });

  for (const el of result.elements) {
    let leftAtoms = 0;
    let rightAtoms = 0;
    result.species.forEach((sp, i) => {
      const atoms = (sp.counts[el] ?? 0) * result.coefficients[i]!;
      if (sp.side === "left") leftAtoms += atoms;
      else rightAtoms += atoms;
    });
    out[`Balance check: ${el}`] =
      `${leftAtoms} left, ${rightAtoms} right${leftAtoms === rightAtoms ? ", balanced" : ", MISMATCH"}`;
  }

  if (result.species.some((sp) => sp.charge !== 0)) {
    let leftCharge = 0;
    let rightCharge = 0;
    result.species.forEach((sp, i) => {
      const q = sp.charge * result.coefficients[i]!;
      if (sp.side === "left") leftCharge += q;
      else rightCharge += q;
    });
    out["Balance check: charge"] =
      `${leftCharge > 0 ? "+" : ""}${leftCharge} left, ${rightCharge > 0 ? "+" : ""}${rightCharge} right${leftCharge === rightCharge ? ", balanced" : ", MISMATCH"}`;
  }

  return out;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, Partial<BalancerOpts>>;

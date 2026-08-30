import { ELEMENTS } from "../_generated/elements";
import { ToolError, type ToolLogic } from "../types";
import { ISOTOPE_TABLE, type ElementIsotopes, type IsotopeRow } from "./isotopes";

/**
 * Naturally occurring isotopes, their abundances, and what they add up to.
 *
 * The bundled table in ./isotopes.ts comes from the NIST Physical Measurement
 * Laboratory database "Atomic Weights and Isotopic Compositions with Relative
 * Atomic Masses", which republishes the IUPAC Commission on Isotopic Abundances
 * and Atomic Weights evaluations. It holds the 288 isotopes across 84 elements
 * that have a listed isotopic composition, which is the naturally occurring
 * set.
 *
 * The average atomic mass printed here is computed rather than looked up:
 *
 *   average = sum over isotopes of (fractional abundance x relative atomic mass)
 *
 * and is then compared against the published standard atomic weight, so the
 * arithmetic that connects the two is visible instead of assumed. For most
 * elements the two agree to five or six figures. For the elements whose
 * composition varies between natural sources, IUPAC publishes an interval
 * instead of a single number, and the comparison is made against its midpoint;
 * lithium is the extreme case, at about 0.4% apart.
 */

const NAME_BY_SYMBOL: Record<string, string> = {};
const SYMBOL_BY_NAME: Record<string, string> = {};
const SYMBOL_BY_NUMBER: Record<number, string> = {};
for (const el of ELEMENTS) {
  NAME_BY_SYMBOL[el.symbol] = el.name;
  SYMBOL_BY_NAME[el.name.toLowerCase()] = el.symbol;
  SYMBOL_BY_NUMBER[el.atomicNumber] = el.symbol;
}

const BY_SYMBOL: Record<string, ElementIsotopes> = {};
for (const entry of ISOTOPE_TABLE) BY_SYMBOL[entry.symbol.toLowerCase()] = entry;

export interface IsotopeOpts {
  /** "auto" reads the input, "element" forces a table, "mass" searches by exact mass. */
  mode: string;
  /** How far from the typed mass a match may sit, in unified atomic mass units. */
  massTolerance: number;
  decimals: number;
  [key: string]: unknown;
}

export interface Query {
  kind: "element" | "isotope" | "mass";
  /** The element symbol, for an element or isotope query. */
  symbol?: string;
  massNumber?: number;
  mass?: number;
}

/** The name of an element, from the periodic table snapshot. */
export function elementName(symbol: string): string {
  return NAME_BY_SYMBOL[symbol] ?? symbol;
}

function resolveSymbol(token: string): string | null {
  if (/^\d+$/.test(token)) return SYMBOL_BY_NUMBER[Number(token)] ?? null;
  const lower = token.toLowerCase();
  if (NAME_BY_SYMBOL[token]) return token;
  const bySymbol = ELEMENTS.find((e) => e.symbol.toLowerCase() === lower);
  if (bySymbol) return bySymbol.symbol;
  return SYMBOL_BY_NAME[lower] ?? null;
}

/** Read "C", "carbon", "6", "C-13", "13C" or "carbon-13". */
export function parseQuery(raw: string, mode = "auto"): Query {
  const text = (raw ?? "").trim();
  if (!text)
    throw new ToolError(
      "empty-input",
      "No element or isotope to look up.",
      'Type an element such as "C", "carbon" or "6", an isotope such as "C-13", or switch the mode to search by exact mass.',
    );

  if (mode === "mass") {
    const value = Number(text.replace(/\s*u$/i, ""));
    if (!Number.isFinite(value) || value <= 0)
      throw new ToolError(
        "bad-mass",
        `"${text}" is not a relative atomic mass.`,
        'Type a mass in unified atomic mass units, such as "34.96885" for chlorine 35.',
      );
    return { kind: "mass", mass: value };
  }

  const compact = text.replace(/\s+/g, "");
  const symbolFirst = /^([A-Za-z]+)[-\u2013_]?(\d+)$/.exec(compact);
  const numberFirst = /^(\d+)[-\u2013_]?([A-Za-z]+)$/.exec(compact);
  const pair = symbolFirst
    ? { name: symbolFirst[1]!, a: Number(symbolFirst[2]) }
    : numberFirst
      ? { name: numberFirst[2]!, a: Number(numberFirst[1]) }
      : null;

  if (pair && mode !== "element") {
    const symbol = resolveSymbol(pair.name);
    if (!symbol)
      throw new ToolError(
        "unknown-element",
        `"${pair.name}" is not an element symbol or name.`,
        'Use a symbol such as C, or a name such as carbon. Write an isotope as "C-13" or "13C".',
      );
    return { kind: "isotope", symbol, massNumber: pair.a };
  }

  const symbol = resolveSymbol(compact);
  if (!symbol)
    throw new ToolError(
      "unknown-element",
      `"${text}" is not an element symbol, name or atomic number.`,
      "Use a symbol such as Fe, a name such as iron, or an atomic number such as 26. American spellings are used, so it is sulfur, aluminum and cesium.",
    );
  return { kind: "element", symbol };
}

/** The bundled isotope table entry for an element, or a clear error. */
export function isotopesOf(symbol: string): ElementIsotopes {
  const entry = BY_SYMBOL[symbol.toLowerCase()];
  if (!entry)
    throw new ToolError(
      "no-natural-isotopes",
      `${elementName(symbol)} has no naturally occurring isotope with a measured abundance.`,
      "Technetium, promethium and most elements past bismuth are only ever made artificially, so there is nothing to average. Try a neighboring element.",
    );
  return entry;
}

/** Abundance weighted mean of the relative atomic masses, in u. */
export function averageAtomicMass(entry: ElementIsotopes): number {
  let weighted = 0;
  let total = 0;
  for (const [, mass, abundance] of entry.isotopes) {
    weighted += mass * abundance;
    total += abundance;
  }
  return total ? weighted / total : 0;
}

export interface MassMatch {
  symbol: string;
  row: IsotopeRow;
  difference: number;
}

/** Every naturally occurring isotope whose relative atomic mass is near `mass`. */
export function findByMass(mass: number, tolerance: number): MassMatch[] {
  const matches: MassMatch[] = [];
  for (const entry of ISOTOPE_TABLE) {
    for (const row of entry.isotopes) {
      const difference = row[1] - mass;
      if (Math.abs(difference) <= tolerance)
        matches.push({ symbol: entry.symbol, row, difference });
    }
  }
  matches.sort((a, b) => Math.abs(a.difference) - Math.abs(b.difference));
  return matches;
}

function fmt(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs < 10 ** -decimals || abs >= 1e9) return value.toExponential(Math.max(2, decimals - 1));
  return value.toFixed(decimals);
}

function clampDecimals(value: unknown, fallback = 6): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(10, Math.max(0, Math.round(n)));
}

const SOURCE =
  "NIST Physical Measurement Laboratory, Atomic Weights and Isotopic Compositions with Relative Atomic Masses (NIST Standard Reference Database 144), which republishes the IUPAC Commission on Isotopic Abundances and Atomic Weights evaluations.";

function elementRows(
  entry: ElementIsotopes,
  d: number,
  highlight?: number,
): Record<string, string> {
  const name = elementName(entry.symbol);
  const average = averageAtomicMass(entry);
  const abundanceTotal = entry.isotopes.reduce((a, r) => a + r[2], 0);
  const mostAbundant = entry.isotopes.reduce((a, r) => (r[2] > a[2] ? r : a), entry.isotopes[0]!);
  const interval = entry.weightText.startsWith("[");

  const out: Record<string, string> = {
    Element: `${name} (${entry.symbol}), atomic number ${entry.atomicNumber}`,
    "Naturally occurring isotopes": String(entry.isotopes.length),
    "Most abundant": `${entry.symbol}-${mostAbundant[0]} at ${(mostAbundant[2] * 100).toFixed(4)}%`,
  };

  if (highlight !== undefined) {
    const row = entry.isotopes.find((r) => r[0] === highlight);
    if (!row)
      throw new ToolError(
        "not-natural",
        `${entry.symbol}-${highlight} is not one of the naturally occurring isotopes of ${name}.`,
        `${name} occurs naturally as ${entry.isotopes.map((r) => `${entry.symbol}-${r[0]}`).join(", ")}. A radioisotope such as carbon 14 has no natural abundance in this table.`,
      );
    out["Isotope"] = `${entry.symbol}-${row[0]}`;
    out["Relative atomic mass"] = `${fmt(row[1], d)} u`;
    out["Natural abundance"] = `${(row[2] * 100).toFixed(Math.max(4, d))}%`;
    out["Mass contribution"] = `${fmt(row[1] * row[2], d)} u of the average`;
    out["Neutrons"] = String(row[0] - entry.atomicNumber);
  }

  for (const [a, mass, abundance] of entry.isotopes) {
    out[`${entry.symbol}-${a}`] =
      `${(abundance * 100).toFixed(Math.max(4, d))}% abundant, ${fmt(mass, d)} u, ${a - entry.atomicNumber} neutrons, contributes ${fmt(mass * abundance, d)} u`;
  }

  out["Computed average atomic mass"] = `${fmt(average, d)} u`;
  out["Standard atomic weight"] = `${entry.weightText} (IUPAC)`;
  out["Difference"] =
    `${fmt(average - entry.weight, d)} u, which is ${(((average - entry.weight) / entry.weight) * 100).toFixed(4)}% of the standard weight`;
  if (Math.abs(abundanceTotal - 1) > 1e-6)
    out["Abundance total"] =
      `${(abundanceTotal * 100).toFixed(4)}%, which is where the published values round to rather than an error in the table.`;
  if (interval)
    out["Interval note"] =
      "IUPAC publishes an interval rather than a single standard atomic weight for this element, because its isotopic composition varies measurably between natural sources. The comparison above is against the midpoint of that interval, so a difference of a fraction of a percent is expected.";
  out["Source"] = SOURCE;
  return out;
}

export function run(input: string, opts?: Partial<IsotopeOpts>): Record<string, string> {
  const mode = String(opts?.mode ?? "auto");
  const d = clampDecimals(opts?.decimals ?? 6);
  const query = parseQuery(input, mode);

  if (query.kind === "mass") {
    const rawTolerance = Number(opts?.massTolerance ?? 0.1);
    const tolerance =
      Number.isFinite(rawTolerance) && rawTolerance > 0 ? Math.min(5, rawTolerance) : 0.1;
    const matches = findByMass(query.mass!, tolerance);
    if (!matches.length)
      throw new ToolError(
        "no-mass-match",
        `No naturally occurring isotope has a relative atomic mass within ${tolerance} u of ${query.mass}.`,
        "Widen the mass tolerance option, or check the mass: relative atomic masses run from 1.008 for hydrogen 1 to about 238 for uranium 238.",
      );
    const out: Record<string, string> = {
      "Searched for": `${fmt(query.mass!, d)} u, within ${tolerance} u`,
      Matches: String(matches.length),
    };
    for (const match of matches.slice(0, 20)) {
      out[`${match.symbol}-${match.row[0]}`] =
        `${elementName(match.symbol)}, ${fmt(match.row[1], d)} u, off by ${fmt(match.difference, d)} u, ${(match.row[2] * 100).toFixed(4)}% abundant`;
    }
    if (matches.length > 20)
      out["More"] = `${matches.length - 20} further matches were left out; narrow the tolerance.`;
    out["Source"] = SOURCE;
    return out;
  }

  const entry = isotopesOf(query.symbol!);
  return elementRows(entry, d, query.massNumber);
}

export default { run } satisfies ToolLogic<string, Record<string, string>, Partial<IsotopeOpts>>;

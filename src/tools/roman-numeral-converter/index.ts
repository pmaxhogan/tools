import { ToolError, type ToolLogic } from "../types";

export interface RomanOpts {
  strict: boolean;
  useVinculum: boolean;
  [key: string]: unknown;
}

export type RomanResult = Record<string, string>;

const MAX_VALUE = 3_999_999;
const OVERLINE = "̅"; // combining overline, renders the vinculum above a letter.

const VALUES: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
const TABLE: [number, string][] = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];

/** Standard subtractive-notation table encoding. No upper bound (M just repeats), which is
 * how most modern converters render numbers above the classical 3999 cap when no vinculum is used. */
function toRomanBasic(n: number): { roman: string; parts: number[] } {
  let remaining = n;
  let roman = "";
  const parts: number[] = [];
  for (const [value, symbol] of TABLE) {
    while (remaining >= value) {
      roman += symbol;
      parts.push(value);
      remaining -= value;
    }
  }
  return { roman, parts };
}

/** Vinculum encoding: a thousands digit written with an overline stands for that value x 1000. */
function toRomanVinculum(n: number): string {
  const thousands = Math.floor(n / 1000);
  const remainder = n % 1000;
  if (thousands === 0) return toRomanBasic(remainder).roman;
  const thousandsRoman = toRomanBasic(thousands).roman;
  const overlined = [...thousandsRoman].map((c) => c + OVERLINE).join("");
  const remainderRoman = toRomanBasic(remainder).roman;
  return overlined + remainderRoman;
}

function encodeRomanString(n: number, useVinculum: boolean): string {
  if (useVinculum && n >= 4000) return toRomanVinculum(n);
  return toRomanBasic(n).roman;
}

const ROMAN_LETTERS = "IVXLCDMivxlcdm";

function isRomanInput(raw: string): boolean {
  const stripped = raw.replace(/\s+/g, "");
  if (!stripped) return false;
  if (stripped.toUpperCase() === "N") return true;
  return [...stripped].every((ch) => ROMAN_LETTERS.includes(ch) || ch === OVERLINE);
}

interface Token {
  char: string;
  overlined: boolean;
}

function tokenize(normalized: string): Token[] {
  const tokens: Token[] = [];
  for (const ch of normalized) {
    if (ch === OVERLINE) {
      if (tokens.length === 0) {
        throw new ToolError(
          "invalid-vinculum",
          "A vinculum mark appeared before any letter.",
          "Put the overline mark directly after the letter it covers.",
        );
      }
      tokens[tokens.length - 1]!.overlined = true;
    } else {
      tokens.push({ char: ch, overlined: false });
    }
  }
  return tokens;
}

/** Sums a run of Roman numeral characters using the standard subtractive rule (a smaller value
 * before a larger one is subtracted, otherwise added), returning the total and each signed step. */
function sumChars(chars: string[]): { value: number; signed: number[] } {
  const signed: number[] = [];
  let total = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    const v = VALUES[c];
    if (v === undefined) {
      throw new ToolError(
        "invalid-character",
        `"${c}" is not a Roman numeral character.`,
        "Use only the letters I, V, X, L, C, D, and M.",
      );
    }
    const next = chars[i + 1] ? VALUES[chars[i + 1]!] : undefined;
    const step = next !== undefined && v < next ? -v : v;
    signed.push(step);
    total += step;
  }
  return { value: total, signed };
}

function buildEncodeBreakdown(n: number, useVinculum: boolean): string {
  if (useVinculum && n >= 4000) {
    const thousands = Math.floor(n / 1000);
    const remainder = n % 1000;
    const remainderPart = remainder > 0 ? ` + ${remainder}` : "";
    return `${thousands} x 1000 (vinculum)${remainderPart} = ${n}`;
  }
  const { parts } = toRomanBasic(n);
  return parts.length ? `${parts.join(" + ")} = ${n}` : `0 = ${n}`;
}

function encodeRoman(n: number, useVinculum: boolean): RomanResult {
  if (n < 0 || n > MAX_VALUE) {
    throw new ToolError(
      "out-of-range",
      `${n} is outside this tool's supported range.`,
      "Enter a whole number from 0 to 3,999,999.",
    );
  }
  if (n === 0) {
    return {
      Direction: "Number to Roman",
      Roman: "N",
      Number: "0",
      Breakdown: "0 -> N (nulla, the medieval symbol for zero)",
    };
  }
  const useVinc = useVinculum && n >= 4000;
  const roman = encodeRomanString(n, useVinc);
  return {
    Direction: "Number to Roman",
    Roman: roman,
    Number: String(n),
    Breakdown: buildEncodeBreakdown(n, useVinc),
  };
}

function decodeRoman(raw: string, strict: boolean): RomanResult {
  const normalized = raw.replace(/\s+/g, "").toUpperCase();
  if (normalized === "N") {
    return {
      Direction: "Roman to number",
      Number: "0",
      Roman: "N",
      Breakdown: "N -> 0 (nulla, the medieval symbol for zero)",
    };
  }

  const tokens = tokenize(normalized);
  let i = 0;
  while (i < tokens.length && tokens[i]!.overlined) i++;
  const overlinedTokens = tokens.slice(0, i);
  const remainderTokens = tokens.slice(i);

  const overlinedSum = overlinedTokens.length
    ? sumChars(overlinedTokens.map((t) => t.char))
    : { value: 0, signed: [] as number[] };
  const remainderSum = sumChars(remainderTokens.map((t) => t.char));
  const value = overlinedSum.value * 1000 + remainderSum.value;

  if (value < 0 || value > MAX_VALUE) {
    throw new ToolError(
      "out-of-range",
      `${value} is outside this tool's supported range.`,
      "This tool supports Roman numerals from 0 (N) to 3,999,999.",
    );
  }

  if (strict) {
    const canonicalBasic = encodeRomanString(value, false);
    const canonicalVinculum = value >= 4000 ? encodeRomanString(value, true) : canonicalBasic;
    if (normalized !== canonicalBasic && normalized !== canonicalVinculum) {
      const alt = value >= 4000 ? ` (or "${canonicalVinculum}" with a vinculum)` : "";
      throw new ToolError(
        "non-canonical-roman-numeral",
        `"${raw.trim()}" is not the canonical Roman numeral for ${value}.`,
        `The canonical form of ${value} is "${canonicalBasic}"${alt}. Switch to lenient mode to accept non-canonical forms.`,
      );
    }
  }

  const breakdown = [
    ...overlinedTokens.map(
      (t, idx) =>
        `${t.char}${OVERLINE} -> ${overlinedSum.signed[idx]! * 1000 >= 0 ? "+" : ""}${overlinedSum.signed[idx]! * 1000} (x1000)`,
    ),
    ...remainderTokens.map(
      (t, idx) =>
        `${t.char} -> ${remainderSum.signed[idx]! >= 0 ? "+" : ""}${remainderSum.signed[idx]}`,
    ),
  ].join("\n");

  return {
    Direction: "Roman to number",
    Number: String(value),
    Roman: normalized,
    Breakdown: breakdown,
  };
}

export function run(input: string, opts: RomanOpts): RomanResult {
  const raw = input ?? "";
  if (!raw.trim())
    throw new ToolError(
      "empty-input",
      "Enter a Roman numeral or a whole number to convert.",
      'Type a number like "1994" or a Roman numeral like "MCMXCIV".',
    );

  if (isRomanInput(raw)) {
    return decodeRoman(raw, !!opts.strict);
  }

  if (!/^\d+$/.test(raw.trim())) {
    throw new ToolError(
      "invalid-input",
      `"${raw.trim()}" is not a whole number or a Roman numeral.`,
      'Enter digits only, like "1994", or Roman numeral letters, like "MCMXCIV".',
    );
  }

  const n = Number(raw.trim());
  return encodeRoman(n, !!opts.useVinculum);
}

export default { run } satisfies ToolLogic<string, RomanResult, RomanOpts>;

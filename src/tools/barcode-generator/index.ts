import { ToolError, type ToolLogic } from "../types";

/**
 * Hand rolled linear barcode encoders. Every pattern table below is embedded
 * verbatim from the published symbology specifications: a single wrong bar is
 * a scanner failure, so nothing here is derived from a library at runtime.
 *
 * Every encoder builds a full bit string first (1 = bar module, 0 = space
 * module) and then run length encodes it. That way two adjacent same color
 * elements can never be emitted as two runs by accident.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export const BARCODE_TYPES = [
  "code128",
  "ean13",
  "ean8",
  "upca",
  "upce",
  "code39",
  "itf14",
  "codabar",
] as const;
export type BarcodeType = (typeof BARCODE_TYPES)[number];

/** Human readable text positioned against the symbol, in module coordinates. */
export interface TextGroup {
  text: string;
  /** Left edge in modules, measured from the symbol's left edge. May be negative. */
  from: number;
  /** Right edge in modules. */
  to: number;
}

export interface EncodedBarcode {
  type: BarcodeType;
  /**
   * Element widths in modules, alternating bar, space, bar, and so on. The
   * first and last entries are always bars.
   */
  modules: number[];
  /** Symbol width in modules, excluding quiet zones. Equals the sum of `modules`. */
  width: number;
  /** The complete encoded value, including any check digit this tool computed. */
  value: string;
  /** The value as it is printed under the bars. */
  humanText: string;
  /** Where each piece of the human readable text sits, in module coordinates. */
  textGroups: TextGroup[];
  /** The check digit, when the symbology has one. */
  checkDigit?: string;
  /**
   * Module ranges whose bars are drawn full length, past the digits. EAN and
   * UPC guard bars use this.
   */
  longBarRanges: Array<[number, number]>;
  /** ITF-14 prints a solid frame (bearer bars) around the symbol. */
  bearerBars: boolean;
  /** Quiet zone the symbology needs on each side, in modules. */
  minQuietZone: number;
  /** Things the caller changed or computed, in plain language. */
  warnings: string[];
}

export interface EncodeOptions {
  /** Code 39 only: append the optional modulo 43 check character. */
  code39Check?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Bit helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Narrow element width in modules. */
const NARROW = 1;
/** Wide element width in modules. Two to one is legal for all three of the
 * two width symbologies at the module sizes this tool renders. */
const WIDE = 2;

/** Expand a numeric width pattern such as "212222" to bits, bar first. */
function widthsToBits(pattern: string): string {
  let out = "";
  let bar = true;
  for (const ch of pattern) {
    out += (bar ? "1" : "0").repeat(Number(ch));
    bar = !bar;
  }
  return out;
}

/** Expand a narrow/wide pattern such as "wnnnw" to bits, bar first. */
function nwToBits(pattern: string): string {
  let out = "";
  let bar = true;
  for (const ch of pattern) {
    out += (bar ? "1" : "0").repeat(ch === "w" ? WIDE : NARROW);
    bar = !bar;
  }
  return out;
}

/**
 * Run length encode a bit string into element widths. The result alternates
 * bar, space, bar, and so on, so the input must start with a bar.
 */
export function bitsToModules(bits: string): number[] {
  if (!bits.startsWith("1")) throw new Error("barcode bit string must start with a bar");
  const runs: number[] = [];
  let current = "1";
  let count = 0;
  for (const bit of bits) {
    if (bit === current) {
      count += 1;
    } else {
      runs.push(count);
      current = bit;
      count = 1;
    }
  }
  runs.push(count);
  return runs;
}

/* -------------------------------------------------------------------------- */
/* Code 128                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The 107 Code 128 symbol patterns (ISO/IEC 15417). Each entry is six element
 * widths, bar first, summing to eleven modules. Index 106 is the stop pattern,
 * which is the one exception: seven elements summing to thirteen.
 */
// prettier-ignore
export const CODE128_PATTERNS: readonly string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
  "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
  "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
  "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
  "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
  "211214", "211232", "2331112",
];

const CODE128_START_A = 103;
const CODE128_START_B = 104;
const CODE128_START_C = 105;
const CODE128_STOP = 106;
/** Switch the reader into the named code set for the rest of the symbol. */
const CODE128_CODE_A = 101;
const CODE128_CODE_B = 100;
const CODE128_CODE_C = 99;
/** Shift the next character only into the other of code set A and B. */
const CODE128_SHIFT = 98;

type Code128Set = "A" | "B" | "C";

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

function digitRun(text: string, from: number): number {
  let n = 0;
  while (isDigit(text[from + n])) n += 1;
  return n;
}

/** Value of a character in code set A, or -1 when it has none. */
function code128ValueA(code: number): number {
  if (code >= 32 && code <= 95) return code - 32;
  if (code >= 0 && code <= 31) return code + 64;
  return -1;
}

/** Value of a character in code set B, or -1 when it has none. */
function code128ValueB(code: number): number {
  if (code >= 32 && code <= 126) return code - 32;
  return -1;
}

function describeChar(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  const hex = code.toString(16).toUpperCase().padStart(4, "0");
  const printable = code >= 32 && code <= 126 ? `"${ch}"` : "a control character";
  return `${printable} (U+${hex})`;
}

function rejectChar(ch: string, symbology: string, fix: string): never {
  throw new ToolError(
    "invalid-chars",
    `${symbology} cannot encode the character ${describeChar(ch)}.`,
    fix,
  );
}

/**
 * Pick code set A or B for the text starting at `from`: A when a control
 * character turns up before any lowercase letter, otherwise B.
 */
function chooseAB(text: string, from: number): Code128Set {
  for (let i = from; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32) return "A";
    if (code >= 97 && code <= 122) return "B";
  }
  return "B";
}

/**
 * Turn text into the full Code 128 symbol value list: start character, data,
 * check character, stop character. The code set selection follows the standard
 * optimization: start in C when the data opens with four or more digits (or is
 * an even run of digits end to end), otherwise A when a control character
 * precedes any lowercase letter, otherwise B; then switch into C for any run
 * of four or more digits and back out again when the digits run out.
 */
export function code128Symbols(text: string): number[] {
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const code = text.charCodeAt(i);
    if (code > 126)
      rejectChar(
        text[i]!,
        "Code 128",
        "Code 128 covers ASCII 0 to 126 only. Remove accented or emoji characters.",
      );
  }

  const leading = digitRun(text, 0);
  let mode: Code128Set;
  if (leading >= 4 || (leading === n && n >= 2 && n % 2 === 0)) mode = "C";
  else mode = chooseAB(text, 0);

  const values: number[] = [
    mode === "A" ? CODE128_START_A : mode === "B" ? CODE128_START_B : CODE128_START_C,
  ];

  let i = 0;
  while (i < n) {
    if (mode === "C") {
      if (digitRun(text, i) >= 2) {
        values.push(Number(text.slice(i, i + 2)));
        i += 2;
        continue;
      }
      mode = chooseAB(text, i);
      values.push(mode === "A" ? CODE128_CODE_A : CODE128_CODE_B);
      continue;
    }

    const run = digitRun(text, i);
    if (run >= 4) {
      if (run % 2 === 1) {
        // Encode one digit here so the remaining run is an even number of
        // digits, which is what code set C needs.
        values.push(
          mode === "A" ? code128ValueA(text.charCodeAt(i)) : code128ValueB(text.charCodeAt(i)),
        );
        i += 1;
      }
      values.push(CODE128_CODE_C);
      mode = "C";
      continue;
    }

    const code = text.charCodeAt(i);
    const here = mode === "A" ? code128ValueA(code) : code128ValueB(code);
    if (here >= 0) {
      values.push(here);
      i += 1;
      continue;
    }

    const other: Code128Set = mode === "A" ? "B" : "A";
    const there = other === "A" ? code128ValueA(code) : code128ValueB(code);
    if (there < 0)
      rejectChar(text[i]!, "Code 128", "Remove the character or use a different symbology.");

    const nextCode = i + 1 < n ? text.charCodeAt(i + 1) : -1;
    const nextFitsHere =
      nextCode < 0 || (mode === "A" ? code128ValueA(nextCode) : code128ValueB(nextCode)) >= 0;
    if (nextFitsHere) {
      values.push(CODE128_SHIFT, there);
      i += 1;
      continue;
    }
    values.push(other === "A" ? CODE128_CODE_A : CODE128_CODE_B);
    mode = other;
  }

  values.push(code128Checksum(values), CODE128_STOP);
  return values;
}

/**
 * The Code 128 check character: the start value plus each data value times its
 * one based position, modulo 103. Pass the value list including its start
 * character and nothing after the data.
 */
export function code128Checksum(values: number[]): number {
  let sum = values[0] ?? 0;
  for (let i = 1; i < values.length; i++) sum += values[i]! * i;
  return sum % 103;
}

function encodeCode128(text: string): EncodedBarcode {
  const values = code128Symbols(text);
  const bits = values.map((v) => widthsToBits(CODE128_PATTERNS[v]!)).join("");
  const modules = bitsToModules(bits);
  const width = bits.length;
  return {
    type: "code128",
    modules,
    width,
    value: text,
    humanText: text,
    textGroups: [{ text, from: 0, to: width }],
    longBarRanges: [],
    bearerBars: false,
    minQuietZone: 10,
    warnings: [],
  };
}

/* -------------------------------------------------------------------------- */
/* EAN and UPC                                                                */
/* -------------------------------------------------------------------------- */

/** Odd parity left hand digit patterns (the "A" set). */
// prettier-ignore
export const EAN_L_CODES: readonly string[] = [
  "0001101", "0011001", "0010011", "0111101", "0100011",
  "0110001", "0101111", "0111011", "0110111", "0001011",
];
/** Right hand digit patterns: the bitwise complement of the L codes. */
export const EAN_R_CODES: readonly string[] = EAN_L_CODES.map((p) =>
  p.replace(/[01]/g, (b) => (b === "0" ? "1" : "0")),
);
/** Even parity left hand digit patterns: the R codes read backwards. */
export const EAN_G_CODES: readonly string[] = EAN_R_CODES.map((p) =>
  p.split("").reverse().join(""),
);

/** Which of the first six EAN-13 digits use the even parity set, by lead digit. */
// prettier-ignore
export const EAN13_PARITY: readonly string[] = [
  "LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG",
  "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL",
];

/**
 * UPC-E parity by UPC-A check digit, for number system 0. O means the odd
 * parity (L) set, E means the even parity (G) set. Number system 1 uses the
 * exact inverse.
 */
// prettier-ignore
export const UPCE_PARITY: readonly string[] = [
  "EEEOOO", "EEOEOO", "EEOOEO", "EEOOOE", "EOEEOO",
  "EOOEEO", "EOOOEE", "EOEOEO", "EOEOOE", "EOOEOE",
];

/**
 * The GS1 modulo 10 check digit. Weights alternate three and one starting from
 * the rightmost data digit, which makes one function correct for EAN-13,
 * EAN-8, UPC-A, UPC-E and ITF-14 alike.
 */
export function gs1CheckDigit(digits: string): string {
  let sum = 0;
  let weight = 3;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += Number(digits[i]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return String((10 - (sum % 10)) % 10);
}

function requireDigits(value: string, symbology: string): string {
  const bad = /[^0-9]/.exec(value);
  if (bad)
    rejectChar(
      bad[0],
      symbology,
      `${symbology} holds digits only. Strip spaces, hyphens and letters first.`,
    );
  return value;
}

/**
 * Normalize a fixed length numeric code: accept the body without its check
 * digit and compute one, or accept the full code and validate the check digit
 * that is already there.
 */
function resolveNumeric(
  raw: string,
  bodyLength: number,
  symbology: string,
): { value: string; checkDigit: string; warnings: string[] } {
  const digits = requireDigits(raw, symbology);
  const warnings: string[] = [];
  if (digits.length === bodyLength) {
    const check = gs1CheckDigit(digits);
    warnings.push(`Check digit ${check} computed and appended.`);
    return { value: digits + check, checkDigit: check, warnings };
  }
  if (digits.length === bodyLength + 1) {
    const expected = gs1CheckDigit(digits.slice(0, bodyLength));
    if (expected !== digits[bodyLength])
      throw new ToolError(
        "bad-check-digit",
        `${symbology} check digit is wrong: ${digits} ends in ${digits[bodyLength]} but should end in ${expected}.`,
        `Enter the first ${bodyLength} digits and the check digit is calculated for you.`,
      );
    return { value: digits, checkDigit: expected, warnings };
  }
  throw new ToolError(
    "invalid-length",
    `${symbology} needs ${bodyLength} digits, or ${bodyLength + 1} with the check digit. You gave ${digits.length}.`,
    `Enter ${bodyLength} digits and the check digit is added for you.`,
  );
}

/** Build the 95 module EAN-13 bit string from thirteen digits. */
export function ean13Bits(value: string): string {
  const parity = EAN13_PARITY[Number(value[0])]!;
  let bits = "101";
  for (let i = 1; i <= 6; i++) {
    const digit = Number(value[i]);
    bits += parity[i - 1] === "L" ? EAN_L_CODES[digit]! : EAN_G_CODES[digit]!;
  }
  bits += "01010";
  for (let i = 7; i <= 12; i++) bits += EAN_R_CODES[Number(value[i])]!;
  return bits + "101";
}

/** Build the 67 module EAN-8 bit string from eight digits. */
export function ean8Bits(value: string): string {
  let bits = "101";
  for (let i = 0; i < 4; i++) bits += EAN_L_CODES[Number(value[i])]!;
  bits += "01010";
  for (let i = 4; i < 8; i++) bits += EAN_R_CODES[Number(value[i])]!;
  return bits + "101";
}

/** Build the 51 module UPC-E bit string. `value` is the eight digit form. */
export function upceBits(value: string): string {
  const system = Number(value[0]);
  const check = Number(value[7]);
  const base = UPCE_PARITY[check]!;
  const parity = system === 1 ? base.replace(/[OE]/g, (c) => (c === "O" ? "E" : "O")) : base;
  let bits = "101";
  for (let i = 0; i < 6; i++) {
    const digit = Number(value[i + 1]);
    bits += parity[i] === "O" ? EAN_L_CODES[digit]! : EAN_G_CODES[digit]!;
  }
  return bits + "010101";
}

function encodeEan13(raw: string): EncodedBarcode {
  const { value, checkDigit, warnings } = resolveNumeric(raw, 12, "EAN-13");
  const bits = ean13Bits(value);
  return {
    type: "ean13",
    modules: bitsToModules(bits),
    width: bits.length,
    value,
    checkDigit,
    humanText: `${value.slice(0, 1)} ${value.slice(1, 7)} ${value.slice(7)}`,
    textGroups: [
      { text: value.slice(0, 1), from: -9, to: -1 },
      { text: value.slice(1, 7), from: 3, to: 45 },
      { text: value.slice(7), from: 50, to: 92 },
    ],
    longBarRanges: [
      [0, 3],
      [45, 50],
      [92, 95],
    ],
    bearerBars: false,
    minQuietZone: 11,
    warnings,
  };
}

function encodeEan8(raw: string): EncodedBarcode {
  const { value, checkDigit, warnings } = resolveNumeric(raw, 7, "EAN-8");
  const bits = ean8Bits(value);
  return {
    type: "ean8",
    modules: bitsToModules(bits),
    width: bits.length,
    value,
    checkDigit,
    humanText: `${value.slice(0, 4)} ${value.slice(4)}`,
    textGroups: [
      { text: value.slice(0, 4), from: 3, to: 31 },
      { text: value.slice(4), from: 36, to: 64 },
    ],
    longBarRanges: [
      [0, 3],
      [31, 36],
      [64, 67],
    ],
    bearerBars: false,
    minQuietZone: 7,
    warnings,
  };
}

function encodeUpcA(raw: string): EncodedBarcode {
  const { value, checkDigit, warnings } = resolveNumeric(raw, 11, "UPC-A");
  // UPC-A is EAN-13 with a leading zero, bar for bar. Only the printed text
  // layout differs, so it shares one bit generator.
  const bits = ean13Bits(`0${value}`);
  return {
    type: "upca",
    modules: bitsToModules(bits),
    width: bits.length,
    value,
    checkDigit,
    humanText: `${value.slice(0, 1)} ${value.slice(1, 6)} ${value.slice(6, 11)} ${value.slice(11)}`,
    textGroups: [
      { text: value.slice(0, 1), from: -9, to: -1 },
      { text: value.slice(1, 6), from: 10, to: 45 },
      { text: value.slice(6, 11), from: 50, to: 85 },
      { text: value.slice(11), from: 96, to: 104 },
    ],
    // The three guard patterns, plus the number system and check digit
    // characters: UPC-A drops those two outside the row of digits, so their
    // bars run full length the way the guards do.
    longBarRanges: [
      [0, 3],
      [3, 10],
      [45, 50],
      [85, 92],
      [92, 95],
    ],
    bearerBars: false,
    minQuietZone: 11,
    warnings,
  };
}

/**
 * Expand a six digit UPC-E body plus its number system into the eleven digit
 * UPC-A body (number system included, check digit excluded). The four rules
 * are selected by the last UPC-E digit.
 */
export function upceToUpcaBody(system: string, six: string): string {
  const d = six;
  const last = d[5]!;
  // Each branch rebuilds the five digit manufacturer code and the five digit
  // item code from the compressed form, then hands back the eleven digits that
  // the check digit is calculated over.
  if (last === "0" || last === "1" || last === "2")
    return `${system}${d[0]}${d[1]}${last}00` + `00${d[2]}${d[3]}${d[4]}`;
  if (last === "3") return `${system}${d[0]}${d[1]}${d[2]}00` + `000${d[3]}${d[4]}`;
  if (last === "4") return `${system}${d[0]}${d[1]}${d[2]}${d[3]}0` + `0000${d[4]}`;
  return `${system}${d[0]}${d[1]}${d[2]}${d[3]}${d[4]}` + `0000${last}`;
}

/**
 * Compress a twelve digit UPC-A into its six digit UPC-E body, or return null
 * when the number does not fit any of the four compression rules.
 */
export function upcaToUpce(upca: string): string | null {
  const system = upca[0]!;
  if (system !== "0" && system !== "1") return null;
  const m = upca.slice(1, 6);
  const item = upca.slice(6, 11);
  if (m[3] === "0" && m[4] === "0" && Number(m[2]) <= 2 && item.slice(0, 2) === "00")
    return `${m[0]}${m[1]}${item[2]}${item[3]}${item[4]}${m[2]}`;
  if (m[3] === "0" && m[4] === "0" && item.slice(0, 3) === "000")
    return `${m[0]}${m[1]}${m[2]}${item[3]}${item[4]}3`;
  if (m[4] === "0" && item.slice(0, 4) === "0000") return `${m[0]}${m[1]}${m[2]}${m[3]}${item[4]}4`;
  if (item.slice(0, 4) === "0000" && Number(item[4]) >= 5)
    return `${m[0]}${m[1]}${m[2]}${m[3]}${m[4]}${item[4]}`;
  return null;
}

/**
 * Accept any of the UPC-E input forms: six digits (number system 0 assumed),
 * seven digits (leading number system), eight digits (system plus check), or a
 * full UPC-A that compresses.
 */
export function resolveUpce(raw: string): {
  value: string;
  checkDigit: string;
  warnings: string[];
} {
  const digits = requireDigits(raw, "UPC-E");
  const warnings: string[] = [];
  let system = "0";
  let six: string;
  let given: string | undefined;

  if (digits.length === 6) {
    six = digits;
    warnings.push("Number system 0 assumed.");
  } else if (digits.length === 7) {
    system = digits[0]!;
    six = digits.slice(1);
  } else if (digits.length === 8) {
    system = digits[0]!;
    six = digits.slice(1, 7);
    given = digits[7];
  } else if (digits.length === 11 || digits.length === 12) {
    const full = digits.length === 11 ? digits + gs1CheckDigit(digits) : digits;
    if (digits.length === 12) {
      const expected = gs1CheckDigit(digits.slice(0, 11));
      if (expected !== digits[11])
        throw new ToolError(
          "bad-check-digit",
          `UPC-A check digit is wrong: ${digits} ends in ${digits[11]} but should end in ${expected}.`,
          "Enter the first 11 digits and the check digit is calculated for you.",
        );
    }
    const compressed = upcaToUpce(full);
    if (!compressed)
      throw new ToolError(
        "not-compressible",
        `UPC-A ${full} has no UPC-E form: only numbers with the right run of zeros compress.`,
        "Use the UPC-A symbology for this number, or pick a UPC-E number directly.",
      );
    system = full[0]!;
    six = compressed;
    warnings.push(`Compressed from UPC-A ${full}.`);
  } else {
    throw new ToolError(
      "invalid-length",
      `UPC-E needs 6, 7 or 8 digits, or a full 11 or 12 digit UPC-A to compress. You gave ${digits.length}.`,
      "Enter the six digit UPC-E body, or paste the whole UPC-A.",
    );
  }

  if (system !== "0" && system !== "1")
    throw new ToolError(
      "invalid-chars",
      `UPC-E number system must be 0 or 1, not ${system}.`,
      "Drop the leading digit to use number system 0.",
    );

  const check = gs1CheckDigit(upceToUpcaBody(system, six));
  if (given !== undefined && given !== check)
    throw new ToolError(
      "bad-check-digit",
      `UPC-E check digit is wrong: ${digits} ends in ${given} but should end in ${check}.`,
      "Enter the seven digit form and the check digit is calculated for you.",
    );
  if (given === undefined) warnings.push(`Check digit ${check} computed and appended.`);

  return { value: `${system}${six}${check}`, checkDigit: check, warnings };
}

function encodeUpcE(raw: string): EncodedBarcode {
  const { value, checkDigit, warnings } = resolveUpce(raw);
  const bits = upceBits(value);
  return {
    type: "upce",
    modules: bitsToModules(bits),
    width: bits.length,
    value,
    checkDigit,
    humanText: `${value.slice(0, 1)} ${value.slice(1, 7)} ${value.slice(7)}`,
    textGroups: [
      { text: value.slice(0, 1), from: -9, to: -1 },
      { text: value.slice(1, 7), from: 3, to: 45 },
      { text: value.slice(7), from: 52, to: 60 },
    ],
    longBarRanges: [
      [0, 3],
      [45, 51],
    ],
    bearerBars: false,
    minQuietZone: 9,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Code 39                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Code 39 is built from a grid rather than transcribed, because the grid is
 * the actual structure of the symbology and a typed table invites a silent
 * off by one. Every character is five bars and four spaces; two of the bars
 * are wide and one of the spaces is wide. The bar pattern cycles through ten
 * arrangements while the wide space walks across four positions.
 */
// prettier-ignore
const CODE39_BAR_PATTERNS = [
  "wnnnw", "nwnnw", "wwnnn", "nnwnw", "wnwnn",
  "nwwnn", "nnnww", "wnnwn", "nwnwn", "nnwwn",
];
const CODE39_SPACE_PATTERNS = ["nwnn", "nnwn", "nnnw", "wnnn"];
const CODE39_GROUPS = ["1234567890", "ABCDEFGHIJ", "KLMNOPQRST", "UVWXYZ-. *"];
/** The four punctuation characters use no wide bars and three wide spaces. */
const CODE39_SPECIAL_SPACES: Array<[string, string]> = [
  ["$", "wwwn"],
  ["/", "wwnw"],
  ["+", "wnww"],
  ["%", "nwww"],
];

function interleave(bars: string, spaces: string): string {
  let out = "";
  for (let i = 0; i < 5; i++) {
    out += bars[i];
    if (i < 4) out += spaces[i];
  }
  return out;
}

function buildCode39Table(): Record<string, string> {
  const table: Record<string, string> = {};
  CODE39_GROUPS.forEach((chars, group) => {
    const spaces = CODE39_SPACE_PATTERNS[group]!;
    for (let i = 0; i < chars.length; i++) {
      table[chars[i]!] = interleave(CODE39_BAR_PATTERNS[i]!, spaces);
    }
  });
  for (const [ch, spaces] of CODE39_SPECIAL_SPACES) table[ch] = interleave("nnnnn", spaces);
  return table;
}

export const CODE39_TABLE: Readonly<Record<string, string>> = buildCode39Table();

/** Character values for the optional modulo 43 check character. */
export const CODE39_VALUES = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%";

/** The optional Code 39 modulo 43 check character for a data string. */
export function code39CheckChar(data: string): string {
  let sum = 0;
  for (const ch of data) {
    const value = CODE39_VALUES.indexOf(ch);
    if (value < 0) rejectChar(ch, "Code 39", "Use A to Z, 0 to 9, space, or - . $ / + %.");
    sum += value;
  }
  return CODE39_VALUES[sum % 43]!;
}

function encodeCode39(raw: string, options: EncodeOptions): EncodedBarcode {
  const warnings: string[] = [];
  let data = raw.replace(/^\*+/, "").replace(/\*+$/, "");
  if (/[a-z]/.test(data)) {
    data = data.toUpperCase();
    warnings.push("Lowercase letters were uppercased: Code 39 has no lowercase.");
  }
  if (!data)
    throw new ToolError(
      "empty-input",
      "Code 39 needs at least one character between the start and stop marks.",
      "Enter the text to encode, for example PART-12345.",
    );
  for (const ch of data) {
    if (ch === "*")
      throw new ToolError(
        "invalid-chars",
        "Code 39 reserves the asterisk for the start and stop marks.",
        "Remove the asterisks from the middle of the text; they are added automatically.",
      );
    if (!(ch in CODE39_TABLE))
      rejectChar(ch, "Code 39", "Use A to Z, 0 to 9, space, or - . $ / + %.");
  }

  let checkDigit: string | undefined;
  if (options.code39Check) {
    checkDigit = code39CheckChar(data);
    data += checkDigit;
    warnings.push(`Modulo 43 check character ${checkDigit} appended.`);
  }

  const framed = `*${data}*`;
  const bits = framed
    .split("")
    .map((ch) => nwToBits(CODE39_TABLE[ch]!))
    .join("0"); // one narrow space between characters
  const modules = bitsToModules(bits);
  return {
    type: "code39",
    modules,
    width: bits.length,
    value: data,
    checkDigit,
    humanText: framed,
    textGroups: [{ text: framed, from: 0, to: bits.length }],
    longBarRanges: [],
    bearerBars: false,
    minQuietZone: 10,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Interleaved 2 of 5 and ITF-14                                              */
/* -------------------------------------------------------------------------- */

/**
 * The 2 of 5 digit patterns: five elements, two of them wide. These are the
 * same ten arrangements Code 39 uses for its bars, which is not a coincidence.
 */
// prettier-ignore
export const ITF_PATTERNS = [
  "nnwwn", "wnnnw", "nwnnw", "wwnnn", "nnwnw",
  "wnwnn", "nwwnn", "nnnww", "wnnwn", "nwnwn",
];

/**
 * Interleave a digit pair: the first digit's five elements become bars and the
 * second digit's five become the spaces between them.
 */
function itfPairBits(a: number, b: number): string {
  const bars = ITF_PATTERNS[a]!;
  const spaces = ITF_PATTERNS[b]!;
  let bits = "";
  for (let i = 0; i < 5; i++) {
    bits += "1".repeat(bars[i] === "w" ? WIDE : NARROW);
    bits += "0".repeat(spaces[i] === "w" ? WIDE : NARROW);
  }
  return bits;
}

function encodeItf14(raw: string): EncodedBarcode {
  const { value, checkDigit, warnings } = resolveNumeric(raw, 13, "ITF-14");
  let bits = "1010"; // start: narrow bar, narrow space, narrow bar, narrow space
  for (let i = 0; i < value.length; i += 2)
    bits += itfPairBits(Number(value[i]), Number(value[i + 1]));
  bits += "1101"; // stop: wide bar, narrow space, narrow bar
  return {
    type: "itf14",
    modules: bitsToModules(bits),
    width: bits.length,
    value,
    checkDigit,
    humanText: `${value.slice(0, 1)} ${value.slice(1, 3)} ${value.slice(3, 8)} ${value.slice(8, 13)} ${value.slice(13)}`,
    textGroups: [
      {
        text: `${value.slice(0, 1)} ${value.slice(1, 3)} ${value.slice(3, 8)} ${value.slice(8, 13)} ${value.slice(13)}`,
        from: 0,
        to: bits.length,
      },
    ],
    longBarRanges: [],
    bearerBars: true,
    minQuietZone: 10,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Codabar                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Codabar (also sold as NW-7 and Code 2 of 7). Seven elements per character,
 * bar first. Digits and the two currency style marks carry two wide elements;
 * the four punctuation marks and the four start/stop letters carry three.
 */
export const CODABAR_TABLE: Readonly<Record<string, string>> = {
  "0": "nnnnnww",
  "1": "nnnnwwn",
  "2": "nnnwnnw",
  "3": "wwnnnnn",
  "4": "nnwnnwn",
  "5": "wnnnnwn",
  "6": "nwnnnnw",
  "7": "nwnnwnn",
  "8": "nwwnnnn",
  "9": "wnnwnnn",
  "-": "nnnwwnn",
  $: "nnwwnnn",
  ":": "wnnnwnw",
  "/": "wnwnnnw",
  ".": "wnwnwnn",
  "+": "nnwnwnw",
  A: "nnwwnwn",
  B: "nwnwnnw",
  C: "nnnwnww",
  D: "nnnwwwn",
};

/** Alternate names for the four start and stop characters. */
const CODABAR_ALIASES: Record<string, string> = { T: "A", N: "B", "*": "C", E: "D" };

function encodeCodabar(raw: string): EncodedBarcode {
  const warnings: string[] = [];
  let text = raw.toUpperCase().replace(/\s+/g, "");
  if (/[a-z]/.test(raw)) warnings.push("Start and stop letters were uppercased.");
  text = text
    .split("")
    .map((ch) => (ch in CODABAR_ALIASES && CODABAR_ALIASES[ch] ? CODABAR_ALIASES[ch]! : ch))
    .join("");

  const isStartStop = (ch: string | undefined) =>
    ch === "A" || ch === "B" || ch === "C" || ch === "D";
  const framed = text.length >= 3 && isStartStop(text[0]) && isStartStop(text[text.length - 1]);
  if (!framed) {
    if (text.split("").some(isStartStop))
      throw new ToolError(
        "invalid-chars",
        "Codabar start and stop letters (A, B, C, D) belong at both ends or at neither.",
        "Write the value as A1234A, or leave the letters off and A is added at both ends.",
      );
    text = `A${text}A`;
    warnings.push("Start and stop character A added at both ends.");
  }

  const body = text.slice(1, -1);
  if (!body)
    throw new ToolError(
      "empty-input",
      "Codabar needs at least one character between the start and stop letters.",
      "Enter the value to encode, for example 1234567.",
    );
  for (const ch of body) {
    if (isStartStop(ch))
      throw new ToolError(
        "invalid-chars",
        "Codabar start and stop letters (A, B, C, D) may only appear at the two ends.",
        "Remove the letter from the middle of the value.",
      );
    if (!(ch in CODABAR_TABLE))
      rejectChar(ch, "Codabar", "Codabar holds 0 to 9 and the marks - $ : / . + only.");
  }

  const bits = text
    .split("")
    .map((ch) => nwToBits(CODABAR_TABLE[ch]!))
    .join("0"); // one narrow space between characters
  return {
    type: "codabar",
    modules: bitsToModules(bits),
    width: bits.length,
    value: text,
    humanText: text,
    textGroups: [{ text, from: 0, to: bits.length }],
    longBarRanges: [],
    bearerBars: false,
    minQuietZone: 10,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* The encoder front door                                                     */
/* -------------------------------------------------------------------------- */

const TYPE_ALIASES: Record<string, BarcodeType> = {
  code128: "code128",
  "code-128": "code128",
  "code 128": "code128",
  c128: "code128",
  ean13: "ean13",
  "ean-13": "ean13",
  ean: "ean13",
  ean8: "ean8",
  "ean-8": "ean8",
  upca: "upca",
  "upc-a": "upca",
  upc: "upca",
  upce: "upce",
  "upc-e": "upce",
  code39: "code39",
  "code-39": "code39",
  "code 39": "code39",
  c39: "code39",
  "3of9": "code39",
  itf14: "itf14",
  "itf-14": "itf14",
  itf: "itf14",
  "2of5": "itf14",
  codabar: "codabar",
  "nw-7": "codabar",
  nw7: "codabar",
};

/** Resolve a symbology name, accepting the common spellings. */
export function normaliseType(value: unknown): BarcodeType {
  const raw = String(value ?? "code128")
    .trim()
    .toLowerCase();
  if (!raw) return "code128";
  const found = TYPE_ALIASES[raw];
  if (!found)
    throw new ToolError(
      "bad-option",
      `Unknown barcode type "${raw}".`,
      `Choose one of ${BARCODE_TYPES.join(", ")}.`,
    );
  return found;
}

/**
 * Encode one value into bar and space widths. `modules` alternates bar, space,
 * bar and so on, always starting and ending with a bar.
 */
export function encode(
  text: string,
  type: BarcodeType,
  options: EncodeOptions = {},
): EncodedBarcode {
  const value = String(text ?? "").trim();
  if (!value)
    throw new ToolError(
      "empty-input",
      "Enter the value you want turned into a barcode.",
      "Type a product number, a part number, or any text for Code 128.",
    );

  switch (type) {
    case "code128":
      return encodeCode128(value);
    case "ean13":
      return encodeEan13(value.replace(/[\s-]/g, ""));
    case "ean8":
      return encodeEan8(value.replace(/[\s-]/g, ""));
    case "upca":
      return encodeUpcA(value.replace(/[\s-]/g, ""));
    case "upce":
      return encodeUpcE(value.replace(/[\s-]/g, ""));
    case "code39":
      return encodeCode39(value, options);
    case "itf14":
      return encodeItf14(value.replace(/[\s-]/g, ""));
    case "codabar":
      return encodeCodabar(value);
  }
}

/* -------------------------------------------------------------------------- */
/* SVG rendering                                                              */
/* -------------------------------------------------------------------------- */

const SVG_NS = "http://www.w3.org/2000/svg";
const FONT_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Trim a coordinate to three decimals so the output stays byte for byte stable. */
function r(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function rect(x: number, y: number, w: number, h: number, fill: string): string {
  return `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="${fill}"/>`;
}

export interface RenderBarcodeOptions {
  /** Width of one module. Pixels in single mode, millimeters on a sheet. */
  moduleWidth?: number;
  /** Bar height, in the same unit as `moduleWidth`. */
  height?: number;
  showText?: boolean;
  /** Quiet zone on each side, in modules. Raised to the symbology minimum. */
  quietZone?: number;
  fontSize?: number;
  color?: string;
  /** Background fill, or "none" to leave the page showing through. */
  background?: string;
}

interface Geometry {
  moduleWidth: number;
  barHeight: number;
  quietZone: number;
  showText: boolean;
  fontSize: number;
  color: string;
}

function inLongRange(enc: EncodedBarcode, from: number, to: number): boolean {
  return enc.longBarRanges.some(([a, b]) => from >= a && to <= b);
}

/**
 * Draw one barcode into a coordinate space whose origin is its top left
 * corner. Shared by the single symbol renderer and the sheet renderer so both
 * stay pixel identical.
 */
function barcodeBody(
  enc: EncodedBarcode,
  g: Geometry,
): { markup: string; width: number; height: number } {
  const mw = g.moduleWidth;
  const bearer = enc.bearerBars ? mw * 4.5 : 0;
  const textBand = g.showText ? g.fontSize * 1.35 : 0;
  const longExtra = g.showText ? textBand * 0.75 : 0;
  const width = (enc.width + g.quietZone * 2) * mw + bearer * 2;
  const height = g.barHeight + textBand + bearer * 2;

  const parts: string[] = [];
  if (bearer > 0) {
    parts.push(rect(0, 0, width, bearer, g.color));
    parts.push(rect(0, height - bearer, width, bearer, g.color));
    parts.push(rect(0, 0, bearer, height, g.color));
    parts.push(rect(width - bearer, 0, bearer, height, g.color));
  }

  const originX = bearer + g.quietZone * mw;
  const originY = bearer;

  let cursor = 0;
  for (let i = 0; i < enc.modules.length; i++) {
    const w = enc.modules[i]!;
    if (i % 2 === 0) {
      const long = inLongRange(enc, cursor, cursor + w);
      parts.push(
        rect(originX + cursor * mw, originY, w * mw, g.barHeight + (long ? longExtra : 0), g.color),
      );
    }
    cursor += w;
  }

  if (g.showText) {
    const baseline = originY + g.barHeight + g.fontSize * 1.05;
    for (const group of enc.textGroups) {
      const cx = originX + ((group.from + group.to) / 2) * mw;
      parts.push(
        `<text x="${r(cx)}" y="${r(baseline)}" font-family="${FONT_STACK}" font-size="${r(g.fontSize)}" text-anchor="middle" fill="${g.color}">${escapeXml(group.text)}</text>`,
      );
    }
  }

  return { markup: parts.join(""), width, height };
}

/** Quiet zone actually used: never below what the symbology needs for its text. */
function effectiveQuietZone(enc: EncodedBarcode, requested: number, showText: boolean): number {
  return showText ? Math.max(requested, enc.minQuietZone) : Math.max(requested, 0);
}

/** Render one encoded barcode as a standalone SVG document, sized in pixels. */
export function renderBarcodeSvg(enc: EncodedBarcode, options: RenderBarcodeOptions = {}): string {
  const moduleWidth = options.moduleWidth ?? 2;
  const barHeight = options.height ?? 80;
  const showText = options.showText ?? true;
  const fontSize = options.fontSize ?? Math.max(8, moduleWidth * 5);
  const color = options.color ?? "#000000";
  const background = options.background ?? "#ffffff";
  const quietZone = effectiveQuietZone(enc, options.quietZone ?? 10, showText);

  const body = barcodeBody(enc, {
    moduleWidth,
    barHeight,
    quietZone,
    showText,
    fontSize,
    color,
  });

  const bg = background === "none" ? "" : rect(0, 0, body.width, body.height, background);
  return (
    `<svg xmlns="${SVG_NS}" width="${r(body.width)}" height="${r(body.height)}" ` +
    `viewBox="0 0 ${r(body.width)} ${r(body.height)}" role="img" ` +
    `aria-label="${escapeXml(`${enc.type} barcode ${enc.humanText}`)}">` +
    `${bg}${body.markup}</svg>`
  );
}

/* -------------------------------------------------------------------------- */
/* Sheet layouts                                                              */
/* -------------------------------------------------------------------------- */

/** One label sheet. Every measurement is millimeters. */
export interface SheetSpec {
  id: string;
  label: string;
  pageWidth: number;
  pageHeight: number;
  cols: number;
  rows: number;
  labelWidth: number;
  labelHeight: number;
  /** Distance from the page edge to the first label. */
  marginLeft: number;
  marginTop: number;
  /** Gap between label columns and rows. */
  gapX: number;
  gapY: number;
  /** White space kept inside each label. */
  padding: number;
}

/** The label sheets the tool can lay out. Exported for the panel's picker. */
export const SHEETS: readonly SheetSpec[] = [
  {
    id: "avery-5160",
    label: "Avery 5160: 30 labels, 2.625 x 1 in, US Letter",
    pageWidth: 215.9,
    pageHeight: 279.4,
    cols: 3,
    rows: 10,
    labelWidth: 66.675,
    labelHeight: 25.4,
    marginLeft: 4.7625,
    marginTop: 12.7,
    gapX: 3.175,
    gapY: 0,
    padding: 1.5,
  },
  {
    id: "a4-3x8",
    label: "A4 3 x 8: 24 labels, 70 x 37 mm",
    pageWidth: 210,
    pageHeight: 297,
    cols: 3,
    rows: 8,
    labelWidth: 70,
    labelHeight: 37,
    marginLeft: 0,
    marginTop: 0.5,
    gapX: 0,
    gapY: 0,
    padding: 2,
  },
  {
    id: "a4-2x7",
    label: "A4 2 x 7: 14 labels, 99.1 x 38.1 mm",
    pageWidth: 210,
    pageHeight: 297,
    cols: 2,
    rows: 7,
    labelWidth: 99.1,
    labelHeight: 38.1,
    marginLeft: 5,
    marginTop: 15.1,
    gapX: 2.5,
    gapY: 0,
    padding: 2,
  },
];

/** Look up a sheet by id. Returns undefined for "single" and for anything unknown. */
export function getSheet(id: string): SheetSpec | undefined {
  return SHEETS.find((s) => s.id === id);
}

export interface SheetCell {
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Every label position on a sheet, in reading order, in millimeters. */
export function sheetCells(spec: SheetSpec): SheetCell[] {
  const cells: SheetCell[] = [];
  for (let row = 0; row < spec.rows; row++) {
    for (let col = 0; col < spec.cols; col++) {
      cells.push({
        row,
        col,
        x: spec.marginLeft + col * (spec.labelWidth + spec.gapX),
        y: spec.marginTop + row * (spec.labelHeight + spec.gapY),
        width: spec.labelWidth,
        height: spec.labelHeight,
      });
    }
  }
  return cells;
}

export interface RenderSheetOptions {
  showText?: boolean;
  quietZone?: number;
  color?: string;
  background?: string;
  /** Faint outlines showing where each label sits. Handy for a test print. */
  showGuides?: boolean;
}

/** Largest module width on a sheet, so a short code does not stretch absurdly. */
const SHEET_MAX_MODULE_MM = 0.6;
/** Tallest bars on a sheet, in millimeters. */
const SHEET_MAX_BAR_MM = 25;

/**
 * Lay a list of encoded barcodes out on a label sheet as one page sized SVG.
 * The document is measured in millimeters so it prints at true size.
 */
export function renderSheetSvg(
  list: EncodedBarcode[],
  spec: SheetSpec,
  options: RenderSheetOptions = {},
): string {
  const cells = sheetCells(spec);
  if (list.length > cells.length)
    throw new ToolError(
      "too-many",
      `That is ${list.length} barcodes but the ${spec.label} sheet holds ${cells.length}.`,
      `Remove ${list.length - cells.length} of them, lower the copies, or print more than one page.`,
    );

  const showText = options.showText ?? true;
  const color = options.color ?? "#000000";
  const background = options.background ?? "#ffffff";
  const parts: string[] = [];
  if (background !== "none") parts.push(rect(0, 0, spec.pageWidth, spec.pageHeight, background));

  list.forEach((enc, index) => {
    const cell = cells[index]!;
    const innerX = cell.x + spec.padding;
    const innerY = cell.y + spec.padding;
    const innerW = cell.width - spec.padding * 2;
    const innerH = cell.height - spec.padding * 2;
    if (options.showGuides)
      parts.push(
        `<rect x="${r(cell.x)}" y="${r(cell.y)}" width="${r(cell.width)}" height="${r(cell.height)}" fill="none" stroke="#cccccc" stroke-width="0.1"/>`,
      );

    const quietZone = effectiveQuietZone(enc, options.quietZone ?? 10, showText);
    const spanModules = enc.width + quietZone * 2 + (enc.bearerBars ? 9 : 0);
    const moduleWidth = Math.min(innerW / spanModules, SHEET_MAX_MODULE_MM);
    const fontSize = Math.min(3.2, Math.max(1.4, innerH * 0.22));
    const textBand = showText ? fontSize * 1.35 : 0;
    const bearerBand = enc.bearerBars ? moduleWidth * 9 : 0;
    const barHeight = Math.max(3, Math.min(innerH - textBand - bearerBand, SHEET_MAX_BAR_MM));

    const body = barcodeBody(enc, {
      moduleWidth,
      barHeight,
      quietZone,
      showText,
      fontSize,
      color,
    });
    const x = innerX + (innerW - body.width) / 2;
    const y = innerY + (innerH - body.height) / 2;
    parts.push(`<g transform="translate(${r(x)},${r(y)})">${body.markup}</g>`);
  });

  return (
    `<svg xmlns="${SVG_NS}" width="${r(spec.pageWidth)}mm" height="${r(spec.pageHeight)}mm" ` +
    `viewBox="0 0 ${r(spec.pageWidth)} ${r(spec.pageHeight)}" role="img" ` +
    `aria-label="${escapeXml(`${list.length} barcodes on ${spec.label}`)}">` +
    `${parts.join("")}</svg>`
  );
}

/* -------------------------------------------------------------------------- */
/* run()                                                                      */
/* -------------------------------------------------------------------------- */

export interface BarcodeOpts {
  /** Symbology. See BARCODE_TYPES. */
  type?: string;
  /** "single", or one of the SHEETS ids. */
  sheet?: string;
  /** How many labels each input line fills on a sheet. */
  copies?: number;
  showText?: boolean;
  moduleWidth?: number;
  height?: number;
  quietZone?: number;
  code39Check?: boolean;
  [key: string]: unknown;
}

function numberOption(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max)
    throw new ToolError(
      "bad-option",
      `${label} must be a number between ${min} and ${max}. You gave "${String(value)}".`,
      `Use the default of ${fallback} if you are not sure.`,
    );
  return n;
}

function boolOption(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const raw = String(value).toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

export function run(input: string, opts: BarcodeOpts = {}): string {
  const raw = String(input ?? "");
  if (!raw.trim())
    throw new ToolError(
      "empty-input",
      "Enter the value you want turned into a barcode.",
      "Type a product number, a part number, or any text for Code 128.",
    );

  const type = normaliseType(opts.type);
  const sheetId = String(opts.sheet ?? "single").trim() || "single";
  const showText = boolOption(opts.showText, true);
  const quietZone = numberOption(opts.quietZone, 10, 0, 40, "Quiet zone");
  const encodeOptions: EncodeOptions = { code39Check: boolOption(opts.code39Check, false) };

  if (sheetId === "single") {
    if (/\r?\n/.test(raw.trim()))
      throw new ToolError(
        "invalid-chars",
        "The input has a line break in it, and a single barcode holds one value.",
        "Pick a sheet layout to print one barcode per line, or enter a single value.",
      );
    const encoded = encode(raw.trim(), type, encodeOptions);
    return renderBarcodeSvg(encoded, {
      moduleWidth: numberOption(opts.moduleWidth, 2, 0.5, 20, "Module width"),
      height: numberOption(opts.height, 80, 10, 600, "Bar height"),
      showText,
      quietZone,
    });
  }

  const spec = getSheet(sheetId);
  if (!spec)
    throw new ToolError(
      "bad-option",
      `Unknown sheet layout "${sheetId}".`,
      `Choose single, ${SHEETS.map((s) => s.id).join(", ")}.`,
    );

  const copies = Math.floor(numberOption(opts.copies, 1, 1, 1000, "Copies"));
  const values = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const list: EncodedBarcode[] = [];
  for (const value of values) {
    const encoded = encode(value, type, encodeOptions);
    for (let i = 0; i < copies; i++) list.push(encoded);
  }

  return renderSheetSvg(list, spec, { showText, quietZone });
}

export default { run } satisfies ToolLogic<string, string, BarcodeOpts>;

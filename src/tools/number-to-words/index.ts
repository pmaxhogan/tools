import { ToolError, type ToolLogic } from "../types";

export interface NumberWordsOpts {
  ordinal: boolean;
  currency: string; // "none" | "usd" | "eur" | "gbp"
  checkStyle: boolean;
  [key: string]: unknown;
}

export type NumberWordsResult = Record<string, string>;

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const TEENS = [
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

// Short scale group names, index i covers 10^(3*i): "" (units), thousand, million, ... vigintillion (10^63).
const ILLIONS = [
  "",
  "thousand",
  "million",
  "billion",
  "trillion",
  "quadrillion",
  "quintillion",
  "sextillion",
  "septillion",
  "octillion",
  "nonillion",
  "decillion",
  "undecillion",
  "duodecillion",
  "tredecillion",
  "quattuordecillion",
  "quindecillion",
  "sexdecillion",
  "septendecillion",
  "octodecillion",
  "novemdecillion",
  "vigintillion",
];
const MAX_GROUP_INDEX = ILLIONS.length - 1;

const BASE_ORDINAL: Record<string, string> = {
  zero: "zeroth",
  one: "first",
  two: "second",
  three: "third",
  four: "fourth",
  five: "fifth",
  six: "sixth",
  seven: "seventh",
  eight: "eighth",
  nine: "ninth",
  ten: "tenth",
  eleven: "eleventh",
  twelve: "twelfth",
  thirteen: "thirteenth",
  fourteen: "fourteenth",
  fifteen: "fifteenth",
  sixteen: "sixteenth",
  seventeen: "seventeenth",
  eighteen: "eighteenth",
  nineteen: "nineteenth",
};
const TENS_ORDINAL: Record<string, string> = {
  twenty: "twentieth",
  thirty: "thirtieth",
  forty: "fortieth",
  fifty: "fiftieth",
  sixty: "sixtieth",
  seventy: "seventieth",
  eighty: "eightieth",
  ninety: "ninetieth",
};

function chunkWords(n: number): string {
  if (n === 0) return "";
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rem = n % 100;
  if (hundreds > 0) parts.push(`${ONES[hundreds]} hundred`);
  if (rem > 0) {
    if (rem < 10) parts.push(ONES[rem]!);
    else if (rem < 20) parts.push(TEENS[rem - 10]!);
    else {
      const tensDigit = Math.floor(rem / 10);
      const onesDigit = rem % 10;
      parts.push(onesDigit > 0 ? `${TENS[tensDigit]}-${ONES[onesDigit]}` : TENS[tensDigit]!);
    }
  }
  return parts.join(" ");
}

function integerToWords(n: bigint): string {
  if (n === 0n) return "zero";
  const groups: number[] = [];
  let x = n;
  while (x > 0n) {
    groups.push(Number(x % 1000n));
    x /= 1000n;
  }
  if (groups.length - 1 > MAX_GROUP_INDEX) {
    throw new ToolError(
      "number-too-large",
      `This number is larger than this tool's largest named scale (vigintillion, 10^63).`,
      "Use a smaller number.",
    );
  }
  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]!;
    if (g === 0) continue;
    const chunk = chunkWords(g);
    const illion = ILLIONS[i];
    parts.push(illion ? `${chunk} ${illion}` : chunk);
  }
  return parts.join(" ");
}

function ordinalizeLastWord(words: string): string {
  const tokens = words.split(" ");
  const last = tokens[tokens.length - 1]!;
  if (last.includes("-")) {
    const [tensPart, onesPart] = last.split("-") as [string, string];
    const ordinalOnes = BASE_ORDINAL[onesPart] ?? onesPart;
    tokens[tokens.length - 1] = `${tensPart}-${ordinalOnes}`;
  } else if (BASE_ORDINAL[last]) {
    tokens[tokens.length - 1] = BASE_ORDINAL[last]!;
  } else if (TENS_ORDINAL[last]) {
    tokens[tokens.length - 1] = TENS_ORDINAL[last]!;
  } else {
    // hundred, thousand, million, ... all ordinalize by appending "th".
    tokens[tokens.length - 1] = `${last}th`;
  }
  return tokens.join(" ");
}

interface ParsedNumber {
  negative: boolean;
  intPart: bigint;
  decimalDigits: string;
}

function parseNumericInput(raw: string): ParsedNumber {
  const trimmed = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new ToolError(
      "invalid-number",
      `"${raw}" is not a valid number.`,
      'Enter a plain number like "1234" or "-56.7".',
    );
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intStr, decStr = ""] = unsigned.split(".");
  return { negative, intPart: BigInt(intStr!), decimalDigits: decStr };
}

function decimalToWords(decimalDigits: string): string {
  if (!decimalDigits) return "";
  const digitWords = [...decimalDigits].map((d) => ONES[Number(d)]!).join(" ");
  return ` point ${digitWords}`;
}

const CURRENCIES: Record<
  string,
  { major: string; majorPlural: string; minor: string; minorPlural: string }
> = {
  usd: { major: "dollar", majorPlural: "dollars", minor: "cent", minorPlural: "cents" },
  eur: { major: "euro", majorPlural: "euros", minor: "cent", minorPlural: "cents" },
  gbp: { major: "pound", majorPlural: "pounds", minor: "penny", minorPlural: "pence" },
};

function toCurrencyWords(parsed: ParsedNumber, currency: string, checkStyle: boolean): string {
  const names = CURRENCIES[currency]!;
  const centsNum = Math.min(99, Number((parsed.decimalDigits + "00").slice(0, 2)));
  const majorWords = integerToWords(parsed.intPart);
  const majorLabel = parsed.intPart === 1n ? names.major : names.majorPlural;
  const negativePrefix = parsed.negative ? "negative " : "";

  if (checkStyle) {
    return `${negativePrefix}${majorWords} and ${String(centsNum).padStart(2, "0")}/100 ${majorLabel}`;
  }

  const centsWords =
    centsNum > 0
      ? ` and ${integerToWords(BigInt(centsNum))} ${centsNum === 1 ? names.minor : names.minorPlural}`
      : "";
  return `${negativePrefix}${majorWords} ${majorLabel}${centsWords}`;
}

const WORD_ONES: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const WORD_TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const WORD_SCALES: Record<string, bigint> = Object.fromEntries(
  ILLIONS.filter((name) => name).map((name, i) => [name, 10n ** BigInt(3 * (i + 1))]),
);

function wordsToNumber(raw: string): string {
  let cleaned = raw.toLowerCase().trim();
  let negative = false;
  const negMatch = cleaned.match(/^(negative|minus)\s+/);
  if (negMatch) {
    negative = true;
    cleaned = cleaned.slice(negMatch[0].length);
  }
  cleaned = cleaned.replace(/,/g, "").replace(/-/g, " ");

  const [intPartRaw, decPartRaw] = cleaned.split(/\bpoint\b/);
  const tokens = (intPartRaw ?? "")
    .trim()
    .split(/\s+/)
    .filter((t) => t && t !== "and");

  if (tokens.length === 0) {
    throw new ToolError(
      "unrecognized-word",
      "No number words found before the decimal point.",
      'Use words like "one hundred twenty-three".',
    );
  }

  let total = 0n;
  let current = 0n;
  for (const token of tokens) {
    if (token === "hundred") {
      current = (current === 0n ? 1n : current) * 100n;
    } else if (token in WORD_ONES) {
      current += BigInt(WORD_ONES[token]!);
    } else if (token in WORD_TENS) {
      current += BigInt(WORD_TENS[token]!);
    } else if (token in WORD_SCALES) {
      total += (current === 0n ? 1n : current) * WORD_SCALES[token]!;
      current = 0n;
    } else {
      throw new ToolError(
        "unrecognized-word",
        `"${token}" is not a recognized number word.`,
        'Use words like "one hundred twenty-three" or "negative forty-two".',
      );
    }
  }
  total += current;

  let result = (negative && total !== 0n ? "-" : "") + total.toString();

  if (decPartRaw && decPartRaw.trim()) {
    const decTokens = decPartRaw.trim().split(/\s+/).filter(Boolean);
    const digits = decTokens
      .map((t) => {
        if (t === "oh") return "0";
        if (t in WORD_ONES && WORD_ONES[t]! <= 9) return String(WORD_ONES[t]);
        throw new ToolError(
          "unrecognized-word",
          `"${t}" is not a recognized digit word after "point".`,
          'Use single digit words like "one two three" after point.',
        );
      })
      .join("");
    result += `.${digits}`;
  }

  return result;
}

export function run(input: string, opts: NumberWordsOpts): NumberWordsResult {
  const raw = input ?? "";
  if (!raw.trim())
    throw new ToolError(
      "empty-input",
      "Enter a number or number words to convert.",
      'Type a number like "1234" or words like "one thousand two hundred thirty-four".',
    );

  const isWordsInput = /[a-zA-Z]/.test(raw);

  if (isWordsInput) {
    const output = wordsToNumber(raw);
    return { Direction: "Words to number", Output: output, Input: raw.trim() };
  }

  const parsed = parseNumericInput(raw);
  const currency = opts.currency && opts.currency !== "none" ? opts.currency : null;

  let output: string;
  let style: string;
  if (currency && CURRENCIES[currency]) {
    output = toCurrencyWords(parsed, currency, !!opts.checkStyle);
    style = opts.checkStyle ? "Check-writing currency" : "Currency";
  } else {
    const negativePrefix = parsed.negative && parsed.intPart !== 0n ? "negative " : "";
    let words = `${negativePrefix}${integerToWords(parsed.intPart)}${decimalToWords(parsed.decimalDigits)}`;
    if (opts.ordinal && !parsed.decimalDigits) {
      words = ordinalizeLastWord(words);
      style = "Ordinal";
    } else {
      style = "Cardinal";
    }
    output = words;
  }

  return { Direction: "Number to words", Output: output, Style: style, Input: raw.trim() };
}

export default { run } satisfies ToolLogic<string, NumberWordsResult, NumberWordsOpts>;

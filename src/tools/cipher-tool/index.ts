import { ToolError, type ToolLogic } from "../types";

export interface CipherOpts {
  cipher: string; // "caesar" | "rot13" | "rot47" | "atbash" | "vigenere" | "affine" | "railfence"
  mode: string; // "encode" | "decode"
  key: string;
  bruteForce: boolean;
  [key: string]: unknown;
}

export type CipherResult = Record<string, string>;

const A_CODE = "A".charCodeAt(0);

function shiftLetter(ch: string, shift: number): string {
  const isUpper = ch >= "A" && ch <= "Z";
  const isLower = ch >= "a" && ch <= "z";
  if (!isUpper && !isLower) return ch;
  const base = isUpper ? A_CODE : "a".charCodeAt(0);
  const idx = ch.charCodeAt(0) - base;
  const shifted = (((idx + shift) % 26) + 26) % 26;
  return String.fromCharCode(base + shifted);
}

function caesarShift(text: string, shift: number): string {
  return [...text].map((ch) => shiftLetter(ch, shift)).join("");
}

function rot47(text: string): string {
  return [...text]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      if (code < 33 || code > 126) return ch;
      return String.fromCharCode(33 + ((code - 33 + 47) % 94));
    })
    .join("");
}

function atbash(text: string): string {
  return [...text]
    .map((ch) => {
      const isUpper = ch >= "A" && ch <= "Z";
      const isLower = ch >= "a" && ch <= "z";
      if (!isUpper && !isLower) return ch;
      const base = isUpper ? A_CODE : "a".charCodeAt(0);
      const idx = ch.charCodeAt(0) - base;
      return String.fromCharCode(base + (25 - idx));
    })
    .join("");
}

function vigenere(text: string, key: string, mode: "encode" | "decode"): string {
  const keyLetters = [...key].filter((c) => /[a-zA-Z]/.test(c));
  if (keyLetters.length === 0)
    throw new ToolError(
      "invalid-key",
      "The Vigenere key must contain at least one letter.",
      'Enter a word like "lemon" as the key.',
    );
  let keyIndex = 0;
  const sign = mode === "decode" ? -1 : 1;
  return [...text]
    .map((ch) => {
      const isUpper = ch >= "A" && ch <= "Z";
      const isLower = ch >= "a" && ch <= "z";
      if (!isUpper && !isLower) return ch;
      const keyChar = keyLetters[keyIndex % keyLetters.length]!;
      const keyShift = keyChar.toUpperCase().charCodeAt(0) - A_CODE;
      keyIndex++;
      return shiftLetter(ch, sign * keyShift);
    })
    .join("");
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function modInverse(a: number): number {
  const normalized = ((a % 26) + 26) % 26;
  for (let x = 1; x < 26; x++) {
    if ((normalized * x) % 26 === 1) return x;
  }
  throw new ToolError(
    "invalid-key",
    `"a" must be coprime with 26; ${a} has no modular inverse.`,
    "Use an a value like 1, 3, 5, 7, 9, 11, 15, 17, 19, 21, 23, or 25.",
  );
}

function parseAffineKey(key: string): { a: number; b: number } {
  const parts = key.split(",").map((s) => Number.parseInt(s.trim(), 10));
  const a = Number.isFinite(parts[0]) ? parts[0]! : 5;
  const b = Number.isFinite(parts[1]) ? parts[1]! : 8;
  if (gcd(((a % 26) + 26) % 26, 26) !== 1) {
    throw new ToolError(
      "invalid-key",
      `"a" must be coprime with 26; ${a} is not.`,
      'Use an a value like 1, 3, 5, 7, 9, 11, 15, 17, 19, 21, 23, or 25, formatted as "a,b" such as "5,8".',
    );
  }
  return { a, b };
}

function affine(text: string, key: string, mode: "encode" | "decode"): string {
  const { a, b } = parseAffineKey(key);
  const aInv = modInverse(a);
  return [...text]
    .map((ch) => {
      const isUpper = ch >= "A" && ch <= "Z";
      const isLower = ch >= "a" && ch <= "z";
      if (!isUpper && !isLower) return ch;
      const base = isUpper ? A_CODE : "a".charCodeAt(0);
      const x = ch.charCodeAt(0) - base;
      const y =
        mode === "decode" ? (((aInv * (x - b)) % 26) + 26 * 26) % 26 : ((a * x + b) % 26) % 26;
      const normalized = ((y % 26) + 26) % 26;
      return String.fromCharCode(base + normalized);
    })
    .join("");
}

function parseRails(key: string): number {
  const n = Number.parseInt(key, 10);
  if (!Number.isFinite(n) || n < 2) return 3;
  return Math.min(n, 26);
}

function railFenceEncode(text: string, rails: number): string {
  if (rails < 2) return text;
  const fence: string[][] = Array.from({ length: rails }, () => []);
  let row = 0;
  let dir = 1;
  for (const ch of text) {
    fence[row]!.push(ch);
    if (row === 0) dir = 1;
    else if (row === rails - 1) dir = -1;
    row += dir;
  }
  return fence.flat().join("");
}

function railFenceDecode(text: string, rails: number): string {
  if (rails < 2) return text;
  const chars = [...text];
  const len = chars.length;
  const pattern: number[] = [];
  let row = 0;
  let dir = 1;
  for (let i = 0; i < len; i++) {
    pattern.push(row);
    if (row === 0) dir = 1;
    else if (row === rails - 1) dir = -1;
    row += dir;
  }
  const rowCounts = Array(rails).fill(0) as number[];
  for (const r of pattern) rowCounts[r]!++;
  const rowsChars: string[][] = [];
  let idx = 0;
  for (let r = 0; r < rails; r++) {
    rowsChars.push(chars.slice(idx, idx + rowCounts[r]!));
    idx += rowCounts[r]!;
  }
  const rowPointers = Array(rails).fill(0) as number[];
  let result = "";
  for (const r of pattern) {
    result += rowsChars[r]![rowPointers[r]!];
    rowPointers[r]!++;
  }
  return result;
}

const ENGLISH_FREQ: Record<string, number> = {
  a: 8.2,
  b: 1.5,
  c: 2.8,
  d: 4.3,
  e: 12.7,
  f: 2.2,
  g: 2.0,
  h: 6.1,
  i: 7.0,
  j: 0.15,
  k: 0.77,
  l: 4.0,
  m: 2.4,
  n: 6.7,
  o: 7.5,
  p: 1.9,
  q: 0.1,
  r: 6.0,
  s: 6.3,
  t: 9.1,
  u: 2.8,
  v: 0.98,
  w: 2.4,
  x: 0.15,
  y: 2.0,
  z: 0.074,
};

/**
 * Chi-squared goodness of fit against standard English letter frequencies.
 * Lower is a better match to English. Used only as a tiebreaker: on its own
 * it is unreliable for short or letter-skewed text, where a wrong shift can
 * coincidentally fit the frequency table better than the real plaintext.
 */
function chiSquared(text: string): number {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const ch of text.toLowerCase()) {
    if (ch >= "a" && ch <= "z") {
      counts[ch] = (counts[ch] ?? 0) + 1;
      total++;
    }
  }
  if (total === 0) return Number.POSITIVE_INFINITY;
  let chi2 = 0;
  for (const letter of Object.keys(ENGLISH_FREQ)) {
    const observed = counts[letter] ?? 0;
    const expected = (ENGLISH_FREQ[letter]! / 100) * total;
    chi2 += (observed - expected) ** 2 / (expected || 1);
  }
  return chi2;
}

// A short list of very common English words. Counting how many of these
// show up in a candidate decoding is a far more reliable "is this English"
// signal than raw letter frequency, especially on short ciphertext.
const COMMON_WORDS = new Set([
  "the",
  "and",
  "to",
  "of",
  "a",
  "in",
  "that",
  "is",
  "was",
  "he",
  "for",
  "it",
  "with",
  "as",
  "his",
  "on",
  "be",
  "at",
  "by",
  "this",
  "had",
  "not",
  "are",
  "but",
  "from",
  "or",
  "have",
  "an",
  "they",
  "which",
  "one",
  "you",
  "were",
  "her",
  "all",
  "she",
  "there",
  "would",
  "their",
  "we",
  "him",
  "been",
  "has",
  "when",
  "who",
  "will",
  "more",
  "no",
  "if",
  "out",
  "so",
  "up",
  "what",
  "its",
  "about",
  "into",
  "than",
  "then",
  "do",
  "any",
  "my",
  "now",
  "over",
  "after",
  "just",
  "most",
  "us",
  "while",
]);

function wordScore(text: string): number {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  return tokens.filter((t) => COMMON_WORDS.has(t)).length;
}

function bruteForceCaesar(text: string): CipherResult {
  const attempts = Array.from({ length: 26 }, (_, shift) => {
    const decoded = caesarShift(text, -shift);
    return { shift, decoded, words: wordScore(decoded), chi2: chiSquared(decoded) };
  });
  const best = attempts.reduce((a, b) =>
    b.words !== a.words ? (b.words > a.words ? b : a) : b.chi2 < a.chi2 ? b : a,
  );
  const result: CipherResult = {};
  for (const a of attempts) {
    result[`Shift ${a.shift}`] =
      `${a.decoded}  (common words: ${a.words}, chi-squared ${a.chi2.toFixed(1)})`;
  }
  result["Best guess"] = `Shift ${best.shift}: ${best.decoded}`;
  return result;
}

const CIPHER_NAMES: Record<string, string> = {
  caesar: "Caesar",
  rot13: "ROT13",
  rot47: "ROT47",
  atbash: "Atbash",
  vigenere: "Vigenere",
  affine: "Affine",
  railfence: "Rail fence",
};

export function run(input: string, opts: CipherOpts): CipherResult {
  const raw = input ?? "";
  if (!raw.trim())
    throw new ToolError(
      "empty-input",
      "Enter text to encode or decode.",
      'Type text like "Attack at dawn".',
    );

  if (opts.bruteForce) {
    return bruteForceCaesar(raw);
  }

  const mode: "encode" | "decode" = opts.mode === "decode" ? "decode" : "encode";
  const cipher = CIPHER_NAMES[opts.cipher] ? opts.cipher : "caesar";
  const key = opts.key ?? "";

  let output: string;
  switch (cipher) {
    case "rot13":
      output = caesarShift(raw, 13);
      break;
    case "rot47":
      output = rot47(raw);
      break;
    case "atbash":
      output = atbash(raw);
      break;
    case "vigenere":
      output = vigenere(raw, key, mode);
      break;
    case "affine":
      output = affine(raw, key, mode);
      break;
    case "railfence": {
      const rails = parseRails(key);
      output = mode === "decode" ? railFenceDecode(raw, rails) : railFenceEncode(raw, rails);
      break;
    }
    case "caesar":
    default: {
      const shiftValue = Number.parseInt(key, 10);
      const shift = Number.isFinite(shiftValue) ? shiftValue : 3;
      output = caesarShift(raw, mode === "decode" ? -shift : shift);
      break;
    }
  }

  return {
    Cipher: CIPHER_NAMES[cipher]!,
    Mode: mode === "decode" ? "Decode" : "Encode",
    Output: output,
  };
}

export default { run } satisfies ToolLogic<string, CipherResult, CipherOpts>;

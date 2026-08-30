import { ToolError, type ToolLogic } from "../types";
import { DICTIONARIES, DICTIONARY_LABEL, MAX_DICTIONARY_WORD } from "./wordlist";

export interface PasswordStrengthOpts {
  /** Which attack scenario the headline crack time describes. */
  attacker?: string;
  /** Include the per-segment pattern breakdown in the output. */
  showPatterns?: boolean;
  [key: string]: unknown;
}

export type PasswordStrengthResult = Record<string, string>;

/** Longer than this and the analysis works on a prefix, which is already unguessable. */
const MAX_ANALYZED = 128;

/* ------------------------------------------------------------------ */
/* Character pools                                                     */
/* ------------------------------------------------------------------ */

const LOWER_RE = /[a-z]/;
const UPPER_RE = /[A-Z]/;
const DIGIT_RE = /[0-9]/;
/** The 33 printable ASCII symbols on a US keyboard, space excluded. */
const SYMBOL_RE = /[!-/:-@[-`{-~]/;

export interface PoolBreakdown {
  size: number;
  parts: string[];
}

/**
 * The size of the alphabet a brute force attacker would have to walk, judged
 * from which classes the password actually uses. This is the naive model, and
 * it is reported as such: it says nothing about the password being a word.
 */
export function characterPool(password: string): PoolBreakdown {
  const parts: string[] = [];
  let size = 0;
  if (LOWER_RE.test(password)) {
    size += 26;
    parts.push("lowercase (26)");
  }
  if (UPPER_RE.test(password)) {
    size += 26;
    parts.push("uppercase (26)");
  }
  if (DIGIT_RE.test(password)) {
    size += 10;
    parts.push("digits (10)");
  }
  if (SYMBOL_RE.test(password)) {
    size += 33;
    parts.push("symbols (33)");
  }
  if (password.includes(" ")) {
    size += 1;
    parts.push("space (1)");
  }
  // Anything outside printable ASCII: accented letters, emoji, other scripts.
  if (/[^\x20-\x7e]/.test(password)) {
    size += 100;
    parts.push("characters beyond ASCII (100 assumed)");
  }
  return { size: Math.max(size, 1), parts };
}

/* ------------------------------------------------------------------ */
/* Keyboard geometry                                                   */
/* ------------------------------------------------------------------ */

const QWERTY_ROWS = ["`1234567890-=", "qwertyuiop[]\\", "asdfghjkl;'", "zxcvbnm,./"];
const QWERTY_SHIFTED = ["~!@#$%^&*()_+", "QWERTYUIOP{}|", 'ASDFGHJKL:"', "ZXCVBNM<>?"];

interface KeySlot {
  row: number;
  col: number;
  shifted: boolean;
}

function buildKeyMap(): Map<string, KeySlot> {
  const map = new Map<string, KeySlot>();
  QWERTY_ROWS.forEach((row, r) =>
    [...row].forEach((ch, c) => map.set(ch, { row: r, col: c, shifted: false })),
  );
  QWERTY_SHIFTED.forEach((row, r) =>
    [...row].forEach((ch, c) => map.set(ch, { row: r, col: c, shifted: true })),
  );
  return map;
}

const KEY_MAP = buildKeyMap();

/**
 * Two keys are neighbors when they sit side by side in a row, or one row apart
 * within one column of each other. The real keyboard is staggered, so this is
 * an approximation, but it catches every walk people actually use.
 */
function adjacent(a: string, b: string): boolean {
  const p = KEY_MAP.get(a);
  const q = KEY_MAP.get(b);
  if (!p || !q) return false;
  const dr = Math.abs(p.row - q.row);
  const dc = Math.abs(p.col - q.col);
  if (dr === 0) return dc === 1;
  return dr === 1 && dc <= 1;
}

/* ------------------------------------------------------------------ */
/* Leet substitutions                                                  */
/* ------------------------------------------------------------------ */

const LEET: Record<string, string[]> = {
  "4": ["a"],
  "@": ["a"],
  "8": ["b"],
  "(": ["c"],
  "3": ["e"],
  "6": ["g"],
  "9": ["g"],
  "1": ["i", "l"],
  "!": ["i"],
  "|": ["i", "l"],
  "0": ["o"],
  $: ["s"],
  "5": ["s"],
  "7": ["t"],
  "+": ["t"],
  "2": ["z"],
};

/**
 * Every plain-letter reading of a token that uses leet characters, capped so a
 * pathological string cannot explode. Returns an empty list when the token has
 * no substitutions at all, so the caller can skip it.
 */
export function unleet(token: string): string[] {
  const lower = token.toLowerCase();
  const positions = [...lower].map((ch, i) => ({ i, options: LEET[ch] })).filter((p) => p.options);
  if (positions.length === 0) return [];
  let variants = [lower];
  for (const { i, options } of positions) {
    const next: string[] = [];
    for (const variant of variants) {
      for (const replacement of options!) {
        next.push(variant.slice(0, i) + replacement + variant.slice(i + 1));
      }
      if (next.length > 64) break;
    }
    variants = next.slice(0, 64);
  }
  return variants;
}

/* ------------------------------------------------------------------ */
/* Matches                                                             */
/* ------------------------------------------------------------------ */

export interface PatternMatch {
  /** Start index, inclusive. */
  i: number;
  /** End index, exclusive. */
  j: number;
  token: string;
  kind: "dictionary" | "leet" | "reversed" | "sequence" | "repeat" | "keyboard" | "date";
  /** How many guesses reaching this token is estimated to cost. */
  guesses: number;
  /** One sentence a person can act on. */
  detail: string;
}

/** Cost of the capitalization pattern on top of the base word rank. */
function capitalizationFactor(token: string): number {
  if (!UPPER_RE.test(token)) return 1;
  // All caps, or only the first letter capitalized: two cheap conventions.
  if (token === token.toUpperCase()) return 2;
  if (/^[A-Z][^A-Z]*$/.test(token)) return 2;
  // Anything else: the attacker has to try the subsets, capped for sanity.
  const upper = [...token].filter((c) => UPPER_RE.test(c)).length;
  return Math.min(2 ** Math.min(upper + 1, 12), 4096);
}

function dictionaryMatches(password: string): PatternMatch[] {
  const lower = password.toLowerCase();
  const out: PatternMatch[] = [];
  const reversedLower = [...lower].reverse().join("");
  for (let i = 0; i < password.length; i++) {
    const limit = Math.min(password.length, i + MAX_DICTIONARY_WORD);
    for (let j = i + 3; j <= limit; j++) {
      const token = password.slice(i, j);
      const plain = lower.slice(i, j);
      for (const [name, dictionary] of DICTIONARIES) {
        const rank = dictionary.get(plain);
        if (rank) {
          out.push({
            i,
            j,
            token,
            kind: "dictionary",
            guesses: rank * capitalizationFactor(token),
            detail: `"${token}" is entry ${rank} in the bundled ${DICTIONARY_LABEL[name]}.`,
          });
        }
      }
      // Reversed words: "drowssap" is not cleverness, it is one extra step.
      const backwards = reversedLower.slice(password.length - j, password.length - i);
      for (const [name, dictionary] of DICTIONARIES) {
        const rank = dictionary.get(backwards);
        if (rank && backwards !== plain) {
          out.push({
            i,
            j,
            token,
            kind: "reversed",
            guesses: rank * capitalizationFactor(token) * 2,
            detail: `"${token}" is "${backwards}" spelled backwards, entry ${rank} in the bundled ${DICTIONARY_LABEL[name]}.`,
          });
        }
      }
      // Leet spellings: p@ssw0rd costs a small multiple of password.
      for (const variant of unleet(token)) {
        for (const [name, dictionary] of DICTIONARIES) {
          const rank = dictionary.get(variant);
          if (rank && variant !== plain) {
            out.push({
              i,
              j,
              token,
              kind: "leet",
              guesses: rank * capitalizationFactor(token) * 4,
              detail: `"${token}" is "${variant}" with digits and symbols swapped in, entry ${rank} in the bundled ${DICTIONARY_LABEL[name]}.`,
            });
          }
        }
      }
    }
  }
  return out;
}

/** Runs of characters whose code points step by one, up or down. */
function sequenceMatches(password: string): PatternMatch[] {
  const out: PatternMatch[] = [];
  let i = 0;
  while (i < password.length - 2) {
    const step = password.charCodeAt(i + 1) - password.charCodeAt(i);
    if (step !== 1 && step !== -1) {
      i++;
      continue;
    }
    let j = i + 2;
    while (j < password.length && password.charCodeAt(j) - password.charCodeAt(j - 1) === step) j++;
    if (j - i >= 3) {
      const token = password.slice(i, j);
      out.push({
        i,
        j,
        token,
        kind: "sequence",
        guesses: 10 * (j - i) * (step === -1 ? 2 : 1),
        detail: `"${token}" is a straight ${step === 1 ? "ascending" : "descending"} run, which every cracking tool generates first.`,
      });
      i = j - 1;
    } else {
      i++;
    }
  }
  return out;
}

/** A short unit repeated back to back: aaaa, abcabcabc. */
function repeatMatches(password: string): PatternMatch[] {
  const out: PatternMatch[] = [];
  const re = /(.+?)\1+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(password)) !== null) {
    const unit = m[1]!;
    const repeats = m[0].length / unit.length;
    out.push({
      i: m.index,
      j: m.index + m[0].length,
      token: m[0],
      kind: "repeat",
      guesses: Math.max(unit.length * 26, 10) * repeats,
      detail: `"${m[0]}" is "${unit}" repeated ${repeats} times, which costs an attacker barely more than "${unit}" alone.`,
    });
  }
  return out;
}

/** Runs of neighboring keys: qwerty, asdf, 1qaz. */
function keyboardMatches(password: string): PatternMatch[] {
  const out: PatternMatch[] = [];
  let i = 0;
  while (i < password.length - 2) {
    let j = i + 1;
    let turns = 0;
    let lastDirection = "";
    while (j < password.length && adjacent(password[j - 1]!, password[j]!)) {
      const p = KEY_MAP.get(password[j - 1]!)!;
      const q = KEY_MAP.get(password[j]!)!;
      const direction = `${q.row - p.row},${q.col - p.col}`;
      if (direction !== lastDirection) {
        turns++;
        lastDirection = direction;
      }
      j++;
    }
    if (j - i >= 3) {
      const token = password.slice(i, j);
      out.push({
        i,
        j,
        token,
        kind: "keyboard",
        guesses: 50 * (j - i) * Math.max(turns, 1),
        detail: `"${token}" walks across neighboring keys, which cracking tools enumerate directly from the keyboard layout.`,
      });
      i = j - 1;
    } else {
      i++;
    }
  }
  return out;
}

/** Years and simple date shapes, which is what most "random" digit runs are. */
function dateMatches(password: string): PatternMatch[] {
  const out: PatternMatch[] = [];
  const yearRe = /(19\d{2}|20[0-4]\d)/g;
  let m: RegExpExecArray | null;
  while ((m = yearRe.exec(password)) !== null) {
    out.push({
      i: m.index,
      j: m.index + 4,
      token: m[0],
      kind: "date",
      guesses: 150,
      detail: `"${m[0]}" reads as a year, and a birth or graduation year is one of about 150 an attacker bothers with.`,
    });
  }
  const dateRe = /(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/g;
  while ((m = dateRe.exec(password)) !== null) {
    out.push({
      i: m.index,
      j: m.index + m[0].length,
      token: m[0],
      kind: "date",
      guesses: 40_000,
      detail: `"${m[0]}" reads as a date, and dates within a human lifetime are a list of a few tens of thousands.`,
    });
  }
  return out;
}

export function findMatches(password: string): PatternMatch[] {
  return [
    ...dictionaryMatches(password),
    ...sequenceMatches(password),
    ...repeatMatches(password),
    ...keyboardMatches(password),
    ...dateMatches(password),
  ];
}

/* ------------------------------------------------------------------ */
/* Search for the cheapest way to cover the password                   */
/* ------------------------------------------------------------------ */

/**
 * The floor an attacker pays for even considering multi-part guesses, one
 * factor of this per extra piece. Borrowed from zxcvbn, including the detail
 * that it is added rather than multiplied: it stops a two word password from
 * scoring as trivially as a one word one, without letting the penalty swamp
 * the actual cost of the pieces.
 */
const SPLIT_PENALTY = 10_000;

/** log2(x + y) from log2(x) and log2(y), without ever building x or y. */
function log2Sum(a: number, b: number): number {
  const high = Math.max(a, b);
  const low = Math.min(a, b);
  return high + Math.log2(1 + 2 ** (low - high));
}

interface Step {
  from: number;
  match: PatternMatch | null;
  cost: number;
}

/** log2 of n!, computed additively so large lengths do not overflow. */
function logFactorial(n: number): number {
  let total = 0;
  for (let k = 2; k <= n; k++) total += Math.log2(k);
  return total;
}

/** One piece of the cheapest cover, in the order it appears in the password. */
export interface Piece {
  token: string;
  /** null when no pattern explained this stretch and it costs brute force. */
  match: PatternMatch | null;
}

export interface Analysis {
  /** Base 2 log of the estimated number of guesses. */
  bits: number;
  guesses: number;
  /** Every piece of the cheapest cover, left to right. */
  pieces: Piece[];
  /** Just the recognized patterns, left to right. */
  sequence: PatternMatch[];
  /** Segments of the password that no pattern explained. */
  bruteforceSegments: string[];
}

/**
 * Finds the cheapest sequence of matches covering the whole password, by
 * dynamic programming over (position, number of pieces). Uncovered stretches
 * fall back to brute force at the password's own alphabet size.
 *
 * This is a small reimplementation of the idea behind zxcvbn, not a port: the
 * dictionaries are far smaller and the per-pattern costs are simpler, so treat
 * the number as an order of magnitude rather than a measurement.
 */
export function analyze(password: string): Analysis {
  const n = password.length;
  const pool = characterPool(password).size;
  const bruteBit = Math.log2(pool);
  const matches = findMatches(password);
  const endingAt = new Map<number, PatternMatch[]>();
  for (const match of matches) {
    const list = endingAt.get(match.j);
    if (list) list.push(match);
    else endingAt.set(match.j, [match]);
  }

  // best[j][c] = cheapest log2(product of piece costs) covering [0,j) in c pieces.
  const best: number[][] = Array.from({ length: n + 1 }, () => Array(n + 2).fill(Infinity));
  const from: (Step | null)[][] = Array.from({ length: n + 1 }, () => Array(n + 2).fill(null));
  best[0]![0] = 0;

  for (let j = 1; j <= n; j++) {
    const candidates: { i: number; match: PatternMatch | null; cost: number }[] = [];
    for (let i = 0; i < j; i++) {
      // A brute force piece: every uncovered stretch costs pool^length.
      candidates.push({ i, match: null, cost: (j - i) * bruteBit });
    }
    for (const match of endingAt.get(j) ?? []) {
      candidates.push({ i: match.i, match, cost: Math.log2(Math.max(match.guesses, 1)) });
    }
    for (const candidate of candidates) {
      for (let c = 0; c < n + 1; c++) {
        const prior = best[candidate.i]![c]!;
        if (prior === Infinity) continue;
        const total = prior + candidate.cost;
        if (total < best[j]![c + 1]!) {
          best[j]![c + 1] = total;
          from[j]![c + 1] = { from: candidate.i, match: candidate.match, cost: candidate.cost };
        }
      }
    }
  }

  const splitBits = Math.log2(SPLIT_PENALTY);
  let bestBits = Infinity;
  let bestCount = 1;
  for (let c = 1; c <= n; c++) {
    const raw = best[n]![c]!;
    if (raw === Infinity) continue;
    const ordered = raw + logFactorial(c);
    const total = c === 1 ? ordered : log2Sum(ordered, (c - 1) * splitBits);
    if (total < bestBits) {
      bestBits = total;
      bestCount = c;
    }
  }

  const pieces: Piece[] = [];
  let at = n;
  let count = bestCount;
  while (at > 0 && count > 0) {
    const step = from[at]![count];
    /* c8 ignore next */
    if (!step) break;
    pieces.unshift({ token: password.slice(step.from, at), match: step.match });
    at = step.from;
    count--;
  }

  return {
    bits: bestBits,
    guesses: 2 ** Math.min(bestBits, 1023),
    pieces,
    sequence: pieces.map((p) => p.match).filter((m): m is PatternMatch => m !== null),
    bruteforceSegments: pieces.filter((p) => p.match === null).map((p) => p.token),
  };
}

/* ------------------------------------------------------------------ */
/* Scoring and crack times                                             */
/* ------------------------------------------------------------------ */

export interface Scenario {
  id: string;
  label: string;
  /** Guesses per second the attacker can make. */
  rate: number;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "online-throttled",
    label: "Online attack against a service that rate limits (100 guesses per hour)",
    rate: 100 / 3600,
  },
  {
    id: "online-open",
    label: "Online attack against a service that does not rate limit (10 guesses per second)",
    rate: 10,
  },
  {
    id: "offline-slow",
    label: "Offline attack on a stolen bcrypt or argon2 hash (10 thousand guesses per second)",
    rate: 1e4,
  },
  {
    id: "offline-fast",
    label: "Offline attack on a stolen fast hash such as SHA-256, one GPU (10 billion per second)",
    rate: 1e10,
  },
  {
    id: "offline-cluster",
    label: "Offline attack on a fast hash with a large GPU cluster (100 trillion per second)",
    rate: 1e14,
  },
];

const SECOND = 1;
const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;
const MONTH = 2_629_746;
const YEAR = 31_556_952;

/** A crack time in words, deliberately vague past a century. */
export function humanTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "longer than the age of the universe";
  if (seconds < 1) return "less than a second";
  const units: [number, string][] = [
    [YEAR, "year"],
    [MONTH, "month"],
    [DAY, "day"],
    [HOUR, "hour"],
    [MINUTE, "minute"],
    [SECOND, "second"],
  ];
  if (seconds >= YEAR * 1e9) return "longer than the age of the universe";
  if (seconds >= YEAR * 1000) return `about ${formatBig(seconds / YEAR)} years`;
  for (const [size, name] of units) {
    if (seconds >= size) {
      const value = Math.round(seconds / size);
      return `about ${value} ${name}${value === 1 ? "" : "s"}`;
    }
  }
  /* c8 ignore next */
  return "less than a second";
}

/** Large numbers as "3.2 million" or "1.4e21", whichever reads better. */
export function formatBig(value: number): string {
  if (!Number.isFinite(value)) return "more than a computer can count";
  if (value < 1000) return String(Math.round(value));
  const named: [number, string][] = [
    [1e12, "trillion"],
    [1e9, "billion"],
    [1e6, "million"],
    [1e3, "thousand"],
  ];
  for (const [size, name] of named) {
    if (value >= size && value < size * 1000) return `${(value / size).toFixed(1)} ${name}`;
  }
  return value.toExponential(1);
}

export interface Score {
  value: 0 | 1 | 2 | 3 | 4;
  label: string;
  rationale: string;
}

/** zxcvbn's five bands, which map onto how a password actually fails. */
export function scoreFor(guesses: number): Score {
  if (guesses < 1e3)
    return {
      value: 0,
      label: "very weak",
      rationale:
        "Under a thousand guesses. This falls to a list of common passwords before any real attack starts.",
    };
  if (guesses < 1e6)
    return {
      value: 1,
      label: "weak",
      rationale:
        "Under a million guesses. Any attacker with a stolen hash file cracks this in well under a second.",
    };
  if (guesses < 1e8)
    return {
      value: 2,
      label: "fair",
      rationale:
        "Under a hundred million guesses. Good enough against an online login form that rate limits, and not good enough if the hash ever leaks.",
    };
  if (guesses < 1e10)
    return {
      value: 3,
      label: "strong",
      rationale:
        "Under ten billion guesses. This holds up against everyday attacks, but a determined offline attack on a fast hash still gets there.",
    };
  return {
    value: 4,
    label: "very strong",
    rationale:
      "More than ten billion guesses. Even an offline attack on a fast hash has to work for this one.",
  };
}

/* ------------------------------------------------------------------ */
/* Suggestions                                                         */
/* ------------------------------------------------------------------ */

function suggestions(password: string, analysis: Analysis, score: Score): string[] {
  const out: string[] = [];
  const kinds = new Set(analysis.sequence.map((m) => m.kind));
  if (password.length < 12) out.push("Make it longer. Length buys more than any other change.");
  if (kinds.has("dictionary") || kinds.has("leet") || kinds.has("reversed"))
    out.push(
      "Drop the recognizable word. Swapping letters for digits does not hide it: cracking tools apply the same substitutions.",
    );
  if (kinds.has("keyboard"))
    out.push(
      "Avoid keyboard walks. A path across neighboring keys is a short list, not randomness.",
    );
  if (kinds.has("sequence"))
    out.push("Avoid runs like 1234 or abcd. They are the first thing every tool tries.");
  if (kinds.has("repeat"))
    out.push("Avoid repeating a chunk. Repetition adds length without adding much work.");
  if (kinds.has("date"))
    out.push(
      "Leave out years and dates. A birth year narrows the search to about a hundred tries.",
    );
  if (analysis.bruteforceSegments.join("").length < password.length / 2 && score.value < 4)
    out.push(
      "Most of this password is explained by known patterns, so its real strength is far below its length.",
    );
  if (score.value >= 3 && out.length === 0)
    out.push(
      "Nothing here needs fixing. Use a password manager so this one only has to protect a single account.",
    );
  out.push(
    "Four or five unrelated words picked at random beat a short scrambled password, and are far easier to type.",
  );
  return out;
}

/* ------------------------------------------------------------------ */
/* run()                                                               */
/* ------------------------------------------------------------------ */

function boolOption(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;
  return raw === "true" || raw === "1";
}

export function run(input: string, opts: PasswordStrengthOpts): PasswordStrengthResult {
  // Only a trailing newline is stripped. A leading or trailing space is a real
  // part of a password, and dropping it would score a different string.
  const password = (input ?? "").replace(/\r?\n$/, "");
  if (password === "") {
    throw new ToolError(
      "empty-input",
      "There is no password to check.",
      "Type or paste the password. It is analyzed on this device and is never sent anywhere.",
    );
  }
  if (password.includes("\n")) {
    throw new ToolError(
      "multiline-input",
      "This checks one password at a time, and the input has more than one line.",
      "Paste a single password with no line breaks in it.",
    );
  }

  const attackerId =
    typeof opts.attacker === "string" && opts.attacker ? opts.attacker : "offline-fast";
  const scenario = SCENARIOS.find((s) => s.id === attackerId);
  if (!scenario) {
    throw new ToolError(
      "bad-option",
      `The option "attacker" does not recognize "${attackerId}".`,
      `Choose one of ${SCENARIOS.map((s) => s.id).join(", ")}.`,
    );
  }

  const analyzed = password.slice(0, MAX_ANALYZED);
  const analysis = analyze(analyzed);
  const score = scoreFor(analysis.guesses);
  const pool = characterPool(analyzed);
  const naiveBits = analyzed.length * Math.log2(pool.size);

  const result: PasswordStrengthResult = {
    Score: `${score.value} of 4 (${score.label})`,
    Why: score.rationale,
    "Estimated strength": `${analysis.bits.toFixed(1)} bits, about ${formatBig(analysis.guesses)} guesses`,
    "Naive strength": `${naiveBits.toFixed(1)} bits if every character were random, from ${analyzed.length} characters over a pool of ${pool.size}: ${pool.parts.join(", ")}. The estimate above is the honest one, because the patterns below cost far less than that.`,
    "Time to crack": `${humanTime(analysis.guesses / scenario.rate)} (${scenario.label})`,
  };

  for (const s of SCENARIOS) {
    result[s.label] = humanTime(analysis.guesses / s.rate);
  }

  if (boolOption(opts.showPatterns, true)) {
    const findings = analysis.sequence.map((m) => `${m.token}: ${m.detail}`);
    result.Findings =
      findings.length > 0
        ? findings.join("\n")
        : "No dictionary word, keyboard walk, run, repeat, or date was recognized in this password.";
    result["How it is guessed"] = analysis.pieces
      .map((p) =>
        p.match
          ? `"${p.token}" as a ${p.match.kind} pattern`
          : `"${p.token}" character by character`,
      )
      .join(", then ");
  }

  result.Suggestions = suggestions(analyzed, analysis, score)
    .map((line) => `- ${line}`)
    .join("\n");

  if (password.length > MAX_ANALYZED) {
    result.Note = `Only the first ${MAX_ANALYZED} characters were analyzed. A password this long is already far past the point where the estimate matters.`;
  }

  result.Privacy =
    "This password was analyzed entirely in this browser tab. Your files and inputs never leave your device, nothing was stored, and there is no server endpoint for this tool.";

  return result;
}

export default { run } satisfies ToolLogic<string, PasswordStrengthResult, PasswordStrengthOpts>;

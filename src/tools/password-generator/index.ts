import { ToolError, type ToolLogic } from '../types';
import { words } from './wordlist';

export interface PasswordOpts {
  /** 'password' | 'passphrase' */
  mode: string;
  length: number;
  lowercase: boolean;
  uppercase: boolean;
  digits: boolean;
  symbols: boolean;
  excludeAmbiguous: boolean;
  words: number;
  separator: string;
  capitalize: boolean;
  /** Empty = crypto.getRandomValues. Non-empty = deterministic xorshift128. */
  seed: string;
  [key: string]: unknown;
}

export type PasswordResult = Record<string, string>;

export const LOWER = 'abcdefghijklmnopqrstuvwxyz';
export const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const DIGITS = '0123456789';
export const SYMBOLS = '!@#$%^&*()-_=+[]{}:;,.?/~';
/** Characters that are easy to confuse in most fonts: zero/O, one/l/I, pipe. */
export const AMBIGUOUS_CHARS = '0O1lI|';

/**
 * FNV-1a 32-bit hash, used to turn an arbitrary seed string into xorshift128
 * state words. Four different starting offsets give four decorrelated words.
 */
function fnv1a(str: string, offset: number): number {
  let h = offset >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** xorshift128 PRNG (Marsaglia), seeded deterministically from a string. */
function makeXorshift128(seed: string): () => number {
  let x = fnv1a(seed, 0x811c9dc5);
  let y = fnv1a(`${seed}:1`, 0x9e3779b9);
  let z = fnv1a(`${seed}:2`, 0x85ebca6b);
  let w = fnv1a(`${seed}:3`, 0xc2b2ae35);
  // All-zero state is a fixed point (would emit zeros forever) — nudge it off.
  if ((x | y | z | w) === 0) w = 1;
  return function next(): number {
    const t = (x ^ (x << 11)) >>> 0;
    x = y;
    y = z;
    z = w;
    w = w ^ (w >>> 19) ^ (t ^ (t >>> 8));
    w >>>= 0;
    return w;
  };
}

/** crypto.getRandomValues, wrapped to match the xorshift128 next() shape. */
function makeCryptoRng(): () => number {
  return function next(): number {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    return buf[0] as number;
  };
}

function makeRng(seed: string): () => number {
  return seed ? makeXorshift128(seed) : makeCryptoRng();
}

/** Uniform random index in [0, n) via rejection sampling — avoids modulo bias. */
function randomIndex(n: number, next: () => number): number {
  const limit = Math.floor(0x100000000 / n) * n;
  let r = next();
  while (r >= limit) r = next();
  return r % n;
}

function buildPool(opts: PasswordOpts): string {
  let pool = '';
  if (opts.lowercase) pool += LOWER;
  if (opts.uppercase) pool += UPPER;
  if (opts.digits) pool += DIGITS;
  if (opts.symbols) pool += SYMBOLS;
  if (opts.excludeAmbiguous) {
    const ambiguous = new Set(AMBIGUOUS_CHARS);
    pool = [...pool].filter((c) => !ambiguous.has(c)).join('');
  }
  return pool;
}

function generatePassword(opts: PasswordOpts): { value: string; poolSize: number } {
  const pool = buildPool(opts);
  if (!pool)
    throw new ToolError(
      'no-charset',
      'At least one character set must be enabled to generate a password.',
      'Turn on lowercase, uppercase, digits, or symbols.',
    );

  const length = Math.floor(opts.length);
  if (!Number.isFinite(length) || length < 8 || length > 128)
    throw new ToolError('bad-length', 'Password length must be between 8 and 128.');

  const next = makeRng(opts.seed || '');
  const chars = Array.from({ length }, () => pool[randomIndex(pool.length, next)] as string);
  return { value: chars.join(''), poolSize: pool.length };
}

function generatePassphrase(opts: PasswordOpts): { value: string; wordCount: number } {
  const count = Math.floor(opts.words);
  if (!Number.isFinite(count) || count < 3 || count > 12)
    throw new ToolError('bad-word-count', 'Word count must be between 3 and 12.');

  const next = makeRng(opts.seed || '');
  const picked = Array.from(
    { length: count },
    () => words[randomIndex(words.length, next)] as string,
  );
  const finalWords = opts.capitalize
    ? picked.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    : picked;
  const separator = opts.separator ?? '-';
  return { value: finalWords.join(separator), wordCount: count };
}

/** Formats a large positive number: fixed for small, grouped for medium, exponential beyond. */
function formatCount(n: number): string {
  if (n < 1000) return n.toFixed(1);
  if (n < 1e21) return Math.round(n).toLocaleString('en-US');
  return n.toExponential(2);
}

const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const YEAR = 365.25 * DAY;
const CENTURY = 100 * YEAR;

/** Humanizes a crack-time duration in seconds, from "instant" up to centuries. */
export function humanizeCrackTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'longer than the heat death of the universe';
  if (seconds < 1) return 'instantly';

  const ladder: [string, number][] = [
    ['seconds', SECOND],
    ['minutes', MINUTE],
    ['hours', HOUR],
    ['days', DAY],
    ['years', YEAR],
    ['centuries', CENTURY],
  ];
  let unit = ladder[0] as [string, number];
  for (const entry of ladder) {
    if (seconds >= entry[1]) unit = entry;
  }
  return `${formatCount(seconds / unit[1])} ${unit[0]}`;
}

/** log2(poolSize) * length — bits of entropy assuming a uniform, unknown selection. */
function entropyBits(poolSize: number, count: number): number {
  return Math.log2(poolSize) * count;
}

export function run(_input: undefined, opts: PasswordOpts): PasswordResult {
  const mode = opts.mode === 'passphrase' ? 'passphrase' : 'password';

  if (mode === 'passphrase') {
    const { value, wordCount } = generatePassphrase(opts);
    const bits = entropyBits(words.length, wordCount);
    const crackSeconds = Math.pow(2, bits) / 1e10;
    return {
      Passphrase: value,
      Entropy: `${bits.toFixed(1)} bits`,
      'Crack time @ 10¹⁰/s': humanizeCrackTime(crackSeconds),
    };
  }

  if (!opts.lowercase && !opts.uppercase && !opts.digits && !opts.symbols)
    throw new ToolError(
      'no-charset',
      'At least one character set must be enabled to generate a password.',
      'Turn on lowercase, uppercase, digits, or symbols.',
    );

  const { value, poolSize } = generatePassword(opts);
  const bits = entropyBits(poolSize, value.length);
  const crackSeconds = Math.pow(2, bits) / 1e10;
  return {
    Password: value,
    Entropy: `${bits.toFixed(1)} bits`,
    'Crack time @ 10¹⁰/s': humanizeCrackTime(crackSeconds),
  };
}

export default { run } satisfies ToolLogic<undefined, PasswordResult, PasswordOpts>;

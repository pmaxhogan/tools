import { ToolError, type ToolLogic } from '../types';

export interface RandomPickerOpts {
  /** 'dice' | 'coin' | 'pick' | 'teams' */
  mode: string;
  count: number;
  /** Empty = crypto random; non-empty = deterministic PRNG seeded from this string. */
  seed: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Randomness: crypto by default, a small seeded PRNG when opts.seed is set so
// tests (and users who want reproducible results) get exact, stable output.
// ---------------------------------------------------------------------------

/** cyrb53-style string hash -> 32-bit seed for the PRNG below. */
function hashString(str: string): number {
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  return h1 >>> 0;
}

/** mulberry32 — tiny, fast, deterministic PRNG returning floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cryptoRandom(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0]! / 4294967296;
}

/** Returns a `() => number` in [0, 1): seeded + repeatable when `seed` is non-empty. */
export function getRng(seed: string): () => number {
  return seed ? mulberry32(hashString(seed)) : cryptoRandom;
}

/** Uniform random integer in [0, maxExclusive). */
function randomInt(next: () => number, maxExclusive: number): number {
  return Math.floor(next() * maxExclusive);
}

/** Fisher-Yates shuffle; returns a new array, does not mutate the input. */
function shuffle<T>(items: T[], next: () => number): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(next, i + 1);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function parseLines(input: string | undefined): string[] {
  return (input ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function validateCount(count: number): number {
  const n = Math.floor(count);
  if (!Number.isFinite(n) || n < 1 || n > 100)
    throw new ToolError('bad-count', 'Count must be between 1 and 100.');
  return n;
}

// ---------------------------------------------------------------------------
// Dice
// ---------------------------------------------------------------------------

export interface DiceNotation {
  count: number;
  sides: number;
  modifier: number;
}

const DICE_RE = /^(\d*)d(\d+)\s*([+-]\s*\d+)?$/i;

export function parseDiceNotation(raw: string): DiceNotation {
  const s = (raw ?? '').trim();
  if (!s)
    throw new ToolError(
      'empty-input',
      'Enter dice notation to roll.',
      'Use notation like "d20", "3d6", or "2d6+3".',
    );

  const m = DICE_RE.exec(s);
  if (!m)
    throw new ToolError(
      'invalid-notation',
      `Could not parse "${s}" as dice notation.`,
      'Use notation like "d20", "3d6", or "2d6+3" (NdM with an optional +/-K modifier).',
    );

  const count = m[1] ? parseInt(m[1], 10) : 1;
  const sides = parseInt(m[2]!, 10);
  const modifier = m[3] ? parseInt(m[3].replace(/\s+/g, ''), 10) : 0;

  if (count < 1 || count > 100)
    throw new ToolError(
      'invalid-notation',
      `Dice count ${count} is out of range.`,
      'Use between 1 and 100 dice, e.g. "3d6+2".',
    );
  if (sides < 1 || sides > 1000)
    throw new ToolError(
      'invalid-notation',
      `Die size d${sides} is out of range.`,
      'Use a die size between 1 and 1000, e.g. "d20".',
    );

  return { count, sides, modifier };
}

export interface DiceResult {
  rolls: number[];
  modifier: number;
  total: number;
}

export function rollDice(notation: DiceNotation, next: () => number): DiceResult {
  const rolls = Array.from({ length: notation.count }, () => randomInt(next, notation.sides) + 1);
  const total = rolls.reduce((a, b) => a + b, 0) + notation.modifier;
  return { rolls, modifier: notation.modifier, total };
}

function formatDiceResult({ rolls, modifier, total }: DiceResult): string {
  const parts = [`Rolls: ${rolls.join(', ')}`];
  if (modifier !== 0) parts.push(`Modifier: ${modifier > 0 ? '+' : ''}${modifier}`);
  parts.push(`Total: ${total}`);
  return parts.join(' | ');
}

// ---------------------------------------------------------------------------
// Coin
// ---------------------------------------------------------------------------

function flipCoins(count: number, next: () => number): string[] {
  return Array.from({ length: count }, () => (next() < 0.5 ? 'Heads' : 'Tails'));
}

function formatCoinResult(flips: string[]): string {
  if (flips.length === 1) return flips[0]!;
  const heads = flips.filter((f) => f === 'Heads').length;
  const tails = flips.length - heads;
  return `Flips: ${flips.join(', ')} | Heads: ${heads}, Tails: ${tails}`;
}

// ---------------------------------------------------------------------------
// Pick
// ---------------------------------------------------------------------------

export function pickItems(items: string[], count: number, next: () => number): string[] {
  if (items.length === 0)
    throw new ToolError('empty-input', 'Enter at least one item, one per line, to pick from.');
  if (count > items.length)
    throw new ToolError(
      'not-enough-items',
      `Cannot pick ${count} distinct items from a list of ${items.length}.`,
      'Reduce the count or add more items, one per line.',
    );
  return shuffle(items, next).slice(0, count);
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export function splitTeams(names: string[], teamCount: number, next: () => number): string[][] {
  if (names.length === 0)
    throw new ToolError(
      'empty-input',
      'Enter at least one name, one per line, to split into teams.',
    );
  if (teamCount > names.length)
    throw new ToolError(
      'not-enough-items',
      `Cannot split ${names.length} names into ${teamCount} teams.`,
      'Reduce the team count or add more names, one per line.',
    );

  const shuffled = shuffle(names, next);
  const teams: string[][] = Array.from({ length: teamCount }, () => []);
  shuffled.forEach((name, i) => teams[i % teamCount]!.push(name));
  return teams;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export const run: ToolLogic<string, string, RandomPickerOpts>['run'] = (input, opts) => {
  const next = getRng(opts.seed ?? '');

  switch (opts.mode) {
    case 'dice': {
      const notation = parseDiceNotation(input ?? '');
      return formatDiceResult(rollDice(notation, next));
    }
    case 'coin': {
      const count = validateCount(opts.count);
      return formatCoinResult(flipCoins(count, next));
    }
    case 'pick': {
      const count = validateCount(opts.count);
      const picked = pickItems(parseLines(input), count, next);
      return `Picked: ${picked.join(', ')}`;
    }
    case 'teams': {
      const count = validateCount(opts.count);
      const teams = splitTeams(parseLines(input), count, next);
      return teams.map((t, i) => `Team ${i + 1}: ${t.join(', ')}`).join('\n');
    }
    default:
      throw new ToolError(
        'bad-mode',
        `Unknown mode "${opts.mode}".`,
        'Use one of: dice, coin, pick, teams.',
      );
  }
};

export default { run } satisfies ToolLogic<string, string, RandomPickerOpts>;

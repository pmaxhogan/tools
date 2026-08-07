import { ToolError, type ToolLogic } from '../types';

export interface LineSorterOpts {
  /** 'sort-az' | 'sort-za' | 'sort-natural' | 'sort-length' | 'dedupe' | 'reverse' | 'shuffle' */
  operation: string;
  caseInsensitive: boolean;
  trim: boolean;
  removeEmpty: boolean;
  /** Only used by 'shuffle'. Non-empty seed => deterministic PRNG. */
  seed: string;
  [key: string]: unknown;
}

/** Locale-aware line comparator; `natural` makes item2 < item10. */
function compareLines(a: string, b: string, natural: boolean, caseInsensitive: boolean): number {
  return a.localeCompare(b, undefined, {
    numeric: natural,
    sensitivity: caseInsensitive ? 'base' : 'variant',
  });
}

function dedupe(lines: string[], caseInsensitive: boolean): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = caseInsensitive ? line.toLowerCase() : line;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(line);
    }
  }
  return out;
}

/** 32-bit string hash (djb2 variant) used to seed the PRNG. */
function hashSeed(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
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

function shuffleLines(lines: string[], seed: string): string[] {
  const out = [...lines];
  const rand = seed ? mulberry32(hashSeed(seed)) : cryptoRandom;
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export const run: ToolLogic<string, string, LineSorterOpts>['run'] = (input, opts) => {
  if (!input || input.trim() === '')
    throw new ToolError(
      'empty-input',
      'Enter some lines of text to process.',
      'Paste multiple lines into the input, one per line.'
    );

  let lines = input.split(/\r?\n/);
  if (opts.trim) lines = lines.map((l) => l.trim());
  if (opts.removeEmpty) lines = lines.filter((l) => l.length > 0);

  switch (opts.operation) {
    case 'sort-az':
      lines = [...lines].sort((a, b) => compareLines(a, b, false, opts.caseInsensitive));
      break;
    case 'sort-za':
      lines = [...lines].sort((a, b) => compareLines(b, a, false, opts.caseInsensitive));
      break;
    case 'sort-natural':
      lines = [...lines].sort((a, b) => compareLines(a, b, true, opts.caseInsensitive));
      break;
    case 'sort-length':
      lines = [...lines].sort((a, b) => a.length - b.length);
      break;
    case 'dedupe':
      lines = dedupe(lines, opts.caseInsensitive);
      break;
    case 'reverse':
      lines = [...lines].reverse();
      break;
    case 'shuffle':
      lines = shuffleLines(lines, opts.seed ?? '');
      break;
    default:
      throw new ToolError(
        'unknown-operation',
        `Unknown operation "${opts.operation}".`,
        'Choose one of sort-az, sort-za, sort-natural, sort-length, dedupe, reverse, shuffle.'
      );
  }

  return lines.join('\n');
};

export default { run } satisfies ToolLogic<string, string, LineSorterOpts>;

import { ToolError, type ToolLogic } from "../types";

export interface BingoOpts {
  /** 3, 4, or 5. Defaults to 5. */
  size?: number;
  /** Place freeText in the exact center on odd sized boards. */
  freeSpace?: boolean;
  /** Text shown in the free space. Defaults to "FREE". */
  freeText?: string;
  /** Deterministic seed. Two calls with the same seed and items are identical. */
  seed: number;
  [key: string]: unknown;
}

export interface BingoBoardsOpts extends BingoOpts {
  /** How many distinct cards to generate. */
  count?: number;
}

export const BOARD_SIZES = [3, 4, 5] as const;

/**
 * mulberry32: a small, fast, deterministic PRNG seeded from a single 32 bit
 * number. Kept local to this file (no Math.random, no Date.now) so run() and
 * generateBoard() stay pure and reproducible across machines and processes.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle driven by an injected RNG, so it stays deterministic. */
function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp!;
  }
  return out;
}

/** Trims every entry and drops blanks and exact duplicates, keeping first-seen order. */
export function cleanItems(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function validSize(size: number): size is (typeof BOARD_SIZES)[number] {
  return (BOARD_SIZES as readonly number[]).includes(size);
}

/**
 * Builds one size x size grid of items. Trims and drops blank/duplicate
 * entries first, then shuffles deterministically with the given seed and
 * fills the grid row major. When freeSpace is set on an odd sized board, the
 * exact center cell gets freeText instead of an item and does not consume one.
 */
export function generateBoard(items: readonly string[], opts: BingoOpts): string[][] {
  const size = opts.size ?? 5;
  if (!validSize(size))
    throw new ToolError(
      "bad-size",
      `Board size must be 3, 4, or 5, got ${size}.`,
      "Choose 3x3, 4x4, or 5x5.",
    );

  const cleaned = cleanItems(items);
  const hasFreeSpace = Boolean(opts.freeSpace) && size % 2 === 1;
  const totalCells = size * size;
  const cellsToFill = totalCells - (hasFreeSpace ? 1 : 0);

  if (cleaned.length < cellsToFill) {
    const short = cellsToFill - cleaned.length;
    throw new ToolError(
      "not-enough-items",
      `A ${size}x${size} board needs ${cellsToFill} unique items${
        hasFreeSpace ? " (the free space does not count)" : ""
      }, but only ${cleaned.length} unique item${cleaned.length === 1 ? "" : "s"} were provided.`,
      `Add ${short} more unique item${short === 1 ? "" : "s"} to the list.`,
    );
  }

  const rng = mulberry32(opts.seed);
  const picked = shuffle(cleaned, rng).slice(0, cellsToFill);
  const freeText = (opts.freeText ?? "").trim() || "FREE";
  const center = Math.floor(size / 2);
  const centerLinear = center * size + center;

  const grid: string[][] = [];
  let cursor = 0;
  for (let row = 0; row < size; row += 1) {
    const line: string[] = [];
    for (let col = 0; col < size; col += 1) {
      const linear = row * size + col;
      if (hasFreeSpace && linear === centerLinear) {
        line.push(freeText);
      } else {
        line.push(picked[cursor]!);
        cursor += 1;
      }
    }
    grid.push(line);
  }
  return grid;
}

/**
 * Generates `count` distinct boards from the same item list. Each card uses
 * its own seed (the base seed plus its index) so cards differ from each other
 * while the whole set stays reproducible from a single seed value.
 */
export function generateBoards(items: readonly string[], opts: BingoBoardsOpts): string[][][] {
  const count = Math.floor(opts.count ?? 1);
  if (!Number.isFinite(count) || count < 1 || count > 50)
    throw new ToolError(
      "bad-count",
      `Number of cards must be between 1 and 50, got ${opts.count}.`,
      "Choose a count between 1 and 50.",
    );

  const baseSeed = opts.seed;
  return Array.from({ length: count }, (_, i) =>
    generateBoard(items, { ...opts, seed: baseSeed + i }),
  );
}

/** Plain text rendering of one grid: cells joined with " | ", rows on their own line. */
export function renderBoard(grid: readonly string[][]): string {
  return grid.map((row) => row.join(" | ")).join("\n");
}

export interface BingoRunOpts extends BingoBoardsOpts {
  [key: string]: unknown;
}

/**
 * Generic-panel entry point: input is the pasted item list, one per line.
 * Returns a labeled record of rendered cards so the fallback ToolShell can
 * still show something useful; the bespoke panel calls generateBoard(s)
 * directly to render an interactive grid instead of this text form.
 */
export function run(input: string, opts: BingoRunOpts): Record<string, string> {
  const items = (input ?? "").split("\n");
  if (cleanItems(items).length === 0)
    throw new ToolError(
      "empty-input",
      "Paste at least one item, one per line, to build a board.",
      "Add items to the list, one per line.",
    );

  const boards = generateBoards(items, opts);
  const out: Record<string, string> = {};
  boards.forEach((grid, i) => {
    out[boards.length === 1 ? "Board" : `Card ${i + 1}`] = renderBoard(grid);
  });
  return out;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, BingoRunOpts>;

import { ToolError, type ToolLogic } from "../types";

/**
 * The classic Minecraft "pixel circle" rasterizer: the same block-grid
 * midpoint method the community's circle and ellipse chart generators use.
 * Each block's own center point (not its corner) is tested against the
 * circle or ellipse equation, so a block is placed exactly when its
 * midpoint falls on or inside the boundary. Centering the ellipse exactly
 * on the grid's midpoint guarantees left/right and top/bottom symmetry by
 * construction (the boundary test only ever sees |dx| and |dy|), and for a
 * true circle (width equals height) it is symmetric across the diagonals
 * too. This reproduces the widely cited reference counts for small
 * diameters exactly: 1, 4, 9, 12, 21, 29, 37, 52, 69 blocks for diameters 1
 * through 9.
 */

export const MIN_SIZE = 1;
export const MAX_SIZE = 256;
export const MIN_THICKNESS = 1;

export type CircleMode = "filled" | "outline";

export interface CircleOptions {
  /** Grid width in blocks, 1 to 256. */
  width: number;
  /** Grid height in blocks, 1 to 256. */
  height: number;
  mode: CircleMode;
  /** Outline thickness in blocks, ignored for filled. */
  thickness: number;
}

export interface RowRun {
  /** Column index the run starts at. */
  start: number;
  /** Number of consecutive filled columns. */
  length: number;
}

export interface CircleGrid {
  width: number;
  height: number;
  /** cells[row][col], row 0 at the top. */
  cells: boolean[][];
  blockCount: number;
  /** Per row, the contiguous filled column runs (usually 1, up to 2 for an outline). */
  rowRuns: RowRun[][];
}

function validateSize(label: string, v: number): void {
  if (!Number.isInteger(v) || v < MIN_SIZE || v > MAX_SIZE)
    throw new ToolError(
      `invalid-${label.toLowerCase()}`,
      `${label} must be a whole number from ${MIN_SIZE} to ${MAX_SIZE}.`,
      `Set ${label.toLowerCase()} to an integer in that range.`,
    );
}

function runsInRow(row: readonly boolean[]): RowRun[] {
  const runs: RowRun[] = [];
  let start = -1;
  for (let i = 0; i < row.length; i++) {
    if (row[i] && start === -1) start = i;
    if (!row[i] && start !== -1) {
      runs.push({ start, length: i - start });
      start = -1;
    }
  }
  if (start !== -1) runs.push({ start, length: row.length - start });
  return runs;
}

/** Rasterizes a filled or outlined circle/ellipse grid. Pure geometry, no I/O. */
export function generateCircleGrid(opts: CircleOptions): CircleGrid {
  validateSize("Width", opts.width);
  validateSize("Height", opts.height);
  if (opts.mode !== "filled" && opts.mode !== "outline")
    throw new ToolError(
      "invalid-mode",
      `Unknown mode "${String(opts.mode)}".`,
      "Choose filled or outline.",
    );
  if (
    opts.mode === "outline" &&
    (!Number.isInteger(opts.thickness) || opts.thickness < MIN_THICKNESS)
  )
    throw new ToolError(
      "invalid-thickness",
      `Thickness must be a whole number of at least ${MIN_THICKNESS}.`,
      "Set thickness to a positive integer, or switch to filled.",
    );

  const { width, height, mode } = opts;
  const rx = width / 2;
  const ry = height / 2;
  const cx = width / 2;
  const cy = height / 2;
  // Shrinking both radii by the outline thickness gives the inner boundary;
  // a shrink that reaches zero or below on either axis means there is no
  // hole left to cut, so the shape is solid all the way through (an outline
  // thick enough to fill the whole circle IS the filled circle).
  const innerRx = mode === "outline" ? rx - opts.thickness : 0;
  const innerRy = mode === "outline" ? ry - opts.thickness : 0;
  const hasHole = mode === "outline" && innerRx > 0 && innerRy > 0;

  const cells: boolean[][] = [];
  const rowRuns: RowRun[][] = [];
  let blockCount = 0;

  for (let row = 0; row < height; row++) {
    const dy = row + 0.5 - cy;
    const rowCells: boolean[] = new Array(width);
    for (let col = 0; col < width; col++) {
      const dx = col + 0.5 - cx;
      const outerInside = (dx / rx) ** 2 + (dy / ry) ** 2 <= 1;
      let filled: boolean;
      if (mode === "filled") {
        filled = outerInside;
      } else {
        const innerInside = hasHole && (dx / innerRx) ** 2 + (dy / innerRy) ** 2 <= 1;
        filled = outerInside && !innerInside;
      }
      rowCells[col] = filled;
      if (filled) blockCount++;
    }
    cells.push(rowCells);
    rowRuns.push(runsInRow(rowCells));
  }

  return { width, height, cells, blockCount, rowRuns };
}

/** Renders a grid as `#`/`.` ASCII art, one row per line. */
export function gridToAscii(grid: CircleGrid): string {
  return grid.cells.map((row) => row.map((c) => (c ? "#" : ".")).join("")).join("\n");
}

/** Renders the run lengths compactly, one line per row: "start:length, start:length". */
export function gridToRunLengths(grid: CircleGrid): string {
  return grid.rowRuns
    .map(
      (runs, i) =>
        `Row ${i}: ${runs.length ? runs.map((r) => `${r.start}:${r.length}`).join(", ") : "empty"}`,
    )
    .join("\n");
}

export interface PixelCircleOpts {
  width: number;
  height: number;
  mode: string; // 'filled' | 'outline'
  thickness: number;
  [key: string]: unknown;
}

export type PixelCircleResult = Record<string, string>;

export function run(_input: undefined, opts: PixelCircleOpts): PixelCircleResult {
  const mode: CircleMode = opts.mode === "outline" ? "outline" : "filled";
  const grid = generateCircleGrid({
    width: opts.width,
    height: opts.height,
    mode,
    thickness: opts.thickness,
  });

  return {
    "Grid size": `${grid.width} x ${grid.height}`,
    Mode: mode === "outline" ? `Outline, ${opts.thickness} block thick` : "Filled",
    "Block count": grid.blockCount.toLocaleString("en-US"),
    "ASCII art": gridToAscii(grid),
  };
}

export default { run } satisfies ToolLogic<undefined, PixelCircleResult, PixelCircleOpts>;

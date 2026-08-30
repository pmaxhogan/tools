import { ToolError, type ToolLogic } from "../types";

/**
 * A sudoku grid as 81 cells in row major order. 0 means empty, 1 to 9 are
 * placed digits. A flat array keeps the solver's hot loops simple and makes
 * peer lookups a single indexed read.
 */
export type Grid = number[];

export const CELL_COUNT = 81;

/** Bit 1 through bit 9 set: the candidate mask for "any digit is possible". */
const ALL_MASK = 0b1111111110;

/* ------------------------------------------------------------------ */
/* Unit and peer tables, computed once at module load                  */
/* ------------------------------------------------------------------ */

function buildUnits(): number[][] {
  const units: number[][] = [];
  for (let r = 0; r < 9; r += 1) units.push(Array.from({ length: 9 }, (_, c) => r * 9 + c));
  for (let c = 0; c < 9; c += 1) units.push(Array.from({ length: 9 }, (_, r) => r * 9 + c));
  for (let br = 0; br < 3; br += 1) {
    for (let bc = 0; bc < 3; bc += 1) {
      const unit: number[] = [];
      for (let r = 0; r < 3; r += 1) {
        for (let c = 0; c < 3; c += 1) unit.push((br * 3 + r) * 9 + (bc * 3 + c));
      }
      units.push(unit);
    }
  }
  return units;
}

/** All 27 units: 9 rows, then 9 columns, then 9 boxes, in that order. */
const UNIT_LIST = buildUnits();

/** The 20 cells that share a row, column, or box with each cell. */
const PEERS: number[][] = Array.from({ length: CELL_COUNT }, (_, i) => {
  const peers = new Set<number>();
  for (const unit of UNIT_LIST) {
    if (!unit.includes(i)) continue;
    for (const j of unit) if (j !== i) peers.add(j);
  }
  return [...peers];
});

/** Human labels for a unit index, used in hint explanations. */
function unitLabel(unitIndex: number): string {
  if (unitIndex < 9) return `Row ${unitIndex + 1}`;
  if (unitIndex < 18) return `Column ${unitIndex - 9 + 1}`;
  return `Box ${unitIndex - 18 + 1}`;
}

export function rowOf(index: number): number {
  return Math.floor(index / 9);
}

export function colOf(index: number): number {
  return index % 9;
}

/** "R4C2" style coordinate, 1 based, for hint text. */
function cellLabel(index: number): string {
  return `R${rowOf(index) + 1}C${colOf(index) + 1}`;
}

/* ------------------------------------------------------------------ */
/* Bit helpers                                                          */
/* ------------------------------------------------------------------ */

function popcount(mask: number): number {
  let n = 0;
  let m = mask;
  while (m) {
    m &= m - 1;
    n += 1;
  }
  return n;
}

/** The digit of a single bit mask (assumes exactly one bit is set). */
function digitOf(mask: number): number {
  return 31 - Math.clz32(mask);
}

function maskDigits(mask: number): number[] {
  const out: number[] = [];
  for (let v = 1; v <= 9; v += 1) if (mask & (1 << v)) out.push(v);
  return out;
}

/* ------------------------------------------------------------------ */
/* Deterministic randomness                                             */
/* ------------------------------------------------------------------ */

/**
 * mulberry32: a small, fast, deterministic PRNG seeded from a single 32 bit
 * number. Local to this file (no Math.random, no Date.now) so generation
 * stays pure and reproducible across machines and processes.
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

/**
 * Turns a free-form seed into the uint32 the generator wants. A digit-only
 * seed maps straight through, so a numeric share link reproduces exactly;
 * anything else is FNV-1a hashed, letting someone type a memorable phrase
 * like "friday-puzzle" and get the same grid back every time.
 */
export function seedToNumber(raw: string): number {
  const s = String(raw ?? "").trim();
  if (s === "") return 0;
  if (/^\d+$/.test(s)) return Number(s) >>> 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A cryptographically random uint32, for a generate call with no seed. */
function randomSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0]!;
}

/* ------------------------------------------------------------------ */
/* Parsing                                                              */
/* ------------------------------------------------------------------ */

/** Characters that separate cells in a pasted grid and carry no value. */
const SEPARATORS = new Set([" ", "\t", "\n", "\r", "|", "+", "-", ",", "/", "\\"]);
/** Characters that all mean "this cell is empty". */
const BLANKS = new Set([".", "0", "_", "*", "x", "X", "?"]);

/**
 * Reads an 81 character string or 9 lines of 9 cells into a grid. Spaces,
 * newlines, and the usual box-drawing separators are ignored, so a puzzle
 * copied out of a book layout parses as readily as one long line. Blanks may
 * be written as 0, a period, an underscore, an asterisk, an x, or a question
 * mark.
 */
export function parsePuzzle(text: string): Grid {
  const raw = String(text ?? "");
  if (raw.trim() === "")
    throw new ToolError(
      "empty-input",
      "No puzzle was provided.",
      "Paste 81 characters, or 9 lines of 9 cells, using 0 or a period for the blanks.",
    );

  const cells: number[] = [];
  for (const ch of raw) {
    if (SEPARATORS.has(ch)) continue;
    if (BLANKS.has(ch)) {
      cells.push(0);
      continue;
    }
    if (ch >= "1" && ch <= "9") {
      cells.push(ch.charCodeAt(0) - 48);
      continue;
    }
    throw new ToolError(
      "bad-char",
      `"${ch}" is not a valid sudoku cell.`,
      "Use 1 through 9 for filled cells and 0 or a period for blanks. Spaces, newlines, and box separators are ignored.",
    );
  }

  if (cells.length !== CELL_COUNT)
    throw new ToolError(
      "bad-length",
      `A sudoku needs 81 cells, but ${cells.length} ${cells.length === 1 ? "was" : "were"} found.`,
      cells.length < CELL_COUNT
        ? `Add ${CELL_COUNT - cells.length} more cells, using 0 or a period for each blank.`
        : `Remove ${cells.length - CELL_COUNT} cells. Only 1 to 9 and blank markers count.`,
    );

  const clash = findConflicts(cells);
  if (clash.length > 0) {
    const first = clash[0]!;
    throw new ToolError(
      "contradiction",
      `The grid breaks sudoku rules already: ${cellLabel(first)} repeats a ${cells[first]} in its row, column, or box.`,
      "Fix the duplicate digit, then try again.",
    );
  }

  return cells;
}

/**
 * Every index holding a digit that repeats within one of its units. Used both
 * by the parser (a pasted grid that is already broken) and by the panel's
 * Check action, which highlights the offending cells rather than throwing.
 */
export function findConflicts(grid: readonly number[]): number[] {
  const bad = new Set<number>();
  for (const unit of UNIT_LIST) {
    const seen = new Map<number, number[]>();
    for (const i of unit) {
      const v = grid[i] ?? 0;
      if (!v) continue;
      const list = seen.get(v);
      if (list) list.push(i);
      else seen.set(v, [i]);
    }
    for (const list of seen.values()) {
      if (list.length > 1) for (const i of list) bad.add(i);
    }
  }
  return [...bad].sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ */
/* Candidates and constraint propagation                                */
/* ------------------------------------------------------------------ */

function candidateMask(grid: readonly number[], index: number): number {
  let used = 0;
  for (const p of PEERS[index]!) {
    const v = grid[p]!;
    if (v) used |= 1 << v;
  }
  return ALL_MASK & ~used;
}

/** The digits that could legally go in an empty cell, ascending. */
export function candidatesFor(grid: readonly number[], index: number): number[] {
  if (grid[index]) return [];
  return maskDigits(candidateMask(grid, index));
}

/**
 * Fills every cell forced by naked singles, in place. Returns false the
 * moment the grid is proven impossible (an empty cell with no candidate).
 */
function propagateNaked(grid: Grid): boolean {
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = 0; i < CELL_COUNT; i += 1) {
      if (grid[i]) continue;
      const mask = candidateMask(grid, i);
      if (mask === 0) return false;
      if ((mask & (mask - 1)) === 0) {
        grid[i] = digitOf(mask);
        progress = true;
      }
    }
  }
  return true;
}

/**
 * Naked singles plus hidden singles, applied to fixpoint, in place. These are
 * the two techniques a human learns first, and together they crack most easy
 * and medium puzzles without a single guess, so running them before branching
 * cuts the search tree dramatically. Returns false on a proven contradiction.
 */
function propagate(grid: Grid): boolean {
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = 0; i < CELL_COUNT; i += 1) {
      if (grid[i]) continue;
      const mask = candidateMask(grid, i);
      if (mask === 0) return false;
      if ((mask & (mask - 1)) === 0) {
        grid[i] = digitOf(mask);
        progress = true;
      }
    }

    for (const unit of UNIT_LIST) {
      for (let v = 1; v <= 9; v += 1) {
        let placed = false;
        for (const i of unit) {
          if (grid[i] === v) {
            placed = true;
            break;
          }
        }
        if (placed) continue;

        const bit = 1 << v;
        let spot = -1;
        let count = 0;
        for (const i of unit) {
          if (grid[i]) continue;
          if (candidateMask(grid, i) & bit) {
            count += 1;
            spot = i;
            if (count > 1) break;
          }
        }
        if (count === 0) return false;
        if (count === 1) {
          grid[spot] = v;
          progress = true;
        }
      }
    }
  }
  return true;
}

function isComplete(grid: readonly number[]): boolean {
  for (let i = 0; i < CELL_COUNT; i += 1) if (!grid[i]) return false;
  return true;
}

/**
 * Depth first search with propagation at every node, branching on the empty
 * cell with the fewest candidates. Collects up to `cap` solutions and stops,
 * which is what makes the uniqueness test cheap: proving a second solution
 * exists is usually far faster than enumerating all of them.
 */
function search(grid: readonly number[], cap: number, out: Grid[], rng?: () => number): void {
  if (out.length >= cap) return;
  const work = grid.slice();
  if (!propagate(work)) return;

  let best = -1;
  let bestCount = 10;
  let bestMask = 0;
  for (let i = 0; i < CELL_COUNT; i += 1) {
    if (work[i]) continue;
    const mask = candidateMask(work, i);
    const count = popcount(mask);
    if (count < bestCount) {
      best = i;
      bestCount = count;
      bestMask = mask;
      if (count === 2) break;
    }
  }

  if (best === -1) {
    out.push(work);
    return;
  }

  const digits = rng ? shuffle(maskDigits(bestMask), rng) : maskDigits(bestMask);
  for (const v of digits) {
    work[best] = v;
    search(work, cap, out, rng);
    work[best] = 0;
    if (out.length >= cap) return;
  }
}

/**
 * How many solutions the grid has, counted only as far as `cap`. A return of
 * 2 with the default cap means "at least two", never exactly two.
 */
export function countSolutions(grid: readonly number[], cap = 2): number {
  const out: Grid[] = [];
  search(grid, Math.max(1, Math.floor(cap)), out);
  return out.length;
}

export type SolveStatus = "solved" | "no-solution" | "multiple-solutions";

export interface SolveResult {
  status: SolveStatus;
  /** The first solution found. Absent only when the puzzle has none. */
  solution?: Grid;
  /** Solutions found, capped at 2: a 2 means "at least two". */
  count: number;
}

/**
 * Solves a grid and reports whether the answer is unique. A well formed
 * puzzle returns "solved"; an over-constrained one returns "no-solution";
 * an under-constrained one returns "multiple-solutions" along with one of
 * the answers, so a caller can still show something concrete.
 */
export function solve(grid: readonly number[]): SolveResult {
  const out: Grid[] = [];
  search(grid, 2, out);
  if (out.length === 0) return { status: "no-solution", count: 0 };
  if (out.length === 1) return { status: "solved", solution: out[0]!, count: 1 };
  return { status: "multiple-solutions", solution: out[0]!, count: 2 };
}

/** True when naked singles alone finish the grid. */
export function solvedByNakedSingles(grid: readonly number[]): boolean {
  const work = grid.slice();
  if (!propagateNaked(work)) return false;
  return isComplete(work);
}

/** True when naked and hidden singles together finish the grid. */
export function solvedBySingles(grid: readonly number[]): boolean {
  const work = grid.slice();
  if (!propagate(work)) return false;
  return isComplete(work);
}

/* ------------------------------------------------------------------ */
/* Hints                                                                */
/* ------------------------------------------------------------------ */

export type HintKind = "naked-single" | "hidden-single" | "solved" | "none";

export interface Hint {
  kind: HintKind;
  /** Cell index the step fills, when the hint names one. */
  index?: number;
  /** 1 based row and column of that cell. */
  row?: number;
  col?: number;
  /** Digit to write there. */
  value?: number;
  /** One sentence a person can act on and learn from. */
  explanation: string;
}

/**
 * The next single step a human could take, preferring the technique that is
 * easiest to see: a naked single (one cell, one possible digit) before a
 * hidden single (one digit with only one home left in a unit). Pure and
 * side effect free, so the panel can show the reasoning without applying it.
 */
export function nextHint(grid: readonly number[]): Hint {
  if (findConflicts(grid).length > 0)
    return {
      kind: "none",
      explanation:
        "This grid already breaks sudoku rules, so no step follows from it. Use Check to find the duplicate digits.",
    };

  if (isComplete(grid))
    return { kind: "solved", explanation: "Every cell is filled and the grid is valid." };

  for (let i = 0; i < CELL_COUNT; i += 1) {
    if (grid[i]) continue;
    const mask = candidateMask(grid, i);
    if (mask === 0)
      return {
        kind: "none",
        explanation: `${cellLabel(i)} has no digit left that fits, so an earlier entry must be wrong.`,
      };
    if ((mask & (mask - 1)) === 0) {
      const value = digitOf(mask);
      return {
        kind: "naked-single",
        index: i,
        row: rowOf(i) + 1,
        col: colOf(i) + 1,
        value,
        explanation: `${cellLabel(i)} can only be ${value}, because the other eight digits already appear in its row, column, or box.`,
      };
    }
  }

  for (let u = 0; u < UNIT_LIST.length; u += 1) {
    const unit = UNIT_LIST[u]!;
    for (let v = 1; v <= 9; v += 1) {
      let placed = false;
      for (const i of unit) {
        if (grid[i] === v) {
          placed = true;
          break;
        }
      }
      if (placed) continue;

      const bit = 1 << v;
      let spot = -1;
      let count = 0;
      for (const i of unit) {
        if (grid[i]) continue;
        if (candidateMask(grid, i) & bit) {
          count += 1;
          spot = i;
          if (count > 1) break;
        }
      }
      if (count === 1) {
        return {
          kind: "hidden-single",
          index: spot,
          row: rowOf(spot) + 1,
          col: colOf(spot) + 1,
          value: v,
          explanation: `${unitLabel(u)} can only place its ${v} at ${cellLabel(spot)}, because every other empty cell there already sees a ${v}.`,
        };
      }
    }
  }

  return {
    kind: "none",
    explanation:
      "No naked single or hidden single is left. From here the puzzle needs a more advanced technique, such as looking at pairs of candidates across a box and a row.",
  };
}

/* ------------------------------------------------------------------ */
/* Generation                                                           */
/* ------------------------------------------------------------------ */

export const DIFFICULTIES = ["easy", "medium", "hard", "expert"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

interface DifficultySpec {
  /** "naked" and "singles" keep the puzzle solvable by that technique alone. */
  technique: "naked" | "singles" | "beyond-singles";
  /** Stop digging once the puzzle is this small, so grids stay solvable by hand. */
  floor: number;
  /** For the harder tiers, keep digging until at least this few clues remain. */
  target: number;
}

/**
 * Difficulty is defined by the technique a solver needs, not by clue count
 * alone: a 30 clue grid that falls to naked singles is easier than a 34 clue
 * grid that does not. Clue floors keep the harder tiers from digging into
 * grids that are only solvable by long trial and error.
 */
const DIFFICULTY_SPECS: Record<Difficulty, DifficultySpec> = {
  easy: { technique: "naked", floor: 36, target: 40 },
  medium: { technique: "singles", floor: 30, target: 34 },
  hard: { technique: "beyond-singles", floor: 26, target: 28 },
  expert: { technique: "beyond-singles", floor: 22, target: 24 },
};

export interface GenerateOpts {
  difficulty?: Difficulty | string;
  /** uint32. The same seed and difficulty always produce the same puzzle. */
  seed: number;
}

export interface GeneratedPuzzle {
  puzzle: Grid;
  solution: Grid;
  clues: number;
  difficulty: Difficulty;
  seed: number;
  /** True when naked and hidden singles alone finish the puzzle. */
  singlesOnly: boolean;
}

function assertDifficulty(value: string | undefined): Difficulty {
  const d = (value ?? "medium").toLowerCase();
  if ((DIFFICULTIES as readonly string[]).includes(d)) return d as Difficulty;
  throw new ToolError(
    "bad-difficulty",
    `"${value}" is not a difficulty this tool knows.`,
    `Choose one of: ${DIFFICULTIES.join(", ")}.`,
  );
}

/** A random complete, valid grid, built by solving the empty grid in a shuffled order. */
export function generateSolved(rng: () => number): Grid {
  const out: Grid[] = [];
  search(new Array<number>(CELL_COUNT).fill(0), 1, out, rng);
  return out[0]!;
}

/**
 * Builds a puzzle with exactly one solution. Starts from a complete grid and
 * removes clues one at a time in a seeded random order, putting any clue back
 * whenever its removal would let a second solution exist or would push the
 * puzzle past the difficulty's technique requirement. Uniqueness is therefore
 * a property of every intermediate grid, not something checked at the end.
 */
export function generatePuzzle(opts: GenerateOpts): GeneratedPuzzle {
  const difficulty = assertDifficulty(
    typeof opts.difficulty === "string" ? opts.difficulty : undefined,
  );
  const spec = DIFFICULTY_SPECS[difficulty];
  const seed = Number.isFinite(opts.seed) ? opts.seed >>> 0 : 0;
  const rng = mulberry32(seed);

  const solution = generateSolved(rng);
  const puzzle = solution.slice();
  const order = shuffle(
    Array.from({ length: CELL_COUNT }, (_, i) => i),
    rng,
  );

  let clues = CELL_COUNT;
  for (const i of order) {
    if (clues - 1 < spec.floor) break;
    if (clues <= spec.target && spec.technique !== "beyond-singles") break;
    if (clues <= spec.target && !solvedBySingles(puzzle)) break;

    const saved = puzzle[i]!;
    puzzle[i] = 0;

    if (countSolutions(puzzle, 2) !== 1) {
      puzzle[i] = saved;
      continue;
    }
    if (spec.technique === "naked" && !solvedByNakedSingles(puzzle)) {
      puzzle[i] = saved;
      continue;
    }
    if (spec.technique === "singles" && !solvedBySingles(puzzle)) {
      puzzle[i] = saved;
      continue;
    }
    clues -= 1;
  }

  return {
    puzzle,
    solution,
    clues,
    difficulty,
    seed,
    singlesOnly: solvedBySingles(puzzle),
  };
}

/* ------------------------------------------------------------------ */
/* Formatting                                                           */
/* ------------------------------------------------------------------ */

export type GridFormat = "grid" | "line";

/**
 * Renders a grid as either one 81 character line (compact, and what the URL
 * fragment carries) or a boxed 9 line layout that reads like a printed
 * puzzle. Empty cells are periods in both forms.
 */
export function formatGrid(grid: readonly number[], style: GridFormat = "grid"): string {
  const ch = (v: number): string => (v ? String(v) : ".");
  if (style === "line")
    return Array.from({ length: CELL_COUNT }, (_, i) => ch(grid[i] ?? 0)).join("");

  const lines: string[] = [];
  for (let r = 0; r < 9; r += 1) {
    if (r > 0 && r % 3 === 0) lines.push("------+-------+------");
    const parts: string[] = [];
    for (let b = 0; b < 3; b += 1) {
      const chunk: string[] = [];
      for (let c = 0; c < 3; c += 1) chunk.push(ch(grid[r * 9 + b * 3 + c] ?? 0));
      parts.push(chunk.join(" "));
    }
    lines.push(parts.join(" | "));
  }
  return lines.join("\n");
}

/** Count of filled cells: the clue count of a puzzle. */
export function clueCount(grid: readonly number[]): number {
  let n = 0;
  for (let i = 0; i < CELL_COUNT; i += 1) if (grid[i]) n += 1;
  return n;
}

/* ------------------------------------------------------------------ */
/* Generic panel and curl entry point                                   */
/* ------------------------------------------------------------------ */

export interface SudokuOpts {
  difficulty?: string;
  /** Free text: digits pass through, anything else is hashed. */
  seed?: string | number;
  format?: string;
  [key: string]: unknown;
}

function formatOf(value: unknown): GridFormat {
  return value === "line" ? "line" : "grid";
}

/**
 * Empty input generates a puzzle at the chosen difficulty and seed; any other
 * input is parsed and solved. An unsolvable grid is a bad input and throws;
 * an under-constrained one is a legitimate finding, so it comes back as a
 * labeled row with one of the answers rather than as an error.
 */
export function run(input: string, opts: SudokuOpts = {}): Record<string, string> {
  const style = formatOf(opts.format);
  const text = String(input ?? "").trim();

  if (text === "") {
    const rawSeed = opts.seed === undefined || opts.seed === "" ? null : String(opts.seed);
    const seed = rawSeed === null ? randomSeed() : seedToNumber(rawSeed);
    const made = generatePuzzle({ difficulty: opts.difficulty, seed });
    return {
      Puzzle: formatGrid(made.puzzle, style),
      Solution: formatGrid(made.solution, style),
      "Puzzle line": formatGrid(made.puzzle, "line"),
      Difficulty: made.difficulty,
      Clues: String(made.clues),
      "Solvable by singles alone": made.singlesOnly ? "yes" : "no",
      Seed: String(made.seed),
    };
  }

  const grid = parsePuzzle(text);
  const result = solve(grid);

  if (result.status === "no-solution")
    throw new ToolError(
      "no-solution",
      "This grid has no solution: no arrangement of digits satisfies every row, column, and box.",
      "Check the givens for a typo. A grid can look legal cell by cell and still be impossible as a whole.",
    );

  const rows: Record<string, string> = {
    Puzzle: formatGrid(grid, style),
    Solution: formatGrid(result.solution!, style),
    Status:
      result.status === "solved"
        ? "Solved, and the solution is unique"
        : "At least two solutions exist, so this puzzle is under-constrained. One of them is shown.",
    Clues: String(clueCount(grid)),
  };
  if (result.status === "solved") {
    rows["Solvable by singles alone"] = solvedBySingles(grid) ? "yes" : "no";
  }
  return rows;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, SudokuOpts>;

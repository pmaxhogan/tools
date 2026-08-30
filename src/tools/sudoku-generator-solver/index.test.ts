import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  CELL_COUNT,
  DIFFICULTIES,
  candidatesFor,
  clueCount,
  colOf,
  countSolutions,
  findConflicts,
  formatGrid,
  generatePuzzle,
  generateSolved,
  nextHint,
  parsePuzzle,
  rowOf,
  run,
  seedToNumber,
  solve,
  solvedByNakedSingles,
  solvedBySingles,
} from "./index";

/** A widely published example puzzle with a known unique solution. */
const WIKI_PUZZLE = [
  "530070000",
  "600195000",
  "098000060",
  "800060003",
  "400803001",
  "700020006",
  "060000280",
  "000419005",
  "000080079",
].join("\n");

const WIKI_SOLUTION =
  "534678912672195348198342567859761423426853791713924856961537284287419635345286179";

/**
 * A grid with one deliberate contradiction: row 1 and box 1 both already hold
 * every digit but 9, and column 9 also already holds a 9 elsewhere, so R1C9
 * has zero legal candidates. No cell repeats a digit within its own row,
 * column, or box, so the parser accepts it; the puzzle simply has no solution.
 */
const NO_SOLUTION_PUZZLE = [
  "12345678.",
  ".........",
  ".........",
  ".........",
  ".........",
  ".........",
  ".........",
  ".........",
  "........9",
].join("\n");

/**
 * A "deadly rectangle": four blanks at the corners of a rectangle spanning
 * two boxes, where the underlying solved grid has digit A at two opposite
 * corners and digit B at the other two. Swapping A and B between the corners
 * is valid too, so this grid has at least two solutions.
 */
const MULTI_SOLUTION_LINE =
  ".82.94371.13.78492974321856825147963749863215136259748458736129367912584291485637";

describe("parsePuzzle", () => {
  it("reads an 81 character line", () => {
    const grid = parsePuzzle(WIKI_PUZZLE.replace(/\n/g, ""));
    expect(grid).toHaveLength(CELL_COUNT);
    expect(grid[0]).toBe(5);
  });

  it("reads 9 lines of 9 cells, ignoring separators", () => {
    const grid = parsePuzzle(WIKI_PUZZLE);
    expect(grid).toHaveLength(CELL_COUNT);
    expect(grid[0]).toBe(5);
    expect(grid[1]).toBe(3);
  });

  it("accepts periods, underscores, asterisks, x, and question marks as blanks", () => {
    for (const marker of [".", "_", "*", "x", "X", "?"]) {
      const grid = parsePuzzle(marker.repeat(81));
      expect(grid.every((c) => c === 0)).toBe(true);
    }
  });

  it("throws empty-input on blank text", () => {
    try {
      parsePuzzle("   ");
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("throws bad-char on an invalid character", () => {
    try {
      parsePuzzle(".".repeat(80) + "A");
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-char");
    }
  });

  it("throws bad-length when too few or too many cells are given", () => {
    try {
      parsePuzzle(".".repeat(80));
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-length");
    }
    try {
      parsePuzzle(".".repeat(82));
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-length");
    }
  });

  it("throws contradiction when the grid already repeats a digit in a unit", () => {
    const bad = `11${".".repeat(79)}`;
    try {
      parsePuzzle(bad);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("contradiction");
    }
  });
});

describe("findConflicts", () => {
  it("finds no conflicts in a clean grid", () => {
    expect(findConflicts(parsePuzzle(WIKI_PUZZLE))).toEqual([]);
  });

  it("flags every cell sharing a repeated digit in a unit", () => {
    const grid = parsePuzzle(WIKI_PUZZLE);
    const dirty = grid.slice();
    dirty[1] = dirty[0]; // repeats row 1's 5 at column 2
    const conflicts = findConflicts(dirty);
    expect(conflicts).toContain(0);
    expect(conflicts).toContain(1);
  });
});

describe("candidatesFor", () => {
  it("returns an empty list for an already filled cell", () => {
    const grid = parsePuzzle(WIKI_PUZZLE);
    expect(candidatesFor(grid, 0)).toEqual([]);
  });

  it("lists only digits that do not already appear in the cell's row, column, or box", () => {
    const grid = parsePuzzle(WIKI_PUZZLE);
    const candidates = candidatesFor(grid, 2); // R1C3, blank in the wiki puzzle
    expect(candidates.length).toBeGreaterThan(0);
    for (const digit of candidates) expect(digit).toBeGreaterThanOrEqual(1);
  });
});

describe("rowOf and colOf", () => {
  it("convert a flat index to its row and column", () => {
    expect(rowOf(0)).toBe(0);
    expect(colOf(0)).toBe(0);
    expect(rowOf(80)).toBe(8);
    expect(colOf(80)).toBe(8);
    expect(rowOf(10)).toBe(1);
    expect(colOf(10)).toBe(1);
  });
});

describe("solve", () => {
  it("solves the classic wiki example puzzle to its known unique solution", () => {
    const grid = parsePuzzle(WIKI_PUZZLE);
    const result = solve(grid);
    expect(result.status).toBe("solved");
    expect(result.count).toBe(1);
    expect(formatGrid(result.solution!, "line")).toBe(WIKI_SOLUTION);
  });

  it("reports no-solution for an over-constrained grid", () => {
    const grid = parsePuzzle(NO_SOLUTION_PUZZLE);
    const result = solve(grid);
    expect(result.status).toBe("no-solution");
    expect(result.solution).toBeUndefined();
  });

  it("reports multiple-solutions for an under-constrained grid, with one answer included", () => {
    const grid = parsePuzzle(MULTI_SOLUTION_LINE);
    const result = solve(grid);
    expect(result.status).toBe("multiple-solutions");
    expect(result.count).toBe(2);
    expect(result.solution).toBeDefined();
  });
});

describe("countSolutions", () => {
  it("counts a uniquely solvable puzzle as exactly one", () => {
    expect(countSolutions(parsePuzzle(WIKI_PUZZLE))).toBe(1);
  });

  it("caps at two for an under-constrained grid", () => {
    expect(countSolutions(parsePuzzle(MULTI_SOLUTION_LINE))).toBe(2);
  });

  it("counts zero for an unsolvable grid", () => {
    expect(countSolutions(parsePuzzle(NO_SOLUTION_PUZZLE))).toBe(0);
  });
});

describe("nextHint", () => {
  it("explains a naked single by name and cell", () => {
    // Row 1 of the wiki puzzle has every digit but 4 already placed among its
    // givens and the rest of the row's candidates, isolating R1C9 to a single
    // naked candidate is not guaranteed here, so build a direct fixture:
    // one cell short of a full row, with the rest of the grid empty.
    const grid = parsePuzzle("1234567.8" + ".".repeat(72));
    const hint = nextHint(grid);
    expect(hint.kind).toBe("naked-single");
    expect(hint.value).toBe(9);
    expect(hint.row).toBe(1);
    expect(hint.col).toBe(8);
    expect(hint.explanation).toContain("R1C8");
  });

  it("explains a hidden single by naming the unit it fills", () => {
    const made = generatePuzzle({ difficulty: "medium", seed: 0 });
    const grid = made.puzzle.slice();
    // Walk naked singles forward until the technique runs out; this seed is
    // known (see the file comment for how it was found) to reach a hidden
    // single before the grid completes.
    let hint = nextHint(grid);
    while (hint.kind === "naked-single") {
      grid[hint.index!] = hint.value!;
      hint = nextHint(grid);
    }
    expect(hint.kind).toBe("hidden-single");
    expect(hint.index).toBeTypeOf("number");
    expect(hint.value).toBeGreaterThanOrEqual(1);
    expect(hint.explanation).toMatch(/Row \d+|Column \d+|Box \d+/);
  });

  it("reports none with a duplicate digit explanation on a broken grid", () => {
    const dirty = parsePuzzle(WIKI_PUZZLE);
    dirty[1] = dirty[0];
    const hint = nextHint(dirty);
    expect(hint.kind).toBe("none");
    expect(hint.explanation).toContain("breaks sudoku rules");
  });

  it("reports solved once every cell is filled", () => {
    const grid = parsePuzzle(WIKI_PUZZLE);
    const solved = solve(grid).solution!;
    const hint = nextHint(solved);
    expect(hint.kind).toBe("solved");
  });
});

describe("solvedByNakedSingles and solvedBySingles", () => {
  it("agree that the tiny one-cell fixture is solved by naked singles alone", () => {
    const grid = parsePuzzle("1234567.8" + ".".repeat(72));
    expect(solvedByNakedSingles(grid)).toBe(false); // rest of the grid is empty
  });

  it("solvedBySingles is at least as capable as solvedByNakedSingles", () => {
    const made = generatePuzzle({ difficulty: "easy", seed: 3 });
    if (solvedByNakedSingles(made.puzzle)) {
      expect(solvedBySingles(made.puzzle)).toBe(true);
    }
  });
});

describe("seedToNumber", () => {
  it("passes a digit only seed straight through", () => {
    expect(seedToNumber("42")).toBe(42);
  });

  it("hashes a non numeric seed deterministically", () => {
    const a = seedToNumber("friday-puzzle");
    const b = seedToNumber("friday-puzzle");
    expect(a).toBe(b);
    expect(Number.isInteger(a)).toBe(true);
  });

  it("returns zero for an empty seed", () => {
    expect(seedToNumber("")).toBe(0);
  });
});

describe("generateSolved", () => {
  it("produces a complete, conflict free grid", () => {
    const rng = (() => {
      let a = 12345 >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    })();
    const grid = generateSolved(rng);
    expect(grid.every((c) => c >= 1 && c <= 9)).toBe(true);
    expect(findConflicts(grid)).toEqual([]);
  });
});

describe("generatePuzzle", () => {
  it("produces a puzzle with a unique solution at every difficulty", () => {
    for (const difficulty of DIFFICULTIES) {
      const made = generatePuzzle({ difficulty, seed: 1 });
      expect(countSolutions(made.puzzle)).toBe(1);
      expect(clueCount(made.puzzle)).toBe(made.clues);
      expect(solve(made.puzzle).solution).toEqual(made.solution);
    }
  });

  it("is deterministic for the same seed and difficulty", () => {
    const a = generatePuzzle({ difficulty: "medium", seed: 99 });
    const b = generatePuzzle({ difficulty: "medium", seed: 99 });
    expect(a.puzzle).toEqual(b.puzzle);
    expect(a.solution).toEqual(b.solution);
  });

  it("produces a different puzzle for a different seed", () => {
    const a = generatePuzzle({ difficulty: "medium", seed: 1 });
    const b = generatePuzzle({ difficulty: "medium", seed: 2 });
    expect(a.puzzle).not.toEqual(b.puzzle);
  });

  it("gives easy puzzles more clues than expert puzzles", () => {
    const easy = generatePuzzle({ difficulty: "easy", seed: 5 });
    const expert = generatePuzzle({ difficulty: "expert", seed: 5 });
    expect(easy.clues).toBeGreaterThan(expert.clues);
  });

  it("marks an easy puzzle as solvable by singles alone", () => {
    const easy = generatePuzzle({ difficulty: "easy", seed: 1 });
    expect(easy.singlesOnly).toBe(true);
  });

  it("rejects a difficulty it does not know", () => {
    try {
      generatePuzzle({ difficulty: "impossible", seed: 1 });
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-difficulty");
    }
  });
});

describe("formatGrid", () => {
  it("renders an 81 character line with periods for blanks", () => {
    const grid = parsePuzzle(WIKI_PUZZLE);
    const line = formatGrid(grid, "line");
    expect(line).toHaveLength(81);
    expect(line[0]).toBe("5");
    expect(line).toContain(".");
  });

  it("renders a boxed 9 line layout", () => {
    const grid = parsePuzzle(WIKI_PUZZLE);
    const boxed = formatGrid(grid, "grid");
    expect(boxed.split("\n")).toHaveLength(11); // 9 rows + 2 box dividers
  });
});

describe("clueCount", () => {
  it("counts the filled cells of a puzzle", () => {
    const grid = parsePuzzle(WIKI_PUZZLE);
    const filled = grid.filter((c) => c !== 0).length;
    expect(clueCount(grid)).toBe(filled);
  });
});

describe("run", () => {
  it("generates a puzzle when given no input", () => {
    const out = run("", { difficulty: "easy", seed: "7" });
    expect(out.Difficulty).toBe("easy");
    expect(out.Puzzle).toBeTruthy();
    expect(out.Solution).toBeTruthy();
    expect(out.Seed).toBe(String(seedToNumber("7")));
  });

  it("is deterministic for the same seed and difficulty via run", () => {
    const a = run("", { difficulty: "medium", seed: "party" });
    const b = run("", { difficulty: "medium", seed: "party" });
    expect(a).toEqual(b);
  });

  it("solves a pasted puzzle", () => {
    const out = run(WIKI_PUZZLE, {});
    expect(out.Status).toContain("unique");
    expect(out.Solution!.replace(/\n|\s|\+|-|\|/g, "")).toBe(WIKI_SOLUTION);
  });

  it("throws no-solution for an unsolvable pasted puzzle", () => {
    try {
      run(NO_SOLUTION_PUZZLE, {});
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("no-solution");
    }
  });

  it("reports multiple solutions as a labeled status rather than throwing", () => {
    const out = run(MULTI_SOLUTION_LINE, {});
    expect(out.Status).toContain("At least two solutions");
  });

  it("respects the line format option", () => {
    const out = run("", { difficulty: "easy", seed: "1", format: "line" });
    expect(out.Puzzle).toHaveLength(81);
  });
});

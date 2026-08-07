import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { cleanItems, generateBoard, generateBoards, renderBoard, run } from "./index";

const ITEMS_24 = Array.from({ length: 24 }, (_, i) => `Item ${i + 1}`);
const ITEMS_25 = Array.from({ length: 25 }, (_, i) => `Item ${i + 1}`);

describe("cleanItems", () => {
  it("trims, drops blanks, and drops exact duplicates while keeping order", () => {
    expect(cleanItems([" Cat ", "Dog", "", "  ", "Cat", "Bird"])).toEqual(["Cat", "Dog", "Bird"]);
  });
});

describe("generateBoard", () => {
  it("is deterministic for a fixed seed", () => {
    const a = generateBoard(ITEMS_24, { size: 5, freeSpace: true, seed: 42 });
    const b = generateBoard(ITEMS_24, { size: 5, freeSpace: true, seed: 42 });
    expect(a).toEqual(b);
  });

  it("produces different boards for different seeds", () => {
    const a = generateBoard(ITEMS_24, { size: 5, freeSpace: true, seed: 1 });
    const b = generateBoard(ITEMS_24, { size: 5, freeSpace: true, seed: 2 });
    expect(a).not.toEqual(b);
  });

  it("places the free text in the exact center on an odd sized board", () => {
    const grid = generateBoard(ITEMS_24, {
      size: 5,
      freeSpace: true,
      freeText: "WILD",
      seed: 7,
    });
    expect(grid[2]?.[2]).toBe("WILD");
    // Every other cell is a real item, never the free text.
    for (let r = 0; r < 5; r += 1) {
      for (let c = 0; c < 5; c += 1) {
        if (r === 2 && c === 2) continue;
        expect(grid[r]?.[c]).not.toBe("WILD");
      }
    }
  });

  it("defaults free text to FREE when freeText is blank", () => {
    const grid = generateBoard(ITEMS_24, { size: 3, freeSpace: true, freeText: "  ", seed: 3 });
    expect(grid[1]?.[1]).toBe("FREE");
  });

  it("does not place a free space on an even sized board", () => {
    const items16 = Array.from({ length: 16 }, (_, i) => `Item ${i + 1}`);
    const grid = generateBoard(items16, { size: 4, freeSpace: true, seed: 5 });
    const flat = grid.flat();
    expect(flat).not.toContain("FREE");
    expect(flat).toHaveLength(16);
  });

  it("throws not-enough-items with a fix hint stating how many more are needed", () => {
    const items = ["A", "B", "C"];
    expect(() => generateBoard(items, { size: 3, freeSpace: false, seed: 1 })).toThrow(ToolError);
    try {
      generateBoard(items, { size: 3, freeSpace: false, seed: 1 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      const err = e as ToolError;
      expect(err.code).toBe("not-enough-items");
      expect(err.fix).toContain("6 more");
    }
  });

  it("accounts for the free space when computing how many items are needed", () => {
    // 5x5 with free space needs 24 unique items; 20 unique items are 4 short.
    const items = Array.from({ length: 20 }, (_, i) => `Item ${i + 1}`);
    try {
      generateBoard(items, { size: 5, freeSpace: true, seed: 1 });
      expect.unreachable();
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("not-enough-items");
      expect(err.fix).toContain("4 more");
    }
  });

  it("rejects an unsupported board size", () => {
    expect(() => generateBoard(ITEMS_25, { size: 6, seed: 1 })).toThrow(ToolError);
  });

  it("only places items from the input list in every cell", () => {
    const grid = generateBoard(ITEMS_25, { size: 5, freeSpace: false, seed: 99 });
    const pool = new Set(ITEMS_25);
    for (const row of grid) {
      for (const cell of row) {
        expect(pool.has(cell)).toBe(true);
      }
    }
  });
});

describe("generateBoards", () => {
  it("returns the requested number of boards, each internally distinct from the others", () => {
    const boards = generateBoards(ITEMS_24, { size: 5, freeSpace: true, seed: 10, count: 3 });
    expect(boards).toHaveLength(3);
    expect(boards[0]).not.toEqual(boards[1]);
    expect(boards[1]).not.toEqual(boards[2]);
  });

  it("is deterministic across calls with the same base seed", () => {
    const a = generateBoards(ITEMS_24, { size: 5, freeSpace: true, seed: 10, count: 3 });
    const b = generateBoards(ITEMS_24, { size: 5, freeSpace: true, seed: 10, count: 3 });
    expect(a).toEqual(b);
  });

  it("rejects a count outside 1 to 50", () => {
    expect(() => generateBoards(ITEMS_25, { size: 5, seed: 1, count: 0 })).toThrow(ToolError);
    expect(() => generateBoards(ITEMS_25, { size: 5, seed: 1, count: 51 })).toThrow(ToolError);
  });
});

describe("renderBoard", () => {
  it("joins cells with a pipe and rows with newlines", () => {
    expect(
      renderBoard([
        ["A", "B"],
        ["C", "D"],
      ]),
    ).toBe("A | B\nC | D");
  });
});

describe("run", () => {
  it("returns a labeled record for a single card", () => {
    const out = run(ITEMS_25.join("\n"), { size: 5, freeSpace: false, seed: 1, count: 1 });
    expect(Object.keys(out)).toEqual(["Board"]);
  });

  it("returns one labeled entry per card when count > 1", () => {
    const out = run(ITEMS_25.join("\n"), { size: 5, freeSpace: false, seed: 1, count: 2 });
    expect(Object.keys(out)).toEqual(["Card 1", "Card 2"]);
  });

  it("throws empty-input when the list has no usable items", () => {
    expect(() => run("\n\n  \n", { size: 3, seed: 1, count: 1 })).toThrow(ToolError);
  });
});

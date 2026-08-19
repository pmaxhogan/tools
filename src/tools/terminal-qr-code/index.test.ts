import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { invertBlocks, padMargin, run } from "./index";

const BLOCK_CHARS = /[ █▀▄]/;

function opts(overrides: Partial<{ ecc: string; invert: boolean; margin: number }> = {}) {
  return { ecc: "M", invert: false, margin: 1, ...overrides };
}

describe("terminal-qr-code", () => {
  it("encodes text as a multi-line unicode-block QR code", async () => {
    const out = await run("HI", opts());
    expect(typeof out).toBe("string");
    const lines = out.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(BLOCK_CHARS.test(out)).toBe(true);
    // every line should have the same width (a rectangular grid)
    const widths = new Set(lines.map((l) => l.length));
    expect(widths.size).toBe(1);
  });

  it("invert changes the output but preserves line count", async () => {
    const normal = await run("HI", opts({ invert: false }));
    const inverted = await run("HI", opts({ invert: true }));
    expect(inverted).not.toBe(normal);
    expect(inverted.split("\n").length).toBe(normal.split("\n").length);
    // inverting twice returns the original grid
    expect(invertBlocks(invertBlocks(normal))).toBe(normal);
  });

  it("throws a typed error on empty input", async () => {
    await expect(run("", opts())).rejects.toThrow(ToolError);
    await expect(run("   ", opts())).rejects.toThrow(ToolError);
  });

  it("throws a typed too-long error when the payload cannot fit", async () => {
    const huge = "x".repeat(5000);
    await expect(run(huge, opts({ ecc: "H" }))).rejects.toMatchObject({ code: "too-long" });
  });

  it("throws a typed error for an unknown error correction level", async () => {
    await expect(run("HI", opts({ ecc: "Z" }))).rejects.toMatchObject({ code: "bad-ecc" });
  });

  it("throws a typed error for an out of range margin", async () => {
    await expect(run("HI", opts({ margin: 10 }))).rejects.toMatchObject({ code: "bad-margin" });
  });

  it("margin 0 adds no padding, larger margins widen and heighten the grid", () => {
    const grid = "AB\nCD";
    expect(padMargin(grid, 0)).toBe(grid);
    const padded = padMargin(grid, 2);
    const lines = padded.split("\n");
    expect(lines.length).toBe(2 + 2 * 2);
    expect(lines[2]?.length).toBe(2 + 2 * 2);
  });

  it("produces deterministic output for the same input and options", async () => {
    const a = await run("https://example.com", opts({ ecc: "Q", margin: 2 }));
    const b = await run("https://example.com", opts({ ecc: "Q", margin: 2 }));
    expect(a).toBe(b);
  });
});

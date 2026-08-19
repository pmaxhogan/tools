import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  CHARSETS,
  ansi16Index,
  ansi256Index,
  luma,
  resizeBox,
  run,
  toAscii,
  toBraille,
} from "./index";

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

/** A solid color image, fully opaque. */
function flat(width: number, height: number, r: number, g = r, b = r): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** A grey ramp running left to right, constant top to bottom, 0 to 255. */
function hGradient(width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = Math.round((x / (width - 1)) * 255);
      const p = (y * width + x) * 4;
      out[p] = v;
      out[p + 1] = v;
      out[p + 2] = v;
      out[p + 3] = 255;
    }
  }
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Minimal base64 encoder, so the test does not depend on a runtime global. */
function toBase64(bytes: Uint8ClampedArray): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64[b2 & 63];
  }
  return out;
}

function payload(buf: Uint8ClampedArray, width: number, height: number): string {
  return JSON.stringify({ width, height, rgbaBase64: toBase64(buf) });
}

const ESC = String.fromCharCode(27);

/**
 * Counts ANSI escape sequences in a string. Every sequence this tool emits
 * carries exactly one escape character, so counting the escape character
 * counts the sequences without needing a regex (the escape character itself
 * trips the `no-control-regex` lint rule inside a pattern literal).
 */
function countAnsiEscapes(s: string): number {
  return s.split(ESC).length - 1;
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

describe("luma", () => {
  it("weights green the most and blue the least, Rec. 601", () => {
    expect(luma(255, 0, 0)).toBeCloseTo(76.245, 3);
    expect(luma(0, 255, 0)).toBeCloseTo(149.685, 3);
    expect(luma(0, 0, 255)).toBeCloseTo(29.07, 3);
  });

  it("is 0 for black and 255 for white", () => {
    expect(luma(0, 0, 0)).toBe(0);
    expect(luma(255, 255, 255)).toBe(255);
  });
});

describe("resizeBox", () => {
  it("averages every source pixel when a box filter shrinks 2x2 to 1x1", () => {
    const src = new Uint8ClampedArray([
      0, 0, 0, 255, 64, 64, 64, 255, 128, 128, 128, 255, 192, 192, 192, 255,
    ]);
    const out = resizeBox(src, 2, 2, 1, 1);
    expect(Array.from(out)).toEqual([96, 96, 96, 255]);
  });

  it("rejects a target size that is not a positive whole number", () => {
    const src = flat(2, 2, 0);
    expect(() => resizeBox(src, 2, 2, 0, 4)).toThrow(ToolError);
    expect(() => resizeBox(src, 2, 2, 3, 1.5)).toThrow(/not usable/);
  });
});

describe("ansi16Index / ansi256Index", () => {
  it("finds exact matches among the 16 standard colors", () => {
    expect(ansi16Index(0, 0, 0)).toBe(0);
    expect(ansi16Index(255, 255, 255)).toBe(15);
    expect(ansi16Index(255, 0, 0)).toBe(9);
  });

  it("maps black to 16 and white to 231 on the 256 color cube", () => {
    expect(ansi256Index(0, 0, 0)).toBe(16);
    expect(ansi256Index(255, 255, 255)).toBe(231);
  });

  it("keeps every channel monotonic across the cube", () => {
    expect(ansi256Index(255, 0, 0)).toBeGreaterThan(ansi256Index(0, 0, 0));
    expect(ansi256Index(0, 255, 0)).toBeGreaterThan(ansi256Index(0, 0, 0));
    expect(ansi256Index(0, 0, 255)).toBeGreaterThan(ansi256Index(0, 0, 0));
  });
});

/* ------------------------------------------------------------------ *
 * toAscii
 * ------------------------------------------------------------------ */

describe("toAscii", () => {
  it("computes the row count from columns, aspect, and the source aspect ratio", () => {
    const src = flat(200, 100, 128);
    const out = toAscii(src, 200, 100, { columns: 80, aspect: 0.5 });
    const lines = out.split("\n");
    // rows = round(80 * 100/200 * 0.5) = 20
    expect(lines).toHaveLength(20);
    for (const line of lines) expect(line).toHaveLength(80);
  });

  it("keeps the character ramp index non decreasing left to right on a gradient", () => {
    const src = hGradient(100, 20);
    const out = toAscii(src, 100, 20, { columns: 100, aspect: 0.2, charset: "standard" });
    const firstLine = out.split("\n")[0]!;
    const ramp = CHARSETS.standard!;
    const indices = Array.from(firstLine).map((ch) => ramp.indexOf(ch));

    expect(indices.every((i) => i >= 0)).toBe(true);
    for (let i = 1; i < indices.length; i += 1) {
      expect(indices[i]).toBeGreaterThanOrEqual(indices[i - 1]! - 0);
    }
    // Darkest (leftmost) maps to the least dense character, brightest
    // (rightmost) to the most dense one, since invert defaults to false.
    expect(indices[0]).toBe(0);
    expect(indices[indices.length - 1]).toBe(ramp.length - 1);
  });

  it("reverses the ramp direction when invert is on", () => {
    const src = hGradient(100, 20);
    const out = toAscii(src, 100, 20, { columns: 100, aspect: 0.2, invert: true });
    const firstLine = out.split("\n")[0]!;
    const ramp = CHARSETS.standard!;
    const indices = Array.from(firstLine).map((ch) => ramp.indexOf(ch));
    expect(indices[0]).toBe(ramp.length - 1);
    expect(indices[indices.length - 1]).toBe(0);
  });

  it("only emits characters from the blocks charset", () => {
    const src = hGradient(60, 10);
    const out = toAscii(src, 60, 10, { columns: 60, aspect: 0.3, charset: "blocks" });
    const allowed = new Set(Array.from(CHARSETS.blocks!));
    allowed.add("\n");
    for (const ch of out) expect(allowed.has(ch)).toBe(true);
  });

  it("uses a custom charset ramp and rejects one that is too short", () => {
    const src = flat(10, 10, 200);
    const out = toAscii(src, 10, 10, { columns: 20, charset: "custom", customChars: "-#" });
    expect(new Set(out.replace(/\n/g, ""))).toEqual(new Set(["#"]));

    expect(() => toAscii(src, 10, 10, { charset: "custom", customChars: "x" })).toThrow(
      ToolError,
    );
    try {
      toAscii(src, 10, 10, { charset: "custom", customChars: "x" });
    } catch (err) {
      expect((err as ToolError).code).toBe("invalid-charset");
    }
  });

  it("rejects an unknown built in charset", () => {
    const src = flat(4, 4, 0);
    expect(() => toAscii(src, 4, 4, { charset: "wingdings" as never })).toThrow(ToolError);
    try {
      toAscii(src, 4, 4, { charset: "wingdings" as never });
    } catch (err) {
      expect((err as ToolError).code).toBe("invalid-charset");
    }
  });

  it("compresses ansi256 color runs so a flat image costs far fewer escapes than cells", () => {
    const src = flat(40, 10, 10, 200, 30);
    const out = toAscii(src, 40, 10, { columns: 40, aspect: 0.25, color: "ansi256" });
    // One color escape for the whole flat run, plus a trailing reset.
    expect(countAnsiEscapes(out)).toBe(2);
    expect(out.endsWith(`${ESC}[0m`)).toBe(true);
    expect(countAnsiEscapes(out)).toBeLessThan(40 * 10); // vastly fewer than total cells
  });

  it("emits a new ansi16 escape only when the color actually changes", () => {
    const src = new Uint8ClampedArray(30 * 1 * 4);
    // Twenty red cells then ten blue cells, so a 1:1 downsample to 30
    // columns keeps two distinct color runs.
    for (let i = 0; i < 20; i += 1) {
      src[i * 4] = 255;
      src[i * 4 + 3] = 255;
    }
    for (let i = 20; i < 30; i += 1) {
      src[i * 4 + 2] = 255;
      src[i * 4 + 3] = 255;
    }
    const out = toAscii(src, 30, 1, { columns: 30, aspect: 1, color: "ansi16" });
    expect(countAnsiEscapes(out)).toBe(3); // red, blue, reset
  });

  it("wraps truecolor runs in 24 bit escapes with the exact RGB", () => {
    const src = flat(20, 1, 12, 34, 56);
    const out = toAscii(src, 20, 1, { columns: 20, aspect: 1, color: "truecolor" });
    expect(out).toContain(`${ESC}[38;2;12;34;56m`);
  });

  it("renders html spans and escapes angle brackets from a custom charset", () => {
    const src = flat(20, 1, 250);
    const out = toAscii(src, 20, 1, {
      columns: 20,
      aspect: 1,
      color: "html",
      charset: "custom",
      customChars: "<>",
    });
    expect(out.startsWith("<pre>")).toBe(true);
    expect(out.endsWith("</pre>")).toBe(true);
    expect(out).toContain("&gt;");
    expect(out).not.toContain("<>"); // the raw char never appears unescaped
    expect(out).toMatch(/<span style="color:#[0-9a-f]{6}">/);
  });

  it("rejects a column count outside 20 to 200", () => {
    const src = flat(4, 4, 0);
    expect(() => toAscii(src, 4, 4, { columns: 10 })).toThrow(ToolError);
    expect(() => toAscii(src, 4, 4, { columns: 300 })).toThrow(ToolError);
    expect(() => toAscii(src, 4, 4, { columns: 40.5 })).toThrow(ToolError);
    try {
      toAscii(src, 4, 4, { columns: 500 });
    } catch (err) {
      expect((err as ToolError).code).toBe("invalid-columns");
    }
  });

  it("rejects a nonsense aspect ratio", () => {
    const src = flat(4, 4, 0);
    expect(() => toAscii(src, 4, 4, { aspect: 0 })).toThrow(ToolError);
    expect(() => toAscii(src, 4, 4, { aspect: -1 })).toThrow(ToolError);
    try {
      toAscii(src, 4, 4, { aspect: 0 });
    } catch (err) {
      expect((err as ToolError).code).toBe("invalid-aspect");
    }
  });

  it("composites a transparent pixel onto white", () => {
    const src = new Uint8ClampedArray([0, 0, 0, 0]);
    const out = toAscii(src, 1, 1, { columns: 20, aspect: 1 });
    // Fully transparent black composited onto white is white, the brightest
    // possible cell, so it gets the densest character in the default ramp.
    expect(out.trim().length).toBeGreaterThan(0);
    expect(out[0]).toBe(CHARSETS.standard![CHARSETS.standard!.length - 1]);
  });
});

/* ------------------------------------------------------------------ *
 * toBraille
 * ------------------------------------------------------------------ */

describe("toBraille", () => {
  it("emits only characters in the braille block, one row per line", () => {
    const src = hGradient(80, 40);
    const out = toBraille(src, 80, 40, { columns: 40 });
    const lines = out.split("\n");
    // rows = round(40 * 40/80 * 0.5) = 10
    expect(lines).toHaveLength(10);
    for (const line of lines) {
      expect(line).toHaveLength(40);
      for (const ch of line) {
        const cp = ch.codePointAt(0)!;
        expect(cp).toBeGreaterThanOrEqual(0x2800);
        expect(cp).toBeLessThanOrEqual(0x28ff);
      }
    }
  });

  it("turns a fully dark image into all dots and a fully bright one into none", () => {
    const dark = toBraille(flat(20, 20, 0), 20, 20, { columns: 20 });
    for (const ch of dark.replace(/\n/g, "")) expect(ch.codePointAt(0)).toBe(0x28ff);

    const bright = toBraille(flat(20, 20, 255), 20, 20, { columns: 20 });
    for (const ch of bright.replace(/\n/g, "")) expect(ch.codePointAt(0)).toBe(0x2800);
  });

  it("moves the cutoff when the threshold changes", () => {
    const mid = flat(20, 20, 150);
    const low = toBraille(mid, 20, 20, { columns: 20, threshold: 100 });
    const high = toBraille(mid, 20, 20, { columns: 20, threshold: 200 });
    expect(low.replace(/\n/g, "")[0]!.codePointAt(0)).toBe(0x2800); // 150 > 100, no dot
    expect(high.replace(/\n/g, "")[0]!.codePointAt(0)).toBe(0x28ff); // 150 <= 200, dot
  });

  it("changes the output when dithering is turned on for a mid grey image", () => {
    const src = flat(32, 32, 140);
    const plain = toBraille(src, 32, 32, { columns: 32, threshold: 128 });
    const dithered = toBraille(src, 32, 32, { columns: 32, threshold: 128, dither: true });
    expect(dithered).not.toBe(plain);
  });

  it("rejects a threshold outside 0 to 255", () => {
    const src = flat(4, 4, 0);
    expect(() => toBraille(src, 4, 4, { threshold: -1 })).toThrow(ToolError);
    expect(() => toBraille(src, 4, 4, { threshold: 256 })).toThrow(ToolError);
    try {
      toBraille(src, 4, 4, { threshold: 999 });
    } catch (err) {
      expect((err as ToolError).code).toBe("invalid-threshold");
    }
  });
});

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

describe("run", () => {
  it("renders plain ascii text by default", () => {
    const out = run(payload(flat(40, 40, 128), 40, 40), {});
    expect(typeof out).toBe("string");
    const lines = out.split("\n");
    expect(lines).toHaveLength(40); // 80 cols default * 40/40 * 0.5 aspect
    expect(lines[0]).toHaveLength(80);
  });

  it("renders braille when style is braille", () => {
    const out = run(payload(flat(40, 40, 200), 40, 40), { style: "braille", columns: 20 });
    for (const ch of out.replace(/\n/g, "")) {
      const cp = ch.codePointAt(0)!;
      expect(cp).toBeGreaterThanOrEqual(0x2800);
      expect(cp).toBeLessThanOrEqual(0x28ff);
    }
  });

  it("accepts the payload as bytes as well as a string", () => {
    const text = payload(flat(8, 8, 90), 8, 8);
    const bytes = new TextEncoder().encode(text);
    expect(run(bytes, {})).toEqual(run(text, {}));
  });

  it("points at the panel for anything that is not a pixel payload", () => {
    for (const bad of ["", "   ", "not json", "[1,2,3]", '"a string"']) {
      expect(() => run(bad, {})).toThrow(ToolError);
      try {
        run(bad, {});
      } catch (err) {
        expect((err as ToolError).code).toBe("use-panel");
        expect((err as ToolError).fix).toContain("panel");
      }
    }
  });

  it("points at the panel when the payload is missing a field", () => {
    expect(() => run(JSON.stringify({ width: 2, height: 2 }), {})).toThrow(/rgbaBase64/);
    expect(() => run(JSON.stringify({ width: 0, height: 2, rgbaBase64: "AAAA" }), {})).toThrow(
      /width` and `height`/,
    );
    expect(() =>
      run(JSON.stringify({ width: 1, height: 1, rgbaBase64: "not base64!!" }), {}),
    ).toThrow(/base64/);
  });

  it("reports a byte count that does not match the declared size", () => {
    const text = JSON.stringify({ width: 4, height: 4, rgbaBase64: toBase64(flat(2, 2, 0)) });
    try {
      run(text, {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("size-mismatch");
    }
  });

  it("rejects settings outside their range", () => {
    const text = payload(flat(8, 8, 100), 8, 8);
    const cases: [Record<string, unknown>, string][] = [
      [{ style: "banner" }, "invalid-style"],
      [{ charset: "wingdings" }, "invalid-charset"],
      [{ color: "cmyk" }, "invalid-color"],
      [{ columns: 5 }, "invalid-columns"],
      [{ columns: 1000 }, "invalid-columns"],
      [{ aspect: -1 }, "invalid-aspect"],
      [{ style: "braille", threshold: 999 }, "invalid-threshold"],
    ];
    for (const [opts, code] of cases) {
      try {
        run(text, opts);
        expect.unreachable(`should have thrown ${code}`);
      } catch (err) {
        expect((err as ToolError).code).toBe(code);
      }
    }
  });
});

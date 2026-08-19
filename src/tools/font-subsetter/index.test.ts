import { describe, expect, it } from "vitest";
// @ts-expect-error: opentype.js ships no type declarations.
import opentype from "opentype.js";
import {
  blockOf,
  detectFormat,
  fontFaceCss,
  fromWoff2,
  inspectFont,
  readSfntDirectory,
  readWoffTags,
  resolveCharacters,
  run,
  subsetFileName,
  subsetFont,
  summariseBlocks,
  toWoff,
  toWoff2,
  unicodeRangeCss,
} from "./index";

/* ------------------------------------------------------------------ */
/* fixtures                                                           */
/* ------------------------------------------------------------------ */

/** A rectangle, so every glyph has a real outline with a known bounding box. */
function boxGlyph(name: string, unicode: number, width: number, height: number) {
  const path = new opentype.Path();
  path.moveTo(40, 0);
  path.lineTo(40, height);
  path.lineTo(width, height);
  path.lineTo(width, 0);
  path.closePath();
  return new opentype.Glyph({ name, unicode, advanceWidth: width + 60, path });
}

/**
 * A four glyph font: .notdef plus A, B, C at U+0041 to U+0043. opentype.js
 * writes CFF outlines, so this comes out as an OTTO flavoured sfnt.
 */
function buildTestFont(): Uint8Array {
  const notdef = new opentype.Glyph({
    name: ".notdef",
    unicode: 0,
    advanceWidth: 600,
    path: new opentype.Path(),
  });
  const font = new opentype.Font({
    familyName: "SubsetTest",
    styleName: "Regular",
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    glyphs: [
      notdef,
      boxGlyph("A", 65, 500, 700),
      boxGlyph("B", 66, 460, 660),
      boxGlyph("C", 67, 420, 620),
    ],
  });
  return new Uint8Array(font.toArrayBuffer());
}

const FONT = buildTestFont();

/** The options the generic panel would hand `run` with nothing changed. */
function defaultOpts(overrides: Record<string, unknown> = {}) {
  return {
    text: "",
    ranges: "",
    preset: "basic-latin",
    format: "woff2",
    includeDigitsPunct: true,
    ...overrides,
  } as Parameters<typeof run>[1];
}

/* ------------------------------------------------------------------ */
/* inspection                                                         */
/* ------------------------------------------------------------------ */

describe("detectFormat", () => {
  it("reads the sfnt magic of the fixture", () => {
    expect(detectFormat(FONT)).toBe("otf");
  });

  it("names TrueType, WOFF, and WOFF2 by their magic bytes", () => {
    expect(detectFormat(new Uint8Array([0x00, 0x01, 0x00, 0x00]))).toBe("ttf");
    expect(detectFormat(new Uint8Array([0x77, 0x4f, 0x46, 0x46]))).toBe("woff");
    expect(detectFormat(new Uint8Array([0x77, 0x4f, 0x46, 0x32]))).toBe("woff2");
  });

  it("rejects a font collection with an explanation", () => {
    expect(() => detectFormat(new Uint8Array([0x74, 0x74, 0x63, 0x66]))).toThrowError(/collection/);
  });
});

describe("inspectFont", () => {
  it("reports names, metrics, glyph count, and coverage", async () => {
    const info = await inspectFont(FONT);
    expect(info.format).toBe("otf");
    expect(info.familyName).toBe("SubsetTest");
    expect(info.styleName).toBe("Regular");
    expect(info.glyphCount).toBe(4);
    expect(info.unitsPerEm).toBe(1000);
    expect(info.ascender).toBe(800);
    expect(info.descender).toBe(-200);
    expect(info.outlines).toBe("cff");
    expect(info.size).toBe(FONT.length);
    expect(info.codePoints).toEqual([65, 66, 67]);
    expect(info.blocks).toEqual([{ name: "Basic Latin", count: 3 }]);
  });

  it("lists the sfnt tables the font actually carries", async () => {
    const info = await inspectFont(FONT);
    expect(info.tables).toContain("cmap");
    expect(info.tables).toContain("head");
    expect(info.tables).toContain("CFF ");
    // opentype.js writes no layout tables, so nothing is lost by rebuilding.
    expect(info.layoutTables).toEqual([]);
  });

  it("reads a WOFF2 file by decompressing it first", async () => {
    const woff2 = await toWoff2(FONT);
    const info = await inspectFont(woff2);
    expect(info.format).toBe("woff2");
    expect(info.formatLabel).toBe("WOFF2");
    expect(info.glyphCount).toBe(4);
    expect(info.size).toBe(woff2.length);
    expect(info.sfnt.length).toBeGreaterThan(woff2.length);
  });
});

/* ------------------------------------------------------------------ */
/* character selection                                                */
/* ------------------------------------------------------------------ */

describe("resolveCharacters", () => {
  it("expands presets into sorted unique code points", () => {
    const basic = resolveCharacters({ presets: ["basic-latin"] });
    expect(basic[0]).toBe(0x20);
    expect(basic[basic.length - 1]).toBe(0x7e);
    expect(basic).toHaveLength(0x7e - 0x20 + 1);

    expect(resolveCharacters({ presets: ["digits"] })).toEqual([
      0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
    ]);
  });

  it("merges text, ranges, and presets without duplicates", () => {
    expect(
      resolveCharacters({ text: "CBA", ranges: "U+0041, 0061-0062", presets: ["digits"] }).slice(
        0,
        6,
      ),
    ).toEqual([0x30, 0x31, 0x32, 0x33, 0x34, 0x35]);

    expect(resolveCharacters({ text: "ABBA", ranges: "U+0043" })).toEqual([65, 66, 67]);
  });

  it("handles astral characters and drops control characters", () => {
    expect(resolveCharacters({ text: "\n\tA\u{1F600}" })).toEqual([65, 0x1f600]);
  });

  it("rejects a malformed range", () => {
    expect(() => resolveCharacters({ ranges: "U+ZZZZ" })).toThrowError(/not a unicode range/);
    try {
      resolveCharacters({ ranges: "hello" });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe("bad-range");
    }
  });

  it("rejects a backwards range, an out of range code point, and a huge one", () => {
    for (const ranges of ["U+0041-0030", "U+110000", "U+0000-10FFFF"]) {
      try {
        resolveCharacters({ ranges });
        throw new Error(`should have thrown for ${ranges}`);
      } catch (error) {
        expect((error as { code: string }).code).toBe("bad-range");
      }
    }
  });

  it("rejects an unknown preset name", () => {
    try {
      resolveCharacters({ presets: ["klingon" as "digits"] });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe("bad-range");
    }
  });
});

/* ------------------------------------------------------------------ */
/* CSS helpers                                                        */
/* ------------------------------------------------------------------ */

describe("unicodeRangeCss", () => {
  it("collapses runs and keeps singles separate", () => {
    expect(unicodeRangeCss(resolveCharacters({ text: "ABCa" }))).toBe("U+0041-0043, U+0061");
    expect(unicodeRangeCss([65])).toBe("U+0041");
    expect(unicodeRangeCss([])).toBe("");
  });

  it("sorts, dedupes, and widens astral code points", () => {
    expect(unicodeRangeCss([0x1f601, 0x41, 0x1f600, 0x41])).toBe("U+0041, U+1F600-1F601");
  });
});

describe("fontFaceCss", () => {
  it("writes a src descriptor with the right format hint", () => {
    const css = fontFaceCss({
      family: "SubsetTest",
      format: "woff2",
      fileName: "subsettest-subset.woff2",
      unicodeRange: "U+0041-0043",
    });
    expect(css).toContain('font-family: "SubsetTest";');
    expect(css).toContain('src: url("subsettest-subset.woff2") format("woff2");');
    expect(css).toContain("unicode-range: U+0041-0043;");
    expect(css).toContain("font-display: swap;");
    expect(css.startsWith("@font-face {")).toBe(true);
    expect(css.endsWith("}")).toBe(true);
  });

  it("uses the opentype format hint for an uncompressed CFF file and omits an empty range", () => {
    const css = fontFaceCss({ family: "X", format: "otf", fileName: "x.otf" });
    expect(css).toContain('format("opentype")');
    expect(css).not.toContain("unicode-range");
  });
});

describe("subsetFileName", () => {
  it("slugifies the family name", () => {
    expect(subsetFileName("Inter Tight", "woff2")).toBe("inter-tight-subset.woff2");
    expect(subsetFileName("!!!", "woff")).toBe("font-subset.woff");
  });
});

describe("blockOf and summariseBlocks", () => {
  it("names the block a code point belongs to", () => {
    expect(blockOf(0x41)).toBe("Basic Latin");
    expect(blockOf(0x3b1)).toBe("Greek and Coptic");
    expect(blockOf(0x1f600)).toBe("Emoticons");
    expect(blockOf(0xe0100)).toBe("Other");
  });

  it("counts per block, largest first", () => {
    expect(summariseBlocks([0x41, 0x42, 0x43, 0x3b1])).toEqual([
      { name: "Basic Latin", count: 3 },
      { name: "Greek and Coptic", count: 1 },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* subsetting                                                         */
/* ------------------------------------------------------------------ */

describe("subsetFont", () => {
  it("keeps only the requested glyph plus .notdef", async () => {
    const result = await subsetFont(FONT, resolveCharacters({ text: "A" }));
    expect(result.glyphCount).toBe(2);
    expect(result.kept).toEqual([65]);
    expect(result.missing).toEqual([]);
    expect(result.droppedTables).toEqual([]);

    const parsed = opentype.parse(result.ttf);
    expect(parsed.glyphs.length).toBe(2);
    expect(parsed.charToGlyph("A").index).toBe(1);
    expect(parsed.charToGlyph("A").path.getBoundingBox()).toMatchObject({ x2: 500, y2: 700 });
    // B is gone, so it now resolves to .notdef.
    expect(parsed.charToGlyph("B").index).toBe(0);
    expect(result.ttf.length).toBeLessThan(FONT.length);
  });

  it("reports characters the font has no glyph for", async () => {
    const result = await subsetFont(FONT, resolveCharacters({ text: "AZ" }));
    expect(result.kept).toEqual([65]);
    expect(result.missing).toEqual([90]);
    expect(result.glyphCount).toBe(2);
  });

  it("can empty the .notdef outline while keeping its slot", async () => {
    const kept = await subsetFont(FONT, [65], { keepNotdef: true });
    const emptied = await subsetFont(FONT, [65], { keepNotdef: false });
    expect(emptied.glyphCount).toBe(kept.glyphCount);
    expect(opentype.parse(emptied.ttf).glyphs.get(0).name).toBe(".notdef");
  });

  it("renames the subset when asked", async () => {
    const result = await subsetFont(FONT, [65, 66], { familyName: "Renamed" });
    const info = await inspectFont(result.ttf);
    expect(info.familyName).toBe("Renamed");
    expect(info.glyphCount).toBe(3);
  });

  it("throws nothing-kept for an empty selection", async () => {
    await expect(subsetFont(FONT, [])).rejects.toMatchObject({ code: "nothing-kept" });
  });

  it("throws nothing-kept when no selected character exists in the font", async () => {
    await expect(subsetFont(FONT, resolveCharacters({ text: "中文" }))).rejects.toMatchObject({
      code: "nothing-kept",
    });
  });

  it("throws empty-input for zero bytes", async () => {
    await expect(subsetFont(new Uint8Array(0), [65])).rejects.toMatchObject({
      code: "empty-input",
    });
  });

  it("throws not-a-font for bytes that are not a font", async () => {
    await expect(subsetFont(new Uint8Array([1, 2, 3, 4, 5, 6]), [65])).rejects.toMatchObject({
      code: "not-a-font",
    });
  });
});

/* ------------------------------------------------------------------ */
/* containers                                                         */
/* ------------------------------------------------------------------ */

describe("toWoff2 and fromWoff2", () => {
  it("round trips a font through the wasm codec", async () => {
    const woff2 = await toWoff2(FONT);
    expect(Array.from(woff2.subarray(0, 4))).toEqual([0x77, 0x4f, 0x46, 0x32]);
    expect(woff2.length).toBeLessThan(FONT.length);

    const back = await fromWoff2(woff2);
    const parsed = opentype.parse(back);
    expect(parsed.glyphs.length).toBe(4);
    expect(parsed.charToGlyph("C").index).toBe(3);
  });

  it("throws subset-failed when the encoder rejects the bytes", async () => {
    await expect(toWoff2(new Uint8Array(64))).rejects.toMatchObject({ code: "subset-failed" });
  });

  it("throws not-a-font when the decompressor rejects the bytes", async () => {
    await expect(fromWoff2(new Uint8Array(64))).rejects.toMatchObject({ code: "not-a-font" });
  });
});

describe("toWoff", () => {
  it("writes a WOFF 1.0 container that opentype.js can read back", async () => {
    const woff = toWoff(FONT);
    const source = readSfntDirectory(FONT);

    expect(Array.from(woff.subarray(0, 4))).toEqual([0x77, 0x4f, 0x46, 0x46]);
    const view = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
    expect(view.getUint32(4)).toBe(source.flavor);
    expect(view.getUint32(8)).toBe(woff.length);
    expect(view.getUint16(12)).toBe(source.tables.length);
    expect(readWoffTags(woff).sort()).toEqual(source.tables.map((t) => t.tag).sort());

    const parsed = opentype.parse(woff);
    expect(parsed.glyphs.length).toBe(4);
    expect(parsed.unitsPerEm).toBe(1000);
    expect(parsed.charToGlyph("B").index).toBe(2);

    const info = await inspectFont(woff);
    expect(info.format).toBe("woff");
    expect(info.familyName).toBe("SubsetTest");
    expect(info.codePoints).toEqual([65, 66, 67]);
  });

  it("round trips a subset, which is what the panel actually ships", async () => {
    const subset = await subsetFont(FONT, resolveCharacters({ text: "AB" }));
    const parsed = opentype.parse(toWoff(subset.ttf));
    expect(parsed.glyphs.length).toBe(3);
    expect(parsed.charToGlyph("A").path.getBoundingBox()).toMatchObject({ x2: 500, y2: 700 });
  });

  it("refuses bytes that carry no table directory", () => {
    expect(() => toWoff(new Uint8Array(8))).toThrowError(/too short/);
  });
});

/* ------------------------------------------------------------------ */
/* run                                                                */
/* ------------------------------------------------------------------ */

describe("run", () => {
  it("subsets to the basic latin preset and reports every row", async () => {
    const out = await run(FONT, defaultOpts());
    expect(Object.keys(out)).toEqual([
      "Original",
      "Coverage",
      "Kept characters",
      "Missing",
      "Subset glyphs",
      "Output",
      "Layout features",
      "unicode-range",
      "@font-face CSS",
      "Download",
      "Data URL",
    ]);
    expect(out.Original).toContain("OpenType CFF (.otf)");
    expect(out.Original).toContain("4 glyphs");
    expect(out.Original).toContain("SubsetTest Regular");
    expect(out.Coverage).toBe("Basic Latin (3)");
    expect(out["Kept characters"]).toBe("3 of 119 selected");
    expect(out.Missing).toContain("116: U+0020");
    expect(out["Subset glyphs"]).toBe("4 including .notdef");
    expect(out["unicode-range"]).toBe("U+0041-0043");
    expect(out.Output).toContain("WOFF2");
    expect(out["Layout features"]).toContain("nothing was lost");
    expect(out["@font-face CSS"]).toContain('format("woff2")');
    expect(out.Download).toContain("subsettest-subset.woff2");
    expect(out["Data URL"].startsWith("data:font/woff2;base64,")).toBe(true);
  });

  it("honours the text option and the none preset", async () => {
    const out = await run(
      FONT,
      defaultOpts({ preset: "none", includeDigitsPunct: false, text: "AC" }),
    );
    expect(out["Kept characters"]).toBe("2 of 2 selected");
    expect(out.Missing).toContain("none");
    expect(out["Subset glyphs"]).toBe("3 including .notdef");
    expect(out["unicode-range"]).toBe("U+0041, U+0043");
  });

  it("writes WOFF and uncompressed OpenType when asked", async () => {
    const woff = await run(
      FONT,
      defaultOpts({ preset: "none", includeDigitsPunct: false, text: "A", format: "woff" }),
    );
    expect(woff.Output).toContain("WOFF,");
    expect(woff["@font-face CSS"]).toContain('format("woff")');
    expect(woff["Data URL"].startsWith("data:font/woff;base64,")).toBe(true);

    const otf = await run(
      FONT,
      defaultOpts({ preset: "none", includeDigitsPunct: false, text: "A", format: "ttf" }),
    );
    expect(otf.Output).toContain("OpenType CFF (.otf)");
    expect(otf["Data URL"].startsWith("data:font/otf;base64,")).toBe(true);
    expect(otf.Download).toContain("subsettest-subset.otf");
  });

  it("accepts a base64 data URL as input", async () => {
    const dataUrl = `data:font/otf;base64,${Buffer.from(FONT).toString("base64")}`;
    const out = await run(
      dataUrl,
      defaultOpts({ preset: "none", includeDigitsPunct: false, text: "B" }),
    );
    expect(out["unicode-range"]).toBe("U+0042");
  });

  it("says an uncompressed output of a WOFF2 source got bigger", async () => {
    const woff2 = await toWoff2(FONT);
    const out = await run(
      woff2,
      defaultOpts({ preset: "none", includeDigitsPunct: false, text: "ABC", format: "ttf" }),
    );
    expect(out.Original).toContain("WOFF2");
    expect(out.Output).toContain("larger than the original");
  });

  it("throws empty-input for no input at all", async () => {
    await expect(run(new Uint8Array(0), defaultOpts())).rejects.toMatchObject({
      code: "empty-input",
    });
    await expect(run("   ", defaultOpts())).rejects.toMatchObject({ code: "empty-input" });
  });

  it("throws not-a-font for pasted prose", async () => {
    await expect(run("this is not a font!", defaultOpts())).rejects.toMatchObject({
      code: "not-a-font",
    });
  });

  it("throws bad-range for a malformed range option and an unknown preset", async () => {
    await expect(run(FONT, defaultOpts({ ranges: "U+00ZZ" }))).rejects.toMatchObject({
      code: "bad-range",
    });
    await expect(run(FONT, defaultOpts({ preset: "klingon" }))).rejects.toMatchObject({
      code: "bad-range",
    });
  });

  it("throws nothing-kept when the selection is empty", async () => {
    await expect(
      run(FONT, defaultOpts({ preset: "none", includeDigitsPunct: false })),
    ).rejects.toMatchObject({ code: "nothing-kept" });
  });

  it("throws nothing-kept when nothing selected exists in the font", async () => {
    await expect(
      run(FONT, defaultOpts({ preset: "none", includeDigitsPunct: false, text: "中" })),
    ).rejects.toMatchObject({ code: "nothing-kept" });
  });
});

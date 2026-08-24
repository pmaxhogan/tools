import { describe, expect, it } from "vitest";
import {
  BARCODE_TYPES,
  CODABAR_TABLE,
  CODE128_PATTERNS,
  CODE39_TABLE,
  CODE39_VALUES,
  EAN13_PARITY,
  EAN_G_CODES,
  EAN_L_CODES,
  EAN_R_CODES,
  ITF_PATTERNS,
  SHEETS,
  UPCE_PARITY,
  code128Checksum,
  code128Symbols,
  code39CheckChar,
  encode,
  gs1CheckDigit,
  getSheet,
  normaliseType,
  renderBarcodeSvg,
  renderSheetSvg,
  run,
  sheetCells,
  upcaToUpce,
  upceToUpcaBody,
} from "./index";
import { ToolError } from "../types";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Rebuild the bit string from element widths so decoders can read it back. */
function modulesToBits(modules: number[]): string {
  return modules.map((w, i) => (i % 2 === 0 ? "1" : "0").repeat(w)).join("");
}

function countWide(pattern: string, from: number, step: number): number {
  let n = 0;
  for (let i = from; i < pattern.length; i += step) if (pattern[i] === "w") n += 1;
  return n;
}

/**
 * Walk a Code 128 value list the way a scanner does: track the active code
 * set, apply every shift and latch, and read the data back out. A decode that
 * round-trips proves the code set switching is legal, not merely plausible.
 */
function decodeCode128(values: number[]): string {
  expect(values[values.length - 1]).toBe(106);
  const check = values[values.length - 2]!;
  expect(check).toBe(code128Checksum(values.slice(0, values.length - 2)));

  const start = values[0]!;
  expect([103, 104, 105]).toContain(start);
  let set: "A" | "B" | "C" = start === 103 ? "A" : start === 104 ? "B" : "C";
  const charOf = (v: number, s: "A" | "B") =>
    s === "A" ? String.fromCharCode(v < 64 ? v + 32 : v - 64) : String.fromCharCode(v + 32);

  let out = "";
  let shift: "A" | "B" | null = null;
  for (const v of values.slice(1, values.length - 2)) {
    if (shift) {
      out += charOf(v, shift);
      shift = null;
      continue;
    }
    if (set === "C") {
      if (v === 100) {
        set = "B";
        continue;
      }
      if (v === 101) {
        set = "A";
        continue;
      }
      expect(v).toBeLessThanOrEqual(99);
      out += String(v).padStart(2, "0");
      continue;
    }
    if (v === 99) {
      set = "C";
      continue;
    }
    if (set === "A" && v === 100) {
      set = "B";
      continue;
    }
    if (set === "B" && v === 101) {
      set = "A";
      continue;
    }
    if (v === 98) {
      shift = set === "A" ? "B" : "A";
      continue;
    }
    expect(v).toBeLessThanOrEqual(set === "A" ? 95 : 94);
    out += charOf(v, set);
  }
  return out;
}

/** Read an EAN-13 bit string back to thirteen digits, guards and parity included. */
function decodeEan13(bits: string): string {
  expect(bits).toHaveLength(95);
  expect(bits.slice(0, 3)).toBe("101");
  expect(bits.slice(45, 50)).toBe("01010");
  expect(bits.slice(92)).toBe("101");

  let parity = "";
  let left = "";
  for (let i = 0; i < 6; i++) {
    const chunk = bits.slice(3 + i * 7, 10 + i * 7);
    const l = EAN_L_CODES.indexOf(chunk);
    const g = EAN_G_CODES.indexOf(chunk);
    expect(l >= 0 || g >= 0).toBe(true);
    parity += l >= 0 ? "L" : "G";
    left += String(l >= 0 ? l : g);
  }
  const lead = EAN13_PARITY.indexOf(parity);
  expect(lead).toBeGreaterThanOrEqual(0);

  let right = "";
  for (let i = 0; i < 6; i++) {
    const index = EAN_R_CODES.indexOf(bits.slice(50 + i * 7, 57 + i * 7));
    expect(index).toBeGreaterThanOrEqual(0);
    right += String(index);
  }
  return `${lead}${left}${right}`;
}

/** Read a UPC-E bit string back to its eight digit form. */
function decodeUpce(bits: string): string {
  expect(bits).toHaveLength(51);
  expect(bits.slice(0, 3)).toBe("101");
  expect(bits.slice(45)).toBe("010101");

  let parity = "";
  let digits = "";
  for (let i = 0; i < 6; i++) {
    const chunk = bits.slice(3 + i * 7, 10 + i * 7);
    const l = EAN_L_CODES.indexOf(chunk);
    const g = EAN_G_CODES.indexOf(chunk);
    expect(l >= 0 || g >= 0).toBe(true);
    parity += l >= 0 ? "O" : "E";
    digits += String(l >= 0 ? l : g);
  }
  let system = "0";
  let check = UPCE_PARITY.indexOf(parity);
  if (check < 0) {
    system = "1";
    check = UPCE_PARITY.indexOf(parity.replace(/[OE]/g, (c) => (c === "O" ? "E" : "O")));
  }
  expect(check).toBeGreaterThanOrEqual(0);
  return `${system}${digits}${check}`;
}

/* -------------------------------------------------------------------------- */
/* Pattern table invariants                                                   */
/* -------------------------------------------------------------------------- */

describe("pattern tables", () => {
  it("holds 107 well formed Code 128 patterns", () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    CODE128_PATTERNS.forEach((pattern, value) => {
      const widths = pattern.split("").map(Number);
      // Every symbol is eleven modules in six elements. The stop pattern is the
      // single exception: thirteen modules in seven.
      expect(widths).toHaveLength(value === 106 ? 7 : 6);
      expect(widths.reduce((a, b) => a + b, 0)).toBe(value === 106 ? 13 : 11);
      // Code 128 is self checking because every symbol's bars total an even
      // number of modules. A mistyped digit almost always breaks this.
      const bars = widths.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0);
      expect(bars % 2).toBe(0);
    });
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
    expect(CODE128_PATTERNS[0]).toBe("212222");
    expect(CODE128_PATTERNS[103]).toBe("211412");
    expect(CODE128_PATTERNS[104]).toBe("211214");
    expect(CODE128_PATTERNS[105]).toBe("211232");
    expect(CODE128_PATTERNS[106]).toBe("2331112");
  });

  it("derives the EAN G and R codes from the L codes", () => {
    expect(EAN_L_CODES[0]).toBe("0001101");
    expect(EAN_L_CODES[6]).toBe("0101111");
    expect(EAN_R_CODES[0]).toBe("1110010");
    expect(EAN_G_CODES[0]).toBe("0100111");
    expect(EAN_G_CODES[6]).toBe("0000101");
    for (let d = 0; d < 10; d++) {
      const l = EAN_L_CODES[d]!;
      expect(l).toHaveLength(7);
      // L codes carry an odd number of dark modules. That is what "odd parity"
      // means and it is how a scanner tells the halves apart.
      expect(l.split("").filter((b) => b === "1").length % 2).toBe(1);
      expect(EAN_R_CODES[d]).toBe(l.replace(/[01]/g, (b) => (b === "0" ? "1" : "0")));
      expect(EAN_G_CODES[d]).toBe(EAN_R_CODES[d]!.split("").reverse().join(""));
    }
    expect(new Set([...EAN_L_CODES, ...EAN_G_CODES]).size).toBe(20);
  });

  it("holds the published EAN-13 and UPC-E parity tables", () => {
    expect(EAN13_PARITY).toHaveLength(10);
    expect(EAN13_PARITY[0]).toBe("LLLLLL");
    expect(EAN13_PARITY[5]).toBe("LGGLLG");
    expect(new Set(EAN13_PARITY).size).toBe(10);
    expect(UPCE_PARITY).toHaveLength(10);
    expect(UPCE_PARITY[4]).toBe("EOEEOO");
    expect(new Set(UPCE_PARITY).size).toBe(10);
  });

  it("builds a structurally valid Code 39 table", () => {
    expect(Object.keys(CODE39_TABLE)).toHaveLength(44);
    expect(CODE39_VALUES).toHaveLength(43);
    for (const [ch, pattern] of Object.entries(CODE39_TABLE)) {
      expect(pattern).toHaveLength(9);
      const wideBars = countWide(pattern, 0, 2);
      const wideSpaces = countWide(pattern, 1, 2);
      if ("$/+%".includes(ch)) {
        expect([wideBars, wideSpaces]).toEqual([0, 3]);
      } else {
        expect([wideBars, wideSpaces]).toEqual([2, 1]);
      }
    }
    expect(new Set(Object.values(CODE39_TABLE)).size).toBe(44);
    expect(CODE39_TABLE["1"]).toBe("wnnwnnnnw");
    expect(CODE39_TABLE.A).toBe("wnnnnwnnw");
    expect(CODE39_TABLE["*"]).toBe("nwnnwnwnn");
    expect(CODE39_TABLE[" "]).toBe("nwwnnnwnn");
    expect(CODE39_TABLE.$).toBe("nwnwnwnnn");
  });

  it("holds ten 2 of 5 patterns and twenty Codabar patterns", () => {
    expect(ITF_PATTERNS).toHaveLength(10);
    for (const pattern of ITF_PATTERNS) {
      expect(pattern).toHaveLength(5);
      expect(pattern.split("").filter((c) => c === "w")).toHaveLength(2);
    }
    expect(new Set(ITF_PATTERNS).size).toBe(10);

    const codabar = Object.entries(CODABAR_TABLE);
    expect(codabar).toHaveLength(20);
    for (const [ch, pattern] of codabar) {
      expect(pattern).toHaveLength(7);
      const wide = pattern.split("").filter((c) => c === "w").length;
      expect(wide).toBe("0123456789-$".includes(ch) ? 2 : 3);
    }
    expect(new Set(Object.values(CODABAR_TABLE)).size).toBe(20);
  });
});

/* -------------------------------------------------------------------------- */
/* Code 128                                                                   */
/* -------------------------------------------------------------------------- */

describe("code 128", () => {
  it('encodes "ABC" to the exact published module sequence', () => {
    // Start B is 104; A, B and C are values 33, 34 and 35 in code set B.
    // 104 + 33*1 + 34*2 + 35*3 = 310, and 310 mod 103 = 1, so the check
    // character is value 1 (pattern 222122).
    expect(code128Symbols("ABC")).toEqual([104, 33, 34, 35, 1, 106]);
    expect(code128Checksum([104, 33, 34, 35])).toBe(1);

    const encoded = encode("ABC", "code128");
    // prettier-ignore
    expect(encoded.modules).toEqual([
      2, 1, 1, 2, 1, 4, // start B
      1, 1, 1, 3, 2, 3, // A
      1, 3, 1, 1, 2, 3, // B
      1, 3, 1, 3, 2, 1, // C
      2, 2, 2, 1, 2, 2, // check character, value 1
      2, 3, 3, 1, 1, 1, 2, // stop
    ]);
    expect(encoded.width).toBe(68);
    expect(encoded.modules.reduce((a, b) => a + b, 0)).toBe(68);
    expect(encoded.humanText).toBe("ABC");
  });

  it("starts in code set C for an all digit payload", () => {
    const values = code128Symbols("1234567890");
    expect(values[0]).toBe(105);
    expect(values.slice(1, 6)).toEqual([12, 34, 56, 78, 90]);
    expect(values[6]).toBe(code128Checksum([105, 12, 34, 56, 78, 90]));
    expect(values[6]).toBe(85);
    expect(decodeCode128(values)).toBe("1234567890");
  });

  it("switches code sets legally across a nasty grid", () => {
    for (const sample of [
      "ABC",
      "12",
      "12345",
      "ABC12345",
      "1234AB5678",
      "a1b2c3",
      "HELLO WORLD",
      "AB\tCD",
      "aBc",
      "123456789012345678",
      "x",
      "9",
    ]) {
      expect(decodeCode128(code128Symbols(sample))).toBe(sample);
    }
  });

  it("uses a shift rather than a latch for a single foreign character", () => {
    // One tab inside otherwise lowercase text is cheaper to shift into code
    // set A than to latch there and back.
    const values = code128Symbols("ab\tcd");
    expect(values).toContain(98);
    expect(decodeCode128(values)).toBe("ab\tcd");
  });

  it("rejects characters outside ASCII", () => {
    expect(() => encode("café", "code128")).toThrowError(ToolError);
    expect(() => encode("café", "code128")).toThrowError(/U\+00E9/);
  });
});

/* -------------------------------------------------------------------------- */
/* EAN and UPC                                                                */
/* -------------------------------------------------------------------------- */

describe("EAN-13", () => {
  it("computes the check digit and the LGGLLG parity for lead digit 5", () => {
    const encoded = encode("590123412345", "ean13");
    expect(encoded.checkDigit).toBe("7");
    expect(encoded.value).toBe("5901234123457");
    expect(encoded.width).toBe(95);
    expect(encoded.humanText).toBe("5 901234 123457");
    expect(EAN13_PARITY[5]).toBe("LGGLLG");
    expect(decodeEan13(modulesToBits(encoded.modules))).toBe("5901234123457");
    expect(encoded.warnings.join(" ")).toMatch(/Check digit 7/);
  });

  it("accepts a full thirteen digit code with a correct check digit", () => {
    const encoded = encode("4006381333931", "ean13");
    expect(encoded.checkDigit).toBe("1");
    expect(encoded.warnings).toEqual([]);
    expect(decodeEan13(modulesToBits(encoded.modules))).toBe("4006381333931");
  });

  it("marks the three guard bar pairs as full length", () => {
    const encoded = encode("4006381333931", "ean13");
    expect(encoded.longBarRanges).toEqual([
      [0, 3],
      [45, 50],
      [92, 95],
    ]);
    expect(encoded.textGroups.map((g) => g.text)).toEqual(["4", "006381", "333931"]);
  });

  it("rejects a wrong check digit, a wrong length and a stray letter", () => {
    expect(() => encode("4006381333930", "ean13")).toThrowError(/should end in 1/);
    expect(() => encode("12345", "ean13")).toThrowError(/needs 12 digits/);
    expect(() => encode("59012341234A", "ean13")).toThrowError(/"A"/);
  });
});

describe("EAN-8", () => {
  it("computes check digit 4 for 9638507", () => {
    const encoded = encode("9638507", "ean8");
    expect(encoded.checkDigit).toBe("4");
    expect(encoded.value).toBe("96385074");
    expect(encoded.width).toBe(67);
    expect(encoded.humanText).toBe("9638 5074");

    const bits = modulesToBits(encoded.modules);
    expect(bits.slice(0, 3)).toBe("101");
    expect(bits.slice(31, 36)).toBe("01010");
    expect(bits.slice(64)).toBe("101");
    for (let i = 0; i < 4; i++) {
      expect(EAN_L_CODES.indexOf(bits.slice(3 + i * 7, 10 + i * 7))).toBe(Number("9638"[i]));
      expect(EAN_R_CODES.indexOf(bits.slice(36 + i * 7, 43 + i * 7))).toBe(Number("5074"[i]));
    }
  });
});

describe("UPC-A", () => {
  it("computes check digit 2 for 03600029145", () => {
    const encoded = encode("03600029145", "upca");
    expect(encoded.checkDigit).toBe("2");
    expect(encoded.value).toBe("036000291452");
    expect(encoded.width).toBe(95);
    expect(encoded.humanText).toBe("0 36000 29145 2");
    // UPC-A is EAN-13 with a leading zero, bar for bar.
    expect(decodeEan13(modulesToBits(encoded.modules))).toBe("0036000291452");
  });

  it("prints the number system and check digits outside the symbol", () => {
    const encoded = encode("03600029145", "upca");
    const outside = encoded.textGroups.filter((g) => g.from < 0 || g.to > encoded.width);
    expect(outside.map((g) => g.text)).toEqual(["0", "2"]);
  });

  it("runs the outer character bars full length, as UPC-A prints them", () => {
    const svg = renderBarcodeSvg(encode("03600029145", "upca"), {
      moduleWidth: 2,
      height: 80,
      background: "none",
    });
    const heights = [...svg.matchAll(/<rect [^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));
    // Six guard bars plus the two bars in each of the two outer characters.
    expect(heights.filter((h) => h > 80)).toHaveLength(10);
  });
});

describe("UPC-E", () => {
  it("compresses the classic 042100005264 example to 425261", () => {
    expect(upcaToUpce("042100005264")).toBe("425261");
    const encoded = encode("042100005264", "upce");
    expect(encoded.value).toBe("04252614");
    expect(encoded.checkDigit).toBe("4");
    expect(encoded.width).toBe(51);
    expect(encoded.humanText).toBe("0 425261 4");
    expect(decodeUpce(modulesToBits(encoded.modules))).toBe("04252614");
  });

  it("round trips all four compression rules in both directions", () => {
    for (const six of ["425261", "123453", "123404", "123457", "000000", "999999"]) {
      for (const system of ["0", "1"]) {
        const body = upceToUpcaBody(system, six);
        expect(body).toHaveLength(11);
        const full = body + gs1CheckDigit(body);
        expect(upcaToUpce(full)).toBe(six);
        const encoded = encode(`${system}${six}`, "upce");
        expect(decodeUpce(modulesToBits(encoded.modules))).toBe(encoded.value);
        expect(encoded.value.slice(0, 7)).toBe(`${system}${six}`);
      }
    }
  });

  it("accepts six, seven and eight digit forms alike", () => {
    expect(encode("425261", "upce").value).toBe("04252614");
    expect(encode("0425261", "upce").value).toBe("04252614");
    expect(encode("04252614", "upce").value).toBe("04252614");
    expect(() => encode("04252615", "upce")).toThrowError(/should end in 4/);
  });

  it("refuses a UPC-A that has no compressed form", () => {
    expect(() => encode("012345678905", "upce")).toThrowError(/no UPC-E form/);
    expect(() => encode("0123", "upce")).toThrowError(/needs 6, 7 or 8 digits/);
    expect(() => encode("2425261", "upce")).toThrowError(/number system must be 0 or 1/);
  });
});

/* -------------------------------------------------------------------------- */
/* Code 39, ITF-14, Codabar                                                   */
/* -------------------------------------------------------------------------- */

describe("code 39", () => {
  it("frames the data with the asterisk start and stop character", () => {
    const encoded = encode("HELLO", "code39");
    expect(encoded.humanText).toBe("*HELLO*");
    const star = CODE39_TABLE["*"]!;
    const starModules = star.split("").map((c) => (c === "w" ? 2 : 1));
    expect(encoded.modules.slice(0, 9)).toEqual(starModules);
    expect(encoded.modules.slice(-9)).toEqual(starModules);
    // Seven characters at nine elements, plus a narrow gap between each.
    expect(encoded.modules).toHaveLength(7 * 9 + 6);
    expect(encode("*HELLO*", "code39").modules).toEqual(encoded.modules);
  });

  it("appends the modulo 43 check character on request", () => {
    expect(code39CheckChar("HELLO")).toBe("B");
    const encoded = encode("HELLO", "code39", { code39Check: true });
    expect(encoded.checkDigit).toBe("B");
    expect(encoded.humanText).toBe("*HELLOB*");
  });

  it("uppercases lowercase input and says so", () => {
    const encoded = encode("part-1", "code39");
    expect(encoded.humanText).toBe("*PART-1*");
    expect(encoded.warnings.join(" ")).toMatch(/uppercased/);
  });

  it("rejects characters outside the 43 character set", () => {
    expect(() => encode("HELLO!", "code39")).toThrowError(/"!"/);
    expect(() => encode("HE*LO", "code39")).toThrowError(/reserves the asterisk/);
    expect(() => encode("**", "code39")).toThrowError(ToolError);
  });
});

describe("ITF-14", () => {
  it("encodes fourteen digits with bearer bars", () => {
    const encoded = encode("1234567890123", "itf14");
    expect(encoded.checkDigit).toBe("1");
    expect(encoded.value).toBe("12345678901231");
    expect(encoded.bearerBars).toBe(true);
    // Start is four narrow elements, each pair is ten elements, stop is three.
    expect(encoded.modules).toHaveLength(4 + 7 * 10 + 3);
    expect(encoded.width).toBe(106);
    expect(encoded.modules.slice(0, 4)).toEqual([1, 1, 1, 1]);
    expect(encoded.modules.slice(-3)).toEqual([2, 1, 1]);
  });

  it("accepts the full fourteen digits and rejects any other length", () => {
    expect(encode("12345678901231", "itf14").checkDigit).toBe("1");
    expect(() => encode("12345678901232", "itf14")).toThrowError(/should end in 1/);
    expect(() => encode("12345", "itf14")).toThrowError(/needs 13 digits/);
  });
});

describe("codabar", () => {
  it("keeps an explicit start and stop pair", () => {
    const encoded = encode("A1234A", "codabar");
    expect(encoded.value).toBe("A1234A");
    expect(encoded.humanText).toBe("A1234A");
    expect(encoded.warnings).toEqual([]);
    expect(encoded.modules).toHaveLength(6 * 7 + 5);
  });

  it("adds start and stop letters when they are missing", () => {
    const encoded = encode("1234", "codabar");
    expect(encoded.value).toBe("A1234A");
    expect(encoded.warnings.join(" ")).toMatch(/added at both ends/);
    expect(encode("T1234T", "codabar").value).toBe("A1234A");
  });

  it("rejects stray start letters and unsupported marks", () => {
    expect(() => encode("1A234", "codabar")).toThrowError(/both ends or at neither/);
    expect(() => encode("A12#4A", "codabar")).toThrowError(/"#"/);
    expect(() => encode("AA", "codabar")).toThrowError(ToolError);
  });
});

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

describe("renderBarcodeSvg", () => {
  it("draws exactly one rect per bar", () => {
    const encoded = encode("ABC", "code128");
    const bars = (encoded.modules.length + 1) / 2;
    expect(bars).toBe(19);
    const bare = renderBarcodeSvg(encoded, { background: "none" });
    expect(bare.match(/<rect /g)).toHaveLength(bars);
    // The default adds one background rect and nothing else.
    expect(renderBarcodeSvg(encoded).match(/<rect /g)).toHaveLength(bars + 1);
  });

  it("sizes the canvas from the module width and quiet zone", () => {
    const encoded = encode("ABC", "code128");
    const svg = renderBarcodeSvg(encoded, {
      moduleWidth: 3,
      height: 60,
      quietZone: 10,
      showText: false,
    });
    // 68 symbol modules plus 10 quiet zone modules on each side, at 3 per module.
    expect(svg).toContain(`width="${(68 + 20) * 3}"`);
    expect(svg).toContain('height="60"');
    expect(svg).not.toContain("<text");
  });

  it("raises the quiet zone so EAN digits printed outside the symbol still fit", () => {
    const encoded = encode("590123412345", "ean13");
    const svg = renderBarcodeSvg(encoded, { moduleWidth: 2, quietZone: 0 });
    // EAN-13 needs eleven modules a side, which is where the lead digit sits.
    expect(svg).toContain(`width="${(95 + 22) * 2}"`);
    expect(svg).toContain(">5</text>");
    expect(svg).toContain(">901234</text>");
    expect(svg).toContain(">123457</text>");
    const xs = [...svg.matchAll(/<text x="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeGreaterThan(0);
  });

  it("draws guard bars longer than the data bars", () => {
    const encoded = encode("590123412345", "ean13");
    const svg = renderBarcodeSvg(encoded, { moduleWidth: 2, height: 80, background: "none" });
    const heights = [...svg.matchAll(/<rect [^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));
    // Two bars in each of the three guard patterns dip past the digits.
    expect(heights.filter((h) => h > 80)).toHaveLength(6);
    expect(heights.filter((h) => h === 80).length).toBeGreaterThan(20);
  });

  it("frames ITF-14 with bearer bars and is byte for byte deterministic", () => {
    const encoded = encode("1234567890123", "itf14");
    const svg = renderBarcodeSvg(encoded);
    const bars = (encoded.modules.length + 1) / 2;
    expect(svg.match(/<rect /g)).toHaveLength(bars + 4 + 1);
    expect(renderBarcodeSvg(encode("1234567890123", "itf14"))).toBe(svg);
  });

  it("escapes markup in the human readable text", () => {
    const svg = renderBarcodeSvg(encode("a<b&c", "code128"));
    expect(svg).toContain("a&lt;b&amp;c");
    expect(svg).not.toContain("<b&c");
  });
});

/* -------------------------------------------------------------------------- */
/* Sheets                                                                     */
/* -------------------------------------------------------------------------- */

describe("sheet layouts", () => {
  it("lays Avery 5160 out as 3 columns by 10 rows", () => {
    const spec = getSheet("avery-5160")!;
    expect(spec.cols * spec.rows).toBe(30);
    const cells = sheetCells(spec);
    expect(cells).toHaveLength(30);
    expect(cells[0]).toMatchObject({ row: 0, col: 0, x: 4.7625, y: 12.7 });
    expect(cells[2]).toMatchObject({ row: 0, col: 2, x: 4.7625 + 2 * 69.85, y: 12.7 });
    expect(cells[29]).toMatchObject({ row: 9, col: 2, y: 12.7 + 9 * 25.4 });
    // Nothing may run off the page.
    for (const cell of cells) {
      expect(cell.x + cell.width).toBeLessThanOrEqual(spec.pageWidth);
      expect(cell.y + cell.height).toBeLessThanOrEqual(spec.pageHeight);
    }
  });

  it("keeps every sheet inside its page", () => {
    expect(SHEETS.map((s) => s.id)).toEqual(["avery-5160", "a4-3x8", "a4-2x7"]);
    for (const spec of SHEETS) {
      const cells = sheetCells(spec);
      expect(cells).toHaveLength(spec.cols * spec.rows);
      const last = cells[cells.length - 1]!;
      expect(last.x + last.width).toBeLessThanOrEqual(spec.pageWidth + 0.001);
      expect(last.y + last.height).toBeLessThanOrEqual(spec.pageHeight + 0.001);
    }
    expect(sheetCells(getSheet("a4-3x8")!)).toHaveLength(24);
    expect(sheetCells(getSheet("a4-2x7")!)).toHaveLength(14);
  });

  it("renders a page sized SVG measured in millimeters", () => {
    const spec = getSheet("avery-5160")!;
    const list = Array.from({ length: 3 }, () => encode("ABC-1", "code128"));
    const svg = renderSheetSvg(list, spec);
    expect(svg).toContain('width="215.9mm"');
    expect(svg).toContain('height="279.4mm"');
    expect(svg).toContain('viewBox="0 0 215.9 279.4"');
    expect(svg.match(/<g transform=/g)).toHaveLength(3);
  });

  it("refuses more barcodes than the sheet holds and says how many fit", () => {
    const spec = getSheet("avery-5160")!;
    const list = Array.from({ length: 31 }, () => encode("ABC", "code128"));
    expect(() => renderSheetSvg(list, spec)).toThrowError(ToolError);
    expect(() => renderSheetSvg(list, spec)).toThrowError(/holds 30/);
  });
});

/* -------------------------------------------------------------------------- */
/* run()                                                                      */
/* -------------------------------------------------------------------------- */

describe("run", () => {
  it("returns a single SVG by default", () => {
    const svg = run("HELLO", { type: "code128" });
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain("<rect");
    expect(run("HELLO", { type: "code128" })).toBe(svg);
  });

  it("defaults to Code 128 and accepts type synonyms", () => {
    expect(normaliseType(undefined)).toBe("code128");
    expect(normaliseType("EAN-13")).toBe("ean13");
    expect(normaliseType("upc")).toBe("upca");
    expect(normaliseType("nw7")).toBe("codabar");
    expect(BARCODE_TYPES).toHaveLength(8);
  });

  it("fills a sheet, one barcode per line, repeated by the copies option", () => {
    const svg = run("111\n222\n333", { type: "code128", sheet: "avery-5160", copies: 2 });
    expect(svg.match(/<g transform=/g)).toHaveLength(6);
    expect(svg).toContain('width="215.9mm"');
  });

  it("reports the empty input, the stray newline and every bad option", () => {
    expect(() => run("", {})).toThrowError(/Enter the value/);
    expect(() => run("   ", {})).toThrowError(ToolError);
    expect(() => run("one\ntwo", {})).toThrowError(/line break/);
    expect(() => run("ABC", { type: "code2000" })).toThrowError(/Unknown barcode type/);
    expect(() => run("ABC", { sheet: "avery-9999" })).toThrowError(/Unknown sheet layout/);
    expect(() => run("ABC", { sheet: "avery-5160", copies: 0 })).toThrowError(/Copies must be/);
    expect(() => run("ABC", { moduleWidth: 99 })).toThrowError(/Module width must be/);
    expect(() => run("ABC", { height: 5 })).toThrowError(/Bar height must be/);
    expect(() => run("ABC", { quietZone: 99 })).toThrowError(/Quiet zone must be/);
  });

  it("overflows the sheet with a count the user can act on", () => {
    const lines = Array.from({ length: 20 }, (_, i) => String(1000 + i)).join("\n");
    expect(() => run(lines, { sheet: "a4-2x7" })).toThrowError(/holds 14/);
  });

  it("passes the Code 39 check character option through", () => {
    expect(run("HELLO", { type: "code39", code39Check: true })).toContain(">*HELLOB*<");
    expect(run("HELLO", { type: "code39" })).toContain(">*HELLO*<");
  });
});

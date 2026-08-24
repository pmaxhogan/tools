import { describe, expect, it } from "vitest";
import {
  BAND_HEX,
  bandHex,
  bandLabel,
  bandRole,
  bandsToCode,
  codeToBands,
  defaultBands,
  encodeToBands,
  legalColorsForPosition,
  parseBandList,
  resizeBands,
  run,
  __test__,
} from "./index";
import { ToolError } from "../types";

const decode = (input: string) => run(input, { mode: "decode" });
const encode = (input: string, opts: Record<string, string> = {}) => run(input, { mode: "encode", ...opts });

function expectToolError(fn: () => unknown, code: string): ToolError {
  try {
    fn();
    throw new Error("expected throw");
  } catch (e) {
    expect(e).toBeInstanceOf(ToolError);
    expect((e as ToolError).code).toBe(code);
    return e as ToolError;
  }
}

describe("resistor-color-code-calculator: decode", () => {
  it("decodes a 4-band resistor (brown black red gold)", () => {
    const out = decode("brown black red gold");
    expect(out.Resistance).toBe("1.00 kohm");
    expect(out.Tolerance).toBe("5%");
    expect(out.Range).toBe("950 ohm to 1.05 kohm");
    expect(out.Bands).toContain("1st brown = digit 1");
    expect(out.Bands).toContain("4th gold = tolerance 5%");
  });

  it("decodes a small 4-band value (yellow violet black gold)", () => {
    const out = decode("yellow violet black gold");
    expect(out.Resistance).toBe("47.0 ohm");
    expect(out.Tolerance).toBe("5%");
  });

  it("decodes a 3-band resistor with no tolerance band as 20%", () => {
    const out = decode("red red orange");
    expect(out.Resistance).toBe("22.0 kohm");
    expect(out.Tolerance).toBe("20%");
    expect(out.Bands).toContain("no tolerance band = tolerance 20%");
  });

  it("decodes a 5-band resistor with 3 significant digits", () => {
    const out = decode("brown black black red brown");
    expect(out.Resistance).toBe("10.0 kohm");
    expect(out.Tolerance).toBe("1%");
  });

  it("decodes a 6-band resistor including the temperature coefficient", () => {
    const out = decode("brown black black red brown brown");
    expect(out.Resistance).toBe("10.0 kohm");
    expect(out.Tolerance).toBe("1%");
    expect(out["Temperature coefficient"]).toBe("100 ppm/K");
    expect(out.Bands).toContain("temperature coefficient 100 ppm/K");
  });

  it("accepts commas and dashes as separators, case-insensitively", () => {
    const out = decode("Brown,Black-RED, gold");
    expect(out.Resistance).toBe("1.00 kohm");
  });

  it("accepts gray/gry as grey and purple as violet", () => {
    const gray = decode("brown gray black gold");
    const grey = decode("brown grey black gold");
    const gry = decode("brown gry black gold");
    expect(gray).toEqual(grey);
    expect(gry).toEqual(grey);

    const purple = decode("brown purple black gold");
    const violet = decode("brown violet black gold");
    expect(purple).toEqual(violet);
  });

  it("reports E-series membership: exact E12/E24 match, E96 rounds to a nearby value", () => {
    const out = decode("yellow violet red gold"); // 4.7k, an E12 and E24 value
    expect(out["E12 standard value"]).toBe("Yes, exact E12 match.");
    expect(out["E24 standard value"]).toBe("Yes, exact E24 match.");
    expect(out["E96 standard value"]).toMatch(/^No, nearest E96 value is/);
  });

  it("reports E-series membership: E96 match but not E12/E24", () => {
    const out = decode("yellow white white black gold"); // 499 ohm, E96-only
    expect(out.Resistance).toBe("499 ohm");
    expect(out["E96 standard value"]).toBe("Yes, exact E96 match.");
    expect(out["E12 standard value"]).toMatch(/^No, nearest E12 value is/);
    expect(out["E24 standard value"]).toMatch(/^No, nearest E24 value is/);
  });

  it("throws empty-input for blank input", () => {
    expectToolError(() => decode(""), "empty-input");
    expectToolError(() => decode("   "), "empty-input");
  });

  it("throws bad-color naming the offending token", () => {
    const err = expectToolError(() => decode("brown blorple red gold"), "bad-color");
    expect(err.message).toContain("blorple");
  });

  it("throws bad-band-count for too few bands", () => {
    expectToolError(() => decode("brown black"), "bad-band-count");
  });

  it("throws bad-band-count for too many bands", () => {
    expectToolError(() => decode("brown black red brown red black brown"), "bad-band-count");
  });

  it("throws bad-band-count when gold or silver is used as a digit band", () => {
    const err = expectToolError(() => decode("gold black red gold"), "bad-band-count");
    expect(err.message).toContain("gold");
  });

  it("throws bad-band-count when a non-tolerance color is used as the tolerance band", () => {
    expectToolError(() => decode("brown black red orange"), "bad-band-count");
  });
});

describe("resistor-color-code-calculator: encode", () => {
  it("encodes 4700 as a 4-band code with the default 5% tolerance", () => {
    const out = encode("4700", { bands: "4" });
    expect(out.Bands).toBe("yellow, violet, red, gold");
    expect(out.Sketch).toBe("[yellow|violet|red|gold]");
    expect(out.Tolerance).toBe("5%");
    expect(out.Note).toBeUndefined();
  });

  it("encodes 4750 as a 5-band 1% code exactly", () => {
    const out = encode("4750", { bands: "5", tolerance: "1" });
    expect(out.Bands).toBe("yellow, violet, green, brown, brown");
    expect(out.Tolerance).toBe("1%");
    expect(out.Note).toBeUndefined();
  });

  it("encodes 4750 as a 4-band code and flags the nearest representable value", () => {
    const out = encode("4750", { bands: "4" });
    expect(out["Value encoded"]).toBe("4.80 kohm");
    expect(out.Note).toMatch(/not exactly representable/);
    expect(out.Note).toContain("4.80 kohm");
  });

  it("parses k7-style shorthand and unit suffixes", () => {
    const a = encode("4k7", { bands: "4" });
    expect(a.Bands).toBe("yellow, violet, red, gold");

    const b = encode("1M", { bands: "4" });
    expect(b["Value encoded"]).toBe("1.00 Mohm");

    const c = encode("0.5 ohm", { bands: "4" });
    expect(c["Value encoded"]).toBe("500 mohm");
  });

  it("encodes a 6-band code with 3 significant digits and the temperature coefficient", () => {
    const out = encode("4700", { bands: "6", tempco: "50" });
    expect(out.Bands).toBe("yellow, violet, black, brown, gold, red");
    expect(out["Temperature coefficient"]).toBe("50 ppm/K");
  });

  it("defaults the temperature coefficient to 100 ppm/K (brown) for 6-band", () => {
    const out = encode("4700", { bands: "6" });
    expect(out.Bands).toBe("yellow, violet, black, brown, gold, brown");
    expect(out["Temperature coefficient"]).toBe("100 ppm/K");
  });

  it("reports E-series membership for the encoded value", () => {
    const out = encode("4700", { bands: "4" });
    expect(out["E12 standard value"]).toBe("Yes, exact E12 match.");
  });

  it("throws empty-input for blank input", () => {
    expectToolError(() => encode(""), "empty-input");
  });

  it("throws bad-value for unparseable input", () => {
    const err = expectToolError(() => encode("banana"), "bad-value");
    expect(err.message).toContain("banana");
  });

  it("throws bad-value for a negative value", () => {
    expectToolError(() => encode("-100"), "bad-value");
  });

  it("throws bad-option for an unsupported band count", () => {
    expectToolError(() => encode("100", { bands: "7" }), "bad-option");
  });

  it("throws bad-option for an unrecognized tolerance", () => {
    expectToolError(() => encode("100", { tolerance: "15" }), "bad-option");
  });

  it("throws bad-option when 20% tolerance is requested since it has no band color", () => {
    expectToolError(() => encode("100", { tolerance: "20" }), "bad-option");
  });

  it("throws bad-option for an unrecognized temperature coefficient", () => {
    expectToolError(() => encode("100", { bands: "6", tempco: "999" }), "bad-option");
  });
});

describe("resistor-color-code-calculator: mode handling", () => {
  it("defaults to decode mode", () => {
    const out = run("brown black red gold", { mode: "" });
    expect(out.Resistance).toBe("1.00 kohm");
  });

  it("throws bad-option for an unrecognized mode", () => {
    expectToolError(() => run("brown black red gold", { mode: "transmogrify" }), "bad-option");
  });
});

// ---------------------------------------------------------------------------
// The drawing surface: everything the bespoke panel calls.
// ---------------------------------------------------------------------------

const BAND_COUNTS = [3, 4, 5, 6] as const;

describe("resistor-color-code-calculator: BAND_HEX", () => {
  it("gives every band color a hex, and invents none", () => {
    const colors = Object.keys(__test__.COLOR_INFO);
    for (const color of colors) {
      expect(BAND_HEX[color], `missing hex for ${color}`).toMatch(/^#[0-9a-f]{6}$/);
    }
    for (const key of Object.keys(BAND_HEX)) {
      expect(colors, `${key} is not a band color`).toContain(key);
    }
    expect(Object.keys(BAND_HEX)).toHaveLength(colors.length);
  });

  it("resolves aliases and answers transparent for anything else", () => {
    expect(bandHex("gray")).toBe(BAND_HEX.grey);
    expect(bandHex("purple")).toBe(BAND_HEX.violet);
    expect(bandHex("BROWN")).toBe(BAND_HEX.brown);
    expect(bandHex("none")).toBe("transparent");
    expect(bandHex("")).toBe("transparent");
  });
});

describe("resistor-color-code-calculator: bandLabel", () => {
  it("uses US English display names for every color", () => {
    expect(bandLabel("grey")).toBe("Gray");
    expect(bandLabel("gray")).toBe("Gray");
    expect(bandLabel("purple")).toBe("Violet");
    expect(bandLabel("black")).toBe("Black");
    for (const color of Object.keys(__test__.COLOR_INFO)) {
      expect(bandLabel(color)).toMatch(/^[A-Z][a-z]+$/);
    }
  });

  it("hands back an unknown name unchanged", () => {
    expect(bandLabel("blorple")).toBe("blorple");
  });
});

describe("resistor-color-code-calculator: bandRole", () => {
  it("mirrors the positions decode reads", () => {
    expect(BAND_COUNTS.map((n) => bandRole(n, 0))).toEqual(["digit", "digit", "digit", "digit"]);
    expect(bandRole(3, 2)).toBe("multiplier");
    expect(bandRole(4, 2)).toBe("multiplier");
    expect(bandRole(4, 3)).toBe("tolerance");
    expect(bandRole(5, 2)).toBe("digit");
    expect(bandRole(5, 3)).toBe("multiplier");
    expect(bandRole(5, 4)).toBe("tolerance");
    expect(bandRole(6, 4)).toBe("tolerance");
    expect(bandRole(6, 5)).toBe("tempco");
  });

  it("returns null outside the code", () => {
    expect(bandRole(3, 3)).toBeNull();
    expect(bandRole(4, 4)).toBeNull();
    expect(bandRole(4, -1)).toBeNull();
    expect(bandRole(7, 0)).toBeNull();
    expect(bandRole(2, 0)).toBeNull();
    expect(bandRole(4.5, 0)).toBeNull();
  });
});

describe("resistor-color-code-calculator: legalColorsForPosition", () => {
  it("only ever offers a color that decode then accepts", () => {
    for (const bands of BAND_COUNTS) {
      const base = defaultBands(bands);
      for (let position = 0; position < bands; position++) {
        const options = legalColorsForPosition(bands, position);
        expect(options.length, `no options at ${bands}/${position}`).toBeGreaterThan(0);
        for (const option of options) {
          const colors = [...base];
          colors[position] = option.color;
          expect(
            () => run(colors.join(" "), { mode: "decode" }),
            `${bands}-band position ${position} offered ${option.color}`,
          ).not.toThrow();
        }
      }
    }
  });

  it("keeps gold and silver out of the digit bands and in the multiplier", () => {
    const digits = legalColorsForPosition(4, 0).map((o) => o.color);
    expect(digits).toHaveLength(10);
    expect(digits).not.toContain("gold");
    expect(digits).not.toContain("silver");

    const multiplier = legalColorsForPosition(4, 2).map((o) => o.color);
    expect(multiplier).toHaveLength(12);
    expect(multiplier).toContain("gold");
    expect(multiplier).toContain("silver");
  });

  it("offers the documented tolerance and temperature coefficient colors", () => {
    expect(legalColorsForPosition(4, 3).map((o) => o.color)).toEqual([
      "brown",
      "red",
      "green",
      "blue",
      "violet",
      "grey",
      "gold",
      "silver",
    ]);
    expect(legalColorsForPosition(6, 5).map((o) => o.color)).toEqual([
      "brown",
      "red",
      "orange",
      "yellow",
      "blue",
      "violet",
    ]);
  });

  it("describes what each color means in its position", () => {
    const byColor = (bands: number, position: number, color: string) =>
      legalColorsForPosition(bands, position).find((o) => o.color === color);

    expect(byColor(4, 0, "violet")?.meaning).toBe("digit 7");
    expect(byColor(4, 2, "black")?.meaning).toBe("x1");
    expect(byColor(4, 2, "red")?.meaning).toBe("x100");
    expect(byColor(4, 2, "orange")?.meaning).toBe("x1k");
    expect(byColor(4, 2, "blue")?.meaning).toBe("x1M");
    expect(byColor(4, 2, "white")?.meaning).toBe("x1G");
    expect(byColor(4, 2, "gold")?.meaning).toBe("x0.1");
    expect(byColor(4, 2, "silver")?.meaning).toBe("x0.01");
    expect(byColor(4, 3, "gold")?.meaning).toBe("±5%");
    expect(byColor(4, 3, "grey")?.meaning).toBe("±0.05%");
    expect(byColor(6, 5, "violet")?.meaning).toBe("5 ppm/K");
  });

  it("carries the US English label and the hex on every option", () => {
    const grey = legalColorsForPosition(4, 0).find((o) => o.color === "grey");
    expect(grey?.label).toBe("Gray");
    expect(grey?.hex).toBe(BAND_HEX.grey);
  });

  it("returns nothing for a position that does not exist", () => {
    expect(legalColorsForPosition(3, 3)).toEqual([]);
    expect(legalColorsForPosition(4, 9)).toEqual([]);
    expect(legalColorsForPosition(9, 0)).toEqual([]);
  });
});

describe("resistor-color-code-calculator: resizeBands", () => {
  it("keeps the value when a third significant digit is added", () => {
    const four = ["brown", "black", "red", "gold"];
    const five = resizeBands(four, 5);
    expect(five).toEqual(["brown", "black", "black", "brown", "gold"]);
    expect(run(five.join(" "), { mode: "decode" }).Resistance).toBe(
      run(four.join(" "), { mode: "decode" }).Resistance,
    );
  });

  it("drops the last significant digit when a band is removed", () => {
    const five = ["yellow", "violet", "green", "brown", "brown"];
    const four = resizeBands(five, 4);
    expect(four).toEqual(["yellow", "violet", "red", "brown"]);
    expect(run(four.join(" "), { mode: "decode" }).Resistance).toBe("4.70 kohm");
  });

  it("adds and removes the tolerance and temperature coefficient bands", () => {
    expect(resizeBands(["brown", "black", "red", "gold"], 3)).toEqual(["brown", "black", "red"]);
    expect(resizeBands(["brown", "black", "red"], 4)).toEqual(["brown", "black", "red", "gold"]);
    const six = resizeBands(["brown", "black", "red", "silver"], 6);
    expect(six).toHaveLength(6);
    expect(six[5]).toBe("brown");
    expect(resizeBands(six, 5)).toHaveLength(5);
  });

  it("carries a chosen tolerance across a resize, and drops a tempco it cannot store", () => {
    const six = ["brown", "black", "black", "red", "violet", "orange"];
    const four = resizeBands(six, 4);
    // Tolerance survives because a 4-band code still has that band.
    expect(four).toEqual(["brown", "black", "orange", "violet"]);
    // The temperature coefficient does not: a 4-band code has nowhere to keep
    // it, so growing back to 6 starts again on the 100 ppm/K default.
    expect(resizeBands(four, 6)).toEqual(["brown", "black", "black", "red", "violet", "brown"]);
  });

  it("clamps a multiplier that would fall off the end of the printable range", () => {
    // Silver is the smallest multiplier there is, so growing a digit cannot
    // borrow another decade from it.
    const grown = resizeBands(["brown", "black", "silver", "gold"], 5);
    expect(grown).toEqual(["brown", "black", "black", "silver", "gold"]);
    const shrunk = resizeBands(["white", "white", "white", "white", "gold"], 4);
    expect(shrunk).toEqual(["white", "white", "white", "gold"]);
  });

  it("never emits an empty or unknown band, whatever it is handed", () => {
    const inputs: string[][] = [
      [],
      ["nonsense"],
      ["gold", "silver", "gold", "gold"],
      ["brown", "black", "red", "orange", "yellow", "green", "blue"],
    ];
    for (const input of inputs) {
      for (const count of BAND_COUNTS) {
        const out = resizeBands(input, count);
        expect(out).toHaveLength(count);
        for (const color of out) {
          expect(__test__.CANONICAL_COLORS, `${color} is not a band color`).toContain(color);
        }
      }
    }
  });

  it("clamps a band count outside 3 to 6", () => {
    expect(resizeBands(["brown", "black", "red", "gold"], 1)).toHaveLength(3);
    expect(resizeBands(["brown", "black", "red", "gold"], 99)).toHaveLength(6);
  });
});

describe("resistor-color-code-calculator: defaultBands", () => {
  it("starts every band count on a real 1 kohm part", () => {
    for (const count of BAND_COUNTS) {
      const colors = defaultBands(count);
      expect(colors).toHaveLength(count);
      expect(run(colors.join(" "), { mode: "decode" }).Resistance).toBe("1.00 kohm");
    }
    expect(defaultBands(4)).toEqual(["brown", "black", "red", "gold"]);
    expect(run(defaultBands(4).join(" "), { mode: "decode" }).Tolerance).toBe("5%");
  });
});

describe("resistor-color-code-calculator: parseBandList", () => {
  it("accepts the same syntax decode accepts", () => {
    expect(parseBandList("brown black red gold")).toEqual(["brown", "black", "red", "gold"]);
    expect(parseBandList("Brown,Gray-RED, gold")).toEqual(["brown", "grey", "red", "gold"]);
    expect(parseBandList("  red red orange  ")).toEqual(["red", "red", "orange"]);
  });

  it("throws the decode errors for blank, miscounted, and unknown colors", () => {
    expectToolError(() => parseBandList(""), "empty-input");
    expectToolError(() => parseBandList("   "), "empty-input");
    expectToolError(() => parseBandList("brown black"), "bad-band-count");
    expectToolError(() => parseBandList("a b c d e f g"), "bad-band-count");
    const err = expectToolError(() => parseBandList("brown blorple red gold"), "bad-color");
    expect(err.message).toContain("blorple");
  });

  it("leaves position legality to run, which names the offending band", () => {
    expect(parseBandList("gold black red gold")).toEqual(["gold", "black", "red", "gold"]);
    expectToolError(() => run("gold black red gold", { mode: "decode" }), "bad-band-count");
  });
});

describe("resistor-color-code-calculator: fragment codes", () => {
  it("round trips every band count", () => {
    for (const count of BAND_COUNTS) {
      const colors = defaultBands(count);
      const code = bandsToCode(colors);
      expect(code).toHaveLength(count);
      expect(codeToBands(code)).toEqual(colors);
    }
    expect(bandsToCode(["brown", "black", "red", "gold"])).toBe("102g");
    expect(codeToBands("102g")).toEqual(["brown", "black", "red", "gold"]);
    expect(codeToBands("47s1")).toEqual(["yellow", "violet", "silver", "brown"]);
  });

  it("normalizes aliases and case on the way in", () => {
    expect(bandsToCode(["brown", "Gray", "purple", "GOLD"])).toBe("187g");
    expect(codeToBands("102G")).toEqual(["brown", "black", "red", "gold"]);
  });

  it("returns null rather than throwing for anything malformed", () => {
    expect(codeToBands("")).toBeNull();
    expect(codeToBands("10")).toBeNull();
    expect(codeToBands("1234567")).toBeNull();
    expect(codeToBands("10z")).toBeNull();
    // gold cannot be a digit band
    expect(codeToBands("gg1")).toBeNull();
    // orange has no tolerance rating
    expect(codeToBands("1023")).toBeNull();
    // 5-band positions, so the 5th band has to be a tolerance color
    expect(codeToBands("102g3")).toBeNull();
  });
});

describe("resistor-color-code-calculator: encodeToBands", () => {
  it("returns exactly the colors the encode result names", () => {
    const cases: [string, Record<string, string>][] = [
      ["4700", { bands: "4" }],
      ["4750", { bands: "5", tolerance: "1" }],
      ["4700", { bands: "6", tempco: "50" }],
      ["0.5 ohm", { bands: "4" }],
      ["1M", { bands: "5", tolerance: "0.1" }],
    ];
    for (const [value, opts] of cases) {
      const colors = encodeToBands(value, opts);
      expect(colors.join(", ")).toBe(run(value, { mode: "encode", ...opts }).Bands);
      expect(colors).toHaveLength(Number(opts.bands));
      for (const color of colors) {
        expect(BAND_HEX[color], `${color} has no hex`).toBeDefined();
      }
    }
  });

  it("produces a code that decodes back to the value it encoded", () => {
    const colors = encodeToBands("4.7k", { bands: "4" });
    expect(run(colors.join(" "), { mode: "decode" }).Resistance).toBe("4.70 kohm");
  });

  it("throws the same errors run does", () => {
    expectToolError(() => encodeToBands("", { bands: "4" }), "empty-input");
    expectToolError(() => encodeToBands("banana", { bands: "4" }), "bad-value");
    expectToolError(() => encodeToBands("100", { bands: "7" }), "bad-option");
    expectToolError(() => encodeToBands("100", { bands: "4", tolerance: "20" }), "bad-option");
    expectToolError(() => encodeToBands("100", { bands: "6", tempco: "999" }), "bad-option");
  });
});

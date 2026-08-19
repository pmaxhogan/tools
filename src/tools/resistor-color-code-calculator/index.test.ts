import { describe, expect, it } from "vitest";
import { run } from "./index";
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

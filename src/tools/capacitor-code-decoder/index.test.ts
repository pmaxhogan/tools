import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

const decode = (input: string, opts: Record<string, string> = {}) =>
  run(input, { mode: "decode", ...opts });
const encode = (input: string, opts: Record<string, string> = {}) =>
  run(input, { mode: "encode", ...opts });

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

describe("capacitor-code-decoder: decode", () => {
  it("decodes a plain 3-digit code (104 -> 100 nF)", () => {
    const out = decode("104");
    expect(out["Value in pF"]).toBe("100000 pF");
    expect(out["Value in nF"]).toBe("100 nF");
    expect(out["Value in uF"]).toBe("0.1 uF");
    expect(out["EIA-198 breakdown"]).toBe("10 x 10^4 pF = 100000 pF = 100 nF");
    expect(out["Tolerance"]).toBeUndefined();
  });

  it("decodes a fused code with tolerance and direct voltage (104J50V)", () => {
    const out = decode("104J50V");
    expect(out["Value in nF"]).toBe("100 nF");
    expect(out["Tolerance"]).toBe("+/-5% (J)");
    expect(out["Voltage rating"]).toBe("50 V");
  });

  it("decodes the same fields given as separate tokens", () => {
    const out = decode("104 J 50V");
    expect(out["Value in nF"]).toBe("100 nF");
    expect(out["Tolerance"]).toBe("+/-5% (J)");
    expect(out["Voltage rating"]).toBe("50 V");
  });

  it("decodes an EIA-198 voltage code and a temperature coefficient word", () => {
    const out = decode("104K 1E X7R");
    expect(out["Tolerance"]).toBe("+/-10% (K)");
    expect(out["Voltage rating"]).toBe("25 V (code 1E)");
    expect(out["Temperature coefficient"]).toBe(
      "X7R: +/-15% over -55C to +125C, general purpose, some voltage and aging sensitivity.",
    );
  });

  it("treats NP0 and C0G as the same class", () => {
    const np0 = decode("104 NP0");
    const c0g = decode("104 C0G");
    expect(np0["Temperature coefficient"]).toBe(np0["Temperature coefficient"]);
    expect(np0["Temperature coefficient"]?.startsWith("NP0:")).toBe(true);
    expect(c0g["Temperature coefficient"]?.startsWith("C0G:")).toBe(true);
    expect(np0["Temperature coefficient"]?.slice(4)).toBe(c0g["Temperature coefficient"]?.slice(4));
  });

  it("decodes the digit-9 x0.1 exception (229 -> 2.2 pF)", () => {
    const out = decode("229");
    expect(out["Value in pF"]).toBe("2.2 pF");
    expect(out["EIA-198 breakdown"]).toBe("22 x 0.1 pF = 2.2 pF");
  });

  it("decodes R notation (4R7 -> 4.7 pF)", () => {
    const out = decode("4R7");
    expect(out["Value in pF"]).toBe("4.7 pF");
    expect(out["EIA-198 breakdown"]).toBe("4.7 pF (R notation: R replaces the decimal point)");
  });

  it("decodes a 2-digit direct pF code (22 -> 22 pF)", () => {
    const out = decode("22");
    expect(out["Value in pF"]).toBe("22 pF");
    expect(out["EIA-198 breakdown"]).toBe("22 pF (direct 2-digit marking, no multiplier digit)");
  });

  it("decodes a 1-digit direct pF code (5 -> 5 pF)", () => {
    const out = decode("5");
    expect(out["Value in pF"]).toBe("5 pF");
  });

  it("computes reactance at the four standard frequencies", () => {
    const out = decode("104"); // 100 nF
    expect(out["Reactance at 50 Hz"]).toBeDefined();
    expect(out["Reactance at 60 Hz"]).toBeDefined();
    expect(out["Reactance at 1 kHz"]).toBeDefined();
    expect(out["Reactance at 1 MHz"]).toBeDefined();
    // Xc = 1 / (2 pi f C); at 1 kHz with 100 nF this is about 1.59 kohm.
    expect(out["Reactance at 1 kHz"]).toBe("1.59 kohm");
  });

  it("throws empty-input for blank input", () => {
    expectToolError(() => decode(""), "empty-input");
    expectToolError(() => decode("   "), "empty-input");
  });

  it("throws bad-code when no recognizable code is present", () => {
    expectToolError(() => decode("hello there"), "bad-code");
  });

  it("throws bad-code for an unrecognized tolerance letter", () => {
    const err = expectToolError(() => decode("104Q"), "bad-code");
    expect(err.message).toContain("Q");
  });

  it("throws bad-code for an unrecognized tolerance letter given as its own token", () => {
    expectToolError(() => decode("104 Q"), "bad-code");
  });

  it("throws bad-code for a numeric code of the wrong shape", () => {
    expectToolError(() => decode("10450"), "bad-code");
  });

  it("omits voltage rather than erroring when a 2-char code is not in the voltage table", () => {
    const out = decode("104 9Z");
    expect(out["Voltage rating"]).toBeUndefined();
  });
});

describe("capacitor-code-decoder: encode", () => {
  it("round trips 100nF to code 104", () => {
    const out = encode("100nF");
    expect(out["Nearest EIA-198 code"]).toBe("104");
    expect(out["Error"]).toBe("0.00%");
    expect(out["Full marking"]).toBe("104K");
  });

  it("encodes a value that needs the x0.1 exception (2.2pF -> 229)", () => {
    const out = encode("2.2pF");
    expect(out["Nearest EIA-198 code"]).toBe("229");
    expect(out["Error"]).toBe("0.00%");
  });

  it("encodes 4.7uF exactly and applies the requested tolerance", () => {
    const out = encode("4.7uF", { tolerance: "J" });
    expect(out["Nearest EIA-198 code"]).toBe("475");
    expect(out["Full marking"]).toBe("475J");
    expect(out["Tolerance"]).toBe("+/-5% (J)");
  });

  it("defaults tolerance to K when not given", () => {
    const out = encode("220pF");
    expect(out["Full marking"]).toBe("221K");
  });

  it("reports a nonzero error percent when the value is not exactly representable", () => {
    const out = encode("123nF");
    expect(out["Error"]).not.toBe("0.00%");
  });

  it("includes reactance rows computed from the encoded value", () => {
    const out = encode("100nF");
    expect(out["Reactance at 1 kHz"]).toBeDefined();
  });

  it("throws empty-input for blank input", () => {
    expectToolError(() => encode(""), "empty-input");
  });

  it("throws bad-token for an unparseable value", () => {
    const err = expectToolError(() => encode("banana"), "bad-token");
    expect(err.message).toContain("banana");
  });

  it("throws bad-value for a non-positive value", () => {
    expectToolError(() => encode("-5nF"), "bad-value");
  });

  it("throws bad-value for a value too small to represent (under about 1 pF)", () => {
    expectToolError(() => encode("0.1pF"), "bad-value");
  });

  it("throws bad-value for a value too large to represent (whole farads)", () => {
    expectToolError(() => encode("1"), "bad-value");
  });

  it("throws bad-option for an unrecognized tolerance letter", () => {
    expectToolError(() => encode("100nF", { tolerance: "Q" }), "bad-option");
  });
});

describe("capacitor-code-decoder: mode handling", () => {
  it("defaults to decode mode", () => {
    const out = run("104", { mode: "" });
    expect(out["Value in nF"]).toBe("100 nF");
  });

  it("throws bad-option for an unrecognized mode", () => {
    expectToolError(() => run("104", { mode: "transmogrify" }), "bad-option");
  });
});

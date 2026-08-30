import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

const divider = (input: string) => run(input, {});

describe("voltage-divider: forward compute (case 1)", () => {
  it("computes vout, current, and per-resistor power given vin, r1, r2", () => {
    const out = divider("vin=12 r1=1000 r2=2000");
    expect(out.Vout).toBe("8.00 V");
    expect(out.Current).toBe("4.00 mA");
    expect(out["R1 power"]).toBe("16.0 mW");
    expect(out["R2 power"]).toBe("32.0 mW");
    expect(out.Formula).toBe("Vout = Vin x R2 / (R1 + R2)");
  });

  it("includes the ratio table with the actual supply flagged", () => {
    const out = divider("vin=12 r1=1000 r2=2000");
    expect(out["At 12 V supply"]).toContain("this circuit's supply");
    expect(out["At 12 V supply"]).toContain("8.00 V");
    expect(out["At 5 V supply"]).toBe("3.33 V");
    expect(out["At 3.3 V supply"]).toBe("2.20 V");
    expect(out["At 9 V supply"]).toBe("6.00 V");
    expect(out["At 24 V supply"]).toBe("16.0 V");
  });

  it("computes forward power/vout even when vout and rtotal are also given (case 1 takes priority)", () => {
    const out = divider("vin=12 r1=1000 r2=2000 vout=1 rtotal=99");
    expect(out.Vout).toBe("8.00 V");
  });

  it("ignores tokens in any order and case", () => {
    const out = divider("R2=2000 VIN=12 r1=1000");
    expect(out.Vout).toBe("8.00 V");
  });
});

describe("voltage-divider: loaded divider sag", () => {
  it("computes vout under load, sag, and sag percent", () => {
    const out = divider("vin=12 r1=1000 r2=2000 load=2000");
    // reff = (2000*2000)/(4000) = 1000; voutLoaded = 12*1000/(1000+1000) = 6
    expect(out["Vout (loaded)"]).toBe("6.00 V");
    expect(out.Vout).toBe("8.00 V");
    expect(out.Sag).toBe("2.00 V");
    expect(out["Sag percent"]).toBe("25.00%");
    expect(out["R2 power (loaded)"]).toBeDefined();
  });

  it("throws impossible for a non-positive load", () => {
    try {
      divider("vin=12 r1=1000 r2=2000 load=0");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("impossible");
    }
  });
});

describe("voltage-divider: solve one resistor (case 2)", () => {
  it("solves R2 exactly and suggests the nearest E24 value when r1 is given", () => {
    const out = divider("vin=15 vout=5 r1=10000");
    expect(out["Exact R2"]).toBe("5.00 kohm");
    expect(out["Nearest E24 R2"]).toBe("5.10 kohm");
    expect(out["Achieved Vout"]).toBe("5.07 V");
    expect(out.Error).toBe("1.32%");
    expect(out.Formula).toBe("R2 = R1 x Vout / (Vin - Vout)");
  });

  it("solves R1 exactly when r2 and vout are given, with a zero-error E24 match", () => {
    const out = divider("vin=9 vout=3 r2=1000");
    expect(out["Exact R1"]).toBe("2.00 kohm");
    expect(out["Nearest E24 R1"]).toBe("2.00 kohm");
    expect(out.Error).toBe("0.00%");
    expect(out.Formula).toBe("R1 = R2 x (Vin - Vout) / Vout");
  });

  it("includes a ratio table using the solved pair's ratio", () => {
    const out = divider("vin=9 vout=3 r2=1000");
    expect(out["At 9 V supply"]).toContain("this circuit's supply");
  });
});

describe("voltage-divider: solve from resistance budget (case 3)", () => {
  it("splits a total resistance budget into r1 and r2 and snaps each to E24", () => {
    const out = divider("vin=12 vout=5 rtotal=10000");
    // exact r2 = 10000*5/12 = 4166.67, exact r1 = 5833.33
    expect(out["Total resistance (given)"]).toBe("10.0 kohm");
    expect(out["Exact R2"]).toBe("4.17 kohm");
    expect(out["Exact R1"]).toBe("5.83 kohm");
    expect(out["Nearest E24 R2"]).toBeDefined();
    expect(out["Nearest E24 R1"]).toBeDefined();
    expect(out.Formula).toBe("R2 = Rtotal x Vout / Vin; R1 = Rtotal - R2");
  });
});

describe("voltage-divider: suggest pairs (case 4)", () => {
  it("suggests three E24 pairs around 10k when only vin and vout are given", () => {
    const out = divider("vin=12 vout=5");
    const errors = [1, 2, 3].map((n) => {
      const m = out[`Suggestion ${n}`].match(/error ([\d.]+)%/);
      expect(m).not.toBeNull();
      return Number(m![1]);
    });
    expect(errors[0]).toBeLessThanOrEqual(errors[1]);
    expect(errors[1]).toBeLessThanOrEqual(errors[2]);
    expect(errors[0]).toBeLessThan(5);
    expect(out.Formula).toBe("Vout = Vin x R2 / (R1 + R2)");
  });

  it("includes a ratio table using the top suggestion's ratio", () => {
    const out = divider("vin=12 vout=5");
    expect(out["At 12 V supply"]).toContain("this circuit's supply");
  });
});

describe("voltage-divider: errors", () => {
  it("throws empty-input for blank input", () => {
    expect(() => divider("")).toThrowError(ToolError);
    try {
      divider("  ");
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("throws bad-token for an unrecognized key", () => {
    try {
      divider("vin=12 foo=5");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-token");
      expect((e as ToolError).message).toContain("foo");
    }
  });

  it("throws bad-token for an unparseable number", () => {
    try {
      divider("vin=12 r1=abc");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-token");
    }
  });

  it("throws bad-token for a token with no key=value shape", () => {
    try {
      divider("vin=12 12k");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-token");
    }
  });

  it("throws missing-values when vin is absent", () => {
    try {
      divider("r1=1000 r2=2000");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("missing-values");
      expect((e as ToolError).message).toContain("vin");
    }
  });

  it("throws missing-values when vin is present but nothing else is (case 6 fallthrough)", () => {
    try {
      divider("vin=12");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("missing-values");
    }
  });

  it("throws missing-values when only rtotal is given without vout", () => {
    try {
      divider("vin=12 rtotal=1000");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("missing-values");
    }
  });

  it("throws impossible for a non-positive vin", () => {
    try {
      divider("vin=-12 r1=1000 r2=2000");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("impossible");
    }
  });

  it("throws impossible for a non-positive resistor", () => {
    try {
      divider("vin=12 r1=0 r2=1000");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("impossible");
    }
  });

  it("throws impossible for a non-positive rtotal", () => {
    try {
      divider("vin=12 vout=5 rtotal=0");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("impossible");
    }
  });

  it("throws impossible when vout is not less than vin", () => {
    try {
      divider("vin=5 vout=6 r1=1000");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("impossible");
    }
  });

  it("throws impossible when vout is zero or negative", () => {
    try {
      divider("vin=12 vout=0 r1=1000");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("impossible");
    }
  });
});

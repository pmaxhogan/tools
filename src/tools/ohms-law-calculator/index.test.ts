import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

const ohms = (input: string) => run(input, { mode: "ohms-law" });
const led = (input: string) => run(input, { mode: "led-resistor" });
const divider = (input: string) => run(input, { mode: "voltage-divider" });

describe("ohms-law-calculator: ohms-law mode", () => {
  it("computes R and P from V and I", () => {
    const out = ohms("12V 100mA");
    expect(out.Voltage).toBe("12.0 V");
    expect(out.Current).toBe("100 mA");
    expect(out.Resistance).toBe("120 ohm");
    expect(out.Power).toBe("1.20 W");
    expect(out.Formula).toBe("R = V / I; P = V x I");
    expect(out.Summary).toContain("120 ohm");
  });

  it("computes V and I from R and P", () => {
    const out = ohms("R=100 P=4");
    expect(out.Voltage).toBe("20.0 V");
    expect(out.Current).toBe("200 mA");
    expect(out.Resistance).toBe("100 ohm");
    expect(out.Power).toBe("4.00 W");
    expect(out.Formula).toBe("V = sqrt(P x R); I = sqrt(P / R)");
  });

  it("accepts more than two values that agree and reports the consistency check", () => {
    const out = ohms("V=12 I=0.1 R=120");
    expect(out.Resistance).toBe("120 ohm");
    expect(out["Consistency check"]).toBe("All given values agree within 1%.");
  });

  it("rejects more than two values that disagree by more than 1%", () => {
    expect(() => ohms("V=12 I=0.1 R=200")).toThrowError(ToolError);
    try {
      ohms("V=12 I=0.1 R=200");
    } catch (e) {
      expect((e as ToolError).code).toBe("impossible");
      expect((e as ToolError).message).toMatch(/does not match/);
    }
  });

  it("throws need-two when fewer than two values are given", () => {
    expect(() => ohms("12V")).toThrowError(ToolError);
    try {
      ohms("12V");
    } catch (e) {
      expect((e as ToolError).code).toBe("need-two");
    }
  });

  it("parses k, M, m, and u unit prefixes", () => {
    const a = ohms("R=4.7k I=10mA");
    expect(a.Resistance).toBe("4.70 kohm");
    expect(a.Current).toBe("10.0 mA");
    expect(a.Voltage).toBe("47.0 V");
    expect(a.Power).toBe("470 mW");

    const b = ohms("R=2M P=2W");
    expect(b.Resistance).toBe("2.00 Mohm");
    expect(b.Voltage).toBe("2.00 kV");
    expect(b.Current).toBe("1.00 mA");

    const c = ohms("V=5 I=100uA");
    expect(c.Resistance).toBe("50.0 kohm");
    expect(c.Power).toBe("500 uW");
    expect(c.Current).toBe("100 uA");
  });

  it("throws empty-input for blank input", () => {
    expect(() => ohms("")).toThrowError(ToolError);
    try {
      ohms("  ");
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("throws bad-token naming the offending token", () => {
    try {
      ohms("R=abc");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-token");
      expect((e as ToolError).message).toContain("R=abc");
    }

    try {
      ohms("foo=5");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-token");
      expect((e as ToolError).message).toContain("foo");
    }

    try {
      ohms("5xyz");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-token");
      expect((e as ToolError).message).toContain("5xyz");
    }

    try {
      ohms("5k");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-token");
      expect((e as ToolError).message).toContain("5k");
    }
  });

  it("throws impossible for a zero or negative value", () => {
    try {
      ohms("R=-100 I=10mA");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("impossible");
    }
  });
});

describe("ohms-law-calculator: led-resistor mode", () => {
  it("computes the exact resistor and nearest E12/E24 for a single LED", () => {
    const out = led("vin=12 vf=2.1 if=20mA");
    expect(out["Exact resistor value"]).toBe("495 ohm");
    expect(out["Next E24 value up"]).toBe("510 ohm");
    expect(out["E24 actual current"]).toBe("19.4 mA");
    expect(out["E24 recommended wattage"]).toBe("0.5 W");
    expect(out["Next E12 value up"]).toBe("560 ohm");
    expect(out["E12 recommended wattage"]).toBe("0.5 W");
    expect(out["LED count"]).toBeUndefined();
  });

  it("defaults If to 20 mA and notes the assumption", () => {
    const out = led("vin=12 vf=2.1");
    expect(out["Exact resistor value"]).toBe("495 ohm");
    expect(out.Assumption).toMatch(/20 mA/);
  });

  it("handles series LEDs via count= and via vf=Nxcount identically", () => {
    const viaCount = led("vin=12 vf=2.1 count=3 if=20mA");
    const viaX = led("vin=12 vf=2.1x3 if=20mA");
    expect(viaCount["LED count"]).toBe("3");
    expect(viaCount["Total forward voltage"]).toBe("6.30 V");
    expect(viaCount["Exact resistor value"]).toBe("285 ohm");
    expect(viaCount).toEqual(viaX);
  });

  it("throws missing-values naming what is missing", () => {
    try {
      led("vin=12");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("missing-values");
      expect((e as ToolError).message).toContain("vf");
    }
  });

  it("throws impossible when supply does not exceed forward voltage", () => {
    try {
      led("vin=2 vf=2.1 if=20mA");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("impossible");
      expect((e as ToolError).message).toMatch(/[Ss]upply must exceed forward voltage/);
    }
  });
});

describe("ohms-law-calculator: voltage-divider mode", () => {
  it("computes vout, current, and per-resistor power given vin, r1, r2", () => {
    const out = divider("vin=12 r1=1000 r2=2000");
    expect(out.Vout).toBe("8.00 V");
    expect(out.Current).toBe("4.00 mA");
    expect(out["R1 power"]).toBe("16.0 mW");
    expect(out["R2 power"]).toBe("32.0 mW");
  });

  it("solves the missing resistor exactly and suggests a nearest E24 value", () => {
    const out = divider("vin=15 vout=5 r1=10000");
    expect(out["Exact R2"]).toBe("5.00 kohm");
    expect(out["Nearest E24 R2"]).toBe("5.10 kohm");
    expect(out["Achieved Vout"]).toBe("5.07 V");
    expect(out.Error).toBe("1.32%");
  });

  it("solves r1 exactly when r2 and vout are given, with a zero-error E24 match", () => {
    const out = divider("vin=9 vout=3 r2=1000");
    expect(out["Exact R1"]).toBe("2.00 kohm");
    expect(out["Nearest E24 R1"]).toBe("2.00 kohm");
    expect(out.Error).toBe("0.00%");
  });

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

  it("throws missing-values when vin is present but nothing else is", () => {
    try {
      divider("vin=12");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("missing-values");
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

  it("throws impossible for a zero resistor", () => {
    try {
      divider("vin=12 r1=0 r2=1000");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("impossible");
    }
  });
});

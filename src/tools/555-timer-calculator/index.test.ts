import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

const astable = (input: string, chip = "bipolar") => run(input, { mode: "astable", chip });
const monostable = (input: string, chip = "bipolar") => run(input, { mode: "monostable", chip });

describe("555-timer-calculator: astable mode", () => {
  it("computes frequency, period, high/low time, and duty from r1, r2, c", () => {
    const out = astable("r1=10k r2=4.7k c=10n");
    expect(out.Frequency).toBe("7.44 kHz");
    expect(out.Period).toBe("134 us");
    expect(out["High time"]).toBe("102 us");
    expect(out["Low time"]).toBe("32.6 us");
    expect(out["Duty cycle"]).toBe("75.77%");
    expect(out.R1).toBe("10.0 kohm");
    expect(out.R2).toBe("4.70 kohm");
    expect(out.C).toBe("10.0 nF");
    expect(out.Formula).toBe("Thigh = 0.693 x (R1+R2) x C; Tlow = 0.693 x R2 x C");
  });

  it("reports the CMOS vs bipolar chip note", () => {
    const bipolar = astable("r1=10k r2=4.7k c=10n", "bipolar");
    expect(bipolar["Chip note"]).toMatch(/NE555/);
    const cmos = astable("r1=10k r2=4.7k c=10n", "cmos");
    expect(cmos["Chip note"]).toMatch(/CMOS/);
  });

  it("solves R1 and R2 for a target frequency and duty cycle, defaulting C", () => {
    const out = astable("freq=1k duty=60");
    expect(out.Assumption).toMatch(/10 nF/);
    expect(out["Achieved duty cycle"]).toMatch(/^6\d\.\d\d%$/);
    const achievedFreq = Number(out["Achieved frequency"].split(" ")[0]);
    expect(achievedFreq).toBeGreaterThan(0.5);
    expect(achievedFreq).toBeLessThan(2);
  });

  it("solves R1 and R2 for a target frequency and duty cycle with a given C", () => {
    const out = astable("freq=1k duty=60 c=10n");
    expect(out.Assumption).toBeUndefined();
    expect(out.C).toBe("10.0 nF");
    expect(out["Exact R1"]).toBeDefined();
    expect(out["Nearest E24 R1"]).toBeDefined();
    expect(out["Exact R2"]).toBeDefined();
    expect(out["Nearest E24 R2"]).toBeDefined();
  });

  it("warns when R2 falls below 1 kohm", () => {
    const out = astable("r1=200 r2=200 c=100n");
    expect(out.Note).toMatch(/1 kohm/);
  });

  it("does not warn when R2 is at or above 1 kohm", () => {
    const out = astable("r1=10k r2=4.7k c=10n");
    expect(out.Note).toBeUndefined();
  });

  it("throws impossible for a target duty cycle of 50 percent or less", () => {
    try {
      astable("freq=1k duty=50");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("impossible");
      expect((e as ToolError).message).toMatch(/cannot produce a duty cycle/);
    }

    try {
      astable("freq=1k duty=30");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("impossible");
    }
  });

  it("throws impossible for a target duty cycle of 100 percent or more", () => {
    try {
      astable("freq=1k duty=100");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("impossible");
      expect((e as ToolError).message).toMatch(/less than 100 percent/);
    }
  });

  it("throws missing-values when neither r1/r2/c nor freq/duty are fully given", () => {
    try {
      astable("r1=10k");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("missing-values");
    }

    try {
      astable("freq=1k");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("missing-values");
    }
  });

  it("throws impossible for a non-positive resistor or capacitor", () => {
    try {
      astable("r1=-10k r2=4.7k c=10n");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("impossible");
    }
  });
});

describe("555-timer-calculator: monostable mode", () => {
  it("computes pulse width from r and c", () => {
    const out = monostable("r=100k c=100n");
    expect(out["Pulse width"]).toBe("11.0 ms");
    expect(out.R).toBe("100 kohm");
    expect(out.C).toBe("100 nF");
    expect(out.Formula).toBe("W = 1.0986 x R x C (ln(3) x R x C)");
  });

  it("solves C for a target pulse width given r", () => {
    const out = monostable("r=100k w=10m");
    expect(out.R).toBe("100 kohm");
    expect(out["Exact C"]).toBeDefined();
    expect(out["Nearest E24 C"]).toBeDefined();
    const achieved = Number(out["Achieved pulse width"].split(" ")[0]);
    expect(achieved).toBeGreaterThan(9);
    expect(achieved).toBeLessThan(11);
  });

  it("solves R for a target pulse width given c", () => {
    const out = monostable("c=100n w=10m");
    expect(out.C).toBe("100 nF");
    expect(out["Exact R"]).toBeDefined();
    expect(out["Nearest E24 R"]).toBeDefined();
  });

  it("defaults C to 100 nF and solves R when neither is given", () => {
    const out = monostable("w=10m");
    expect(out.Assumption).toMatch(/100 nF/);
    expect(out.C).toMatch(/^100(\.0)? nF$/);
    expect(out["Exact R"]).toBeDefined();
  });

  it("reports the chip note and sketch", () => {
    const out = monostable("r=100k c=100n");
    expect(out["Chip note"]).toMatch(/NE555/);
    expect(out.Sketch).toContain("pin2 = trigger");
  });

  it("throws missing-values when neither r/c nor w are fully given", () => {
    try {
      monostable("r=100k");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("missing-values");
    }
  });

  it("throws impossible for a non-positive r, c, or w", () => {
    try {
      monostable("r=-100k c=100n");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("impossible");
    }
    try {
      monostable("w=-10m");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("impossible");
    }
  });
});

describe("555-timer-calculator: shared input handling", () => {
  it("throws empty-input for blank input", () => {
    try {
      astable("");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("throws bad-token for an unrecognized key", () => {
    try {
      astable("foo=5");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-token");
      expect((e as ToolError).message).toContain("foo");
    }
  });

  it("throws bad-token for an unparseable number", () => {
    try {
      astable("r1=abc r2=4.7k c=10n");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-token");
    }
  });

  it("throws bad-option for an unrecognized mode or chip", () => {
    try {
      run("r1=10k r2=4.7k c=10n", { mode: "weird", chip: "bipolar" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-option");
    }

    try {
      run("r1=10k r2=4.7k c=10n", { mode: "astable", chip: "weird" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-option");
    }
  });
});

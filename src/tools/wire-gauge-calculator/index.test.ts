import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

const lookup = (input: string) => run(input, { mode: "lookup" });
const drop = (input: string) => run(input, { mode: "voltage-drop" });
const sizeFor = (input: string) => run(input, { mode: "size-for" });

function getCode(fn: () => unknown): string {
  try {
    fn();
    throw new Error("expected throw");
  } catch (e) {
    if (e instanceof ToolError) return e.code;
    throw e;
  }
}

describe("wire-gauge-calculator: lookup mode", () => {
  it("looks up 12 AWG (explicit unit)", () => {
    const out = lookup("12 awg");
    expect(out["Gauge"]).toBe("12 AWG");
    const diameter = Number(out["Diameter"].match(/^([\d.]+) mm/)![1]);
    expect(diameter).toBeCloseTo(2.053, 2);
    const area = Number(out["Area"].match(/^([\d.]+) mm2/)![1]);
    expect(area).toBeCloseTo(3.31, 1);
    const rCu = Number(out["Resistance (copper, 20C)"].match(/^([\d.]+) ohm\/km/)![1]);
    expect(rCu).toBeCloseTo(5.21, 1);
    expect(out["Ampacity, NEC 310.16 copper (60C / 75C / 90C)"]).toBe("20 A / 25 A / 30 A");
    expect(out["Ampacity, NEC 310.16 aluminum (75C)"]).toBe("20 A");
  });

  it("looks up 12 AWG via bare number default and via 12awg suffix identically", () => {
    const a = lookup("12");
    const b = lookup("12awg");
    expect(a).toEqual(b);
    expect(a["Gauge"]).toBe("12 AWG");
  });

  it("looks up 4/0 (and 0000) with exact circular mils", () => {
    const a = lookup("4/0");
    const b = lookup("0000");
    expect(a).toEqual(b);
    expect(a["Gauge"]).toBe("4/0 AWG");
    const area = Number(a["Area"].match(/^([\d.]+) mm2 \((\d+) cmil\)/)![1]);
    const cmils = Number(a["Area"].match(/\((\d+) cmil\)/)![1]);
    expect(area).toBeCloseTo(107.22, 1);
    expect(cmils).toBe(211600);
    expect(a["Ampacity, NEC 310.16 copper (60C / 75C / 90C)"]).toBe("195 A / 230 A / 260 A");
    expect(a["Ampacity, NEC 310.16 aluminum (75C)"]).toBe("180 A");
  });

  it("has no chassis-wiring row for a code-sized gauge and has one for a small gauge", () => {
    const twelve = lookup("12 awg");
    expect(twelve["Chassis wiring reference (hobbyist, not code)"]).toBeUndefined();

    const twentytwo = lookup("22 awg");
    expect(twentytwo["Chassis wiring reference (hobbyist, not code)"]).toBe(
      "7 A open-air chassis wiring / 0.92 A continuous power transmission",
    );
  });

  it("looks up a metric size and reports the nearest AWG with a US-equivalent hedge near 2.5 mm2", () => {
    const out = lookup("2.5 mm2");
    expect(out["Size"]).toBe("2.5 mm2");
    expect(out["Nearest AWG"]).toContain("13 AWG");
    expect(out["Nearest AWG"]).toContain("14 AWG");
  });

  it("looks up a bare decimal as metric mm2", () => {
    const a = lookup("2.5");
    const b = lookup("2.5mm2");
    expect(a).toEqual(b);
  });

  it("reports a metric-only tool with an ampacity hedge", () => {
    const out = lookup("2.5 mm2");
    expect(out["Approximate ampacity (IEC-style reference)"]).toContain("A near the 2.5 mm2 standard size");
    expect(out["Ampacity note"]).toMatch(/IEC 60364/);
  });

  it("reports a gauge outside the NEC reference range", () => {
    const out = lookup("30 awg");
    expect(out["Ampacity, NEC 310.16"]).toMatch(/Outside the common/);
  });

  it("throws empty-input for blank input", () => {
    expect(getCode(() => lookup(""))).toBe("empty-input");
    expect(getCode(() => lookup("   "))).toBe("empty-input");
  });

  it("throws unknown-gauge for an out-of-range or unrecognized size", () => {
    expect(getCode(() => lookup("99 awg"))).toBe("unknown-gauge");
    expect(getCode(() => lookup("banana"))).toBe("unknown-gauge");
  });
});

describe("wire-gauge-calculator: voltage-drop mode", () => {
  it("computes voltage drop and percent for 12 AWG copper DC/single-phase, and fails the 3% guidance", () => {
    const out = drop("20A 30m 12awg 120V copper dc");
    expect(out.Wire).toBe("12 AWG");
    expect(out.Material).toBe("copper");
    expect(Number(out["Voltage drop"].replace(" V", ""))).toBeCloseTo(6.25, 2);
    expect(Number(out["Percent drop"].replace("%", ""))).toBeCloseTo(5.21, 2);
    expect(out.Verdict).toMatch(/exceeds/);
  });

  it("defaults to copper and DC/single-phase when material and phase are omitted", () => {
    const withDefaults = drop("20A 30m 12awg 120V");
    const explicit = drop("20A 30m 12awg 120V copper dc");
    expect(withDefaults).toEqual(explicit);
  });

  it("accepts key=value syntax identically to bare unit tokens", () => {
    const bare = drop("20A 30m 12awg 120V copper dc");
    const kv = drop("current=20 length=30m gauge=12awg voltage=120 material=copper phase=dc");
    expect(bare).toEqual(kv);
  });

  it("applies the sqrt(3) three-phase factor instead of the round-trip factor of 2", () => {
    const single = drop("20A 30m 12awg 120V copper dc");
    const three = drop("20A 30m 12awg 120V copper ac3");
    const vSingle = Number(single["Voltage drop"].replace(" V", ""));
    const vThree = Number(three["Voltage drop"].replace(" V", ""));
    expect(vThree / vSingle).toBeCloseTo(Math.sqrt(3) / 2, 3);
    expect(three.Circuit).toBe("three-phase");
  });

  it("converts feet to meters for length", () => {
    const meters = drop("20A 30m 12awg 120V");
    const feet = drop(`20A ${30 / 0.3048}ft 12awg 120V`);
    expect(Number(feet["Voltage drop"].replace(" V", ""))).toBeCloseTo(Number(meters["Voltage drop"].replace(" V", "")), 2);
  });

  it("throws missing-values naming what is missing", () => {
    try {
      drop("20A 30m 120V");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("missing-values");
      expect((e as ToolError).message).toContain("gauge");
    }
  });

  it("throws bad-token for an unparseable value", () => {
    expect(getCode(() => drop("current=abc 30m 12awg 120V"))).toBe("bad-token");
  });

  it("throws unknown-gauge for an out-of-range gauge", () => {
    expect(getCode(() => drop("20A 30m 99awg 120V"))).toBe("unknown-gauge");
  });

  it("throws impossible for a non-positive value", () => {
    expect(getCode(() => drop("0A 30m 12awg 120V"))).toBe("impossible");
  });

  it("throws empty-input for blank input", () => {
    expect(getCode(() => drop(""))).toBe("empty-input");
  });
});

describe("wire-gauge-calculator: size-for mode", () => {
  it("finds 8 AWG as the smallest gauge satisfying ampacity and a 3% drop limit for 20A over 30m at 120V", () => {
    const out = sizeFor("20A 30m 120V");
    expect(out["Recommended gauge"]).toBe("8 AWG");
    expect(out["Ampacity constraint"]).toContain("pass");
    expect(out["Voltage drop constraint"]).toContain("pass");
  });

  it("agrees with directly computed drop percentages: 10 AWG fails, 8 AWG passes", () => {
    const tenAwgDrop = drop("20A 30m 10awg 120V");
    const eightAwgDrop = drop("20A 30m 8awg 120V");
    expect(Number(tenAwgDrop["Percent drop"].replace("%", ""))).toBeGreaterThan(3);
    expect(Number(eightAwgDrop["Percent drop"].replace("%", ""))).toBeLessThanOrEqual(3);
  });

  it("respects an explicit maxdrop and can require a larger gauge", () => {
    const loose = sizeFor("20A 30m 120V maxdrop=6");
    const strict = sizeFor("20A 30m 120V maxdrop=1");
    expect(loose["Recommended gauge"]).toBe("12 AWG");
    expect(strict["Recommended gauge"]).toBe("4 AWG");
  });

  it("throws missing-values naming what is missing", () => {
    try {
      sizeFor("30m 120V");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("missing-values");
      expect((e as ToolError).message).toContain("current");
    }
  });

  it("throws impossible when no gauge up to 4/0 satisfies the requirements, naming the largest tried", () => {
    try {
      sizeFor("1000A 30m 120V");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("impossible");
      expect((e as ToolError).message).toContain("4/0");
    }
  });

  it("throws bad-token for an unrecognized key", () => {
    expect(getCode(() => sizeFor("current=20 length=30m voltage=120 bogus=5"))).toBe("bad-token");
  });

  it("throws empty-input for blank input", () => {
    expect(getCode(() => sizeFor(""))).toBe("empty-input");
  });
});

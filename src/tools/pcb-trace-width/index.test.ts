import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

const widthFor = (input: string, layer = "external", copperWeight = "1") =>
  run(input, { mode: "width-for-current", layer, copperWeight });
const currentFor = (input: string, layer = "external", copperWeight = "1") =>
  run(input, { mode: "current-for-width", layer, copperWeight });

function getCode(fn: () => unknown): string {
  try {
    fn();
    throw new Error("expected throw");
  } catch (e) {
    if (e instanceof ToolError) return e.code;
    throw e;
  }
}

describe("pcb-trace-width: width-for-current mode", () => {
  it("computes required width for 3A at the default 10C rise, external, 1oz", () => {
    const out = widthFor("current=3");
    expect(out["Required width (mil)"]).toBe("50.11 mil");
    expect(out["Required width (mm)"]).toBe("1.2727 mm");
    expect(out["Cross-section area"]).toBe("69.0 mil2");
    expect(out["Copper thickness"]).toBe("1 oz (1.378 mil)");
    expect(out["Layer"]).toBe("external");
    expect(out["Temperature rise used"]).toBe("10 C (default)");
    expect(out["Resistance per length"]).toBe("387 mohm/m (9.83 mohm/in)");
  });

  it("does not mark temperature rise as default when given explicitly", () => {
    const out = widthFor("current=3 temprise=10");
    expect(out["Temperature rise used"]).toBe("10 C");
  });

  it("includes the IPC-2221 formula note and the IPC-2152 hedge", () => {
    const out = widthFor("current=3");
    expect(out["Note"]).toMatch(/20C/);
    expect(out["Note"]).toMatch(/0.393/);
    expect(out["IPC-2152 note"]).toMatch(/IPC-2152/);
    expect(out["IPC-2152 note"]).toMatch(/wider traces/);
  });

  it("includes a reference table from 0.5A to 10A", () => {
    const out = widthFor("current=3");
    expect(out["Table: 0.5 A"]).toBeDefined();
    expect(out["Table: 1 A"]).toBeDefined();
    expect(out["Table: 10 A"]).toBeDefined();
    expect(out["Table: 3 A"]).toMatch(/^50\.1 mil/);
  });

  it("requires more width for an internal trace than an external trace at the same current", () => {
    const ext = widthFor("current=3");
    const int = widthFor("current=3", "internal");
    const extWidth = Number(ext["Required width (mil)"].replace(" mil", ""));
    const intWidth = Number(int["Required width (mil)"].replace(" mil", ""));
    expect(intWidth).toBeGreaterThan(extWidth);
  });

  it("adds resistance, voltage drop, and power loss rows when a length is given", () => {
    const out = widthFor("current=3 length=0.1m");
    expect(out["Trace length"]).toBe("0.1000 m (0.328 ft)");
    expect(out["Total resistance"]).toBe("38.7 mohm");
    expect(out["Voltage drop"]).toBe("116 mV");
    expect(out["Power loss"]).toBe("348 mW");
  });

  it("omits length rows when no length is given", () => {
    const out = widthFor("current=3");
    expect(out["Trace length"]).toBeUndefined();
    expect(out["Voltage drop"]).toBeUndefined();
  });

  it("throws missing-values when current is absent", () => {
    expect(getCode(() => widthFor("temprise=10"))).toBe("missing-values");
  });

  it("throws impossible for a non-positive current", () => {
    expect(getCode(() => widthFor("current=0"))).toBe("impossible");
    expect(getCode(() => widthFor("current=-3"))).toBe("impossible");
  });

  it("throws impossible for a non-positive temprise", () => {
    expect(getCode(() => widthFor("current=3 temprise=0"))).toBe("impossible");
  });

  it("throws impossible for a non-positive length", () => {
    expect(getCode(() => widthFor("current=3 length=0"))).toBe("impossible");
  });

  it("throws bad-token for an unrecognized key", () => {
    expect(getCode(() => widthFor("current=3 bogus=5"))).toBe("bad-token");
  });

  it("throws bad-token for an unparseable number", () => {
    expect(getCode(() => widthFor("current=abc"))).toBe("bad-token");
  });

  it("throws bad-option for an unrecognized layer", () => {
    expect(getCode(() => widthFor("current=3", "sideways"))).toBe("bad-option");
  });

  it("throws bad-option for an unrecognized copper weight", () => {
    expect(getCode(() => widthFor("current=3", "external", "3"))).toBe("bad-option");
  });

  it("throws empty-input for blank input", () => {
    expect(getCode(() => widthFor(""))).toBe("empty-input");
    expect(getCode(() => widthFor("   "))).toBe("empty-input");
  });
});

describe("pcb-trace-width: current-for-width mode", () => {
  it("computes max current for a 20 mil trace at the default 10C rise, external, 1oz", () => {
    const out = currentFor("width=20mil");
    expect(out["Maximum current"]).toBe("1.617 A");
    expect(out["Width used"]).toBe("20.00 mil (0.5080 mm)");
    expect(out["Cross-section area"]).toBe("27.6 mil2");
    expect(out["Temperature rise used"]).toBe("10 C (default)");
  });

  it("defaults width to mils when no unit is given, and accepts an explicit mm width", () => {
    const bare = currentFor("width=20");
    const mil = currentFor("width=20mil");
    expect(bare).toEqual(mil);

    const mm = currentFor("width=0.508mm");
    expect(Number(mm["Maximum current"].replace(" A", ""))).toBeCloseTo(
      Number(mil["Maximum current"].replace(" A", "")),
      2,
    );
  });

  it("allows less current for an internal trace than an external trace at the same width", () => {
    const ext = currentFor("width=20mil");
    const int = currentFor("width=20mil", "internal");
    const extCurrent = Number(ext["Maximum current"].replace(" A", ""));
    const intCurrent = Number(int["Maximum current"].replace(" A", ""));
    expect(intCurrent).toBeLessThan(extCurrent);
  });

  it("adds resistance, voltage drop, and power loss rows when a length is given", () => {
    const out = currentFor("width=20mil length=0.1m");
    expect(out["Trace length"]).toBe("0.1000 m (0.328 ft)");
    expect(out["Voltage drop"]).toBeDefined();
    expect(out["Power loss"]).toBeDefined();
    expect(out["Total resistance"]).toBeDefined();
  });

  it("includes a reference table from 0.5A to 10A", () => {
    const out = currentFor("width=20mil");
    expect(out["Table: 0.5 A"]).toBeDefined();
    expect(out["Table: 10 A"]).toBeDefined();
  });

  it("throws missing-values when width is absent", () => {
    expect(getCode(() => currentFor("temprise=10"))).toBe("missing-values");
  });

  it("throws impossible for a non-positive width", () => {
    expect(getCode(() => currentFor("width=0"))).toBe("impossible");
    expect(getCode(() => currentFor("width=-5mil"))).toBe("impossible");
  });

  it("throws bad-token for an unparseable width", () => {
    expect(getCode(() => currentFor("width=abc"))).toBe("bad-token");
  });

  it("throws bad-option for an unrecognized copper weight", () => {
    expect(getCode(() => currentFor("width=20mil", "external", "5"))).toBe("bad-option");
  });

  it("throws empty-input for blank input", () => {
    expect(getCode(() => currentFor(""))).toBe("empty-input");
  });
});

describe("pcb-trace-width: shared parsing", () => {
  it("throws bad-token for a bare token with no key", () => {
    expect(getCode(() => widthFor("3"))).toBe("bad-token");
  });

  it("throws bad-option for an unrecognized mode", () => {
    expect(
      getCode(() => run("current=3", { mode: "sideways", layer: "external", copperWeight: "1" })),
    ).toBe("bad-option");
  });
});

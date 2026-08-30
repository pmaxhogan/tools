import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { run, __test__ } from "./index";

const { dbuVFromVrms, vrmsFromDbuV } = __test__;

const optsFor = (impedance = "50") => ({ impedance }) as never;

describe("dbm-watts-volts: dBm input", () => {
  it("converts 0 dBm to 1 mW", () => {
    const out = run("0dBm", optsFor());
    expect(out["Power"]).toBe("1.000 mW");
    expect(out["dBW"]).toBe("-30.000 dBW");
  });

  it("converts 30 dBm to 1 W and the correct Vrms at 50 ohm", () => {
    const out = run("30dBm", optsFor("50"));
    expect(out["Power"]).toBe("1.000 W");
    const vrms = parseFloat(out["Vrms"]);
    expect(vrms).toBeCloseTo(Math.sqrt(50), 3);
  });

  it("uses the selected reference impedance for Vrms", () => {
    const at50 = run("30dBm", optsFor("50"));
    const at75 = run("30dBm", optsFor("75"));
    expect(parseFloat(at75["Vrms"])).toBeGreaterThan(parseFloat(at50["Vrms"]));
  });
});

describe("dbm-watts-volts: watts and milliwatts", () => {
  it("parses SI prefixed watts", () => {
    expect(run("1W", optsFor())["dBm"]).toBe("30.000 dBm");
    expect(run("100mW", optsFor())["dBm"]).toBe("20.000 dBm");
    expect(run("1uW", optsFor())["dBm"]).toBe("-30.000 dBm");
  });

  it("throws on non-positive watts", () => {
    expect(() => run("0W", optsFor())).toThrow(ToolError);
    expect(() => run("-1W", optsFor())).toThrow(ToolError);
  });
});

describe("dbm-watts-volts: voltage input", () => {
  it("converts Vrms to the correct power at 50 ohm", () => {
    const out = run(`${Math.sqrt(50)}Vrms`, optsFor("50"));
    expect(parseFloat(out["Power"])).toBeCloseTo(1, 2);
  });

  it("converts Vpp to a smaller Vrms figure", () => {
    const out = run("10Vpp", optsFor());
    const vrms = parseFloat(out["Vrms"]);
    expect(vrms).toBeCloseTo(10 / (2 * Math.SQRT2), 3);
  });

  it("throws on non-positive voltage", () => {
    expect(() => run("0Vrms", optsFor())).toThrow(ToolError);
  });
});

describe("dbm-watts-volts: dBuV input and round trips", () => {
  it("round trips dBuV through Vrms exactly, and the tool agrees on 120 dBuV", () => {
    expect(dbuVFromVrms(vrmsFromDbuV(120))).toBeCloseTo(120, 6);
    const out = run("120dBuV", optsFor());
    expect(parseFloat(out["dBuV"])).toBeCloseTo(120, 1);
  });

  it("reports dBW as 30 dB below dBm for the same power", () => {
    const out = run("40dBm", optsFor());
    expect(parseFloat(out["dBm"]) - parseFloat(out["dBW"])).toBeCloseTo(30, 3);
  });
});

describe("dbm-watts-volts: errors and reference table", () => {
  it("throws on empty input", () => {
    expect(() => run("", optsFor())).toThrow(ToolError);
  });

  it("throws when no recognizable unit is present", () => {
    expect(() => run("42", optsFor())).toThrow(ToolError);
  });

  it("throws on an unparseable number", () => {
    expect(() => run("abcdBm", optsFor())).toThrow(ToolError);
  });

  it("includes a reference table of common values", () => {
    const out = run("0dBm", optsFor());
    expect(out["Reference table"]).toContain("30 dBm");
    expect(out["Reference table"]).toContain("dBm =");
  });

  it("defaults to 50 ohm when an unrecognized impedance is given", () => {
    const out = run("0dBm", { impedance: "999" } as never);
    expect(out["Reference impedance"]).toBe("50 ohm");
  });
});

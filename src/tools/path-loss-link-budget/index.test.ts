import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { run } from "./index";

const optsFor = (distanceUnit = "km") => ({ distanceUnit }) as never;

describe("path-loss-link-budget: FSPL only", () => {
  it("computes free space path loss for a well known figure (2.4 GHz at 1 km)", () => {
    const out = run("2.4 GHz 1 km", optsFor());
    // Standard reference value: FSPL(2.4GHz, 1km) ~= 100.05 dB
    const loss = parseFloat(out["Free space path loss"]);
    expect(loss).toBeGreaterThan(99.5);
    expect(loss).toBeLessThan(100.6);
  });

  it("accepts key=value syntax and combined number+unit tokens", () => {
    const a = run("freq=915MHz distance=5km", optsFor());
    const b = run("915MHz 5km", optsFor());
    expect(a["Free space path loss"]).toBe(b["Free space path loss"]);
  });

  it("reports FSPL reference values at 1km and 10km", () => {
    const out = run("915MHz 5km", optsFor());
    expect(out["FSPL at 1 km"]).toContain("dB");
    expect(out["FSPL at 10 km"]).toContain("dB");
  });

  it("path loss increases by about 20dB for a 10x distance increase", () => {
    const out = run("915MHz 5km", optsFor());
    const at1 = parseFloat(out["FSPL at 1 km"]);
    const at10 = parseFloat(out["FSPL at 10 km"]);
    expect(at10 - at1).toBeCloseTo(20, 0);
  });

  it("formats distance in the requested unit", () => {
    const out = run("915MHz 5km", optsFor("mi"));
    expect(out["Distance"]).toContain("mi");
  });
});

describe("path-loss-link-budget: full link budget", () => {
  it("computes EIRP, received power, fade margin, and a pass verdict", () => {
    const out = run(
      "freq=915MHz distance=2km txpower=20dBm txgain=6 rxgain=6 cableloss=1 sensitivity=-100dBm",
      optsFor(),
    );
    expect(out["EIRP"]).toBe("25.00 dBm");
    expect(out["Received power"]).toBeDefined();
    expect(out["Fade margin"]).toBeDefined();
    expect(out["Link"]).toMatch(/Passes|Fails/);
  });

  it("reports a fail when the fade margin is negative", () => {
    const out = run(
      "freq=5800MHz distance=50km txpower=10dBm txgain=0 rxgain=0 cableloss=0 sensitivity=-90dBm",
      optsFor(),
    );
    expect(out["Link"]).toContain("Fails");
  });

  it("defaults gains and cable loss to zero when omitted", () => {
    const out = run("freq=915MHz distance=1km txpower=20dBm sensitivity=-100dBm", optsFor());
    expect(out["TX antenna gain"]).toBe("0.00 dBi");
    expect(out["Cable / feedline loss"]).toBe("0.00 dB");
  });

  it("accepts transmit power in watts", () => {
    const out = run("freq=915MHz distance=1km txpower=1W sensitivity=-100dBm", optsFor());
    expect(out["TX power"]).toBe("30.00 dBm");
  });
});

describe("path-loss-link-budget: errors", () => {
  it("throws on empty input", () => {
    expect(() => run("", optsFor())).toThrow(ToolError);
  });

  it("throws when frequency is missing", () => {
    expect(() => run("5km", optsFor())).toThrow(ToolError);
  });

  it("throws when distance is missing", () => {
    expect(() => run("915MHz", optsFor())).toThrow(ToolError);
  });

  it("throws when a link budget is missing the sensitivity", () => {
    expect(() => run("915MHz 5km txpower=20dBm", optsFor())).toThrow(ToolError);
  });

  it("throws when a link budget is missing the transmit power", () => {
    expect(() => run("915MHz 5km sensitivity=-100dBm", optsFor())).toThrow(ToolError);
  });

  it("throws on an unparseable frequency or distance", () => {
    expect(() => run("freq=abcMHz distance=5km", optsFor())).toThrow(ToolError);
    expect(() => run("freq=915MHz distance=abckm", optsFor())).toThrow(ToolError);
  });
});

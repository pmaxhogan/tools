import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { run, __test__ } from "./index";

const { interpolateLoss, CABLES } = __test__;

const optsFor = (cable = "rg8x", compareAll = false) => ({ cable, compareAll }) as never;

describe("coax-cable-loss: table lookup and interpolation", () => {
  it("returns the exact table value at a tabulated frequency", () => {
    const spec = CABLES.lmr400;
    expect(interpolateLoss(spec, 450)).toBeCloseTo(2.7, 5);
    expect(interpolateLoss(spec, 900)).toBeCloseTo(3.9, 5);
  });

  it("interpolates between two tabulated points for an in-between frequency", () => {
    const spec = CABLES.lmr400;
    const at450 = interpolateLoss(spec, 450);
    const at900 = interpolateLoss(spec, 900);
    const mid = interpolateLoss(spec, 636); // sqrt(450*900), the log-log midpoint
    expect(mid).toBeGreaterThan(Math.min(at450, at900));
    expect(mid).toBeLessThan(Math.max(at450, at900));
  });

  it("extrapolates below the lowest and above the highest tabulated frequency", () => {
    const spec = CABLES.rg8x;
    expect(interpolateLoss(spec, 10)).toBeGreaterThan(0);
    expect(interpolateLoss(spec, 10000)).toBeGreaterThan(interpolateLoss(spec, 5800));
  });
});

describe("coax-cable-loss: single cable calculation", () => {
  it("computes total loss over a length from the per 100ft figure", () => {
    const out = run("100ft 450MHz", optsFor("lmr400"));
    expect(out["Attenuation at this frequency"]).toContain("2.700");
    expect(out["Total loss over this length"]).toBe("2.70 dB");
  });

  it("scales loss linearly with length", () => {
    const short = run("50ft 450MHz", optsFor("lmr400"));
    const long = run("200ft 450MHz", optsFor("lmr400"));
    const shortLoss = parseFloat(short["Total loss over this length"]);
    const longLoss = parseFloat(long["Total loss over this length"]);
    expect(longLoss).toBeCloseTo(shortLoss * 4, 1);
  });

  it("computes power delivered and percent lost when input power is given", () => {
    const out = run("100ft 450MHz power=5W", optsFor("lmr400"));
    expect(out["Input power"]).toBe("5.000 W");
    const delivered = parseFloat(out["Power delivered to the load"]);
    expect(delivered).toBeLessThan(5);
    expect(delivered).toBeGreaterThan(0);
    expect(parseFloat(out["Percent of power lost"])).toBeGreaterThan(0);
  });

  it("accepts power given in dBm", () => {
    const out = run("100ft 450MHz power=37dBm", optsFor("lmr400"));
    expect(parseFloat(out["Input power"])).toBeCloseTo(5.012, 1);
  });

  it("thinner cable loses more than thicker cable at the same length and frequency", () => {
    const thin = run("100ft 450MHz", optsFor("rg58"));
    const thick = run("100ft 450MHz", optsFor("lmr400"));
    expect(parseFloat(thin["Total loss over this length"])).toBeGreaterThan(
      parseFloat(thick["Total loss over this length"]),
    );
  });
});

describe("coax-cable-loss: compare all cables", () => {
  it("lists every cable sorted from lowest to highest loss", () => {
    const out = run("100ft 450MHz", optsFor("rg8x", true));
    const labels = Object.keys(out).filter(
      (k) => k !== "Frequency" && k !== "Length" && k !== "Note",
    );
    expect(labels.length).toBe(Object.keys(CABLES).length);
    const losses = labels.map((label) => parseFloat(out[label]));
    for (let i = 1; i < losses.length; i++) {
      expect(losses[i]).toBeGreaterThanOrEqual(losses[i - 1]);
    }
  });
});

describe("coax-cable-loss: errors", () => {
  it("throws on empty input", () => {
    expect(() => run("", optsFor())).toThrow(ToolError);
  });

  it("throws when frequency is missing", () => {
    expect(() => run("100ft", optsFor())).toThrow(ToolError);
  });

  it("throws when length is missing", () => {
    expect(() => run("450MHz", optsFor())).toThrow(ToolError);
  });

  it("throws on an unknown cable type", () => {
    expect(() => run("100ft 450MHz", optsFor("not-a-cable"))).toThrow(ToolError);
  });

  it("throws on an unparseable power token", () => {
    expect(() => run("100ft 450MHz power=abc", optsFor("lmr400"))).toThrow(ToolError);
  });
});

import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { run } from "./index";

const optsFor = (kFactor = "4/3") => ({ kFactor }) as never;

describe("fresnel-zone", () => {
  it("computes the first Fresnel zone radius at the midpoint for a well known figure", () => {
    // 5.8GHz, 10km link: wavelength ~5.17cm, r = sqrt(0.0517 * 5000 * 5000 / 10000) ~= 11.36 m
    const out = run("5.8GHz 10km", optsFor());
    const radius = parseFloat(out["First Fresnel zone radius at midpoint"]);
    expect(radius).toBeGreaterThan(11);
    expect(radius).toBeLessThan(11.7);
  });

  it("reports the 60% clearance target as 60% of the full radius", () => {
    const out = run("5.8GHz 10km", optsFor());
    const radius = parseFloat(out["First Fresnel zone radius at midpoint"]);
    const clearance = parseFloat(out["60% clearance target at midpoint"]);
    expect(clearance).toBeCloseTo(radius * 0.6, 1);
  });

  it("computes earth bulge and increases with k=1 versus k=4/3", () => {
    const withK43 = run("915MHz 20km", optsFor("4/3"));
    const withK1 = run("915MHz 20km", optsFor("1"));
    const bulge43 = parseFloat(withK43["Earth bulge at midpoint"]);
    const bulge1 = parseFloat(withK1["Earth bulge at midpoint"]);
    expect(bulge1).toBeGreaterThan(bulge43);
  });

  it("computes an obstacle point off-center and required clearance", () => {
    const out = run("freq=5.8GHz distance=10km obstacle=3km", optsFor());
    expect(out["First Fresnel zone radius at obstacle"]).toBeDefined();
    expect(out["Required clearance above the obstacle top"]).toBeDefined();
  });

  it("computes a recommended antenna height given an obstacle height", () => {
    const out = run("freq=5.8GHz distance=10km obstacle=3km obstacleheight=15m", optsFor());
    const obstacleHeight = parseFloat(out["Obstacle height"]);
    const recommended = parseFloat(out["Recommended antenna height at the obstacle"]);
    expect(recommended).toBeGreaterThan(obstacleHeight);
  });

  it("accepts bare tokens without an explicit obstacle", () => {
    const out = run("2.4GHz 5km", optsFor());
    expect(out["First Fresnel zone radius at midpoint"]).toBeDefined();
    expect(out["First Fresnel zone radius at obstacle"]).toBeUndefined();
  });

  it("throws on empty input", () => {
    expect(() => run("", optsFor())).toThrow(ToolError);
  });

  it("throws when frequency is missing", () => {
    expect(() => run("10km", optsFor())).toThrow(ToolError);
  });

  it("throws when distance is missing", () => {
    expect(() => run("5.8GHz", optsFor())).toThrow(ToolError);
  });

  it("throws when the obstacle distance is outside the link", () => {
    expect(() => run("freq=5.8GHz distance=10km obstacle=15km", optsFor())).toThrow(ToolError);
    expect(() => run("freq=5.8GHz distance=10km obstacle=0km", optsFor())).toThrow(ToolError);
  });

  it("throws on an unrecognized key", () => {
    expect(() => run("freq=5.8GHz distance=10km bogus=1", optsFor())).toThrow(ToolError);
  });
});

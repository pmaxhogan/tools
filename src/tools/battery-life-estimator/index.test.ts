import { describe, expect, it } from "vitest";
import { formatDuration, run, type BatteryLifeOpts } from "./index";
import { ToolError } from "../types";

const base: BatteryLifeOpts = {
  capacity: 3000,
  capacityUnit: "mAh",
  voltage: 3.7,
  activeDraw: 500,
  drawUnit: "mA",
  sleepDraw: 5,
  sleepDrawUnit: "mA",
  activeHoursPerDay: 4,
  efficiency: 85,
};

describe("battery-life-estimator", () => {
  it("formats durations without leading zero units", () => {
    expect(formatDuration(6)).toBe("6h");
    expect(formatDuration(32)).toBe("1d 8h");
    expect(formatDuration(48)).toBe("2d 0h");
    expect(formatDuration(0.5)).toBe("30m");
    expect(formatDuration(Infinity)).toBe("Unlimited (no power draw)");
  });

  it("computes a known fully-active case exactly", () => {
    // 3000 mAh @ 3.7V, 100% efficiency = 11.1 Wh usable.
    // 500 mA @ 3.7V = 1.85 W active draw, active 24h/day -> 6h runtime exactly.
    const out = run("", {
      ...base,
      efficiency: 100,
      activeHoursPerDay: 24,
    });
    expect(out["Usable energy"]).toBe("11.10 Wh (3000 mAh equivalent)");
    expect(out["Active power"]).toBe("1.850 W");
    expect(out["Estimated runtime"]).toBe("6h");
    expect(out["Continuous active"]).toBe("6h");
  });

  it("computes a hand-checked mixed active/sleep case in watt units", () => {
    // 24 Wh usable (100% efficiency), 2 W active for 4h, 0.5 W sleep for 20h.
    // Energy/day = 2*4 + 0.5*20 = 18 Wh/day -> runtime = 24/18 days = 32h = 1d 8h.
    // Continuous active = 24/2 = 12h. Continuous standby = 24/0.5 = 48h = 2d 0h.
    const out = run("", {
      capacity: 24,
      capacityUnit: "Wh",
      voltage: 3.7,
      activeDraw: 2,
      drawUnit: "W",
      sleepDraw: 0.5,
      sleepDrawUnit: "W",
      activeHoursPerDay: 4,
      efficiency: 100,
    });
    expect(out["Energy per day"]).toBe("18.00 Wh/day");
    expect(out["Estimated runtime"]).toBe("1d 8h");
    expect(out["Continuous active"]).toBe("12h");
    expect(out["Continuous standby"]).toBe("2d 0h");
    expect(out["Continuous standby"]).not.toBe(out["Continuous active"]);
  });

  it("treats zero draw as an unlimited continuous runtime", () => {
    const out = run("", { ...base, sleepDraw: 0, activeDraw: 0, activeHoursPerDay: 0 });
    expect(out["Continuous active"]).toBe("Unlimited (no power draw)");
    expect(out["Continuous standby"]).toBe("Unlimited (no power draw)");
    expect(out["Estimated runtime"]).toBe("Unlimited (no power draw)");
  });

  it("rejects non-positive capacity with a typed error", () => {
    expect(() => run("", { ...base, capacity: 0 })).toThrowError(ToolError);
    expect(() => run("", { ...base, capacity: 0 })).toThrowError(/positive/);
  });

  it("rejects non-positive voltage with a typed error", () => {
    expect(() => run("", { ...base, voltage: 0 })).toThrowError(ToolError);
  });

  it("rejects active hours outside 0-24", () => {
    expect(() => run("", { ...base, activeHoursPerDay: 25 })).toThrowError(ToolError);
    expect(() => run("", { ...base, activeHoursPerDay: -1 })).toThrowError(ToolError);
  });

  it("rejects efficiency outside 1-100", () => {
    expect(() => run("", { ...base, efficiency: 0 })).toThrowError(ToolError);
    expect(() => run("", { ...base, efficiency: 150 })).toThrowError(ToolError);
  });

  it("rejects negative draw values", () => {
    expect(() => run("", { ...base, activeDraw: -1 })).toThrowError(ToolError);
    expect(() => run("", { ...base, sleepDraw: -1 })).toThrowError(ToolError);
  });
});

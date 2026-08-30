import { describe, expect, it } from "vitest";
import {
  formatMoney,
  materialDensity,
  metersToGrams,
  parseSlicerSummary,
  priceBreakdown,
  run,
  type PrintCostOpts,
} from "./index";
import { ToolError } from "../types";

const base: PrintCostOpts = {
  grams: 25,
  meters: 0,
  material: "pla",
  customDensity: 1.24,
  filamentDiameter: 1.75,
  spoolPrice: 20,
  spoolGrams: 1000,
  hours: 2,
  minutes: 0,
  printerWatts: 120,
  kwhPrice: 0.15,
  currency: "USD",
  markupPercent: 0,
  failureRatePercent: 0,
  laborRate: 0,
  laborMinutes: 0,
  printerPrice: 0,
  printerLifeHours: 2000,
  postProcessingCost: 0,
};

describe("print-cost-calculator: metersToGrams", () => {
  it("converts 1 meter of 1.75mm PLA to about 2.98 grams", () => {
    expect(metersToGrams(1, 1.75, 1.24)).toBeCloseTo(2.98, 2);
  });

  it("scales linearly with length", () => {
    expect(metersToGrams(10, 1.75, 1.24)).toBeCloseTo(29.83, 1);
  });
});

describe("print-cost-calculator: materialDensity", () => {
  it("resolves known materials", () => {
    expect(materialDensity("pla", 1.24)).toBe(1.24);
    expect(materialDensity("petg", 1.24)).toBe(1.27);
    expect(materialDensity("resin", 1.24)).toBe(1.1);
  });

  it("uses the custom density for the custom material", () => {
    expect(materialDensity("custom", 2.5)).toBe(2.5);
  });

  it("throws for an unknown material id", () => {
    expect(() => materialDensity("adamantium", 1)).toThrowError(ToolError);
  });
});

describe("print-cost-calculator: priceBreakdown", () => {
  it("computes material cost for 25g at $20 per 1000g spool", () => {
    const b = priceBreakdown(25, 0, 0, base);
    expect(b.materialCost).toBeCloseTo(0.5, 5);
  });

  it("computes electricity cost for 3 hours at 120W and $0.15/kWh", () => {
    const b = priceBreakdown(25, 0, 3, base);
    expect(b.kwh).toBeCloseTo(0.36, 5);
    expect(b.electricityCost).toBeCloseTo(0.054, 5);
  });

  it("amortizes failure rate and applies markup on top of it", () => {
    // subtotal = 100 (materialCost only, isolated by zeroing every other rate).
    const opts = {
      spoolPrice: 1000,
      spoolGrams: 1000,
      printerWatts: 0,
      kwhPrice: 0,
      printerPrice: 0,
      printerLifeHours: 1000,
      laborRate: 0,
      laborMinutes: 0,
      postProcessingCost: 0,
      failureRatePercent: 20,
      markupPercent: 10,
    };
    const b = priceBreakdown(100, 0, 0, opts);
    expect(b.subtotal).toBeCloseTo(100, 5);
    expect(b.failureMultiplier).toBeCloseTo(1.25, 5);
    expect(b.failureAllowance).toBeCloseTo(25, 5);
    expect(b.markup).toBeCloseTo(12.5, 5);
    expect(b.total).toBeCloseTo(137.5, 5);
    expect(b.totalPerGram).toBeCloseTo(1.375, 5);
  });

  it("treats zero failure rate and zero markup as a no-op on the total", () => {
    const b = priceBreakdown(25, 0, 0, base);
    expect(b.total).toBeCloseTo(b.subtotal, 5);
  });
});

describe("print-cost-calculator: parseSlicerSummary", () => {
  it("parses a plain 'Filament used: Ng' line", () => {
    expect(parseSlicerSummary("Filament used: 23.4g")).toEqual({ grams: 23.4 });
  });

  it("parses a bare meters value", () => {
    expect(parseSlicerSummary("45.2m")).toEqual({ meters: 45.2 });
  });

  it("parses a plain printing time line", () => {
    expect(parseSlicerSummary("Estimated printing time: 3h 12m")).toEqual({
      hours: 3,
      minutes: 12,
    });
  });

  it("parses Cura's semicolon filament comment in meters", () => {
    expect(parseSlicerSummary(";Filament used: 12.3m")).toEqual({ meters: 12.3 });
  });

  it("parses Cura's ;TIME: seconds comment", () => {
    expect(parseSlicerSummary(";TIME:11520")).toEqual({ hours: 3, minutes: 12 });
  });

  it("parses PrusaSlicer's bracketed grams comment", () => {
    expect(parseSlicerSummary("; filament used [g] = 23.4")).toEqual({ grams: 23.4 });
  });

  it("parses PrusaSlicer's estimated printing time comment with seconds", () => {
    expect(parseSlicerSummary("; estimated printing time (normal mode) = 3h 12m 5s")).toEqual({
      hours: 3,
      minutes: 12,
    });
  });

  it("returns an empty object for text with no recognizable numbers", () => {
    expect(parseSlicerSummary("This slicer summary has no useful data.")).toEqual({});
  });
});

describe("print-cost-calculator: formatMoney", () => {
  it("formats with the given symbol and two decimals", () => {
    expect(formatMoney(0.5, "$")).toBe("$0.50");
    expect(formatMoney(137.5, "$")).toBe("$137.50");
  });

  it("never prints a signed zero", () => {
    expect(formatMoney(-1e-12, "$")).toBe("$0.00");
  });
});

describe("print-cost-calculator: run", () => {
  it("computes the default 25g PLA material cost at $20/kg", () => {
    const out = run("", { ...base, hours: 3 });
    expect(out["Material cost"]).toContain("$0.50");
  });

  it("computes the full total for a hand-checked case with every cost line active", () => {
    const out = run("", {
      ...base,
      grams: 100,
      spoolPrice: 25,
      spoolGrams: 1000,
      hours: 4,
      minutes: 30,
      printerWatts: 150,
      kwhPrice: 0.12,
      markupPercent: 20,
      failureRatePercent: 10,
      laborRate: 15,
      laborMinutes: 30,
      printerPrice: 300,
      printerLifeHours: 3000,
      postProcessingCost: 2,
    });
    expect(out.Total).toBe("$16.71");
  });

  it("derives grams from meters when grams is zero", () => {
    const out = run("", { ...base, grams: 0, meters: 10 });
    expect(out["Filament amount"]).toContain("29.8");
    expect(out["Filament amount"]).toContain("from 10.00 m");
  });

  it("prefers an explicit grams option over meters when both are set", () => {
    const out = run("", { ...base, grams: 25, meters: 999 });
    expect(out["Filament amount"]).toBe("25.00 g PLA");
  });

  it("prefills grams and print time from a pasted slicer summary", () => {
    const out = run("Filament used: 23.4g\nEstimated printing time: 3h 12m", {
      ...base,
      grams: 0,
    });
    expect(out["Filament amount"]).toBe("23.40 g PLA");
    expect(out["Machine wear"]).toBeDefined();
  });

  it("uses the requested currency symbol throughout", () => {
    const out = run("", { ...base, currency: "EUR" });
    expect(out.Total.startsWith("€")).toBe(true);
    expect(out["Material cost"]).toContain("€");
  });

  it("supports all five currencies", () => {
    for (const [code, symbol] of [
      ["USD", "$"],
      ["EUR", "€"],
      ["GBP", "£"],
      ["CAD", "CA$"],
      ["AUD", "AU$"],
    ] as const) {
      const out = run("", { ...base, currency: code });
      expect(out.Total.startsWith(symbol)).toBe(true);
    }
  });

  it("throws bad-option for an out-of-range grams value", () => {
    expect(() => run("", { ...base, grams: -1 })).toThrowError(ToolError);
    expect(() => run("", { ...base, grams: 6000 })).toThrowError(ToolError);
  });

  it("throws bad-option for an invalid failure rate", () => {
    expect(() => run("", { ...base, failureRatePercent: 51 })).toThrowError(ToolError);
  });

  it("computes the meta.ts examples without throwing", () => {
    const slicerOut = run("Filament used: 23.4g\nEstimated printing time: 3h 12m", {
      ...base,
      material: "pla",
      spoolPrice: 20,
      spoolGrams: 1000,
      printerWatts: 120,
    });
    expect(slicerOut["Filament amount"]).toBe("23.40 g PLA");

    const quoteOut = run("", {
      ...base,
      grams: 48,
      material: "petg",
      hours: 4,
      minutes: 30,
      markupPercent: 40,
      failureRatePercent: 10,
    });
    expect(quoteOut["Filament amount"]).toBe("48.00 g PETG");
    expect(quoteOut.Total).toBeDefined();
  });

  it("throws bad-option for an invalid markup percent", () => {
    expect(() => run("", { ...base, markupPercent: 501 })).toThrowError(ToolError);
  });

  it("throws bad-option for a zero or negative spool weight", () => {
    expect(() => run("", { ...base, spoolGrams: 0 })).toThrowError(ToolError);
  });

  it("throws bad-option for an unknown currency", () => {
    expect(() => run("", { ...base, currency: "XYZ" })).toThrowError(ToolError);
  });

  it("throws bad-option for an unknown material", () => {
    expect(() => run("", { ...base, material: "unobtainium" })).toThrowError(ToolError);
  });

  it("throws nothing-to-price when grams and meters are both zero with no paste", () => {
    expect(() => run("", { ...base, grams: 0, meters: 0 })).toThrowError(ToolError);
    try {
      run("", { ...base, grams: 0, meters: 0 });
    } catch (err) {
      expect((err as ToolError).code).toBe("nothing-to-price");
    }
  });

  it("throws bad-paste for pasted text with no recognizable numbers", () => {
    expect(() => run("just some random notes", { ...base })).toThrowError(ToolError);
    try {
      run("just some random notes", { ...base });
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-paste");
    }
  });
});

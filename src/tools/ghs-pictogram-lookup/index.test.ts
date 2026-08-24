import { describe, expect, it } from "vitest";
import { CHEMICALS, type Chemical } from "../_generated/chem-data";
import { ToolError } from "../types";
import {
  DISCLAIMER,
  PICTOGRAM_INFO,
  commonHCodes,
  hStatementText,
  matchByHCodes,
  matchByPictograms,
  normalizeHCodes,
  normalizePictogramCodes,
  pStatementText,
  pictogramCounts,
  run,
} from "./index";

const named = (name: string): Chemical => {
  const hit = CHEMICALS.find((c) => c.name === name);
  if (!hit) throw new Error(`fixture missing: ${name}`);
  return hit;
};

describe("PICTOGRAM_INFO", () => {
  it("carries all nine symbols with their self hosted SVG paths", () => {
    expect(PICTOGRAM_INFO).toHaveLength(9);
    expect(PICTOGRAM_INFO.map((p) => p.code)).toEqual([
      "GHS01",
      "GHS02",
      "GHS03",
      "GHS04",
      "GHS05",
      "GHS06",
      "GHS07",
      "GHS08",
      "GHS09",
    ]);
    expect(PICTOGRAM_INFO[0]).toEqual({
      code: "GHS01",
      name: "Exploding Bomb",
      hazardClass: "Explosives",
      svgPath: "/ghs/GHS01.svg",
    });
  });

  it("omits the hazard class where the reference has none", () => {
    const health = PICTOGRAM_INFO.find((p) => p.code === "GHS08")!;
    expect(health.name).toBe("Health Hazard");
    expect(health.hazardClass).toBeUndefined();
    expect(health.svgPath).toBe("/ghs/GHS08.svg");
  });

  it("counts how many chemicals carry each symbol", () => {
    const counts = pictogramCounts();
    expect(counts["GHS07"]).toBe(1362);
    expect(counts["GHS01"]).toBe(22);
    expect(Object.keys(counts)).toHaveLength(9);
    // Memoized, so a second call has to agree with the first.
    expect(pictogramCounts()).toEqual(counts);
  });
});

describe("normalizePictogramCodes", () => {
  it("accepts full codes, lowercase, and bare digits", () => {
    expect(normalizePictogramCodes("GHS02")).toEqual(["GHS02"]);
    expect(normalizePictogramCodes("ghs2")).toEqual(["GHS02"]);
    expect(normalizePictogramCodes("2")).toEqual(["GHS02"]);
    expect(normalizePictogramCodes(["GHS-07", "ghs 2"])).toEqual(["GHS02", "GHS07"]);
  });

  it("splits on commas and spaces, dedupes, and sorts", () => {
    expect(normalizePictogramCodes("GHS07, GHS02; GHS07 ghs2")).toEqual(["GHS02", "GHS07"]);
    expect(normalizePictogramCodes("")).toEqual([]);
    expect(normalizePictogramCodes("   ")).toEqual([]);
  });

  it("rejects an unknown code with the valid list", () => {
    try {
      normalizePictogramCodes("GHS10");
      throw new Error("expected a ToolError");
    } catch (err) {
      expect((err as ToolError).code).toBe("unknown-pictogram");
      expect((err as ToolError).fix).toContain("GHS09");
    }
    expect(() => normalizePictogramCodes("flame")).toThrow(ToolError);
    expect(() => normalizePictogramCodes("GHS0")).toThrow(ToolError);
  });
});

describe("normalizeHCodes and statement text", () => {
  it("accepts full codes, lowercase, and bare digits", () => {
    expect(normalizeHCodes("H225")).toEqual(["H225"]);
    expect(normalizeHCodes("h225")).toEqual(["H225"]);
    expect(normalizeHCodes("225")).toEqual(["H225"]);
    expect(normalizeHCodes("H319, H225, h319")).toEqual(["H225", "H319"]);
    expect(normalizeHCodes("")).toEqual([]);
  });

  it("rejects a code the GHS reference does not list", () => {
    try {
      normalizeHCodes("H999");
      throw new Error("expected a ToolError");
    } catch (err) {
      expect((err as ToolError).code).toBe("unknown-h-code");
      expect((err as ToolError).fix).toContain("H225");
    }
    expect(() => normalizeHCodes("flammable")).toThrow(ToolError);
  });

  it("returns the canonical UN wording, obsolete marker and all", () => {
    expect(hStatementText("H225")).toBe("Highly Flammable liquid and vapor");
    expect(hStatementText("h225")).toBe("Highly Flammable liquid and vapor");
    expect(hStatementText("225")).toBe("Highly Flammable liquid and vapor");
    expect(hStatementText("H200")).toContain("(Obsolete)");
    expect(hStatementText("H999")).toBeUndefined();
    expect(hStatementText("nope")).toBeUndefined();
  });

  it("resolves plain and combination precautionary codes", () => {
    expect(pStatementText("P210")).toBeTruthy();
    expect(pStatementText("p210")).toBe(pStatementText("P210"));
    expect(pStatementText("P305+P351+P338")).toBeTruthy();
    expect(pStatementText("P999")).toBeUndefined();
  });
});

describe("matchByPictograms", () => {
  it("requires every pictogram in all mode", () => {
    const both = matchByPictograms(["GHS02", "GHS07"], "all");
    expect(both.length).toBeGreaterThan(0);
    expect(
      both.every((c) => c.ghs!.pictograms.includes("GHS02") && c.ghs!.pictograms.includes("GHS07")),
    ).toBe(true);
    expect(both.map((c) => c.name)).toContain("Acetone");
  });

  it("requires only one pictogram in any mode", () => {
    const all = matchByPictograms(["GHS02", "GHS07"], "all");
    const any = matchByPictograms(["GHS02", "GHS07"], "any", CHEMICALS.length);
    expect(any.length).toBeGreaterThan(all.length);
    expect(
      any.every((c) => c.ghs!.pictograms.includes("GHS02") || c.ghs!.pictograms.includes("GHS07")),
    ).toBe(true);
  });

  it("matches a single pictogram against its whole count", () => {
    const flame = matchByPictograms(["GHS02"], "all", CHEMICALS.length);
    expect(flame.length).toBe(pictogramCounts()["GHS02"]);
  });

  it("sorts by name and honors the limit", () => {
    const hits = matchByPictograms(["GHS01"], "any", CHEMICALS.length);
    const names = hits.map((c) => c.name.toLowerCase());
    expect(names).toEqual([...names].sort());
    expect(matchByPictograms(["GHS01"], "any", 3).length).toBe(3);
    expect(matchByPictograms(["GHS01"], "any", 0)).toEqual([]);
  });

  it("returns nothing for an empty selection instead of throwing", () => {
    expect(matchByPictograms([], "all")).toEqual([]);
    expect(matchByPictograms([], "any")).toEqual([]);
    expect(matchByPictograms([""], "any")).toEqual([]);
  });

  it("defaults to all mode", () => {
    expect(matchByPictograms(["GHS02", "GHS07"]).map((c) => c.id)).toEqual(
      matchByPictograms(["GHS02", "GHS07"], "all").map((c) => c.id),
    );
  });

  it("throws for an unknown code", () => {
    expect(() => matchByPictograms(["GHS42"], "any")).toThrow(ToolError);
  });
});

describe("matchByHCodes", () => {
  it("requires every code in all mode and one in any mode", () => {
    const all = matchByHCodes(["H225", "H319"], "all", CHEMICALS.length);
    const any = matchByHCodes(["H225", "H319"], "any", CHEMICALS.length);
    expect(all.length).toBe(85);
    expect(any.length).toBeGreaterThan(all.length);
    expect(
      all.every(
        (c) => c.ghs!.h.some((h) => h.code === "H225") && c.ghs!.h.some((h) => h.code === "H319"),
      ),
    ).toBe(true);
    expect(all.map((c) => c.name)).toContain("Acetone");
  });

  it("matches a single code against its whole count", () => {
    expect(matchByHCodes(["H225"], "all", CHEMICALS.length).length).toBe(224);
  });

  it("returns nothing for an empty list and throws for a bad code", () => {
    expect(matchByHCodes([], "all")).toEqual([]);
    expect(() => matchByHCodes(["H999"], "all")).toThrow(ToolError);
  });

  it("sorts by name", () => {
    const names = matchByHCodes(["H225"], "all", 50).map((c) => c.name.toLowerCase());
    expect(names).toEqual([...names].sort());
  });
});

describe("commonHCodes", () => {
  it("tallies the codes across a result set, most first", () => {
    const flame = matchByPictograms(["GHS02"], "all", CHEMICALS.length);
    const common = commonHCodes(flame, 3);
    expect(common).toHaveLength(3);
    expect(common[0]!.count).toBeGreaterThanOrEqual(common[1]!.count);
    expect(common.map((h) => h.code).some((c) => c.startsWith("H22"))).toBe(true);
  });

  it("handles an empty set and a zero limit", () => {
    expect(commonHCodes([], 5)).toEqual([]);
    expect(commonHCodes([named("Acetone")], 0)).toEqual([]);
  });
});

describe("run", () => {
  it("lists the pictogram catalog with counts when nothing is selected", () => {
    const out = run(undefined, {});
    expect(out["Chemicals with a GHS classification"]).toBe("2096");
    expect(out["GHS01 Exploding Bomb"]).toContain("22 chemicals");
    expect(out["GHS01 Exploding Bomb"]).toContain("/ghs/GHS01.svg");
    expect(out["GHS08 Health Hazard"]).toContain("/ghs/GHS08.svg");
    expect(out["Disclaimer"]).toBe(DISCLAIMER);
    expect(out["Matches"]).toBeUndefined();
  });

  it("summarizes a pictogram search", () => {
    const out = run(undefined, { pictograms: "GHS02, GHS07", mode: "all" });
    expect(out["Mode"]).toBe("match all");
    expect(out["Pictograms"]).toBe("GHS02 Flame, GHS07 Exclamation Mark");
    expect(Number(out["Matches"])).toBe(
      matchByPictograms(["GHS02", "GHS07"], "all", CHEMICALS.length).length,
    );
    expect(out["Chemicals"]).toContain("(+-)-alpha-Pinene");
    expect(out["Chemicals"]).toContain("more");
    expect(out["Most common hazard statements"]).toContain("H");
    expect(out["Disclaimer"]).toBe(DISCLAIMER);
  });

  it("summarizes an H code search and reports the canonical wording", () => {
    const out = run(undefined, { hcodes: "H225" });
    expect(out["Hazard statements"]).toBe("H225 Highly Flammable liquid and vapor");
    expect(out["Matches"]).toBe("224");
  });

  it("applies both filters together", () => {
    const out = run(undefined, { pictograms: "GHS05", hcodes: "H225", mode: "all" });
    const combined = Number(out["Matches"]);
    expect(combined).toBeLessThan(Number(run(undefined, { hcodes: "H225" })["Matches"]));
    expect(combined).toBeLessThan(Number(run(undefined, { pictograms: "GHS05" })["Matches"]));
  });

  it("switches to any mode", () => {
    const all = Number(run(undefined, { pictograms: "GHS02, GHS09", mode: "all" })["Matches"]);
    const any = Number(run(undefined, { pictograms: "GHS02, GHS09", mode: "any" })["Matches"]);
    expect(any).toBeGreaterThan(all);
    expect(run(undefined, { pictograms: "GHS02", mode: "any" })["Mode"]).toBe("match any");
  });

  it("caps the chemical list", () => {
    const out = run(undefined, { pictograms: "GHS07" });
    expect(out["Chemicals"]).toContain("and");
    expect(out["Chemicals"]).toContain("more");
  });

  it("reports zero matches without a chemical list", () => {
    const out = run(undefined, { pictograms: "GHS01", hcodes: "H420", mode: "all" });
    expect(out["Matches"]).toBe("0");
    expect(out["Chemicals"]).toBeUndefined();
  });

  it("throws for a bad code in either option", () => {
    expect(() => run(undefined, { pictograms: "GHS10" })).toThrow(ToolError);
    expect(() => run(undefined, { hcodes: "H999" })).toThrow(ToolError);
  });

  it("is the default export", async () => {
    const mod = await import("./index");
    expect(mod.default.run(undefined, { pictograms: "GHS02" })["Mode"]).toBe("match all");
  });
});

describe("dataset safety", () => {
  it("leaves the shared pictogram and statement arrays untouched", () => {
    const acetone = named("Acetone");
    const before = {
      pictograms: acetone.ghs!.pictograms.join(","),
      p: acetone.ghs!.p.join(","),
      h: acetone.ghs!.h.map((h) => h.code).join(","),
    };
    matchByPictograms(["GHS02", "GHS07"], "all", CHEMICALS.length);
    matchByHCodes(["H225"], "all", CHEMICALS.length);
    run(undefined, { pictograms: "GHS02", hcodes: "H225" });
    expect(acetone.ghs!.pictograms.join(",")).toBe(before.pictograms);
    expect(acetone.ghs!.p.join(",")).toBe(before.p);
    expect(acetone.ghs!.h.map((h) => h.code).join(",")).toBe(before.h);
  });
});

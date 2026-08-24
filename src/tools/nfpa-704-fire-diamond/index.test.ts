import { describe, expect, it } from "vitest";
import { CHEMICALS, type Chemical } from "../_generated/chem-data";
import { ToolError } from "../types";
import {
  ANY_SPECIALS,
  DISCLAIMER,
  NFPA_COLORS,
  RATING_LABELS,
  SPECIAL_LABELS,
  describeQuery,
  diamondSvg,
  formatRating,
  matchChemicals,
  nearbyChemicals,
  queryFromOpts,
  run,
  searchChemical,
  specialsFor,
  type NfpaQuery,
} from "./index";

const named = (name: string): Chemical => {
  const hit = CHEMICALS.find((c) => c.name === name);
  if (!hit) throw new Error(`fixture missing: ${name}`);
  return hit;
};

const query = (partial: Partial<NfpaQuery> = {}): NfpaQuery => ({
  special: { ...ANY_SPECIALS },
  ...partial,
});

describe("specialsFor", () => {
  it("unions the PubChem and Wikipedia white quadrants", () => {
    const acid = named("Sulfuric acid");
    expect(acid.nfpa!.special).toEqual([]);
    expect(acid.nfpaAlt!.special).toEqual(["W", "OX"]);
    expect(specialsFor(acid)).toEqual(["W", "OX"]);
  });

  it("keeps W, OX, SA order and dedupes", () => {
    expect(specialsFor(named("Butane"))).toEqual(["SA"]);
    expect(specialsFor(named("Oxygen"))).toEqual(["OX"]);
    expect(specialsFor(named("Sodium"))).toEqual(["W"]);
    expect(specialsFor(named("Acetone"))).toEqual([]);
  });

  it("returns a fresh array and never touches the shared dataset arrays", () => {
    const acid = named("Sulfuric acid");
    const before = acid.nfpaAlt!.special.join(",");
    const specials = specialsFor(acid);
    specials.push("SA");
    specials.sort();
    expect(acid.nfpaAlt!.special.join(",")).toBe(before);
    expect(specialsFor(acid)).toEqual(["W", "OX"]);
  });
});

describe("matchChemicals", () => {
  it("matches an exact rating combo and sorts by name", () => {
    const hits = matchChemicals(query({ h: 1, f: 3, r: 0 }));
    expect(hits.length).toBe(54);
    expect(hits.map((c) => c.name)).toContain("Acetone");
    const names = hits.map((c) => c.name.toLowerCase());
    expect(names).toEqual([...names].sort());
  });

  it("treats an undefined quadrant as any", () => {
    const pinned = matchChemicals(query({ h: 1, f: 3, r: 0 }));
    const open = matchChemicals(query({ h: 1, f: 3 }));
    expect(open.length).toBeGreaterThan(pinned.length);
    expect(matchChemicals(query()).length).toBe(CHEMICALS.filter((c) => c.nfpa).length);
  });

  it("requires a special against the union of both sources", () => {
    const required = matchChemicals(query({ special: { ...ANY_SPECIALS, W: "require" } }));
    expect(required.map((c) => c.name)).toContain("Sulfuric acid");
    expect(required.map((c) => c.name)).toContain("Sodium");
    expect(required.every((c) => specialsFor(c).includes("W"))).toBe(true);
    // 187 rows carry W on the PubChem rating; the union adds 10 more.
    expect(required.length).toBe(197);
  });

  it("excludes a special against the union too", () => {
    const excluded = matchChemicals(query({ special: { ...ANY_SPECIALS, W: "exclude" } }));
    expect(excluded.map((c) => c.name)).not.toContain("Sulfuric acid");
    expect(excluded.every((c) => !specialsFor(c).includes("W"))).toBe(true);
    const all = matchChemicals(query()).length;
    const required = matchChemicals(query({ special: { ...ANY_SPECIALS, W: "require" } })).length;
    expect(excluded.length + required).toBe(all);
  });

  it("combines two special filters", () => {
    const both = matchChemicals(query({ special: { W: "require", OX: "require", SA: "any" } }));
    expect(both.map((c) => c.name)).toContain("Sulfuric acid");
    expect(both.every((c) => specialsFor(c).includes("W") && specialsFor(c).includes("OX"))).toBe(
      true,
    );
    const contradiction = matchChemicals(
      query({ special: { W: "require", OX: "any", SA: "any" }, h: 1, f: 3, r: 0 }),
    );
    expect(contradiction.every((c) => specialsFor(c).includes("W"))).toBe(true);
  });

  it("finds the simple asphyxiants", () => {
    const sa = matchChemicals(query({ special: { ...ANY_SPECIALS, SA: "require" } }));
    expect(sa.map((c) => c.name)).toEqual([
      "Butane",
      "Carbon dioxide",
      "Carbon tetrafluoride",
      "Cyclopropane",
      "Ethane",
      "Fluoroethane",
      "Methane",
      "Octafluoropropane",
      "Sulfur hexafluoride",
      "Trifluoromethylsulfur pentafluoride",
      "Xenon",
    ]);
  });
});

describe("nearbyChemicals", () => {
  it("ranks by rating distance and never returns an exact match", () => {
    const q = query({ h: 4, f: 4, r: 4 });
    const exact = new Set(matchChemicals(q).map((c) => c.id));
    const nearby = nearbyChemicals(q, 10);
    expect(nearby.length).toBe(10);
    expect(nearby.every((n) => !exact.has(n.chemical.id))).toBe(true);
    expect(nearby.every((n) => n.distance > 0)).toBe(true);
    const distances = nearby.map((n) => n.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it("only counts the quadrants the query pinned", () => {
    const nearby = nearbyChemicals(query({ h: 0 }), 5);
    expect(nearby.every((n) => n.distance === n.chemical.nfpa!.h)).toBe(true);
    expect(nearby[0]!.distance).toBe(1);
  });

  it("keeps the special filters hard while relaxing the numbers", () => {
    const nearby = nearbyChemicals(
      query({ h: 4, f: 4, r: 4, special: { ...ANY_SPECIALS, SA: "require" } }),
      5,
    );
    expect(nearby.length).toBeGreaterThan(0);
    expect(nearby.every((n) => specialsFor(n.chemical).includes("SA"))).toBe(true);
  });

  it("returns nothing when no quadrant is pinned, and honors the limit", () => {
    expect(nearbyChemicals(query(), 10)).toEqual([]);
    expect(nearbyChemicals(query({ h: 2, f: 2, r: 2 }), 3).length).toBe(3);
    expect(nearbyChemicals(query({ h: 2, f: 2, r: 2 }), 0)).toEqual([]);
  });
});

describe("searchChemical", () => {
  it("puts an exact name first", () => {
    expect(searchChemical("acetone")[0]!.name).toBe("Acetone");
    expect(searchChemical("Sulfuric acid")[0]!.name).toBe("Sulfuric acid");
  });

  it("finds a CAS number and a formula", () => {
    expect(searchChemical("67-64-1")[0]!.name).toBe("Acetone");
    expect(searchChemical("H2SO4")[0]!.name).toBe("Sulfuric acid");
  });

  it("finds a synonym", () => {
    const hits = searchChemical("dimethyl ketone");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.name).toBe("Acetone");
  });

  it("only returns chemicals that carry an NFPA rating", () => {
    expect(searchChemical("acid", 40).every((c) => c.nfpa !== undefined)).toBe(true);
  });

  it("caps the result list and handles an empty or unmatched query", () => {
    expect(searchChemical("acid", 5).length).toBe(5);
    expect(searchChemical("")).toEqual([]);
    expect(searchChemical("   ")).toEqual([]);
    expect(searchChemical("zzzzzzznotathing")).toEqual([]);
  });

  it("is stable: the same query gives the same order", () => {
    expect(searchChemical("acid", 20).map((c) => c.id)).toEqual(
      searchChemical("acid", 20).map((c) => c.id),
    );
  });
});

describe("diamondSvg", () => {
  it("is a standalone SVG with a title and no XML prolog", () => {
    const svg = diamondSvg({ h: 3, f: 0, r: 2 });
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(svg).not.toContain("<?xml");
    expect(svg).toContain("<title>NFPA 704 diamond: health 3, fire 0, instability 2</title>");
  });

  it("draws four quadrants in the NFPA colors", () => {
    const svg = diamondSvg({ h: 3, f: 0, r: 2 });
    expect((svg.match(/<polygon /g) ?? []).length).toBe(4);
    expect(svg).toContain(`fill="${NFPA_COLORS.health}"`);
    expect(svg).toContain(`fill="${NFPA_COLORS.fire}"`);
    expect(svg).toContain(`fill="${NFPA_COLORS.instability}"`);
    expect(svg).toContain(`fill="${NFPA_COLORS.special}"`);
  });

  it("puts each numeral in its own quadrant", () => {
    const svg = diamondSvg({ h: 3, f: 1, r: 2 });
    // Health sits left of center, fire above it, instability right of it.
    expect(svg).toMatch(/<text x="129.29" y="[\d.]+"[^>]*>3<\/text>/);
    expect(svg).toMatch(/<text x="200" y="[\d.]+"[^>]*>1<\/text>/);
    expect(svg).toMatch(/<text x="270.71" y="[\d.]+"[^>]*>2<\/text>/);
  });

  it("leaves a quadrant blank when its rating is undefined", () => {
    const svg = diamondSvg({ f: 4 });
    expect((svg.match(/<text /g) ?? []).length).toBe(1); // only the fire numeral
    expect(svg).toContain(">4</text>");
    expect(svg).toContain("<title>NFPA 704 diamond: fire 4</title>");
  });

  it("draws the W strikethrough as a real line, not a combining character", () => {
    const svg = diamondSvg({ h: 3, f: 1, r: 2, special: ["W"] });
    expect(svg).toContain(">W</text>");
    expect(svg).toContain('class="nfpa-w-bar"');
    expect(svg).toMatch(/<line class="nfpa-w-bar"[^>]*stroke-width="[\d.]+"/);
    expect(svg).toMatch(/<line class="nfpa-w-bar"[^>]*stroke="#111111"/);
    expect(svg).not.toContain("̶");
  });

  it("omits the bar when W is not present", () => {
    const svg = diamondSvg({ h: 0, f: 0, r: 1, special: ["OX"] });
    expect(svg).toContain(">OX</text>");
    expect(svg).not.toContain("nfpa-w-bar");
  });

  it("stacks several specials in W, OX, SA order", () => {
    const svg = diamondSvg({ h: 3, f: 0, r: 2, special: ["SA", "OX", "W"] });
    expect(svg.indexOf(">W</text>")).toBeLessThan(svg.indexOf(">OX</text>"));
    expect(svg.indexOf(">OX</text>")).toBeLessThan(svg.indexOf(">SA</text>"));
    expect(svg).toContain("nfpa-w-bar");
  });

  it("adds an optional caption below the diamond and grows the canvas", () => {
    const plain = diamondSvg({ h: 1, f: 3, r: 0 });
    const captioned = diamondSvg({ h: 1, f: 3, r: 0, caption: "Acetone" });
    expect(plain).toContain('viewBox="0 0 400 400"');
    expect(captioned).toContain('viewBox="0 0 400 420"');
    expect(captioned).toContain(">Acetone</text>");
    expect(captioned).toContain(
      "<title>NFPA 704 diamond for Acetone: health 1, fire 3, instability 0</title>",
    );
  });

  it("escapes a caption so markup in a name cannot break the file", () => {
    const svg = diamondSvg({ h: 0, f: 0, r: 0, caption: 'Tin <b>&</b> "lead"' });
    expect(svg).toContain("Tin &lt;b&gt;&amp;&lt;/b&gt; &quot;lead&quot;");
    expect(svg).not.toContain("<b>");
  });

  it("paints an optional background for a PNG export", () => {
    expect(diamondSvg({ h: 0, f: 0, r: 0 })).not.toContain("<rect");
    expect(diamondSvg({ h: 0, f: 0, r: 0, background: "#ffffff" })).toContain(
      '<rect x="0" y="0" width="400" height="400" fill="#ffffff" />',
    );
  });

  it("rejects a rating outside 0 to 4", () => {
    expect(() => diamondSvg({ h: 5 as never })).toThrow(ToolError);
    expect(() => diamondSvg({ f: 1.5 as never })).toThrow(/not an NFPA 704 degree/);
    try {
      diamondSvg({ r: -1 as never });
      throw new Error("expected a ToolError");
    } catch (err) {
      expect((err as ToolError).code).toBe("invalid-rating");
    }
  });
});

describe("labels and formatting", () => {
  it("formats a rating with its source", () => {
    const acid = named("Sulfuric acid");
    expect(formatRating(acid.nfpa!)).toBe("Health 3, Fire 0, Instability 2 (HSDB)");
    expect(formatRating(acid.nfpaAlt!)).toBe("Health 3, Fire 0, Instability 2, W OX (Wikipedia)");
    expect(formatRating(acid.nfpa!, specialsFor(acid))).toBe(
      "Health 3, Fire 0, Instability 2, W OX (HSDB)",
    );
  });

  it("carries the five NFPA degree descriptions per quadrant", () => {
    expect(RATING_LABELS.h).toHaveLength(5);
    expect(RATING_LABELS.f).toHaveLength(5);
    expect(RATING_LABELS.r).toHaveLength(5);
    expect(RATING_LABELS.f[0]).toBe("Will not burn");
    expect(SPECIAL_LABELS.W).toContain("water");
    expect(SPECIAL_LABELS.OX).toBe("Oxidizer");
  });

  it("describes a query in words", () => {
    expect(describeQuery(query({ h: 3, r: 2, special: { ...ANY_SPECIALS, W: "require" } }))).toBe(
      "Health 3, Fire any, Instability 2, W required",
    );
    expect(describeQuery(query({ special: { ...ANY_SPECIALS, OX: "exclude" } }))).toBe(
      "Health any, Fire any, Instability any, OX excluded",
    );
  });
});

describe("queryFromOpts", () => {
  it("reads the option strings the panel and the API send", () => {
    const q = queryFromOpts({ health: "3", fire: "any", instability: "2", water: "require" });
    expect(q.h).toBe(3);
    expect(q.f).toBeUndefined();
    expect(q.r).toBe(2);
    expect(q.special).toEqual({ W: "require", OX: "any", SA: "any" });
  });

  it("defaults everything to any", () => {
    const q = queryFromOpts();
    expect(q.h).toBeUndefined();
    expect(q.special).toEqual(ANY_SPECIALS);
  });

  it("rejects a bad rating or filter", () => {
    expect(() => queryFromOpts({ health: "9" })).toThrow(ToolError);
    expect(() => queryFromOpts({ health: "high" })).toThrow(/not an NFPA 704 health rating/);
    expect(() => queryFromOpts({ water: "maybe" })).toThrow(/not a filter/);
  });
});

describe("run", () => {
  it("summarizes a rating combo with a count and always carries the disclaimer", () => {
    const out = run(undefined, { health: "1", fire: "3", instability: "0" });
    expect(out["Rating"]).toBe("Health 1, Fire 3, Instability 0");
    expect(out["Exact matches"]).toBe("54");
    expect(out["Chemicals"]).toContain("Acetone");
    expect(out["Chemicals"]).toContain("more");
    expect(out["Disclaimer"]).toBe(DISCLAIMER);
    expect(out["Nearby ratings"]).toBeUndefined();
  });

  it("adds nearby ratings when a combo has few matches", () => {
    const out = run(undefined, { health: "4", fire: "4", instability: "4" });
    expect(Number(out["Exact matches"])).toBeLessThan(5);
    expect(out["Nearby ratings"]).toBeTruthy();
    expect(out["Nearby ratings"]).toContain("(");
  });

  it("reports a combo with no matches at all", () => {
    const out = run(undefined, {
      health: "0",
      fire: "4",
      instability: "4",
      water: "require",
      oxidizer: "require",
      asphyxiant: "require",
    });
    expect(out["Exact matches"]).toBe("0");
    expect(out["Chemicals"]).toBeUndefined();
    expect(out["Nearby ratings"]).toBe("none within the special symbol filters");
  });

  it("includes the SVG only when asked and every quadrant is pinned", () => {
    expect(
      run(undefined, { health: "3", fire: "0", instability: "2" })["Diamond SVG"],
    ).toBeUndefined();
    expect(run(undefined, { health: "3", fire: "0", svg: true })["Diamond SVG"]).toBeUndefined();
    const svg = run(undefined, {
      health: "3",
      fire: "0",
      instability: "2",
      water: "require",
      svg: true,
    })["Diamond SVG"]!;
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain("nfpa-w-bar");
  });

  it("is the default export", async () => {
    const mod = await import("./index");
    expect(mod.default.run(undefined, {})["Disclaimer"]).toBe(DISCLAIMER);
  });
});

describe("dataset safety", () => {
  it("leaves the shared hazard arrays untouched after a full run", () => {
    const acetone = named("Acetone");
    const before = {
      pictograms: acetone.ghs!.pictograms.join(","),
      p: acetone.ghs!.p.join(","),
      h: acetone.ghs!.h.map((h) => h.code).join(","),
      special: acetone.nfpa!.special.join(","),
    };
    matchChemicals(query({ h: 1, f: 3, r: 0 }));
    nearbyChemicals(query({ h: 1, f: 3, r: 0 }), 20);
    searchChemical("acetone");
    run(undefined, { health: "1", fire: "3", instability: "0", svg: true });
    expect(acetone.ghs!.pictograms.join(",")).toBe(before.pictograms);
    expect(acetone.ghs!.p.join(",")).toBe(before.p);
    expect(acetone.ghs!.h.map((h) => h.code).join(",")).toBe(before.h);
    expect(acetone.nfpa!.special.join(",")).toBe(before.special);
  });
});

import { describe, expect, it } from "vitest";
import { CHEMICALS, type Chemical } from "../_generated/chem-data";
import { ToolError } from "../types";
import {
  DISCLAIMER,
  describeChemical,
  formatNfpa,
  lookup,
  pubchemUrl,
  run,
  suggestions,
  wikipediaUrl,
} from "./index";

const named = (name: string): Chemical => {
  const hit = CHEMICALS.find((c) => c.name === name);
  if (!hit) throw new Error(`fixture missing: ${name}`);
  return hit;
};

describe("lookup", () => {
  it("puts an exact name first", () => {
    const hits = lookup("acetone");
    expect(hits[0]!.chemical.name).toBe("Acetone");
    expect(hits[0]!.score).toBe(1000);
    expect(hits[0]!.matchedOn).toBe("name");
  });

  it("is case and whitespace insensitive", () => {
    expect(lookup("  ACETONE  ")[0]!.chemical.name).toBe("Acetone");
    expect(lookup("Acetone")[0]!.chemical.id).toBe(lookup("acetone")[0]!.chemical.id);
  });

  it("finds a CAS registry number", () => {
    const hits = lookup("67-64-1");
    expect(hits[0]!.chemical.name).toBe("Acetone");
    expect(hits[0]!.matchedOn).toBe("CAS");
    expect(hits[0]!.score).toBe(950);
  });

  it("finds a synonym", () => {
    const hits = lookup("dimethyl ketone");
    expect(hits[0]!.chemical.name).toBe("Acetone");
    expect(hits[0]!.matchedOn).toBe("synonym");
  });

  it("finds every chemical with a formula, ranked equally", () => {
    const hits = lookup("C3H6O", 10);
    expect(hits.length).toBeGreaterThan(1);
    expect(hits.every((h) => h.matchedOn === "formula")).toBe(true);
    expect(new Set(hits.map((h) => h.score))).toEqual(new Set([600]));
    expect(hits.map((h) => h.chemical.name)).toContain("Allyl alcohol");
  });

  it("ranks a prefix above a substring", () => {
    const hits = lookup("sulfuric", 10);
    expect(hits[0]!.chemical.name).toBe("Sulfuric acid");
    const prefixScore = hits[0]!.score;
    expect(prefixScore).toBeGreaterThanOrEqual(500);
  });

  it("honors the limit and handles an empty or unmatched query", () => {
    expect(lookup("acid", 4).length).toBe(4);
    expect(lookup("")).toEqual([]);
    expect(lookup("   ")).toEqual([]);
    expect(lookup("zzzzzzznotathing")).toEqual([]);
    expect(lookup("acetone", 0)).toEqual([]);
  });

  it("is stable across calls", () => {
    expect(lookup("chloride", 20).map((h) => h.chemical.id)).toEqual(
      lookup("chloride", 20).map((h) => h.chemical.id),
    );
  });
});

describe("suggestions", () => {
  it("shortens a misspelled word until something matches", () => {
    expect(suggestions("acetonezz").map((c) => c.name)).toContain("Acetone");
    expect(suggestions("ethanolll").length).toBeGreaterThan(0);
  });

  it("gives up on a word with no recognizable stem", () => {
    expect(suggestions("zzzzzzznotathing")).toEqual([]);
    expect(suggestions("ab")).toEqual([]);
    expect(suggestions("")).toEqual([]);
  });

  it("honors the limit and returns names in order", () => {
    const three = suggestions("chloride", 3);
    expect(three.length).toBeLessThanOrEqual(3);
    const names = three.map((c) => c.name.toLowerCase());
    expect(names).toEqual([...names].sort());
  });
});

describe("describeChemical", () => {
  it("reports the full sheet for acetone", () => {
    const out = describeChemical(named("Acetone"));
    expect(out["Name"]).toBe("Acetone");
    expect(out["Formula"]).toBe("C3H6O");
    expect(out["Molar mass"]).toBe("58.08 g/mol");
    expect(out["CAS number"]).toBe("67-64-1");
    expect(out["NFPA 704"]).toBe("Health 1, Fire 3, Instability 0 (HSDB)");
    expect(out["GHS signal word"]).toBe("Danger");
    expect(out["GHS pictograms"]).toBe("GHS02 Flame, GHS07 Exclamation Mark");
    expect(out["GHS hazard statements"]).toContain("H225");
    expect(out["GHS precautionary statements"]).toContain("P210");
    expect(out["Flash point"]).toBe("-20 °C");
    expect(out["Wikipedia"]).toBe("https://en.wikipedia.org/wiki/Acetone");
    expect(out["PubChem"]).toBe("https://pubchem.ncbi.nlm.nih.gov/compound/180");
    expect(out["Note"]).toBe(DISCLAIMER);
  });

  it("shows both NFPA ratings when the sources disagree", () => {
    const out = describeChemical(named("Sulfuric acid"));
    expect(out["NFPA 704"]).toBe("Health 3, Fire 0, Instability 2 (HSDB)");
    expect(out["NFPA 704, second source"]).toBe(
      "Health 3, Fire 0, Instability 2, W OX (Wikipedia)",
    );
  });

  it("omits every field the row does not carry", () => {
    const out = describeChemical(named("Sodium"));
    expect(out["Name"]).toBe("Sodium");
    expect(out["NFPA 704"]).toBe("Health 3, Fire 1, Instability 2, W (Wikipedia)");
    expect(out["Formula"]).toBeUndefined();
    expect(out["CAS number"]).toBeUndefined();
    expect(out["GHS signal word"]).toBeUndefined();
    expect(out["PubChem"]).toBeUndefined();
    expect(out["Wikipedia"]).toBe("https://en.wikipedia.org/wiki/Sodium");
  });

  it("uses the wording the notifying body used, not the canonical text", () => {
    const out = describeChemical(named("Acetone"));
    // The row's own text carries the bracketed hazard class; H_STATEMENTS does not.
    expect(out["GHS hazard statements"]).toContain("[Danger Flammable liquids]");
  });

  it("credits Wikipedia only when a Wikipedia article backed the row", () => {
    expect(describeChemical(named("Acetone"))["Sources"]).toContain("CC BY-SA");
    const noArticle = CHEMICALS.find((c) => !c.wikipedia)!;
    expect(describeChemical(noArticle)["Sources"]).not.toContain("CC BY-SA");
  });

  it("caps long synonym and precautionary lists", () => {
    const many = CHEMICALS.find((c) => (c.ghs?.p.length ?? 0) > 24)!;
    expect(describeChemical(many)["GHS precautionary statements"]).toContain("and");
    expect(describeChemical(many)["GHS precautionary statements"]).toContain("more");
  });
});

describe("links and formatting", () => {
  it("builds article and compound URLs, and returns undefined without them", () => {
    expect(wikipediaUrl(named("Sulfuric acid"))).toBe(
      "https://en.wikipedia.org/wiki/Sulfuric_acid",
    );
    expect(pubchemUrl(named("Sulfuric acid"))).toBe(
      "https://pubchem.ncbi.nlm.nih.gov/compound/1118",
    );
    expect(pubchemUrl(named("Sodium"))).toBeUndefined();
  });

  it("formats an NFPA rating with its specials and source", () => {
    expect(formatNfpa(named("Acetone").nfpa!)).toBe("Health 1, Fire 3, Instability 0 (HSDB)");
    expect(formatNfpa(named("Sodium").nfpa!)).toBe(
      "Health 3, Fire 1, Instability 2, W (Wikipedia)",
    );
  });
});

describe("run", () => {
  it("describes the best match", () => {
    expect(run("acetone")["Formula"]).toBe("C3H6O");
    expect(run("67-64-1")["Name"]).toBe("Acetone");
    expect(run("H2SO4")["Name"]).toBe("Sulfuric acid");
  });

  it("throws on empty input with a hint", () => {
    try {
      run("");
      throw new Error("expected a ToolError");
    } catch (err) {
      expect((err as ToolError).code).toBe("empty-input");
      expect((err as ToolError).fix).toContain("CAS");
    }
  });

  it("throws with suggestions when nothing matches", () => {
    try {
      run("zzzzzzznotathing");
      throw new Error("expected a ToolError");
    } catch (err) {
      expect((err as ToolError).code).toBe("no-match");
      expect((err as ToolError).fix).toBeTruthy();
    }
  });

  it("names candidates when the query is genuinely ambiguous", () => {
    try {
      run("C3H6O");
      throw new Error("expected a ToolError");
    } catch (err) {
      expect((err as ToolError).code).toBe("ambiguous");
      expect((err as ToolError).fix).toMatch(/^Try one of .*,.*,.*\.$/);
    }
  });

  it("offers a near miss when the words are recognizable", () => {
    try {
      run("acetonezz notreal");
      throw new Error("expected a ToolError");
    } catch (err) {
      expect((err as ToolError).code).toBe("no-match");
      expect((err as ToolError).fix).toContain("Did you mean");
    }
  });

  it("is the default export", async () => {
    const mod = await import("./index");
    expect(mod.default.run("ethanol", {})["Name"]).toBe("Ethanol");
  });
});

describe("dataset safety", () => {
  it("leaves the shared hazard arrays untouched", () => {
    const acetone = named("Acetone");
    const before = {
      pictograms: acetone.ghs!.pictograms.join(","),
      p: acetone.ghs!.p.join(","),
      h: acetone.ghs!.h.map((h) => h.code).join(","),
      synonyms: acetone.synonyms.join(","),
    };
    lookup("acetone", 10);
    describeChemical(acetone);
    run("acetone");
    expect(acetone.ghs!.pictograms.join(",")).toBe(before.pictograms);
    expect(acetone.ghs!.p.join(",")).toBe(before.p);
    expect(acetone.ghs!.h.map((h) => h.code).join(",")).toBe(before.h);
    expect(acetone.synonyms.join(",")).toBe(before.synonyms);
  });
});

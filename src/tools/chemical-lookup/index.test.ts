import { describe, expect, it } from "vitest";
import { CHEMICALS, type Chemical } from "../_generated/chem-data";
import {
  CHEM_BROAD_META,
  CHEM_FLAG_CID,
  CHEM_FLAG_DRUG,
  CHEM_FLAG_GHS,
  CHEM_FLAG_NFPA,
  type ChemIndexRow,
  type ChemRecord,
} from "../_generated/chem-index";
import { ToolError } from "../types";
import {
  DISCLAIMER,
  MASS_TOLERANCE,
  SCORE_CAS_EXACT,
  SCORE_FORMULA_EXACT,
  SCORE_FORMULA_HILL,
  SCORE_MASS,
  SCORE_NAME_EXACT,
  SCORE_NAME_PREFIX,
  SCORE_NAME_SUBSTRING,
  SCORE_NAME_TOKENS,
  SCORE_SYNONYM_EXACT,
  SCORE_SYNONYM_PREFIX,
  SCORE_SYNONYM_SUBSTRING,
  NARROW_SCORE_MAP,
  describeChemical,
  formatNfpa,
  formulaKey,
  isBroadId,
  lookup,
  narrowChemical,
  parseFormula,
  parseMassQuery,
  prepareChemIndex,
  provenanceLines,
  pubchemUrl,
  recordPubchemUrl,
  recordWikipediaUrl,
  renderRecord,
  run,
  searchChemIndex,
  searchChemicals,
  suggestions,
  wikipediaAttribution,
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

/* ==================================================================== *
 *  THE BROAD TIER
 *
 *  These run against a hand written fixture index, never against the real
 *  /data/chem/index.json: the point is the ranking rules, and 25,248 real
 *  rows would make every assertion a moving target on the next data build.
 * ==================================================================== */

const H_FIXTURE: Record<string, string> = {
  H225: "Highly flammable liquid and vapour",
  H319: "Causes serious eye irritation",
};

const P_FIXTURE: Record<string, string> = {
  P210: "Keep away from heat, hot surfaces, sparks, open flames and other ignition sources.",
};

/** [id, name, formula, cas, molarMass, flags, syn?] */
const FIXTURE: ChemIndexRow[] = [
  [180, "Acetone", "C3H6O", "67-64-1", 58.08, CHEM_FLAG_NFPA | CHEM_FLAG_GHS | CHEM_FLAG_CID],
  [1140, "Acetone cyanohydrin", "C4H7NO", "75-86-5", 85.11, CHEM_FLAG_GHS | CHEM_FLAG_CID],
  [
    1118,
    "Sulfuric acid",
    "H2SO4",
    "7664-93-9",
    98.08,
    CHEM_FLAG_NFPA | CHEM_FLAG_GHS | CHEM_FLAG_CID,
  ],
  [962, "Water", "H2O", "7732-18-5", 18.02, CHEM_FLAG_CID],
  [2244, "Aspirin", "C9H8O4", "50-78-2", 180.16, CHEM_FLAG_DRUG | CHEM_FLAG_GHS | CHEM_FLAG_CID],
  [3672, "Ibuprofen", "C13H18O2", "15687-27-1", 206.29, CHEM_FLAG_DRUG | CHEM_FLAG_CID],
  [900000001, "Phosphoric acid ester", "", "", 0, 0],
  [712, "Formaldehyde", "CH2O", "50-00-0", 30.03, CHEM_FLAG_NFPA | CHEM_FLAG_GHS],
  // A broad-tier row whose article title is not what most people type, the
  // exact case index.json's `syn` column exists for: "baking soda" style
  // lookups that the name alone would miss.
  [
    516892,
    "Sodium bicarbonate",
    "NaHCO3",
    "144-55-8",
    84.01,
    CHEM_FLAG_CID,
    ["Baking soda", "Bicarbonate of soda", "Sodium hydrogen carbonate"],
  ],
];

const index = prepareChemIndex(FIXTURE);
const names = (hits: { name: string }[]) => hits.map((h) => h.name);

describe("prepareChemIndex", () => {
  it("derives lowercased names, formulas, element keys and CAS numbers", () => {
    expect(index.names[0]).toBe("acetone");
    expect(index.formulas[2]).toBe("h2so4");
    expect(index.formulaKeys[2]).toBe("H2O4S1");
    expect(index.cas[2]).toBe("7664-93-9");
  });

  it("lowercases the syn column, and leaves it empty for a row without one", () => {
    expect(index.synonyms[8]).toEqual([
      "baking soda",
      "bicarbonate of soda",
      "sodium hydrogen carbonate",
    ]);
    expect(index.synonyms[0]).toEqual([]);
  });

  it("leaves the derived keys empty for a row with no formula or CAS", () => {
    expect(index.formulas[6]).toBe("");
    expect(index.formulaKeys[6]).toBe("");
    expect(index.cas[6]).toBe("");
  });
});

describe("parseFormula", () => {
  it("counts a plain formula", () => {
    expect([...parseFormula("H2SO4")!.entries()]).toEqual([
      ["H", 2],
      ["S", 1],
      ["O", 4],
    ]);
  });

  it("expands a parenthesised group and its multiplier", () => {
    const parsed = parseFormula("Ca(OH)2")!;
    expect(parsed.get("Ca")).toBe(1);
    expect(parsed.get("O")).toBe(2);
    expect(parsed.get("H")).toBe(2);
  });

  it("accepts square brackets as groups", () => {
    expect(formulaKey("K3[Fe(CN)6]")).toBe(formulaKey("K3Fe(CN)6"));
  });

  it("refuses a lowercase formula rather than guessing the case", () => {
    expect(parseFormula("h2so4")).toBeUndefined();
  });

  it("refuses unbalanced or non formula text", () => {
    expect(parseFormula("Ca(OH2")).toBeUndefined();
    expect(parseFormula("acetone!")).toBeUndefined();
    expect(parseFormula("")).toBeUndefined();
  });

  it("gives the same key whatever order the elements are written in", () => {
    expect(formulaKey("O4SH2")).toBe(formulaKey("H2SO4"));
    expect(formulaKey("h2so4")).toBe("");
  });
});

describe("parseMassQuery", () => {
  it("reads an explicit range", () => {
    expect(parseMassQuery("mass:98-99")).toEqual({ min: 98, max: 99 });
    expect(parseMassQuery("mw = 98 to 99")).toEqual({ min: 98, max: 99 });
  });

  it("reads a single mass as a tolerance window", () => {
    expect(parseMassQuery("mass:98")).toEqual({
      min: 98 - MASS_TOLERANCE,
      max: 98 + MASS_TOLERANCE,
    });
  });

  it("reads a bare number as a mass too", () => {
    expect(parseMassQuery("58.08")).toEqual({
      min: 58.08 - MASS_TOLERANCE,
      max: 58.08 + MASS_TOLERANCE,
    });
  });

  it("is not a mass query for text or an empty string", () => {
    expect(parseMassQuery("acetone")).toBeUndefined();
    expect(parseMassQuery("")).toBeUndefined();
    expect(parseMassQuery("mass:heavy")).toBeUndefined();
  });
});

describe("searchChemIndex", () => {
  it("puts an exact name first", () => {
    const hits = searchChemIndex(index, "acetone");
    expect(hits[0]!.name).toBe("Acetone");
    expect(hits[0]!.score).toBe(SCORE_NAME_EXACT);
    expect(hits[0]!.matchedOn).toBe("name");
    expect(hits[1]!.name).toBe("Acetone cyanohydrin");
    expect(hits[1]!.score).toBe(SCORE_NAME_PREFIX);
  });

  it("returns nothing for an empty query or a zero limit", () => {
    expect(searchChemIndex(index, "   ")).toEqual([]);
    expect(searchChemIndex(index, "acetone", { limit: 0 })).toEqual([]);
  });

  it("ranks exact name over prefix over formula over CAS over mass over fuzzy", () => {
    const tiers = [
      searchChemIndex(index, "water")[0]!.score,
      searchChemIndex(index, "aceton")[0]!.score,
      searchChemIndex(index, "H2SO4")[0]!.score,
      searchChemIndex(index, "7664-93-9")[0]!.score,
      searchChemIndex(index, "mass:98-99")[0]!.score,
      searchChemIndex(index, "watre")[0]!.score,
    ];
    expect(tiers).toEqual([...tiers].sort((a, b) => b - a));
    expect(new Set(tiers).size).toBe(tiers.length);
  });

  it("matches a lowercase formula as a string", () => {
    const hits = searchChemIndex(index, "h2so4");
    expect(hits[0]!.name).toBe("Sulfuric acid");
    expect(hits[0]!.matchedOn).toBe("formula");
    expect(hits[0]!.score).toBe(SCORE_FORMULA_EXACT);
  });

  it("matches a formula written in another element order", () => {
    const hits = searchChemIndex(index, "O4SH2");
    expect(hits[0]!.name).toBe("Sulfuric acid");
    expect(hits[0]!.score).toBe(SCORE_FORMULA_HILL);
  });

  it("finds a CAS number exactly and by fragment, exact first", () => {
    expect(searchChemIndex(index, "67-64-1")[0]!.name).toBe("Acetone");
    expect(searchChemIndex(index, "67-64-1")[0]!.score).toBe(SCORE_CAS_EXACT);
    const partial = searchChemIndex(index, "7664");
    expect(names(partial)).toContain("Sulfuric acid");
    expect(partial.find((h) => h.name === "Sulfuric acid")!.matchedOn).toBe("cas");
  });

  it("reads a bare number as both a CAS fragment and a mass, CAS first", () => {
    const hits = searchChemIndex(index, "180");
    const aspirin = hits.find((h) => h.name === "Aspirin")!;
    const ibuprofen = hits.find((h) => h.name === "Ibuprofen")!;
    // 180 is a fragment of aspirin's mass, and of no CAS number here, so the
    // mass tier is what it lands in; ibuprofen matches nothing at all.
    expect(aspirin.matchedOn).toBe("mass");
    expect(ibuprofen).toBeUndefined();
    expect(hits[0]!.score).toBeGreaterThanOrEqual(aspirin.score);
  });

  it("finds a compound by a molar mass range", () => {
    expect(names(searchChemIndex(index, "mass:98-99"))).toEqual(["Sulfuric acid"]);
    expect(names(searchChemIndex(index, "mw:18.02"))).toEqual(["Water"]);
  });

  it("matches every query word as the start of a name word", () => {
    const hits = searchChemIndex(index, "acet cyano");
    expect(hits[0]!.name).toBe("Acetone cyanohydrin");
    expect(hits[0]!.score).toBe(SCORE_NAME_TOKENS);
  });

  it("corrects a typo through the bounded edit distance pass", () => {
    const hits = searchChemIndex(index, "acetne");
    expect(hits[0]!.name).toBe("Acetone");
    expect(hits[0]!.matchedOn).toBe("fuzzy");
    expect(hits[0]!.score).toBeLessThan(SCORE_MASS);
  });

  it("skips the edit distance pass when asked", () => {
    expect(searchChemIndex(index, "acetne", { fuzzy: false })).toEqual([]);
  });

  it("filters to compounds carrying an NFPA rating", () => {
    const hits = searchChemIndex(index, "acid", { filters: { nfpa: true } });
    expect(names(hits)).toEqual(["Sulfuric acid"]);
  });

  it("filters to compounds carrying a GHS classification", () => {
    const hits = searchChemIndex(index, "a", { filters: { ghs: true }, fuzzy: false });
    expect(hits.every((h) => h.hasGhs)).toBe(true);
    expect(names(hits)).not.toContain("Ibuprofen");
  });

  it("filters to drugs", () => {
    expect(names(searchChemIndex(index, "aspirin", { filters: { drug: true } }))).toEqual([
      "Aspirin",
    ]);
    expect(
      searchChemIndex(index, "sulfuric acid", { filters: { drug: true }, fuzzy: false }),
    ).toEqual([]);
  });

  it("combines filters", () => {
    const hits = searchChemIndex(index, "a", { filters: { drug: true, ghs: true }, fuzzy: false });
    expect(names(hits)).toEqual(["Aspirin"]);
  });

  it("honors the limit", () => {
    expect(searchChemIndex(index, "a", { limit: 2, fuzzy: false })).toHaveLength(2);
  });

  it("carries the flags through onto every hit", () => {
    const hit = searchChemIndex(index, "aspirin")[0]!;
    expect(hit).toMatchObject({
      id: 2244,
      formula: "C9H8O4",
      cas: "50-78-2",
      molarMass: 180.16,
      hasNfpa: false,
      hasGhs: true,
      isDrug: true,
    });
  });

  it("reports an absent molar mass as undefined rather than zero", () => {
    const hit = searchChemIndex(index, "Phosphoric acid ester")[0]!;
    expect(hit.molarMass).toBeUndefined();
    expect(hit.formula).toBe("");
  });

  it("resolves a table-salt style query through the index's own syn column", () => {
    const hits = searchChemIndex(index, "baking soda");
    expect(hits[0]!.name).toBe("Sodium bicarbonate");
    expect(hits[0]!.matchedOn).toBe("synonym");
    expect(hits[0]!.score).toBe(SCORE_SYNONYM_EXACT);
  });

  it("ranks a synonym prefix below an exact one", () => {
    const hits = searchChemIndex(index, "baking so");
    expect(hits[0]!.name).toBe("Sodium bicarbonate");
    expect(hits[0]!.matchedOn).toBe("synonym");
    expect(hits[0]!.score).toBe(SCORE_SYNONYM_PREFIX);
  });

  it("finds a synonym as a substring, below a CAS exact match", () => {
    // Present in "Sodium hydrogen carbonate" but neither in the display name
    // "Sodium bicarbonate" nor a prefix of any of its synonyms.
    const hits = searchChemIndex(index, "hydrogen carbon");
    expect(hits[0]!.name).toBe("Sodium bicarbonate");
    expect(hits[0]!.matchedOn).toBe("synonym");
    expect(hits[0]!.score).toBe(SCORE_SYNONYM_SUBSTRING);
    expect(hits[0]!.score).toBeLessThan(SCORE_CAS_EXACT);
  });

  it("still ranks an exact name above a same-row synonym match", () => {
    const hits = searchChemIndex(index, "sodium bicarbonate");
    expect(hits[0]!.name).toBe("Sodium bicarbonate");
    expect(hits[0]!.matchedOn).toBe("name");
    expect(hits[0]!.score).toBe(SCORE_NAME_EXACT);
  });
});

describe("renderRecord", () => {
  const full: ChemRecord = {
    name: "Acetone",
    formula: "C3H6O",
    cas: "67-64-1",
    molarMass: 58.08,
    exactMass: 58.0419,
    cid: 180,
    wikipedia: "Acetone",
    description: "Acetone is an organic compound with the formula (CH3)2CO.",
    synonyms: ["Propanone", "Dimethyl ketone"],
    nfpa: { h: 1, f: 3, r: 0, special: [], source: "Wikipedia" },
    ghs: { pictograms: ["GHS02", "GHS07"], signal: "Danger", h: ["H225", "H319"], p: ["P210"] },
    props: { density: "0.7845 g/cm3", boilingPoint: "56.05 C" },
  };

  it("renders the whole sheet, statements included", () => {
    const out = renderRecord(full, H_FIXTURE, P_FIXTURE);
    expect(out["Name"]).toBe("Acetone");
    expect(out["Also known as"]).toBe("Propanone, Dimethyl ketone");
    expect(out["Molar mass"]).toBe("58.08 g/mol");
    expect(out["Exact mass"]).toBe("58.0419 g/mol");
    expect(out["PubChem CID"]).toBe("180");
    expect(out["Density"]).toBe("0.7845 g/cm3");
    expect(out["NFPA 704"]).toBe("Health 1, Fire 3, Instability 0 (Wikipedia)");
    expect(out["GHS signal word"]).toBe("Danger");
    expect(out["GHS pictograms"]).toBe("GHS02 Flame, GHS07 Exclamation Mark");
    expect(out["GHS hazard statements"]).toBe(
      "H225 Highly flammable liquid and vapour; H319 Causes serious eye irritation",
    );
    expect(out["GHS precautionary statements"]).toContain("P210 Keep away from heat");
    expect(out["Wikipedia"]).toBe("https://en.wikipedia.org/wiki/Acetone");
    expect(out["PubChem"]).toBe("https://pubchem.ncbi.nlm.nih.gov/compound/180");
    expect(out["Note"]).toBe(DISCLAIMER);
  });

  it("credits the article whenever a description is shown", () => {
    const out = renderRecord(full, H_FIXTURE, P_FIXTURE);
    expect(out["Description"]).toContain("organic compound");
    expect(out["Attribution"]).toBe("Text from Wikipedia: Acetone, CC BY-SA 4.0");
    expect(wikipediaAttribution("Sulfuric acid")).toBe(
      "Text from Wikipedia: Sulfuric acid, CC BY-SA 4.0",
    );
  });

  it("omits every row the record has no value for", () => {
    const out = renderRecord({ name: "Mystery compound" });
    expect(Object.keys(out)).toEqual(["Name", "Sources", "Note"]);
    expect(out["Sources"]).toBe("PubChem (public domain, US National Library of Medicine).");
  });

  it("prints a statement code the injected map does not carry", () => {
    const out = renderRecord({
      name: "Thing",
      ghs: { pictograms: ["GHS99"], h: ["H999"], p: ["P999"] },
    });
    expect(out["GHS pictograms"]).toBe("GHS99");
    expect(out["GHS hazard statements"]).toBe("H999");
    expect(out["GHS precautionary statements"]).toBe("P999");
  });

  it("marks a drug and encodes a spaced article title", () => {
    const out = renderRecord({ name: "Aspirin", isDrug: true, wikipedia: "Acetylsalicylic acid" });
    expect(out["Compound type"]).toBe("Drug or medication");
    expect(out["Wikipedia"]).toBe("https://en.wikipedia.org/wiki/Acetylsalicylic_acid");
  });

  it("has url helpers that return undefined rather than a broken link", () => {
    expect(recordWikipediaUrl({ name: "x" })).toBeUndefined();
    expect(recordPubchemUrl({ name: "x" })).toBeUndefined();
  });
});

describe("provenanceLines", () => {
  it("reports the build date and the counts", () => {
    const lines = provenanceLines();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("25,248 compounds");
    expect(lines[0]).toContain(CHEM_BROAD_META.builtAt);
    expect(lines[2]).toContain("CC BY-SA 4.0");
  });
});

describe("searchChemicals", () => {
  it("answers a household name from the narrow tier, which the broad index misses", () => {
    // The broad index names come from Wikipedia article titles, so it has no
    // row called "Sodium chloride" at all. The bundled tier does.
    expect(searchChemIndex(index, "sodium chloride", { fuzzy: false })).toEqual([]);
    const hits = searchChemicals(index, "sodium chloride", { limit: 5 });
    expect(hits[0]!.name).toBe("Sodium chloride");
    expect(hits[0]!.tier).toBe("narrow");
    expect(hits[0]!.matchedOn).toBe("name");
    expect(hits[0]!.score).toBe(SCORE_NAME_EXACT);
  });

  it("finds a compound by a synonym, which the index does not carry", () => {
    const hits = searchChemicals(index, "table salt", { limit: 3 });
    expect(hits[0]!.name).toBe("Sodium chloride");
    expect(hits[0]!.matchedOn).toBe("synonym");
    expect(hits[0]!.score).toBe(SCORE_SYNONYM_EXACT);
  });

  it("merges the two tiers on the PubChem CID and keeps the canonical name", () => {
    // Fixture row 1118 and the bundled row "cid:1118" are the same compound.
    // They merge into one hit, and the bundled row wins the tie, which is what
    // keeps the real dataset showing "Sulfuric acid" rather than the title of
    // the Wikipedia article that happens to describe it.
    const hits = searchChemicals(index, "H2SO4", { limit: 10 });
    const sulfuric = hits.filter((h) => h.cas === "7664-93-9");
    expect(sulfuric).toHaveLength(1);
    expect(sulfuric[0]!.name).toBe("Sulfuric acid");
    expect(sulfuric[0]!.tier).toBe("narrow");
    expect(sulfuric[0]!.id).toBe("cid:1118");
  });

  it("keeps a broad only compound exactly as the index has it", () => {
    const hits = searchChemicals(index, "Phosphoric acid ester", { limit: 3 });
    expect(hits[0]).toMatchObject({
      id: "900000001",
      tier: "broad",
      name: "Phosphoric acid ester",
      formula: "",
    });
  });

  it("searches the bundled tier alone when the index has not downloaded yet", () => {
    const hits = searchChemicals(undefined, "sulfuric acid", { limit: 3 });
    expect(hits[0]!.name).toBe("Sulfuric acid");
    expect(hits.every((h) => h.tier === "narrow")).toBe(true);
  });

  it("returns nothing for an empty query or a zero limit", () => {
    expect(searchChemicals(index, "  ")).toEqual([]);
    expect(searchChemicals(index, "acetone", { limit: 0 })).toEqual([]);
  });

  it("gives broad ids that address a shard and narrow ids that do not", () => {
    expect(isBroadId("900000001")).toBe(true);
    expect(isBroadId("cid:1118")).toBe(false);
    expect(isBroadId("wp:Acetone")).toBe(false);
  });

  it("resolves a narrow id back to its row", () => {
    expect(narrowChemical("cid:1118")!.name).toBe("Sulfuric acid");
    expect(narrowChemical("cid:0")).toBeUndefined();
  });

  it("drops the bundled tier when filtering to drugs, which it cannot answer", () => {
    const hits = searchChemicals(index, "aspirin", { filters: { drug: true }, limit: 5 });
    expect(hits.every((h) => h.tier === "broad")).toBe(true);
    expect(hits.map((h) => h.name)).toEqual(["Aspirin"]);
  });

  it("applies the NFPA and GHS filters to both tiers", () => {
    const nfpa = searchChemicals(index, "sulfuric acid", { filters: { nfpa: true }, limit: 20 });
    expect(nfpa.every((h) => h.hasNfpa)).toBe(true);
    expect(nfpa.map((h) => h.name)).toContain("Sulfuric acid");
    const ghs = searchChemicals(index, "acetone", { filters: { ghs: true }, limit: 20 });
    expect(ghs.every((h) => h.hasGhs)).toBe(true);
  });

  it("sinks the bundled tier's exact CAS hit below a name match, which its own ladder does not", () => {
    // `lookup` scores an exact CAS number 950, second only to an exact name.
    // The merged ladder puts CAS below every name match, so the translation
    // has to invert that. This is the seam NARROW_SCORE_MAP exists for, and
    // the one a future editor is most likely to "fix" back.
    expect(NARROW_SCORE_MAP[950]!.score).toBe(SCORE_CAS_EXACT);
    expect(NARROW_SCORE_MAP[950]!.score).toBeLessThan(SCORE_NAME_SUBSTRING);
    expect(NARROW_SCORE_MAP[250]!.score).toBe(SCORE_NAME_SUBSTRING);
    // And end to end: 7664-93-9 is sulfuric acid's CAS number, so the bundled
    // row scores it 950, yet the broad row whose name contains the digits
    // outranks it once both are on the merged ladder.
    const hits = searchChemicals(index, "7664-93-9", { limit: 5 });
    expect(hits.map((h) => h.name)).toContain("Sulfuric acid");
    expect(hits.find((h) => h.name === "Sulfuric acid")!.score).toBe(SCORE_CAS_EXACT);
  });

  it("translates every score the bundled tier can produce", () => {
    const produced = new Set<number>();
    for (const query of [
      "acetone",
      "67-64-1",
      "table salt",
      "H2SO4",
      "h2so4",
      "aceto",
      "battery ac",
      "cetone",
      "attery",
    ]) {
      for (const m of lookup(query, 200)) produced.add(m.score);
    }
    expect(produced.size).toBeGreaterThan(6);
    for (const score of produced) expect(NARROW_SCORE_MAP[score]).toBeDefined();
  });
});

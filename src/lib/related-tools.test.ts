import { describe, expect, it } from "vitest";
import { relatedTools, type RelatedTool } from "./related-tools";

function tool(overrides: Partial<RelatedTool> & { slug: string; name: string }): RelatedTool {
  return {
    description: "",
    category: "Data",
    keywords: [],
    ...overrides,
  };
}

const json = tool({
  slug: "json-formatter",
  name: "JSON Formatter",
  category: "Data",
  keywords: ["json", "pretty print", "validate", "minify"],
});

/** Four shared subject words, which is what CROSS_CATEGORY_MIN asks for. */
const strongOutsider = tool({
  slug: "yaml-beautifier",
  name: "YAML Beautifier",
  category: "Dev",
  keywords: ["json", "pretty print", "minify"],
});

const noOverlap = (slug: string, name: string, category = "Text") =>
  tool({ slug, name, category, keywords: ["nothing", "shared", "here"] });

describe("relatedTools", () => {
  it("puts every category sibling ahead of an outsider that qualifies on overlap", () => {
    const sibling = tool({ slug: "csv-viewer", name: "CSV Viewer", category: "Data" });

    const result = relatedTools(json, [json, strongOutsider, sibling]);

    expect(result.map((t) => t.slug)).toEqual(["csv-viewer", "yaml-beautifier"]);
  });

  it("ranks siblings against each other by shared vocabulary", () => {
    const overlapping = tool({
      slug: "json-schema-validator",
      name: "JSON Schema Validator",
      category: "Data",
      keywords: ["json", "validate"],
    });
    const bare = tool({ slug: "sqlite-viewer", name: "SQLite Browser", category: "Data" });

    const result = relatedTools(json, [json, bare, overlapping]);

    expect(result.map((t) => t.slug)).toEqual(["json-schema-validator", "sqlite-viewer"]);
  });

  it("never fills the list with tools that share nothing at all", () => {
    const siblings = Array.from({ length: 2 }, (_, i) =>
      tool({ slug: `data-${i}`, name: `Data ${i}`, category: "Data" }),
    );
    const strangers = Array.from({ length: 6 }, (_, i) => noOverlap(`stranger-${i}`, `Zed ${i}`));

    const result = relatedTools(json, [json, ...siblings, ...strangers]);

    expect(result.map((t) => t.slug)).toEqual(["data-0", "data-1"]);
  });

  it("does not treat a shared generic word like calculator as relatedness", () => {
    // The live bug: a chemistry calculator recommending a 3D printing one.
    const molar = tool({
      slug: "molar-mass-calculator",
      name: "Molar Mass Calculator",
      category: "Chemistry",
      keywords: ["molecular weight", "chemical formula", "grams per mole"],
    });
    const printCost = tool({
      slug: "print-cost-calculator",
      name: "3D Print Cost Calculator",
      category: "Hardware",
      keywords: ["filament weight", "grams of filament", "free online calculator"],
    });
    const chemistry = Array.from({ length: 3 }, (_, i) =>
      tool({ slug: `chem-${i}`, name: `Chem ${i}`, category: "Chemistry" }),
    );

    const result = relatedTools(molar, [molar, printCost, ...chemistry]);

    expect(result.map((t) => t.slug)).not.toContain("print-cost-calculator");
    expect(result).toHaveLength(3);
  });

  it("reaches for weaker overlaps only when fewer than three tools qualify", () => {
    // A category of one, so there are no siblings and nothing meets the bar.
    const only = tool({
      slug: "light-meter",
      name: "Light Meter",
      category: "Mobile",
      keywords: ["lux", "exposure"],
    });
    const weak = tool({
      slug: "photography-calculator",
      name: "Photography Calculators",
      category: "Geo",
      keywords: ["exposure"],
    });
    const strangers = Array.from({ length: 4 }, (_, i) => noOverlap(`stranger-${i}`, `Zed ${i}`));

    const result = relatedTools(only, [only, weak, ...strangers]);

    expect(result.map((t) => t.slug)).toEqual(["photography-calculator"]);
  });

  it("finds relatedness through a single-hop search synonym", () => {
    // search-synonyms.ts maps "sound" -> ["audio", "tone"].
    const soundTool = tool({
      slug: "tone-generator",
      name: "Tone Generator",
      category: "Audio",
      keywords: ["sound"],
    });
    const audioTool = tool({
      slug: "audio-trimmer",
      name: "Audio Trimmer",
      category: "Media",
      keywords: ["audio"],
    });
    const unrelated = noOverlap("cron-parser", "Cron Parser", "Dev");

    const result = relatedTools(soundTool, [soundTool, audioTool, unrelated], 3);

    expect(result.map((t) => t.slug)).toEqual(["audio-trimmer"]);
  });

  it("excludes the tool itself even when it appears in allMetas", () => {
    const other = tool({ slug: "csv-formatter", name: "CSV Formatter" });
    const result = relatedTools(json, [json, other]);
    expect(result.some((t) => t.slug === json.slug)).toBe(false);
  });

  it("breaks ties deterministically by name", () => {
    const zeta = tool({ slug: "zeta", name: "Zeta Tool", category: "Data" });
    const alpha = tool({ slug: "alpha", name: "Alpha Tool", category: "Data" });
    const beta = tool({ slug: "beta", name: "Beta Tool", category: "Data" });

    const result = relatedTools(json, [json, zeta, alpha, beta]);
    expect(result.map((t) => t.slug)).toEqual(["alpha", "beta", "zeta"]);
  });

  it("clamps the requested count to between 3 and 6", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      tool({ slug: `tool-${i}`, name: `Tool ${i}`, category: "Data" }),
    );
    expect(relatedTools(json, [json, ...many]).length).toBe(6);
    expect(relatedTools(json, [json, ...many], 1).length).toBe(3);
    expect(relatedTools(json, [json, ...many], 100).length).toBe(6);
  });

  it("returns an empty list rather than an unrelated one", () => {
    expect(relatedTools(json, [json])).toEqual([]);
    expect(relatedTools(json, [json, noOverlap("stranger", "Zed")])).toEqual([]);
  });
});

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
  keywords: ["json", "pretty print", "validate"],
});

describe("relatedTools", () => {
  it("ranks same-category tools above unrelated tools with no overlap", () => {
    const sameCategory = tool({ slug: "yaml-formatter", name: "YAML Formatter", category: "Data" });
    const otherCategory = tool({ slug: "qr-code-generator", name: "QR Code Generator", category: "QR" });
    const filler = Array.from({ length: 4 }, (_, i) =>
      tool({ slug: `filler-${i}`, name: `Filler ${i}`, category: "Text" }),
    );

    const result = relatedTools(json, [json, sameCategory, otherCategory, ...filler]);
    const slugs = result.map((t) => t.slug);
    expect(slugs.indexOf("yaml-formatter")).toBeLessThan(slugs.indexOf("qr-code-generator"));
  });

  it("boosts tools by shared keyword and name vocabulary regardless of category", () => {
    const overlapping = tool({
      slug: "json-to-csv",
      name: "JSON to CSV",
      category: "Dev",
      keywords: ["json", "convert"],
    });
    const unrelated = tool({ slug: "cron-parser", name: "Cron Parser", category: "Dev" });

    const result = relatedTools(json, [json, overlapping, unrelated], 3);
    const slugs = result.map((t) => t.slug);
    expect(slugs.indexOf("json-to-csv")).toBeLessThan(slugs.indexOf("cron-parser"));
  });

  it("finds relatedness through a single-hop search synonym", () => {
    // search-synonyms.ts maps "sound" -> ["audio", "tone"].
    const soundTool = tool({ slug: "tone-generator", name: "Tone Generator", category: "Audio", keywords: ["sound"] });
    const audioTool = tool({ slug: "audio-trimmer", name: "Audio Trimmer", category: "Media", keywords: ["audio"] });
    const unrelated = tool({ slug: "cron-parser", name: "Cron Parser", category: "Dev" });

    const result = relatedTools(soundTool, [soundTool, audioTool, unrelated], 3);
    const slugs = result.map((t) => t.slug);
    expect(slugs.indexOf("audio-trimmer")).toBeLessThan(slugs.indexOf("cron-parser"));
  });

  it("excludes the tool itself even when it appears in allMetas", () => {
    const other = tool({ slug: "csv-formatter", name: "CSV Formatter" });
    const result = relatedTools(json, [json, other]);
    expect(result.some((t) => t.slug === json.slug)).toBe(false);
  });

  it("breaks ties deterministically by name", () => {
    const zeta = tool({ slug: "zeta", name: "Zeta Tool", category: "Text" });
    const alpha = tool({ slug: "alpha", name: "Alpha Tool", category: "Text" });
    const beta = tool({ slug: "beta", name: "Beta Tool", category: "Text" });

    const result = relatedTools(json, [json, zeta, alpha, beta]);
    expect(result.map((t) => t.slug)).toEqual(["alpha", "beta", "zeta"]);
  });

  it("clamps results to between 3 and 6, and never exceeds available candidates", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      tool({ slug: `tool-${i}`, name: `Tool ${i}`, category: "Text" }),
    );
    expect(relatedTools(json, [json, ...many]).length).toBe(6);
    expect(relatedTools(json, [json, ...many], 1).length).toBe(3);
    expect(relatedTools(json, [json, ...many], 100).length).toBe(6);

    const few = [tool({ slug: "one", name: "One", category: "Text" })];
    expect(relatedTools(json, [json, ...few]).length).toBe(1);
  });

  it("returns an empty list when there are no other tools", () => {
    expect(relatedTools(json, [json])).toEqual([]);
  });
});

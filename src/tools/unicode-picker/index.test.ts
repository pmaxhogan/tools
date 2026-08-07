import { describe, expect, it } from "vitest";
import { MAX_RESULTS, run, search } from "./index";
import { CATEGORIES, ENTRIES } from "./data";
import { meta } from "./meta";
import { ToolError } from "../types";

const opts = (category = "all") => ({ category });
const ZWSP = String.fromCodePoint(0x200b);
const NBSP = String.fromCodePoint(0x00a0);

describe("unicode-picker", () => {
  it("finds arrows by keyword", () => {
    const out = run("arrow", opts());
    expect(Object.keys(out)).toContain("→");
    expect(out["→"]).toBe("rightwards arrow · U+2192 · &rarr;");
  });

  it("matches every word of a multi-word query", () => {
    const out = run("left arrow", opts());
    expect(out["←"]).toContain("leftwards arrow");
    expect(Object.keys(out)).not.toContain("→");
  });

  it("matches the character itself and ranks it first", () => {
    const out = run("—", opts());
    expect(Object.keys(out)[0]).toBe("—");
    expect(out["—"]).toBe("em dash · U+2014 · &mdash;");
  });

  it("filters by category", () => {
    const hits = search("", "greek");
    expect(hits.length).toBeGreaterThan(40);
    expect(hits.every((e) => e.category === "greek")).toBe(true);
    const out = run("sigma", opts("greek"));
    expect(out["Σ"]).toContain("greek capital letter sigma");
    // The same query outside its category finds nothing.
    expect(Object.keys(run("sigma", opts("currency")))).toEqual(["No matches"]);
  });

  it("returns an informative row instead of an error when nothing matches", () => {
    const out = run("zzzznope", opts());
    expect(Object.keys(out)).toEqual(["No matches"]);
    expect(out["No matches"]).toMatch(/zzzznope/);
    expect(out["No matches"]).toMatch(/Try a shorter query/);
  });

  it("rejects an unknown category with an actionable ToolError", () => {
    expect(() => run("arrow", opts("emoji"))).toThrowError(ToolError);
    try {
      run("arrow", opts("emoji"));
    } catch (e) {
      expect((e as ToolError).code).toBe("unknown-category");
      expect((e as ToolError).fix).toMatch(/arrows/);
    }
  });

  it("caps output at 100 rows plus a summary row", () => {
    const out = run("", opts());
    const keys = Object.keys(out);
    expect(keys).toHaveLength(MAX_RESULTS + 1);
    const overflow = keys[keys.length - 1]!;
    expect(overflow).toBe(`…and ${ENTRIES.length - MAX_RESULTS} more`);
    // Must not collide with the horizontal ellipsis entry.
    expect(overflow).not.toBe("…");
  });

  it("finds invisible characters by name", () => {
    const out = run("zero width space", opts("invisible"));
    expect(out[ZWSP]).toBe("zero width space · U+200B · &#x200B;");
    expect(run("no-break space", opts())[NBSP]).toContain("&nbsp;");
  });

  it("has a dataset of 300-500 unique single-code-point characters", () => {
    expect(ENTRIES.length).toBeGreaterThanOrEqual(300);
    expect(ENTRIES.length).toBeLessThanOrEqual(500);
    expect(new Set(ENTRIES.map((e) => e.char)).size).toBe(ENTRIES.length);
    for (const e of ENTRIES) expect([...e.char]).toHaveLength(1);
  });

  it("has a code point matching the character for every entry", () => {
    for (const e of ENTRIES) {
      const expected = "U+" + e.char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
      expect(e.codepoint, e.name).toBe(expected);
    }
  });

  it("has a well-formed name, category and HTML entity for every entry", () => {
    const ids = new Set(CATEGORIES.map((c) => c.id));
    for (const e of ENTRIES) {
      expect(e.name, e.codepoint).toBe(e.name.toLowerCase());
      expect(e.name.length, e.codepoint).toBeGreaterThan(1);
      expect(ids.has(e.category), e.codepoint).toBe(true);
      expect(e.htmlEntity, e.codepoint).toMatch(/^&(#x[0-9A-F]+|[A-Za-z][A-Za-z0-9]*);$/);
      if (e.htmlEntity.startsWith("&#x"))
        expect(e.htmlEntity).toBe(`&#x${e.char.codePointAt(0)!.toString(16).toUpperCase()};`);
    }
  });

  it("keeps every category populated and reachable from meta", () => {
    const used = new Set(ENTRIES.map((e) => e.category));
    expect([...used].sort()).toEqual([...CATEGORIES.map((c) => c.id)].sort());

    const categorySelect = meta.options?.[0];
    expect(categorySelect?.kind).toBe("select");
    if (categorySelect?.kind !== "select") throw new Error("expected a select option");
    expect(categorySelect.default).toBe("all");
    expect(categorySelect.options?.map((o) => o.value)).toEqual([
      "all",
      ...CATEGORIES.map((c) => c.id),
    ]);
    expect(categorySelect.options?.slice(1).map((o) => o.label)).toEqual(
      CATEGORIES.map((c) => c.label),
    );
    // Every option carries real search synonyms (the dropdown contract).
    expect(categorySelect.options?.every((o) => (o.synonyms?.length ?? 0) > 0)).toBe(true);
  });

  it("quotes the real dataset size in the page copy", () => {
    // The copy names a count; regenerating data.ts must not silently make it a lie.
    expect(meta.copy.what).toContain(String(ENTRIES.length));
    expect(meta.copy.faq[2]!.a).toContain(String(ENTRIES.length));
  });

  it("defaults a missing category to all", () => {
    expect(Object.keys(run("euro sign", {} as { category: string }))).toContain("€");
  });
});

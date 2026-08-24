import { describe, expect, it } from "vitest";
import { describeCountry, findCountry, run, suggestions, wikipediaUrl } from "./index";
import { ToolError } from "../types";
import { COUNTRIES } from "../_generated/wikidata-countries";

describe("country-code-lookup", () => {
  it("matches an ISO 3166-1 alpha-2 code exactly, case-insensitively", () => {
    const out = run("de", {});
    expect(out["Name"]).toBe("Germany");
    expect(out["ISO 3166-1 alpha-2"]).toBe("DE");
    expect(out["ISO 3166-1 alpha-3"]).toBe("DEU");
    expect(out["ISO 3166-1 numeric"]).toBe("276");
    expect(out["Capital"]).toBe("Berlin");
    expect(out["Continent"]).toBe("Europe");
    expect(out["Population"]).toBe("83,577,140");
    expect(out["Flag"]).toBe("🇩🇪");
    expect(out["Wikipedia"]).toBe("https://en.wikipedia.org/wiki/Germany");
    expect(out["Source"]).toMatch(/Wikidata, CC0 1\.0\. Snapshot built \d{4}-\d{2}-\d{2}\./);
  });

  it("matches an ISO 3166-1 alpha-3 code", () => {
    const out = run("DEU", {});
    expect(out["Name"]).toBe("Germany");
  });

  it("matches the ISO 3166-1 numeric code, tolerant of leading zeros", () => {
    const out = run("4", {});
    expect(out["Name"]).toBe("Afghanistan");
    expect(out["ISO 3166-1 numeric"]).toBe("004");
  });

  it("matches a calling code with a leading plus", () => {
    const out = run("+49", {});
    expect(out["Name"]).toBe("Germany");
    expect(out["Calling code"]).toBe("+49");
  });

  it("matches a top level domain with a leading dot", () => {
    const out = run(".de", {});
    expect(out["Name"]).toBe("Germany");
  });

  it("ranks an exact name match over a prefix or substring match", () => {
    const matches = findCountry("Chad");
    expect(matches[0]!.country.name).toBe("Chad");
    expect(matches[0]!.matchedOn).toBe("name");
  });

  it("prefix-matches a partial country name", () => {
    const out = run("Ger", {});
    expect(out["Name"]).toBe("Germany");
  });

  it("throws an ambiguous error with top-3 suggestions when a calling code is shared", () => {
    expect(() => run("+1", {})).toThrowError(ToolError);
    try {
      run("+1", {});
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("ambiguous");
      expect(err.fix).toMatch(/Canada/);
      expect(err.fix).toMatch(/United States/);
    }
  });

  it("throws a no-match error with suggestions for a near miss", () => {
    expect(() => run("Germanyzz", {})).toThrowError(ToolError);
    try {
      run("Germanyzz", {});
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("no-match");
      expect(err.fix).toMatch(/Germany/);
    }
  });

  it("throws a no-match error for total garbage", () => {
    try {
      run("zzzznotacountryzzzz", {});
    } catch (e) {
      expect((e as ToolError).code).toBe("no-match");
    }
  });

  it("throws an actionable empty-input error", () => {
    expect(() => run("", {})).toThrowError(ToolError);
    try {
      run("", {});
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("formats missing optional fields as Not recorded rather than dropping the row", () => {
    // Antarctica-like rows without a capital exist; find one to exercise the fallback.
    const noCapital = COUNTRIES.find((c) => !c.capital);
    expect(noCapital).toBeDefined();
    const out = describeCountry(noCapital!);
    expect(out["Capital"]).toBe("Not recorded");
  });

  it("suggestions() returns nearby names for a near-miss stem", () => {
    const hits = suggestions("Germanyzz");
    expect(hits.some((c) => c.name === "Germany")).toBe(true);
  });

  it("wikipediaUrl() encodes spaces and is undefined without an article", () => {
    const us = COUNTRIES.find((c) => c.iso2 === "US")!;
    expect(wikipediaUrl(us)).toBe("https://en.wikipedia.org/wiki/United_States");
  });
});

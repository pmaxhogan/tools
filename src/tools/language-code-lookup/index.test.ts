import { describe, expect, it } from "vitest";
import { describeLanguage, findLanguage, findScript, run, suggestions } from "./index";
import { ToolError } from "../types";
import { LANGUAGES } from "../_generated/wikidata-languages";

describe("language-code-lookup", () => {
  describe("language matching", () => {
    it("matches an ISO 639-1 code exactly", () => {
      const out = run("ja", {});
      expect(out["Type"]).toBe("Language");
      expect(out["Name"]).toBe("Japanese");
      expect(out["Native name"]).toBe("日本語");
      expect(out["ISO 639-1"]).toBe("ja");
      expect(out["ISO 639-2"]).toBe("jpn");
      expect(out["ISO 639-3"]).toBe("jpn");
      expect(out["Scripts"]).toContain("hiragana (Hira)");
      expect(out["Speakers"]).toBe("128,000,000");
      expect(out["Family"]).toBe("Japonic");
      expect(out["Wikipedia"]).toBe("https://en.wikipedia.org/wiki/Japanese_language");
    });

    it("matches an English name exactly, case-insensitively", () => {
      const out = run("swahili", {});
      expect(out["Name"]).toBe("Swahili");
      expect(out["ISO 639-1"]).toBe("sw");
    });

    it("prefers an exact language name match over a script name that also matches", () => {
      // "Japanese writing system" (script code Jpan) also prefix-matches this
      // query, but the exact language name match must win.
      const out = run("Japanese", {});
      expect(out["Type"]).toBe("Language");
      expect(out["Name"]).toBe("Japanese");
    });

    it("ranks an exact match ahead of a prefix match", () => {
      const matches = findLanguage("Japanese");
      expect(matches[0]!.language.name).toBe("Japanese");
      expect(matches[0]!.matchedOn).toBe("name");
    });

    it("treats an empty scripts array as Not recorded, not as no script", () => {
      const french = LANGUAGES.find((l) => l.iso1 === "fr")!;
      expect(french.scripts).toEqual([]);
      const out = describeLanguage(french);
      expect(out["Scripts"]).toBe("Not recorded");
    });

    it("throws an ambiguous error when two languages share an English name", () => {
      // Two unrelated ISO 639-3 languages are both named "Bemba".
      expect(() => run("Bemba", {})).toThrowError(ToolError);
      try {
        run("Bemba", {});
      } catch (e) {
        const err = e as ToolError;
        expect(err.code).toBe("ambiguous");
        expect(err.fix).toMatch(/bem/);
        expect(err.fix).toMatch(/bmy/);
      }
    });

    it("throws a no-match error for garbage", () => {
      try {
        run("zzzznotalanguagezzzz", {});
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

    it("suggestions() returns nearby names for a near-miss stem", () => {
      const hits = suggestions("Japanesezz");
      expect(hits.some((l) => l.name === "Japanese")).toBe(true);
    });
  });

  describe("script matching", () => {
    it("matches an ISO 15924 code exactly and returns a script record instead of a language", () => {
      const out = run("Latn", {});
      expect(out["Type"]).toBe("Writing script (ISO 15924)");
      expect(out["Name"]).toBe("Latin script");
      expect(out["ISO 15924 code"]).toBe("Latn");
    });

    it("matches a script by name", () => {
      const out = run("Cyrillic", {});
      expect(out["Type"]).toBe("Writing script (ISO 15924)");
      expect(out["Name"]).toBe("Cyrillic script");
      expect(out["ISO 15924 code"]).toBe("Cyrl");
    });

    it("ranks an exact script code above a name prefix match", () => {
      const matches = findScript("Latn");
      expect(matches[0]!.script.code).toBe("Latn");
      expect(matches[0]!.matchedOn).toBe("code");
    });
  });
});

import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

describe("fancy-text-generator", () => {
  it("converts a happy path string into every style", () => {
    const result = run("Hi 5", { zalgoIntensity: 40 });
    expect(result.Bold).toBe("𝐇𝐢 𝟓");
    expect(result.Italic).toBe("𝐻𝑖 5");
    expect(result["Bold Italic"]).toBe("𝑯𝒊 5");
    expect(result.Monospace).toBe("𝙷𝚒 𝟻");
    expect(result.Fullwidth).toBe("Ｈｉ　５");
    expect(result.Circled).toBe("Ⓗⓘ ⑤");
  });

  it("uses legacy math symbols for gap letters (script H, fraktur C, double-struck N)", () => {
    const result = run("HCN", { zalgoIntensity: 0 });
    expect(result.Script).toBe("ℋ\u{1D49E}\u{1D4A9}"); // H gap, C, N ok in script (C,N assigned)
    expect(result.Fraktur.charAt(0)).toBe("ℌ"); // fraktur H is a gap letter
    expect(result["Double-struck"]).toBe("ℍℂℕ"); // H, C, N are all gap letters
  });

  it("passes non-Latin characters through unchanged in every style", () => {
    const result = run("héllo мир 日本語", { zalgoIntensity: 0 });
    for (const [style, text] of Object.entries(result)) {
      // Upside Down reverses order and Strikethrough/Underline interleave combining
      // marks between every character, so neither preserves the literal substring.
      if (style === "Upside Down" || style === "Strikethrough" || style === "Underline") continue;
      expect(text).toContain("мир");
      expect(text).toContain("日本語");
    }
  });

  it("passes digits through unchanged for italic and bold-italic (no dedicated math digit glyphs)", () => {
    const result = run("42", { zalgoIntensity: 0 });
    expect(result.Italic).toBe("42");
    expect(result["Bold Italic"]).toBe("42");
    expect(result["Sans-serif Italic"]).toBe("42");
  });

  it("reverses order for upside down and flips 6/9", () => {
    const result = run("69", { zalgoIntensity: 0 });
    expect(result["Upside Down"]).toBe("69"); // 9 flips to 6, 6 flips to 9, then order reverses
  });

  it("appends a combining mark after every character for strikethrough and underline", () => {
    const result = run("ab", { zalgoIntensity: 0 });
    expect(result.Strikethrough).toBe("a̶b̶");
    expect(result.Underline).toBe("a̲b̲");
  });

  it("zalgo is deterministic for the same input and intensity", () => {
    const first = run("test", { zalgoIntensity: 60 }).Zalgo;
    const second = run("test", { zalgoIntensity: 60 }).Zalgo;
    expect(first).toBe(second);
    expect(first!.length).toBeGreaterThan("test".length);
  });

  it("zalgo intensity 0 leaves the text unchanged", () => {
    const result = run("clean", { zalgoIntensity: 0 });
    expect(result.Zalgo).toBe("clean");
  });

  it("throws ToolError on empty input", () => {
    expect(() => run("", { zalgoIntensity: 40 })).toThrow(ToolError);
    expect(() => run("   ", { zalgoIntensity: 40 })).toThrow(ToolError);
  });

  it("defaults zalgo intensity when opts omit it or pass a non-finite value", () => {
    const result = run("x", { zalgoIntensity: Number.NaN });
    expect(result.Zalgo!.length).toBeGreaterThan(1);
  });
});

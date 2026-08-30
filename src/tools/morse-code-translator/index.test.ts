import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

const defaultOpts = { separator: "space", dotChar: "dot-dash", wpm: 20 };

describe("morse-code-translator", () => {
  it("encodes text to Morse (happy path)", () => {
    const result = run("SOS", defaultOpts);
    expect(result.Direction).toBe("Text to Morse");
    expect(result.Output).toBe("... --- ...");
  });

  it("decodes Morse to text (happy path)", () => {
    const result = run("... --- ...", defaultOpts);
    expect(result.Direction).toBe("Morse to text");
    expect(result.Output).toBe("SOS");
  });

  it("round trips a multi-word phrase through slash word separators", () => {
    const encoded = run("HI THERE", { ...defaultOpts, separator: "slash-words" });
    expect(encoded.Output).toBe(".... .. / - .... . .-. .");
    const decoded = run(encoded.Output!, defaultOpts);
    expect(decoded.Output).toBe("HI THERE");
  });

  it("encodes and decodes a prosign", () => {
    const encoded = run("<AR>", defaultOpts);
    expect(encoded.Output).toBe(".-.-.");
    const decoded = run(".-.-.", defaultOpts);
    expect(decoded.Output).toBe("<AR>");
  });

  it("renders dit/dah letter style when requested", () => {
    const result = run("E", { ...defaultOpts, dotChar: "dit-dah-letters" });
    expect(result.Output).toBe("dit");
  });

  it("computes PARIS-standard timing for the given WPM", () => {
    const result = run("E", { ...defaultOpts, wpm: 20 });
    expect(result.Timing).toContain("20 WPM");
    expect(result.Timing).toContain("dit: 60 ms");
    expect(result.Timing).toContain("dah: 180 ms");
  });

  it("throws on an unsupported character when encoding", () => {
    expect(() => run("Hello ☺", defaultOpts)).toThrow(ToolError);
  });

  it("throws on an invalid Morse sequence when decoding", () => {
    expect(() => run(".-.-.-.-.-.-.-.-", defaultOpts)).toThrow(ToolError);
  });

  it("throws ToolError on empty input", () => {
    expect(() => run("", defaultOpts)).toThrow(ToolError);
    expect(() => run("   ", defaultOpts)).toThrow(ToolError);
  });

  it("defaults WPM when opts omit a valid value", () => {
    const result = run("E", { ...defaultOpts, wpm: 0 });
    expect(result.Timing).toContain("20 WPM");
  });
});

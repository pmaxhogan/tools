import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

const defaultOpts = { alphabet: "nato", digitStyle: "standard" };

describe("nato-phonetic-alphabet", () => {
  it("spells text out using the NATO alphabet (happy path)", () => {
    const result = run("SOS", defaultOpts);
    expect(result.Direction).toBe("Text to phonetic");
    expect(result.Output).toBe("Sierra Oscar Sierra");
  });

  it("decodes phonetic words back to text", () => {
    const result = run("Alfa Bravo Charlie", defaultOpts);
    expect(result.Direction).toBe("Phonetic to text");
    expect(result.Output).toBe("ABC");
  });

  it("round trips a multi-word phrase with a word break", () => {
    const encoded = run("HI THERE", defaultOpts);
    expect(encoded.Output).toBe("Hotel India / Tango Hotel Echo Romeo Echo");
    const decoded = run(encoded.Output!, defaultOpts);
    expect(decoded.Output).toBe("HI THERE");
  });

  it("uses the US Army legacy alphabet when selected", () => {
    const result = run("AB", { ...defaultOpts, alphabet: "us-army" });
    expect(result.Output).toBe("Able Baker");
  });

  it("uses the German alphabet when selected", () => {
    const result = run("A", { ...defaultOpts, alphabet: "german" });
    expect(result.Output).toBe("Anton");
  });

  it("uses the Italian alphabet when selected", () => {
    const result = run("A", { ...defaultOpts, alphabet: "italian" });
    expect(result.Output).toBe("Ancona");
  });

  it("uses the Swedish alphabet when selected", () => {
    const result = run("A", { ...defaultOpts, alphabet: "swedish" });
    expect(result.Output).toBe("Adam");
  });

  it("spells digits with the aviation pronunciation when selected", () => {
    const result = run("39", { ...defaultOpts, digitStyle: "aviation" });
    expect(result.Output).toBe("Tree Niner");
  });

  it("decodes aviation digit words back to digits", () => {
    const result = run("Tree Niner", { ...defaultOpts, digitStyle: "aviation" });
    expect(result.Output).toBe("39");
  });

  it("throws on an unsupported character when encoding", () => {
    expect(() => run("Hi!", defaultOpts)).toThrow(ToolError);
  });

  it("throws on an unrecognized phonetic word when decoding", () => {
    expect(() => run("Alfa Bravo Zzzzz", defaultOpts)).toThrow(ToolError);
  });

  it("throws ToolError on empty input", () => {
    expect(() => run("", defaultOpts)).toThrow(ToolError);
    expect(() => run("   ", defaultOpts)).toThrow(ToolError);
  });

  it("falls back to the NATO alphabet for an unknown alphabet option", () => {
    const result = run("A", { ...defaultOpts, alphabet: "klingon" });
    expect(result.Output).toBe("Alfa");
  });
});

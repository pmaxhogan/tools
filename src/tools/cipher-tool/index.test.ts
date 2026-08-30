import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

describe("cipher-tool", () => {
  it("encodes with Caesar cipher (happy path)", () => {
    const result = run("Attack at dawn", {
      cipher: "caesar",
      mode: "encode",
      key: "3",
      bruteForce: false,
    });
    expect(result.Output).toBe("Dwwdfn dw gdzq");
  });

  it("decodes with Caesar cipher", () => {
    const result = run("Dwwdfn dw gdzq", {
      cipher: "caesar",
      mode: "decode",
      key: "3",
      bruteForce: false,
    });
    expect(result.Output).toBe("Attack at dawn");
  });

  it("round trips ROT13 (self-inverse)", () => {
    const encoded = run("Hello World", {
      cipher: "rot13",
      mode: "encode",
      key: "",
      bruteForce: false,
    });
    expect(encoded.Output).toBe("Uryyb Jbeyq");
    const decoded = run(encoded.Output!, {
      cipher: "rot13",
      mode: "encode",
      key: "",
      bruteForce: false,
    });
    expect(decoded.Output).toBe("Hello World");
  });

  it("round trips ROT47 (self-inverse)", () => {
    const encoded = run("Hello, World!", {
      cipher: "rot47",
      mode: "encode",
      key: "",
      bruteForce: false,
    });
    const decoded = run(encoded.Output!, {
      cipher: "rot47",
      mode: "encode",
      key: "",
      bruteForce: false,
    });
    expect(decoded.Output).toBe("Hello, World!");
  });

  it("round trips Atbash (self-inverse)", () => {
    const encoded = run("Hello", { cipher: "atbash", mode: "encode", key: "", bruteForce: false });
    expect(encoded.Output).toBe("Svool");
    const decoded = run(encoded.Output!, {
      cipher: "atbash",
      mode: "encode",
      key: "",
      bruteForce: false,
    });
    expect(decoded.Output).toBe("Hello");
  });

  it("encodes and decodes with Vigenere", () => {
    const encoded = run("ATTACKATDAWN", {
      cipher: "vigenere",
      mode: "encode",
      key: "LEMON",
      bruteForce: false,
    });
    expect(encoded.Output).toBe("LXFOPVEFRNHR");
    const decoded = run(encoded.Output!, {
      cipher: "vigenere",
      mode: "decode",
      key: "LEMON",
      bruteForce: false,
    });
    expect(decoded.Output).toBe("ATTACKATDAWN");
  });

  it("encodes and decodes with Affine", () => {
    const encoded = run("HELLO", {
      cipher: "affine",
      mode: "encode",
      key: "5,8",
      bruteForce: false,
    });
    const decoded = run(encoded.Output!, {
      cipher: "affine",
      mode: "decode",
      key: "5,8",
      bruteForce: false,
    });
    expect(decoded.Output).toBe("HELLO");
  });

  it("encodes and decodes with Rail fence", () => {
    const encoded = run("WEAREDISCOVEREDFLEEATONCE", {
      cipher: "railfence",
      mode: "encode",
      key: "3",
      bruteForce: false,
    });
    expect(encoded.Output).toBe("WECRLTEERDSOEEFEAOCAIVDEN");
    const decoded = run(encoded.Output!, {
      cipher: "railfence",
      mode: "decode",
      key: "3",
      bruteForce: false,
    });
    expect(decoded.Output).toBe("WEAREDISCOVEREDFLEEATONCE");
  });

  it("throws on an invalid Vigenere key", () => {
    expect(() =>
      run("Hello", { cipher: "vigenere", mode: "encode", key: "123", bruteForce: false }),
    ).toThrow(ToolError);
  });

  it("throws on a non-coprime Affine a value", () => {
    expect(() =>
      run("Hello", { cipher: "affine", mode: "encode", key: "2,8", bruteForce: false }),
    ).toThrow(ToolError);
  });

  it("runs a Caesar brute force scan of all 26 shifts", () => {
    // A long, letter-diverse pangram gives chi-squared scoring enough signal to be reliable.
    const plaintext =
      "The quick brown fox jumps over the lazy dog while thinking about cipher puzzles";
    const encoded = run(plaintext, {
      cipher: "caesar",
      mode: "encode",
      key: "3",
      bruteForce: false,
    });
    const result = run(encoded.Output!, {
      cipher: "caesar",
      mode: "encode",
      key: "3",
      bruteForce: true,
    });
    expect(Object.keys(result).length).toBe(27); // 26 shifts + Best guess
    expect(result["Best guess"]).toContain(plaintext);
  });

  it("throws ToolError on empty input", () => {
    expect(() =>
      run("", { cipher: "caesar", mode: "encode", key: "3", bruteForce: false }),
    ).toThrow(ToolError);
  });
});

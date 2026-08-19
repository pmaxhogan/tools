import { describe, expect, it } from "vitest";
import { identify, run } from "./index";
import { ToolError } from "../types";

describe("hash-identifier", () => {
  it("ranks MD5 above NTLM for a 32-hex digest", () => {
    const out = run("5f4dcc3b5aa765d61d8327deb882cf99", { hashcatMode: false });
    expect(out["Most likely"]).toBe("MD5");
    expect(out["Candidates"]).toMatch(/NTLM/);
  });

  it("identifies a 40-hex digest as SHA-1", () => {
    const out = run("da39a3ee5e6b4b0d3255bfef95601890afd80709", { hashcatMode: false });
    expect(out["Most likely"]).toBe("SHA-1");
  });

  it("recognizes bcrypt with high confidence and parses the cost factor", () => {
    const out = run("$2b$12$abcdefghijklmnopqrstuvKjLxosdLmqz0EJfW/OjNr5odiUyoxaG", {
      hashcatMode: false,
    });
    expect(out["Most likely"]).toBe("bcrypt");
    expect(out["Candidates"]).toMatch(/high/);
    expect(out["Format"]).toMatch(/cost factor 12/);
  });

  it("recognizes sha512crypt from its $6$ prefix", () => {
    const out = run("$6$rounds=5000$saltsalt$abcdefghijklmnopqrstuvwxyz0123456789", {
      hashcatMode: false,
    });
    expect(out["Most likely"]).toBe("sha512crypt");
  });

  it("flags a UUID as not a hash", () => {
    const out = run("123e4567-e89b-12d3-a456-426614174000", { hashcatMode: false });
    expect(out["Most likely"]).toMatch(/UUID/);
    expect(out["Most likely"]).toMatch(/not a hash/);
  });

  it("appends the hashcat mode number when hashcatMode is on", () => {
    const out = run("5f4dcc3b5aa765d61d8327deb882cf99", { hashcatMode: true });
    expect(out["Candidates"]).toMatch(/MD5 \(high\) \[hashcat -m 0\]/);
  });

  it("throws an actionable error on empty input", () => {
    expect(() => run("", { hashcatMode: false })).toThrowError(ToolError);
    expect(() => run("   ", { hashcatMode: false })).toThrowError(ToolError);
    try {
      run("", { hashcatMode: false });
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
      expect((e as ToolError).fix).toMatch(/5f4dcc3b/);
    }
  });

  it("reports Unknown without throwing for unrecognized junk", () => {
    const out = run("zzz!!!not_a_hash???", { hashcatMode: false });
    expect(out["Most likely"]).toBe("Unknown");
    expect(out["Candidates"]).toMatch(/No known hash/);
  });

  it("identify() returns an empty array for empty input and does not throw", () => {
    expect(identify("")).toEqual([]);
  });
});

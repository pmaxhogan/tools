import { describe, expect, it } from "vitest";
import { md5, run } from "./index";

describe("hash-generator", () => {
  describe("md5 (RFC 1321 test vectors)", () => {
    it("hashes the empty string", () => {
      expect(md5("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    });

    it('hashes "abc"', () => {
      expect(md5("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    });

    // Longer RFC 1321 vectors that force the padding to spill into a
    // second 64-byte block (62 chars) and span two full blocks (80 chars),
    // exercising the chunk-chaining path that "" and "abc" never touch.
    it("hashes a 26-char single-block message", () => {
      expect(md5("abcdefghijklmnopqrstuvwxyz")).toBe("c3fcd3d76192e4007dfb496cca67e13b");
    });

    it("hashes a 62-char message (padding spills into a second block)", () => {
      expect(md5("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")).toBe(
        "d174ab98d277d9f5a5611c2c9f419d9f",
      );
    });

    it("hashes an 80-char message spanning two full blocks", () => {
      expect(
        md5("12345678901234567890123456789012345678901234567890123456789012345678901234567890"),
      ).toBe("57edf4a22be3c955ac49da2e2107b67a");
    });
  });

  it('computes every algorithm for "abc" against known vectors', async () => {
    const out = await run("abc", { verify: "" });
    expect(out.MD5).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(out["SHA-1"]).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(out["SHA-256"]).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(out["SHA-384"]).toBe(
      "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7",
    );
    expect(out["SHA-512"]).toBe(
      "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    );
  });

  it("hashes the empty string to the well-known empty-input digests", async () => {
    const out = await run("", { verify: "" });
    expect(out.MD5).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(out["SHA-1"]).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(out["SHA-256"]).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(out["SHA-512"]).toBe(
      "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e",
    );
  });

  it("does not add a Verification row when verify is empty", async () => {
    const out = await run("abc", { verify: "" });
    expect(out.Verification).toBeUndefined();
  });

  it("reports which algorithm matched, case-insensitively", async () => {
    const out = await run("abc", {
      verify: "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD",
    });
    expect(out.Verification).toBe("Matches SHA-256");
  });

  it("reports no match when the verify value hits nothing", async () => {
    const out = await run("abc", { verify: "deadbeefdeadbeefdeadbeefdeadbeef" });
    expect(out.Verification).toBe("No match");
  });

  it("ignores surrounding whitespace in the verify option", async () => {
    const out = await run("abc", { verify: "  900150983cd24fb0d6963f7d28e17f72  " });
    expect(out.Verification).toBe("Matches MD5");
  });

  it("produces consistent digests for unicode input", async () => {
    const a = await run("héllo wörld 🌍", { verify: "" });
    const b = await run("héllo wörld 🌍", { verify: "" });
    expect(a).toEqual(b);
    expect(a.MD5).toMatch(/^[0-9a-f]{32}$/);
    expect(a["SHA-256"]).toMatch(/^[0-9a-f]{64}$/);
    // Distinct from the visually similar ASCII string.
    const ascii = await run("hello world", { verify: "" });
    expect(a.MD5).not.toBe(ascii.MD5);
  });
});

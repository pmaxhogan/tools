import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  constantTimeEqual,
  fromBase64,
  parseExpected,
  run,
  splitMessageAndKey,
  toBase64,
  toBase64Url,
  toHex,
} from "./index";

/*
 * The pinned digests below are RFC 4231 test vectors (HMAC-SHA256/384/512) and
 * RFC 2202 test vectors (HMAC-SHA1), so the assertions cross-check this tool
 * against the specifications rather than against itself.
 *
 * RFC 4231 test case 2 and RFC 2202 test case 2 both use key "Jefe" and data
 * "what do ya want for nothing?", which is the one vector expressible as plain
 * text in every algorithm without hex escapes.
 */

/**
 * The message on its own, and the key in the option the panel now shows. The
 * legacy shape (the key below a --- line in the message box) is exercised by
 * its own cases below, because links written before the option existed still
 * have to produce the same digest.
 */
const MESSAGE = "what do ya want for nothing?";
const KEY = { key: "Jefe" };
const JEFE_LEGACY = "what do ya want for nothing?\n---\nJefe";

const JEFE_SHA1 = "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79";
const JEFE_SHA256 = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
const JEFE_SHA384 =
  "af45d2e376484031617f78d2b58a6b1b9c7ef464f5a01b47e42ec3736322445e8e2240ca5e69e2c78b3239ecfab21649";
const JEFE_SHA512 =
  "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737";

describe("hmac-generator run()", () => {
  it("matches the RFC 4231 HMAC-SHA256 vector", () => {
    const out = run(MESSAGE, KEY);
    expect(out.MAC).toBe(JEFE_SHA256);
    expect(out.Algorithm).toBe("HMAC-SHA256 (RFC 2104)");
    expect(out["Digest size"]).toBe("32 bytes (256 bits)");
    expect(out["Key size"]).toBe("4 bytes");
  });

  it("matches the RFC 2202 HMAC-SHA1 vector", () => {
    expect(run(MESSAGE, { ...KEY, algorithm: "sha1" }).MAC).toBe(JEFE_SHA1);
  });

  it("matches the RFC 4231 HMAC-SHA384 and HMAC-SHA512 vectors", () => {
    expect(run(MESSAGE, { ...KEY, algorithm: "sha384" }).MAC).toBe(JEFE_SHA384);
    expect(run(MESSAGE, { ...KEY, algorithm: "sha512" }).MAC).toBe(JEFE_SHA512);
  });

  it("accepts an algorithm written with a dash, as the label spells it", () => {
    expect(run(MESSAGE, { ...KEY, algorithm: "SHA-256" }).MAC).toBe(JEFE_SHA256);
  });

  it("encodes the digest as base64 and base64url", () => {
    const b64 = run(MESSAGE, { ...KEY, encoding: "base64" }).MAC;
    const b64url = run(MESSAGE, { ...KEY, encoding: "base64url" }).MAC;
    expect(b64).toBe("W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM=");
    expect(b64url).toBe("W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM");
    expect(toHex(fromBase64(b64)!)).toBe(JEFE_SHA256);
  });

  it("reads a hex key, so a binary key does not have to be typed as text", () => {
    // "Jefe" is 4a656665 in hex, so the two spellings must agree.
    const out = run(MESSAGE, { key: "4a656665", keyEncoding: "hex" });
    expect(out.MAC).toBe(JEFE_SHA256);
  });

  it("reads a base64 key", () => {
    const out = run(MESSAGE, { key: "SmVmZQ==", keyEncoding: "base64" });
    expect(out.MAC).toBe(JEFE_SHA256);
  });

  it("normalizes CRLF in the message", () => {
    expect(run("what do ya want\r\nfor nothing?", KEY).MAC).toBe(
      run("what do ya want\nfor nothing?", KEY).MAC,
    );
  });

  it("warns about a short key and about an oversized one", () => {
    expect(run(MESSAGE, KEY).Note).toContain("short for a message authentication code");
    expect(run("msg", { key: "k".repeat(100) }).Note).toContain("adds no extra strength");
  });
});

describe("hmac-generator key sources", () => {
  it("reads the key from the option and leaves the whole input as the message", () => {
    expect(run(MESSAGE, KEY).MAC).toBe(JEFE_SHA256);
  });

  it("still reads a key below the --- line when the option is empty", () => {
    expect(run(JEFE_LEGACY, {}).MAC).toBe(JEFE_SHA256);
    expect(run(JEFE_LEGACY, { key: "" }).MAC).toBe(JEFE_SHA256);
    expect(run("what do ya want for nothing?\r\n---\r\nJefe", {}).MAC).toBe(JEFE_SHA256);
  });

  it("splits on the last separator, so a legacy message may contain dashes", () => {
    expect(splitMessageAndKey("a\n---\nb\n---\nk")).toEqual({
      message: "a\n---\nb",
      key: "k",
      hasKey: true,
    });
    expect(splitMessageAndKey("no separator here")).toEqual({
      message: "no separator here",
      key: "",
      hasKey: false,
    });
  });

  it("treats the whole input as the message once the option holds a key", () => {
    // The dashes are part of the message here, so this is not the legacy MAC.
    const out = run(JEFE_LEGACY, { key: "Jefe" });
    expect(out.MAC).not.toBe(JEFE_SHA256);
    expect(out.MAC).toBe(run(JEFE_LEGACY, { key: "Jefe" }).MAC);
  });
});

describe("hmac-generator verify mode", () => {
  it("reports a match for the correct MAC", () => {
    const out = run(MESSAGE, { ...KEY, mode: "verify", expected: JEFE_SHA256 });
    expect(out.Match).toBe("yes");
    expect(out.Comparison).toContain("equals the expected MAC");
  });

  it("accepts the expected MAC in base64 even when output is hex", () => {
    const out = run(MESSAGE, {
      ...KEY,
      mode: "verify",
      expected: "W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM=",
    });
    expect(out.Match).toBe("yes");
    expect(out["Expected MAC"]).toBe(JEFE_SHA256);
  });

  it("reports no match when one byte differs", () => {
    const tampered = `${JEFE_SHA256.slice(0, -1)}4`;
    const out = run(MESSAGE, { ...KEY, mode: "verify", expected: tampered });
    expect(out.Match).toBe("no");
    expect(out.Comparison).toContain("differs");
  });

  it("throws when verify mode has no expected MAC", () => {
    expect(() => run(MESSAGE, { ...KEY, mode: "verify" })).toThrow(ToolError);
    expect(() => run(MESSAGE, { ...KEY, mode: "verify", expected: "  " })).toThrow(/needs the MAC/);
  });

  it("throws when the expected MAC is the wrong length for the algorithm", () => {
    expect(() => run(MESSAGE, { ...KEY, mode: "verify", expected: JEFE_SHA1 })).toThrow(/32 bytes/);
  });
});

describe("hmac-generator errors", () => {
  it("throws on empty input", () => {
    expect(() => run("", {})).toThrow(ToolError);
    expect(() => run("   \n  ", {})).toThrow(/Nothing to authenticate/);
  });

  it("throws when no key is given in either place", () => {
    try {
      run("just a message", {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("empty-key");
      expect((err as ToolError).fix).toContain("Key option");
    }
  });

  it("throws when the option and the legacy key half are both blank", () => {
    expect(() => run("message\n---\n   ", { key: "  " })).toThrow(/no secret key/);
  });

  it("throws on an unknown algorithm, and says MD5 is not offered", () => {
    try {
      run(MESSAGE, { ...KEY, algorithm: "md5" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-option");
      expect((err as ToolError).fix).toContain("MD5 is deliberately not offered");
    }
  });

  it("throws on an unknown output encoding and an unknown key format", () => {
    expect(() => run(MESSAGE, { ...KEY, encoding: "base32" })).toThrow(/encoding/);
    expect(() => run(MESSAGE, { ...KEY, keyEncoding: "ascii85" })).toThrow(/keyEncoding/);
  });

  it("throws when a hex or base64 key cannot be decoded", () => {
    expect(() => run("m", { key: "zz", keyEncoding: "hex" })).toThrow(/not valid hexadecimal/);
    expect(() => run("m", { key: "!!!!", keyEncoding: "base64" })).toThrow(/not valid base64/);
  });
});

describe("hmac-generator helpers", () => {
  it("round-trips base64 and base64url", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253]);
    expect(toBase64(bytes)).toBe("AAEC+vv8/Q==");
    expect(toBase64Url(bytes)).toBe("AAEC-vv8_Q");
    expect(fromBase64(toBase64Url(bytes))).toEqual(bytes);
  });

  it("compares equal length buffers without an early exit", () => {
    const a = new Uint8Array([1, 2, 3]);
    expect(constantTimeEqual(a, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(a, new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(a, new Uint8Array([1, 2]))).toBe(false);
  });

  it("rejects an expected MAC of the wrong length in either encoding", () => {
    expect(parseExpected("abcd", 32)).toBeNull();
    expect(parseExpected("", 32)).toBeNull();
    expect(parseExpected(JEFE_SHA256, 32)).not.toBeNull();
  });
});

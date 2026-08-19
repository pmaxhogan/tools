import { describe, expect, it } from "vitest";
import { base32Decode, parseOtpauth, run } from "./index";
import { ToolError } from "../types";

/** RFC 6238 Appendix B keys, Base32 encoded. */
const KEY_SHA1 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // ASCII "12345678901234567890"
const KEY_SHA256 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA";
const KEY_SHA512 =
  "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA";

/** The Code row is grouped for readability; the vectors are not. */
const digitsOf = (out: Record<string, string>, key = "Code") => out[key].replace(/\s/g, "");

/** Minimal RFC 4648 encoder, so the key constants above can be re-derived. */
function base32Encode(ascii: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < ascii.length; i++) {
    value = (value << 8) | ascii.charCodeAt(i);
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

describe("totp-generator", () => {
  it("matches the RFC 6238 SHA1 test vectors", () => {
    const cases: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
    ];
    for (const [now, expected] of cases) {
      const out = run(KEY_SHA1, { algorithm: "SHA1", digits: "8", period: 30, now });
      expect(digitsOf(out)).toBe(expected);
    }
  });

  it("matches the RFC 6238 SHA256 and SHA512 vectors", () => {
    const sha256 = run(KEY_SHA256, { algorithm: "SHA256", digits: "8", period: 30, now: 59 });
    expect(digitsOf(sha256)).toBe("46119246");
    expect(sha256.Algorithm).toBe("SHA256");

    const sha512 = run(KEY_SHA512, { algorithm: "SHA512", digits: "8", period: 30, now: 59 });
    expect(digitsOf(sha512)).toBe("90693936");
  });

  it("re-derives the RFC key constants with an independent encoder", () => {
    expect(base32Encode("12345678901234567890")).toBe(KEY_SHA1);
    expect(base32Encode("12345678901234567890123456789012")).toBe(KEY_SHA256);
  });

  it("defaults to 6 digits, SHA1, and a 30 second period", () => {
    const out = run(KEY_SHA1, { now: 59 });
    expect(digitsOf(out)).toBe("287082");
    expect(out.Code).toBe("287 082");
    expect(out.Algorithm).toBe("SHA1");
    expect(out.Digits).toBe("6");
    expect(out.Period).toBe("30s");
  });

  it("computes the seconds remaining in the current period", () => {
    expect(run(KEY_SHA1, { now: 59 })["Valid for"]).toBe("1s");
    expect(run(KEY_SHA1, { now: 60 })["Valid for"]).toBe("30s");
    expect(run(KEY_SHA1, { now: 61 })["Valid for"]).toBe("29s");
    expect(run(KEY_SHA1, { period: 60, now: 61 })["Valid for"]).toBe("59s");
  });

  it("reports the adjacent codes, and they roll over across a boundary", () => {
    const before = run(KEY_SHA1, { digits: "8", now: 59 });
    const after = run(KEY_SHA1, { digits: "8", now: 60 });

    expect(digitsOf(before)).toBe("94287082");
    expect(digitsOf(before, "Previous")).not.toBe(digitsOf(before));
    expect(digitsOf(before, "Next")).not.toBe(digitsOf(before));
    // The code that was current at T=59 becomes "Previous" one step later.
    expect(digitsOf(after, "Previous")).toBe("94287082");
    expect(digitsOf(before, "Next")).toBe(digitsOf(after));
  });

  it("tolerates lowercase, spaces, padding, and hyphens in the secret", () => {
    const messy = "gezd gnbv-gy3t qojq gezd gnbv gy3t qojq==";
    expect(run(messy, { digits: "8", now: 59 })).toEqual(run(KEY_SHA1, { digits: "8", now: 59 }));
  });

  it("parses an otpauth URI and reports the account and issuer", () => {
    const uri =
      "otpauth://totp/ACME%20Co:john.doe%40email.com" +
      `?secret=${KEY_SHA1}&issuer=ACME%20Co&algorithm=SHA1&digits=8&period=30`;
    const out = run(uri, { algorithm: "SHA512", digits: "6", period: 60, now: 59 });

    // The URI describes itself, so it overrides the panel options.
    expect(digitsOf(out)).toBe("94287082");
    expect(out.Account).toBe("john.doe@email.com");
    expect(out.Issuer).toBe("ACME Co");
    expect(out.Algorithm).toBe("SHA1");
    expect(out.Digits).toBe("8");
    expect(out.Period).toBe("30s");
  });

  it("reads a bare label with no issuer prefix", () => {
    const parsed = parseOtpauth(`otpauth://totp/alice@example.com?secret=${KEY_SHA1}`);
    expect(parsed.account).toBe("alice@example.com");
    expect(parsed.issuer).toBeUndefined();
    expect(parsed.type).toBe("totp");
  });

  it("prefers the issuer parameter over the label prefix", () => {
    const parsed = parseOtpauth(
      `otpauth://totp/GitHub:%20alice?secret=${KEY_SHA1}&issuer=GitHub%2C%20Inc.`,
    );
    expect(parsed.issuer).toBe("GitHub, Inc.");
    expect(parsed.account).toBe("alice");
  });

  it("handles counter based otpauth hotp URIs", () => {
    const out = run(`otpauth://hotp/Bank:acct?secret=${KEY_SHA1}&counter=1&digits=8`, {});
    // Counter 1 with the 20 byte RFC key is the same HMAC as TOTP at T=59.
    expect(digitsOf(out)).toBe("94287082");
    expect(out.Counter).toBe("1");
    expect(out.Type).toBe("HOTP (counter based)");
    expect(out["Valid for"]).toBeUndefined();
    expect(digitsOf(out, "Next")).not.toBe(digitsOf(out));
  });

  it("matches the RFC 4226 HOTP vectors for counters 0 through 3", () => {
    const expected = ["755224", "287082", "359152", "969429"];
    expected.forEach((code, counter) => {
      const out = run(`otpauth://hotp/x?secret=${KEY_SHA1}&counter=${counter}`, {});
      expect(digitsOf(out)).toBe(code);
    });
  });

  it("treats a now of 0 as live time", () => {
    const before = Math.floor(Date.now() / 1000);
    const live = run(KEY_SHA1, { now: 0 });
    const after = Math.floor(Date.now() / 1000);
    // Tolerant of a step boundary landing between the two clock reads.
    const acceptable = [run(KEY_SHA1, { now: before }).Code, run(KEY_SHA1, { now: after }).Code];
    expect(acceptable).toContain(live.Code);
    // Omitting now entirely behaves the same as passing 0.
    expect(acceptable).toContain(run(KEY_SHA1, {}).Code);
  });

  it("throws empty-input on blank input", () => {
    expect(() => run("", {})).toThrowError(ToolError);
    try {
      run("   ", {});
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
      expect((e as ToolError).message).toBe("Enter a TOTP secret or an otpauth:// URI.");
      expect((e as ToolError).fix).toBe("Paste the Base32 secret from your provider.");
    }
  });

  it("throws bad-secret on characters outside the Base32 alphabet", () => {
    for (const bad of ["1", "0", "JBSWY3DPEHPK3PX!", "hello world 189"]) {
      expect(() => run(bad, { now: 59 })).toThrowError(/not valid Base32/);
    }
    try {
      run("1", { now: 59 });
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-secret");
      expect((e as ToolError).fix).toBe("TOTP secrets use A-Z and 2-7. Remove other characters.");
    }
  });

  it("throws bad-secret when the input cleans down to nothing", () => {
    expect(() => run("===", { now: 59 })).toThrowError(/not valid Base32/);
  });

  it("throws on an otpauth URI with no secret", () => {
    expect(() => run("otpauth://totp/Example:me", {})).toThrowError(/no secret parameter/);
    expect(() => run("otpauth://weird/Example?secret=" + KEY_SHA1, {})).toThrowError(
      /not a supported otpauth type/,
    );
  });

  it("rejects unusable options", () => {
    expect(() => run(KEY_SHA1, { algorithm: "md5", now: 59 })).toThrowError(/not a supported/);
    expect(() => run(KEY_SHA1, { digits: "12", now: 59 })).toThrowError(/code length/);
    expect(() => run(KEY_SHA1, { period: 0, now: 59 })).toThrowError(/not a usable period/);
    expect(() => run(KEY_SHA1, { now: "soon" })).toThrowError(/not a unix timestamp/);
  });

  it("accepts algorithm synonyms", () => {
    expect(run(KEY_SHA1, { algorithm: "sha-1", now: 59 }).Algorithm).toBe("SHA1");
    expect(run(KEY_SHA256, { algorithm: "sha 256", now: 59 }).Algorithm).toBe("SHA256");
  });

  it("decodes Base32 to the expected bytes", () => {
    expect(Array.from(base32Decode("MZXW6==="))).toEqual([0x66, 0x6f, 0x6f]);
    expect(base32Decode(KEY_SHA1).length).toBe(20);
    expect(base32Decode(KEY_SHA512).length).toBe(64);
  });

  it("uses a big-endian counter that survives past 2^32", () => {
    // A time step above 2^32 requires 64 bit counter handling; a 32 bit shift
    // implementation would silently wrap and return the code for step 0.
    const far = run(KEY_SHA1, { digits: "8", period: 1, now: 4294967296 * 2 });
    const zero = run(KEY_SHA1, { digits: "8", period: 1, now: 0.5 });
    expect(digitsOf(far)).not.toBe(digitsOf(zero));
  });
});

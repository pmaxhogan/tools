import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { fromBase64Url, parsePem, run, splitBodyAndKey, toBase64Url, toPem } from "./index";

/*
 * Cross-validation, not self-consistency.
 *
 * HS256_TOKEN is the canonical example token published on jwt.io for the
 * payload and secret below, so a green test here means this tool agrees with
 * the reference every JWT article quotes.
 *
 * RS256_TOKEN was produced with these fixtures and independently confirmed
 * with node:crypto's createSign("RSA-SHA256"), a different code path from the
 * WebCrypto call the tool makes.
 *
 * The key pairs were generated once with OpenSSL 3.x purely for this file.
 * They are published here and are therefore not secrets: never use them.
 */

const PAYLOAD = '{"sub":"1234567890","name":"John Doe","iat":1516239022}';
const SECRET = "your-256-bit-secret";

const HS256_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

const RSA_PRIVATE_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC1eDlP7bgFvS2g
GHskW00WTCSk0hJiWJLBdrWv4TPc/Pu6Z9hbxYOupDXWMNUKKvvfLTf4pWvlKcyM
LeoJwFByaw59MB2jMFzCPtg49BFNdT528COCGKu5dhCjmnUkZ8WVsfpMwAkaJTaZ
TUAb7Yb507eiIpwPU84QbYMd3lheU50i61rj+HY81TO716P3z6yyUMEfpJeZwbFu
ZitFKMsVQrPhf3obzbAL2aRIfxRLvv+9xTnmWNGQWBwEJ8ylfYDC+qWpNLsVSwE5
l+eHZrTuZkgpNYQljjypAaZLOeLllJtdC9AcsGRWBwJoFUl+yzyalXWMsEI1T/z3
Nuhvc+BLAgMBAAECggEAHmvVm8cbquagX+7KsfkWTq8cE39d8purmoAWjDICGkFU
x9aByDyvyxafKdWM2UQEblDryaSdllCwCC3oRpM1SUEWMDlhNoq0eiHD6KRNxEDr
5E90fGo7W39l4a9ShPRahLJN5hDpVbc4VHHFVgk3L+lkpusLY2xmpo1dRiQQh1tP
h0taM9XLUaECJziIfAc4ZuLac6HQPNDoqyjOaGZ0jrDHPrfPjvMaCKoKjJ0zyfm4
T1rMiwRpIaobJ5NanWTGsNmW7EVQ8xMft9wMSNQW+Agnf8k1JS1f4h14hqvcM/wC
2CQupXYO3UxSvcgRMaXoQXZ0VkML+DUQk1sUTGm4SQKBgQDpEPIWonUUvVrZ5Ow0
mTV4hAUPs9ik3KHEUggqsZ12QcgWMLw/1UgBt6AB3pPGHW/ZCuPIgZ+XOx5eUGSa
5n2kTr9rWOEYmhytRPwFHieZS5bykPo3ls/BQ+OvfAljaDS0MJHgnNXGxqR/EiZH
0KFrx9EHTm6tQHTmvc56ACsb6QKBgQDHU4jlZFBV8To1HH46hU0T/NIuMDh9Ikuv
u8imneSrbAxYDfdzfF4pjUbUZDdUBn+oal1HvCa0psZPe5I141EuSQwnGucgf024
O670BKVe24LD9ngSDPeFscUo0oM1gACvp5+JhJFWPPO23TbDePDVplOoKk0iSOQn
9VpRn2+eEwKBgQDo89AVgaHm7fD984uIc053u/VXIZq8Be8GzDtveQJ7Lfrw+xtd
7i8/0Cr1U2R+0/N0jCbqxW0feq669D3qedFBRpibkkXDEl7xbQ89iktoNJ6WqwP+
RhY4BURxpVe47XIoXJeiWwBt4ySOAjUS+NwvX5R1ahbDwrZV34eed8ae6QKBgQCG
93FComIjT2vyepCeX5SJbC+FRvF5CbfmDmkXKOKlkEvrc8mSUSwRRrAnMJSmOKBI
EX2IDUbIHAU73JhsFLfrd1rbP8QwpQKjNQaKBHtVd51bw5AZ6N3RkUXHFoPxvfK4
/e9w1mry0eLUd4WVZlbs0+rhe4MvK9wRknjNu/+AMQKBgD2E0cEJLwI7vkzAsrzy
2s7CceNNAwekSstZPL5U6JySwv71h9p0+Ul3ET/gMkvhwjxcEabErrA1+jSfA7V4
k6NhVxLEQ/58GMaxcTCDLi/hq04fD+JPKLtA2lsT7EjSKQffQv6rT4NGJk4TzhWa
kVxjCvhJlsAkTKqiW4c1guzO
-----END PRIVATE KEY-----
`;

const RSA_PUBLIC_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtXg5T+24Bb0toBh7JFtN
FkwkpNISYliSwXa1r+Ez3Pz7umfYW8WDrqQ11jDVCir73y03+KVr5SnMjC3qCcBQ
cmsOfTAdozBcwj7YOPQRTXU+dvAjghiruXYQo5p1JGfFlbH6TMAJGiU2mU1AG+2G
+dO3oiKcD1POEG2DHd5YXlOdIuta4/h2PNUzu9ej98+sslDBH6SXmcGxbmYrRSjL
FUKz4X96G82wC9mkSH8US77/vcU55ljRkFgcBCfMpX2AwvqlqTS7FUsBOZfnh2a0
7mZIKTWEJY48qQGmSzni5ZSbXQvQHLBkVgcCaBVJfss8mpV1jLBCNU/89zbob3Pg
SwIDAQAB
-----END PUBLIC KEY-----
`;

const RS256_TOKEN =
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.VJKTYoLq71vYTS6Wh5NYL_6ZBuXkpx-F79eaVsbytVk4C_-8Ww5JpME9DGsWwlOVSoIgudu3XigKtZgZ7RYz_dCjK38I3mDj8jxCU6MG_Pvdws5zLQVagfSiSlfMBM8nNp233GunMeNqvJDMb14g2N7ygozO_S1JvcD1b_RzKSGfiMG2QzWCt2ajfiPMZE2orv3Sh_-YQYVRvQt-1-i2isL019lJa6qEm10ODEn-KeTgkMLau7h7iyuFl7WzEltGTe65lv3AOKiNkQ7TtVBgrtTvv60_Y--X7wkZXmLs9lM3OBeCBw9TefaOHbdy3p8743kfgXq-NclDWTrl1DOFHQ";

const EC_PRIVATE_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgTXCyAPDao9gHKoiv
duE4qugmLq1Lsv0sG/Gxff+lVnGhRANCAARuSEw6gch8BkJWeyDJj2tnC9P+VhLg
D10UIetNL/viHjJzanns8RBysROgzelCAGvWTqr4qCSPpgFle1iYttX+
-----END PRIVATE KEY-----
`;

const EC_PUBLIC_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEbkhMOoHIfAZCVnsgyY9rZwvT/lYS
4A9dFCHrTS/74h4yc2p57PEQcrEToM3pQgBr1k6q+Kgkj6YBZXtYmLbV/g==
-----END PUBLIC KEY-----
`;

/**
 * The legacy shape: the key below a --- line in the main input. The key option
 * is the way in now, so only the backward compatibility cases below build this.
 */
const withKey = (body: string, key: string) => `${body}\n---\n${key}`;

describe("jwt-generator signing", () => {
  it("reproduces the canonical HS256 example token", async () => {
    const out = await run(PAYLOAD, { key: SECRET, mode: "sign", alg: "HS256" });
    expect(out.Token).toBe(HS256_TOKEN);
    expect(out.Header).toBe('{\n  "alg": "HS256",\n  "typ": "JWT"\n}');
    expect(out.Algorithm).toContain("can also forge one");
  });

  it("defaults to signing with HS256", async () => {
    const out = await run(PAYLOAD, { key: SECRET });
    expect(out.Token).toBe(HS256_TOKEN);
  });

  it("signs with HS384 and HS512, producing longer signatures", async () => {
    const s384 = await run(PAYLOAD, { key: SECRET, alg: "HS384" });
    const s512 = await run(PAYLOAD, { key: SECRET, alg: "HS512" });
    expect(fromBase64Url(s384["Signature (base64url)"]!)!.length).toBe(48);
    expect(fromBase64Url(s512["Signature (base64url)"]!)!.length).toBe(64);
  });

  it("reproduces an RS256 token that node:crypto also produces", async () => {
    const out = await run(PAYLOAD, { key: RSA_PRIVATE_PEM, alg: "RS256" });
    expect(out.Token).toBe(RS256_TOKEN);
  });

  it("signs ES256 and verifies it back, since ECDSA signatures are randomized", async () => {
    const signed = await run(PAYLOAD, { key: EC_PRIVATE_PEM, alg: "ES256" });
    // JOSE requires the raw 64 byte r||s form, not a DER wrapper.
    expect(fromBase64Url(signed["Signature (base64url)"]!)!.length).toBe(64);
    const checked = await run(signed.Token!, { key: EC_PUBLIC_PEM, mode: "verify", alg: "ES256" });
    expect(checked.Signature).toBe("valid");
  });

  it("adds iat, nbf, and exp from the injected clock", async () => {
    const out = await run('{"sub":"a"}', {
      key: SECRET,
      addIat: true,
      addNbf: true,
      expiresIn: 3600,
      now: 1_700_000_000,
    });
    expect(JSON.parse(out.Payload!)).toEqual({
      sub: "a",
      iat: 1_700_000_000,
      nbf: 1_700_000_000,
      exp: 1_700_003_600,
    });
    expect(out.Expires).toContain("2023-11-14T23:13:20Z");
    expect(out["Issued at"]).toContain("1700000000");
  });

  it("leaves iat, nbf, and exp out by default", async () => {
    const out = await run('{"sub":"a"}', { key: SECRET });
    expect(JSON.parse(out.Payload!)).toEqual({ sub: "a" });
    expect(out.Expires).toBe("not set");
    expect(out["Not before"]).toBe("not set");
  });

  it("signs with a generated demo key pair and returns both PEM blocks", async () => {
    const out = await run('{"sub":"demo"}', { alg: "ES256", demoKey: true });
    expect(out["Demo private key (PKCS#8 PEM)"]).toContain("BEGIN PRIVATE KEY");
    expect(out["Demo public key (SPKI PEM)"]).toContain("BEGIN PUBLIC KEY");
    expect(out.Warning).toContain("throwaway key pair");
    const checked = await run(out.Token!, {
      key: out["Demo public key (SPKI PEM)"]!,
      mode: "verify",
      alg: "ES256",
    });
    expect(checked.Signature).toBe("valid");
  });

  it("signs an RS256 demo token that verifies against its own demo public key", async () => {
    const out = await run('{"sub":"demo"}', { alg: "RS256", demoKey: true });
    const checked = await run(out.Token!, {
      key: out["Demo public key (SPKI PEM)"]!,
      mode: "verify",
    });
    expect(checked.Signature).toBe("valid");
    expect(checked["Algorithm checked"]).toContain("RS256");
  }, 15_000);
});

describe("jwt-generator verifying", () => {
  it("accepts a correctly signed HS256 token", async () => {
    const out = await run(HS256_TOKEN, { key: SECRET, mode: "verify" });
    expect(out.Signature).toBe("valid");
    expect(out["Expiry check"]).toContain("never expires");
    expect(out["Not before check"]).toBe("no nbf claim");
    expect(JSON.parse(out.Payload!).name).toBe("John Doe");
  });

  it("rejects the same token under a different secret", async () => {
    const out = await run(HS256_TOKEN, { key: "not-the-secret", mode: "verify" });
    expect(out.Signature).toBe("invalid");
    expect(out.Verdict).toContain("does not match");
  });

  it("rejects a token whose payload was edited", async () => {
    const parts = HS256_TOKEN.split(".");
    const edited = `${parts[0]}.${toBase64Url(new TextEncoder().encode('{"sub":"admin"}'))}.${parts[2]}`;
    const out = await run(edited, { key: SECRET, mode: "verify" });
    expect(out.Signature).toBe("invalid");
  });

  it("verifies RS256 against the SPKI public key", async () => {
    const out = await run(RS256_TOKEN, { key: RSA_PUBLIC_PEM, mode: "verify" });
    expect(out.Signature).toBe("valid");
  });

  it("reads the algorithm from the header on the Auto default", async () => {
    // "" is the meta default, so an untouched panel auto-detects RS256.
    const out = await run(RS256_TOKEN, { key: RSA_PUBLIC_PEM, mode: "verify", alg: "" });
    expect(out["Algorithm checked"]).toContain("RS256");
    expect(out.Signature).toBe("valid");
    // Auto still means HS256 when signing, since a payload carries no header.
    expect((await run(PAYLOAD, { key: SECRET, mode: "sign", alg: "" })).Token).toBe(HS256_TOKEN);
  });

  it("checks against the chosen algorithm when one is picked explicitly", async () => {
    const out = await run(RS256_TOKEN, {
      key: "your-256-bit-secret",
      mode: "verify",
      alg: "HS256",
    });
    expect(out.Signature).toBe("invalid");
    expect(out["Algorithm checked"]).toBe("HS256 (the header declares RS256)");
  });

  it("reports an expired token as correctly signed but expired", async () => {
    const signed = await run('{"sub":"a"}', { key: SECRET, expiresIn: 60, now: 1_700_000_000 });
    const out = await run(signed.Token!, { key: SECRET, mode: "verify", now: 1_700_010_000 });
    expect(out.Signature).toBe("valid");
    expect(out.Verdict).toContain("has expired");
    expect(out["Expiry check"]).toContain("expired");
  });

  it("reports a token that is not valid yet", async () => {
    const signed = await run('{"nbf":1800000000}', { key: SECRET });
    const out = await run(signed.Token!, { key: SECRET, mode: "verify", now: 1_700_000_000 });
    expect(out.Verdict).toContain("not valid yet");
    expect(out["Not before check"]).toContain("not usable yet");
  });

  it("refuses a token that declares alg none", async () => {
    const header = toBase64Url(new TextEncoder().encode('{"alg":"none","typ":"JWT"}'));
    const payload = toBase64Url(new TextEncoder().encode('{"sub":"admin"}'));
    try {
      await run(`${header}.${payload}.`, { key: SECRET, mode: "verify", alg: "" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("alg-none");
    }
  });
});

describe("jwt-generator errors", () => {
  it("throws on empty input", async () => {
    await expect(run("", {})).rejects.toThrow(/Nothing to sign or verify/);
  });

  it("throws when the payload is not valid JSON or not an object", async () => {
    await expect(run("{sub:1}", { key: SECRET })).rejects.toThrow(/not valid JSON/);
    await expect(run("[1,2]", { key: SECRET })).rejects.toThrow(/has to be a JSON object/);
    await expect(run(withKey("   ", SECRET), {})).rejects.toThrow(/no payload to sign/);
  });

  it("throws when an HS algorithm has no secret", async () => {
    try {
      await run(PAYLOAD, { alg: "HS256" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("missing-key");
      expect((err as ToolError).fix).toContain("Secret or private key");
    }
  });

  it("points at the demo key option when RS256 has no key", async () => {
    try {
      await run(PAYLOAD, { alg: "RS256" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ToolError).fix).toContain("demo key pair");
    }
  });

  it("throws when signing is given a public key", async () => {
    try {
      await run(PAYLOAD, { key: RSA_PUBLIC_PEM, alg: "RS256" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ToolError).message).toContain("Signing needs a private key");
      expect((err as ToolError).fix).toContain("can only verify a token");
    }
  });

  it("throws when the PEM is a legacy RSA or EC private key block", async () => {
    const legacy = "-----BEGIN RSA PRIVATE KEY-----\nAAEC\n-----END RSA PRIVATE KEY-----";
    try {
      await run(PAYLOAD, { key: legacy, alg: "RS256" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ToolError).message).toContain("RSA PRIVATE KEY");
      expect((err as ToolError).fix).toContain("pkcs8 -topk8");
    }
  });

  it("throws when the key is the wrong type for the algorithm", async () => {
    try {
      await run(PAYLOAD, { key: EC_PRIVATE_PEM, alg: "RS256" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("key-import-failed");
      expect((err as ToolError).fix).toContain("switch the algorithm to ES256");
    }
  });

  it("throws when there is no PEM block at all for RS256", async () => {
    await expect(run(PAYLOAD, { key: "hunter2", alg: "RS256" })).rejects.toThrow(
      /no PEM block was found/,
    );
  });

  it("throws on a malformed token in verify mode", async () => {
    await expect(run("a.b", { key: SECRET, mode: "verify" })).rejects.toThrow(
      /three dot separated parts/,
    );
    await expect(run("!!!.!!!.!!!", { key: SECRET, mode: "verify" })).rejects.toThrow(
      /not valid base64url/,
    );
    await expect(run("aGk.aGk.aGk", { key: SECRET, mode: "verify" })).rejects.toThrow(
      /does not decode to JSON/,
    );
    await expect(run(withKey("   ", SECRET), { mode: "verify" })).rejects.toThrow(
      /no token to verify/,
    );
  });

  it("throws when verifying without a key", async () => {
    await expect(run(HS256_TOKEN, { mode: "verify" })).rejects.toThrow(/Verifying needs the/);
  });

  it("throws when verifying RS256 with something other than a PUBLIC KEY block", async () => {
    await expect(
      run(RS256_TOKEN, { key: RSA_PRIVATE_PEM, mode: "verify", alg: "RS256" }),
    ).rejects.toThrow(/SubjectPublicKeyInfo/);
    await expect(run(RS256_TOKEN, { key: "nope", mode: "verify", alg: "RS256" })).rejects.toThrow(
      /needs a PEM public key/,
    );
  });

  it("throws on an unknown algorithm or mode", async () => {
    await expect(run(PAYLOAD, { key: SECRET, alg: "none" })).rejects.toThrow(/does not recognize/);
    try {
      await run(PAYLOAD, { key: SECRET, mode: "decode" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ToolError).fix).toBe("Choose Sign or Verify.");
    }
  });

  it("throws on an out of range expiresIn", async () => {
    await expect(run(PAYLOAD, { key: SECRET, expiresIn: -5 })).rejects.toThrow(/expiresIn/);
  });
});

describe("jwt-generator helpers", () => {
  it("finds the last separator, and treats a PEM's own dashes as content", () => {
    expect(splitBodyAndKey(withKey("{}", RSA_PUBLIC_PEM)).key.trim()).toBe(RSA_PUBLIC_PEM.trim());
    expect(splitBodyAndKey("no separator here")).toEqual({
      body: "no separator here",
      key: "",
      hasKey: false,
    });
    expect(splitBodyAndKey("a\n---\n  ").hasKey).toBe(false);
  });

  it("parses and rebuilds a PEM block", () => {
    const parsed = parsePem(RSA_PUBLIC_PEM)!;
    expect(parsed.label).toBe("PUBLIC KEY");
    expect(toPem("PUBLIC KEY", parsed.bytes)).toBe(RSA_PUBLIC_PEM);
    expect(parsePem("nothing here")).toBeNull();
  });

  it("round-trips base64url", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253]);
    expect(toBase64Url(bytes)).toBe("AAEC-vv8_Q");
    expect(fromBase64Url("AAEC-vv8_Q")).toEqual(bytes);
    expect(fromBase64Url("AAEC+vv8/Q==")).toEqual(bytes);
  });
});

describe("jwt-generator key sources", () => {
  it("signs the canonical token from the key option", async () => {
    const out = await run(PAYLOAD, { mode: "sign", alg: "HS256", key: SECRET });
    expect(out.Token).toBe(HS256_TOKEN);
  });

  it("still reads a key below the --- line when the option is empty", async () => {
    expect((await run(withKey(PAYLOAD, SECRET), { alg: "HS256" })).Token).toBe(HS256_TOKEN);
    expect((await run(withKey(PAYLOAD, SECRET), { alg: "HS256", key: "" })).Token).toBe(
      HS256_TOKEN,
    );
    expect((await run(withKey(HS256_TOKEN, SECRET), { mode: "verify" })).Signature).toContain(
      "valid",
    );
  });

  it("accepts a multi-line PEM key through the option", async () => {
    const out = await run(PAYLOAD, { alg: "RS256", key: RSA_PRIVATE_PEM });
    expect(out.Token).toBe(RS256_TOKEN);
    const checked = await run(RS256_TOKEN, { mode: "verify", key: RSA_PUBLIC_PEM });
    expect(checked.Signature).toContain("valid");
  });

  it("treats the whole input as the payload once the option holds a key", async () => {
    // The legacy tail is payload text here, so the JSON parse is what fails.
    await expect(run(withKey(PAYLOAD, SECRET), { key: SECRET })).rejects.toThrow(/not valid JSON/);
  });

  it("points at the key option when a key is missing entirely", async () => {
    try {
      await run(PAYLOAD, { alg: "HS256" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("missing-key");
      expect((err as ToolError).fix).toContain("Secret or private key");
    }
  });
});

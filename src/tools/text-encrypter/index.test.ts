import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  DEFAULT_ITERATIONS,
  FORMAT_VERSION,
  fromBase64Url,
  run,
  splitPayloadAndPassword,
  toBase64Url,
} from "./index";

const PASSWORD = "correct horse battery staple";

/**
 * A fixed salt and nonce, supplied only so the pinned fixture below stays
 * stable. Real encryption always draws fresh random bytes: reusing an AES-GCM
 * nonce with the same key is catastrophic, which is why this is not an option
 * the panel exposes.
 */
const FIXED_RANDOM = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b";

/**
 * Pinned armored message, produced once by this tool at 10,000 iterations.
 * It exists to freeze the version 1 wire format: if the header layout, the
 * additional authenticated data, or the base64url alphabet ever changes, this
 * message stops decrypting and the test fails rather than silently orphaning
 * every message anyone already encrypted.
 */
const FIXTURE =
  "AQAAJxAAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobk3RQrQStcaf7RTjV4cXJr6UyGzLRQ9ZhzbhCjs3Tkw";

/** Most tests use a low iteration count so the suite stays fast. */
const FAST = { iterations: 10_000 };

describe("text-encrypter round trip", () => {
  it("encrypts and decrypts back to the same text", async () => {
    const enc = await run(`Attack at dawn.`, { password: PASSWORD, mode: "encrypt", ...FAST });
    expect(enc.Mode).toBe("Encrypted");
    const dec = await run(`${enc["Armored message"]}`, { password: PASSWORD, mode: "decrypt" });
    expect(dec.Plaintext).toBe("Attack at dawn.");
    expect(dec.Parameters).toContain("format version 1");
  });

  it("round-trips multi-line text, Unicode, and leading whitespace", async () => {
    const secret = "  line one\nline two\n\ntrailing emoji \u{1f512}\n你好";
    const enc = await run(`${secret}`, { password: PASSWORD, mode: "encrypt", ...FAST });
    const dec = await run(`${enc["Armored message"]}`, { password: PASSWORD, mode: "decrypt" });
    expect(dec.Plaintext).toBe(secret);
  });

  it("produces a different message every time for the same input", async () => {
    const a = await run(`same`, { password: PASSWORD, mode: "encrypt", ...FAST });
    const b = await run(`same`, { password: PASSWORD, mode: "encrypt", ...FAST });
    expect(a["Armored message"]).not.toBe(b["Armored message"]);
  });

  it("works at the default 600,000 iterations", async () => {
    const enc = await run(`slow but real`, { password: PASSWORD, mode: "encrypt" });
    expect(enc.Parameters).toContain("600,000 iterations");
    expect(enc.Warning).toBeUndefined();
    const dec = await run(`${enc["Armored message"]}`, { password: PASSWORD, mode: "decrypt" });
    expect(dec.Plaintext).toBe("slow but real");
  });

  it("defaults to encrypt mode when none is given", async () => {
    const out = await run("hello", { ...FAST, password: PASSWORD });
    expect(out.Mode).toBe("Encrypted");
  });
});

describe("text-encrypter wire format", () => {
  it("still decrypts the pinned version 1 fixture", async () => {
    const dec = await run(`${FIXTURE}`, { password: PASSWORD, mode: "decrypt" });
    expect(dec.Plaintext).toBe("Attack at dawn.");
    expect(dec.Parameters).toContain("10,000 iterations");
  });

  it("reproduces the fixture byte for byte from the same salt and nonce", async () => {
    const enc = await run(`Attack at dawn.`, {
      password: PASSWORD,
      mode: "encrypt",
      iterations: 10_000,
      fixedRandom: FIXED_RANDOM,
    });
    expect(enc["Armored message"]).toBe(FIXTURE);
  });

  it("lays the header out as version, iterations, salt, nonce", () => {
    const bytes = fromBase64Url(FIXTURE)!;
    expect(bytes[0]).toBe(FORMAT_VERSION);
    // 10,000 = 0x00002710 big endian.
    expect([...bytes.subarray(1, 5)]).toEqual([0, 0, 0x27, 0x10]);
    expect([...bytes.subarray(5, 21)]).toEqual([...Array(16).keys()]);
    expect(bytes.length).toBe(33 + "Attack at dawn.".length + 16);
  });

  it("authenticates the header, so a tampered iteration count fails", async () => {
    const bytes = fromBase64Url(FIXTURE)!;
    bytes[4] = (bytes[4]! ^ 0x01) & 0xff;
    await expect(
      run(`${toBase64Url(bytes)}`, { password: PASSWORD, mode: "decrypt" }),
    ).rejects.toThrow(/did not decrypt/);
  });

  it("fails when a ciphertext byte is altered", async () => {
    const bytes = fromBase64Url(FIXTURE)!;
    bytes[40] = bytes[40]! ^ 0xff;
    await expect(
      run(`${toBase64Url(bytes)}`, { password: PASSWORD, mode: "decrypt" }),
    ).rejects.toThrow(/altered in transit|did not decrypt/);
  });
});

describe("text-encrypter errors", () => {
  it("rejects a wrong password with a clear message", async () => {
    try {
      await run(`${FIXTURE}\n---\nwrong password`, { mode: "decrypt" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("decrypt-failed");
      expect((err as ToolError).message).toBe("That password did not decrypt this message.");
      expect((err as ToolError).fix).toContain("capitalization");
    }
  });

  it("throws on empty input", async () => {
    await expect(run("", {})).rejects.toThrow(/Nothing to encrypt or decrypt/);
  });

  it("throws when no passphrase is given in either place", async () => {
    try {
      await run("just text", {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("empty-password");
      expect((err as ToolError).fix).toContain("Password option");
    }
    await expect(run("secret\n---\n   ", { password: "  " })).rejects.toThrow(/no passphrase/);
  });

  it("throws when there is no message, only a passphrase", async () => {
    await expect(run(`---\n${PASSWORD}`, { mode: "encrypt" })).rejects.toThrow(
      /no message to encrypt/,
    );
    await expect(run(`---\n${PASSWORD}`, { mode: "decrypt" })).rejects.toThrow(
      /no armored message to decrypt/,
    );
  });

  it("rejects armor that is not base64url", async () => {
    try {
      await run(`not a message!!!`, { password: PASSWORD, mode: "decrypt" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-armor");
      expect((err as ToolError).fix).toContain("switch Mode to Encrypt");
    }
  });

  it("rejects armor that is too short to hold a header and a tag", async () => {
    await expect(run(`AQAAJxAA`, { password: PASSWORD, mode: "decrypt" })).rejects.toThrow(
      /at least 49 bytes/,
    );
  });

  it("rejects an unknown format version", async () => {
    const bytes = fromBase64Url(FIXTURE)!;
    bytes[0] = 9;
    try {
      await run(`${toBase64Url(bytes)}`, { password: PASSWORD, mode: "decrypt" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("unsupported-version");
      expect((err as ToolError).message).toContain("version 9");
    }
  });

  it("rejects an out of range iteration count, in the option and in the armor", async () => {
    await expect(run(`hi`, { password: PASSWORD, iterations: 10 })).rejects.toThrow(/iterations/);
    const bytes = fromBase64Url(FIXTURE)!;
    bytes[1] = 0xff;
    await expect(
      run(`${toBase64Url(bytes)}`, { password: PASSWORD, mode: "decrypt" }),
    ).rejects.toThrow(/outside the range/);
  });

  it("rejects an unknown mode", async () => {
    await expect(run(`hi`, { password: PASSWORD, mode: "sign" })).rejects.toThrow(
      /does not recognize/,
    );
  });

  it("rejects a fixedRandom that is not hex or is too short", async () => {
    await expect(run(`hi`, { password: PASSWORD, ...FAST, fixedRandom: "zz" })).rejects.toThrow(
      /not valid hexadecimal/,
    );
    await expect(run(`hi`, { password: PASSWORD, ...FAST, fixedRandom: "00ff" })).rejects.toThrow(
      /at least 28 bytes/,
    );
  });

  it("warns when the iteration count is low enough to be brute forced", async () => {
    const out = await run(`hi`, { password: PASSWORD, iterations: 1_000 });
    expect(out.Warning).toContain("offline guessing attack");
    expect(DEFAULT_ITERATIONS).toBe(600_000);
  });
});

describe("text-encrypter helpers", () => {
  it("round-trips base64url without padding", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253]);
    expect(toBase64Url(bytes)).toBe("AAEC-vv8_Q");
    expect(fromBase64Url("AAEC-vv8_Q")).toEqual(bytes);
    // The +/ alphabet and padding are accepted too, since people paste both.
    expect(fromBase64Url("AAEC+vv8/Q==")).toEqual(bytes);
    expect(fromBase64Url("!!!")).toBeNull();
  });

  it("splits on the last separator so a message may contain dashes", () => {
    expect(splitPayloadAndPassword("a\n---\nb\n---\npw")).toEqual({
      payload: "a\n---\nb",
      password: "pw",
      hasPassword: true,
    });
    expect(splitPayloadAndPassword("a\r\n---\r\npw")).toEqual({
      payload: "a",
      password: "pw",
      hasPassword: true,
    });
    expect(splitPayloadAndPassword("no separator here")).toEqual({
      payload: "no separator here",
      password: "",
      hasPassword: false,
    });
  });
});

describe("text-encrypter passphrase sources", () => {
  it("decrypts a legacy message whose passphrase sits below the --- line", async () => {
    const dec = await run(`${FIXTURE}\n---\n${PASSWORD}`, { mode: "decrypt" });
    expect(dec.Plaintext).toBe("Attack at dawn.");
  });

  it("reads the passphrase from the option instead", async () => {
    const dec = await run(FIXTURE, { mode: "decrypt", password: PASSWORD });
    expect(dec.Plaintext).toBe("Attack at dawn.");
  });

  it("treats the whole input as the message once the option holds a passphrase", async () => {
    // The dashes are part of the message here, so this is not the legacy split.
    const enc = await run(`one\n---\ntwo`, { ...FAST, password: PASSWORD });
    const dec = await run(enc["Armored message"]!, { mode: "decrypt", password: PASSWORD });
    expect(dec.Plaintext).toBe("one\n---\ntwo");
  });
});

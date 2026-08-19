import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { fromB64, looksLikeHash, run, toB64, type BcryptOpts } from "./index";

/**
 * Every hashing assertion pins a fixed salt through the test-only `salt`
 * option, so the encoded strings below are reproducible. The salt is the
 * 16 bytes 00..0f. Costs are kept at the bottom of each documented range
 * (bcrypt cost 4, argon2 m=8192/t=1, scrypt log2 N = 10) so the whole suite
 * stays under a second.
 */
const SALT = "000102030405060708090a0b0c0d0e0f";

const BCRYPT_C4 = "$2a$04$..CA.uOD/eaGAOmJB.yMBurkTM.teJW4P/NXJXOT49X8IHvXALk4i";
const ARGON2ID_M8192 =
  "$argon2id$v=19$m=8192,t=1,p=1$AAECAwQFBgcICQoLDA0ODw$iTVhb4LxLVJcfxU4kJmKfQvNC1JpjC791oXEDmFjAys";
const SCRYPT_LN10 =
  "$scrypt$ln=10,r=8,p=1$AAECAwQFBgcICQoLDA0ODw$DXBGFk5ctjv6hJ1qqn6/vDJxvAFTl2yR3xWBXu/gyII";

function opts(over: Partial<BcryptOpts> = {}): BcryptOpts {
  return {
    mode: "hash",
    algorithm: "bcrypt",
    cost: 4,
    iterations: 1,
    memoryKiB: 8192,
    parallelism: 1,
    hashLength: 32,
    scryptN: 10,
    salt: SALT,
    ...over,
  };
}

/** Run and return the ToolError code, failing loudly on anything else. */
async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return (err as ToolError).code;
  }
  throw new Error("expected a ToolError");
}

describe("base64 helpers", () => {
  it("round trips bytes through the unpadded PHC alphabet", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253]);
    const encoded = toB64(bytes);
    expect(encoded).not.toContain("=");
    expect(fromB64(encoded)).toEqual(bytes);
  });

  it("rejects characters outside the alphabet and the empty string", () => {
    expect(fromB64("not base64!")).toBeNull();
    expect(fromB64("")).toBeNull();
  });
});

describe("hash detection", () => {
  it("knows the prefixes it can verify and refuses the buggy 2x variant", () => {
    expect(looksLikeHash("$2a$10$abc")).toBe(true);
    expect(looksLikeHash("$2b$10$abc")).toBe(true);
    expect(looksLikeHash("$2y$10$abc")).toBe(true);
    expect(looksLikeHash("$argon2id$v=19$m=1,t=1,p=1$a$b")).toBe(true);
    expect(looksLikeHash("$scrypt$ln=10,r=8,p=1$a$b")).toBe(true);
    expect(looksLikeHash("$2x$10$abc")).toBe(false);
    expect(looksLikeHash("correct horse battery staple")).toBe(false);
  });
});

describe("hash mode", () => {
  it("produces the pinned bcrypt encoding at cost 4", async () => {
    expect(await run("hunter2", opts({ algorithm: "bcrypt", cost: 4 }))).toEqual({
      Algorithm: "bcrypt",
      Parameters: "cost 4 (2^4 = 16 rounds), 16 byte salt",
      Hash: BCRYPT_C4,
      "Time hint": "about 2 ms per hash on a typical laptop (rough estimate, not measured)",
      "Verify hint":
        "Switch Mode to Verify, then paste the password on the first line and this hash on the second.",
    });
  });

  it("defaults to bcrypt cost 10 and reports the 100 ms estimate", async () => {
    const out = await run("hunter2", opts({ algorithm: "", cost: 10 }));
    expect(out.Algorithm).toBe("bcrypt");
    expect(out.Hash).toMatch(/^\$2a\$10\$/);
    expect(out.Parameters).toBe("cost 10 (2^10 = 1024 rounds), 16 byte salt");
    expect(out["Time hint"]).toContain("about 100 ms");
  });

  it("produces the pinned argon2id PHC string", async () => {
    const out = await run("hunter2", opts({ algorithm: "argon2id" }));
    expect(out).toEqual({
      Algorithm: "argon2id",
      Parameters:
        "argon2id v19, memory 8192 KiB (8 MiB), iterations 1, parallelism 1, hash length 32 bytes",
      Hash: ARGON2ID_M8192,
      "Time hint": "about 16 ms per hash on a typical laptop (rough estimate, not measured)",
      "Verify hint":
        "Switch Mode to Verify, then paste the password on the first line and this hash on the second.",
    });
  });

  it("hashes argon2i and argon2d under their own prefixes", async () => {
    const i = await run("hunter2", opts({ algorithm: "argon2i" }));
    const d = await run("hunter2", opts({ algorithm: "argon2d" }));
    expect(i.Algorithm).toBe("argon2i");
    expect(i.Hash).toMatch(/^\$argon2i\$v=19\$m=8192,t=1,p=1\$/);
    expect(d.Algorithm).toBe("argon2d");
    expect(d.Hash).toMatch(/^\$argon2d\$v=19\$m=8192,t=1,p=1\$/);
    expect(i.Hash).not.toBe(d.Hash);
  });

  it("notes that a large argon2 memory setting may be slow in a browser", async () => {
    const out = await run("hunter2", opts({ algorithm: "argon2id", memoryKiB: 262145 }));
    expect(out.Note).toContain("262144 KiB (256 MiB)");
    const small = await run("hunter2", opts({ algorithm: "argon2id", memoryKiB: 262144 }));
    expect(small.Note).toBeUndefined();
  });

  it("produces the pinned scrypt string in this tool's documented format", async () => {
    const out = await run("hunter2", opts({ algorithm: "scrypt" }));
    expect(out.Hash).toBe(SCRYPT_LN10);
    expect(out.Parameters).toBe(
      "N 1024 (log2 N = 10), r 8, p 1, memory 1 MiB, hash length 32 bytes",
    );
    expect(out.Note).toContain("$scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt>$<hash>");
  });

  it("uses a fresh random salt when none is supplied", async () => {
    const a = await run("hunter2", opts({ salt: undefined }));
    const b = await run("hunter2", opts({ salt: undefined }));
    expect(a.Hash).not.toBe(b.Hash);
    expect(a.Hash).toMatch(/^\$2a\$04\$[./A-Za-z0-9]{53}$/);
  });

  it("warns and truncates when the password is longer than 72 bytes", async () => {
    const out = await run("a".repeat(73), opts({ algorithm: "bcrypt", cost: 4 }));
    expect(out.Warning).toBe(
      "bcrypt hashes only the first 72 bytes of a password. This one is 73 bytes, so the last byte was ignored. Use argon2id if the whole password has to count.",
    );
    const exact = await run("a".repeat(72), opts({ algorithm: "bcrypt", cost: 4 }));
    expect(exact.Warning).toBeUndefined();
    // Truncation is bcrypt's own behavior, so both passwords hash identically.
    expect(out.Hash).toBe(exact.Hash);
  });

  it("counts bytes, not characters, against the 72 byte bcrypt limit", async () => {
    // 25 three-byte characters is 75 bytes but only 25 code points.
    const out = await run("あ".repeat(25), opts({ algorithm: "bcrypt", cost: 4 }));
    expect(out.Warning).toContain("This one is 75 bytes");
  });

  it("strips a trailing newline but keeps surrounding spaces", async () => {
    const bare = await run(" pw ", opts());
    expect(await run(" pw \n", opts())).toEqual(bare);
    expect(await run(" pw \r\n", opts())).toEqual(bare);
    expect((await run("pw", opts())).Hash).not.toBe(bare.Hash);
  });
});

describe("verify mode", () => {
  it("matches a correct bcrypt password and rejects a wrong one", async () => {
    const ok = await run(`hunter2\n${BCRYPT_C4}`, opts({ mode: "verify" }));
    expect(ok).toEqual({
      "Algorithm detected": "bcrypt ($2a$ prefix)",
      Parameters: "cost 4 (2^4 = 16 rounds), 16 byte salt",
      Match: "yes",
    });
    const bad = await run(`hunter3\n${BCRYPT_C4}`, opts({ mode: "verify" }));
    expect(bad.Match).toBe("no");
  });

  it("normalizes a $2y$ hash to $2b$ and says so", async () => {
    const out = await run(`hunter2\n$2y$${BCRYPT_C4.slice(4)}`, opts({ mode: "verify" }));
    expect(out["Algorithm detected"]).toBe("bcrypt ($2y$ prefix)");
    expect(out.Match).toBe("yes");
    expect(out.Note).toContain("normalized to $2b$");
  });

  it("accepts the hash on the first line and the password on the second", async () => {
    const out = await run(`${ARGON2ID_M8192}\nhunter2`, opts({ mode: "verify" }));
    expect(out["Algorithm detected"]).toBe("argon2id");
    expect(out.Parameters).toBe(
      "argon2id v19, memory 8192 KiB (8 MiB), iterations 1, parallelism 1, hash length 32 bytes",
    );
    expect(out.Match).toBe("yes");
  });

  it("prefers the second line when both lines look like a hash", async () => {
    const out = await run(`${SCRYPT_LN10}\n${ARGON2ID_M8192}`, opts({ mode: "verify" }));
    // The scrypt string is being treated as the password here, so no match.
    expect(out["Algorithm detected"]).toBe("argon2id");
    expect(out.Match).toBe("no");
  });

  it("verifies a scrypt hash in this tool's own format", async () => {
    const ok = await run(`hunter2\n${SCRYPT_LN10}`, opts({ mode: "verify" }));
    expect(ok["Algorithm detected"]).toBe("scrypt");
    expect(ok.Parameters).toBe(
      "N 1024 (log2 N = 10), r 8, p 1, memory 1 MiB, hash length 32 bytes",
    );
    expect(ok.Match).toBe("yes");
    const bad = await run(`hunter3\n${SCRYPT_LN10}`, opts({ mode: "verify" }));
    expect(bad.Match).toBe("no");
  });

  it("ignores blank lines and trims whitespace around the hash", async () => {
    const out = await run(`\nhunter2\n\n  ${BCRYPT_C4}  \n`, opts({ mode: "verify" }));
    expect(out.Match).toBe("yes");
  });

  it("warns that only the first 72 bytes of a long password were compared", async () => {
    const out = await run(`${"a".repeat(73)}\n${BCRYPT_C4}`, opts({ mode: "verify" }));
    expect(out.Warning).toContain("only the first 72 bytes");
    expect(out.Match).toBe("no");
  });
});

describe("errors", () => {
  it("throws empty-input on nothing to work with", async () => {
    expect(await codeOf(() => run("", opts()))).toBe("empty-input");
    expect(await codeOf(() => run("\n", opts()))).toBe("empty-input");
    expect(await codeOf(() => run("   ", opts({ mode: "verify" })))).toBe("empty-input");
  });

  it("throws bad-option for a cost outside the documented range", async () => {
    expect(await codeOf(() => run("pw", opts({ cost: 3 })))).toBe("bad-option");
    expect(await codeOf(() => run("pw", opts({ cost: 16 })))).toBe("bad-option");
    expect(await codeOf(() => run("pw", opts({ cost: 10.5 })))).toBe("bad-option");
  });

  it("names the offending option in the message", async () => {
    let caught: ToolError | undefined;
    try {
      await run("pw", opts({ cost: 31 }));
    } catch (err) {
      caught = err as ToolError;
    }
    expect(caught?.code).toBe("bad-option");
    expect(caught?.message).toContain('"cost"');
    expect(caught?.message).toContain("Bcrypt cost");
    expect(caught?.fix).toContain("The default is 10.");
  });

  it("throws bad-option for every argon2 and scrypt range", async () => {
    const argon = (over: Partial<BcryptOpts>) =>
      codeOf(() => run("pw", opts({ algorithm: "argon2id", ...over })));
    expect(await argon({ iterations: 0 })).toBe("bad-option");
    expect(await argon({ iterations: 11 })).toBe("bad-option");
    expect(await argon({ memoryKiB: 8191 })).toBe("bad-option");
    expect(await argon({ memoryKiB: 1048577 })).toBe("bad-option");
    expect(await argon({ parallelism: 0 })).toBe("bad-option");
    expect(await argon({ parallelism: 9 })).toBe("bad-option");
    expect(await argon({ hashLength: 15 })).toBe("bad-option");
    expect(await argon({ hashLength: 65 })).toBe("bad-option");
    expect(await codeOf(() => run("pw", opts({ algorithm: "scrypt", scryptN: 9 })))).toBe(
      "bad-option",
    );
    expect(await codeOf(() => run("pw", opts({ algorithm: "scrypt", scryptN: 21 })))).toBe(
      "bad-option",
    );
  });

  it("throws bad-option for an unknown algorithm or a malformed salt", async () => {
    expect(await codeOf(() => run("pw", opts({ algorithm: "md5" })))).toBe("bad-option");
    expect(await codeOf(() => run("pw", opts({ salt: "zz" })))).toBe("bad-option");
    expect(await codeOf(() => run("pw", opts({ salt: "00010203" })))).toBe("bad-option");
  });

  it("reports a clean mismatch on a well formed hash with a one byte salt", async () => {
    // hash-wasm accepts a short scrypt salt, so this must be a plain "no",
    // never an unhandled library throw escaping run().
    const out = await run("pw\n$scrypt$ln=10,r=8,p=1$AQ$AQ", opts({ mode: "verify" }));
    expect(out.Match).toBe("no");
  });

  it("throws verify-needs-two when only one line was pasted", async () => {
    expect(await codeOf(() => run("hunter2", opts({ mode: "verify" })))).toBe("verify-needs-two");
    expect(await codeOf(() => run(`${BCRYPT_C4}\n\n`, opts({ mode: "verify" })))).toBe(
      "verify-needs-two",
    );
  });

  it("throws unknown-hash when neither line carries a known prefix", async () => {
    expect(await codeOf(() => run("hunter2\nhunter3", opts({ mode: "verify" })))).toBe(
      "unknown-hash",
    );
    expect(
      await codeOf(() => run(`hunter2\n$2x$04$${"a".repeat(53)}`, opts({ mode: "verify" }))),
    ).toBe("unknown-hash");
  });

  it("throws bad-hash when a recognized prefix is followed by garbage", async () => {
    expect(await codeOf(() => run("pw\n$2a$04$tooshort", opts({ mode: "verify" })))).toBe(
      "bad-hash",
    );
    expect(
      await codeOf(() => run("pw\n$argon2id$v=19$m=32,t=1,p=1$bogus", opts({ mode: "verify" }))),
    ).toBe("bad-hash");
    expect(await codeOf(() => run("pw\n$scrypt$nope", opts({ mode: "verify" })))).toBe("bad-hash");
    expect(
      await codeOf(() =>
        run("pw\n$scrypt$ln=25,r=8,p=1$AAECAwQFBgcICQoLDA0ODw$AAAA", opts({ mode: "verify" })),
      ),
    ).toBe("bad-hash");
  });
});

import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  fingerprint,
  generateKeypair,
  openSshPublicKey,
  pem,
  publicKeyBlob,
  run,
  seededBytes,
  sshMpint,
  toBase64,
} from "./index";

/*
 * Cross-validation, not self-consistency: every pinned value below was checked
 * against OpenSSH 9.x and OpenSSL 3.x on the seeded fixture "fixture-1".
 *
 *   ssh-keygen -y  -f ed25519.key   reproduces PUB_ED25519 exactly
 *   ssh-keygen -lf ed25519.key      reports FP_ED25519
 *   openssl pkey -in ed25519.pk8 -pubout   reproduces SPKI_ED25519
 *
 * and the same three for the ECDSA fixture. A seeded key is reproducible on
 * purpose, so these fixtures are safe to publish: they are not usable secrets
 * for anything, and the run() output says so out loud.
 */

const SEED = "fixture-1";
const COMMENT = "test@example.com";

const PUB_ED25519 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFUavAqcy/1Z9nOZXueQL1f54ybTGXQtpvXAwfkypP/n test@example.com";
const FP_ED25519 = "SHA256:LQWZdV031xv2GcJssE8TNB9kjmSOEfeiNa9ihnxBwrw";
const PKCS8_ED25519 =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIGXqM3mnQA+eamp1PfmgKSnxjIXKYm89IDHHmE+tQBFM\n-----END PRIVATE KEY-----\n";
const SPKI_ED25519 =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAVRq8CpzL/Vn2c5le55AvV/njJtMZdC2m9cDB+TKk/+c=\n-----END PUBLIC KEY-----\n";

const PUB_ECDSA =
  "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBIdw1qCJaNp7KME2Lhl12QwdsgGIz4e3pWYKHdiEpVMsCNKn3a4hc/d2FZKmh7oRzhx3k1iw6DMVVCXRKuAjbJ0= test@example.com";
const FP_ECDSA = "SHA256:4JMDh3zTH5aMclOFbviIkgn2GI4FjI4l0YbFKfz/T8E";

/* ------------------------------------------------------------------ */
/* A minimal openssh-key-v1 reader, so the tests parse what run() wrote */
/* ------------------------------------------------------------------ */

function fromPem(text: string): Uint8Array {
  const body = text
    .split("\n")
    .filter((line) => !line.startsWith("-----"))
    .join("");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class Reader {
  constructor(
    private bytes: Uint8Array,
    private at = 0,
  ) {}
  uint32(): number {
    const v =
      ((this.bytes[this.at]! << 24) |
        (this.bytes[this.at + 1]! << 16) |
        (this.bytes[this.at + 2]! << 8) |
        this.bytes[this.at + 3]!) >>>
      0;
    this.at += 4;
    return v;
  }
  string(): Uint8Array {
    const len = this.uint32();
    const out = this.bytes.subarray(this.at, this.at + len);
    this.at += len;
    return out;
  }
  text(): string {
    return new TextDecoder().decode(this.string());
  }
  take(n: number): Uint8Array {
    const out = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  get rest(): Uint8Array {
    return this.bytes.subarray(this.at);
  }
}

interface ParsedPrivate {
  cipher: string;
  kdf: string;
  keyCount: number;
  publicBlob: Uint8Array;
  keyType: string;
  comment: string;
  checkintsMatch: boolean;
  padding: number[];
  embeddedPublic: Uint8Array;
}

function parseOpenSshPrivate(text: string): ParsedPrivate {
  const r = new Reader(fromPem(text));
  const magic = new TextDecoder().decode(r.take(15));
  expect(magic).toBe("openssh-key-v1\0");
  const cipher = r.text();
  const kdf = r.text();
  expect(r.string().length).toBe(0);
  const keyCount = r.uint32();
  const publicBlob = r.string();
  const priv = new Reader(r.string());
  const a = priv.uint32();
  const b = priv.uint32();
  const keyType = priv.text();
  // Ed25519 stores pub then the 64 byte expanded private; ECDSA stores the
  // curve name, then the point, then the scalar as an mpint.
  let embeddedPublic: Uint8Array;
  if (keyType === "ssh-ed25519") {
    embeddedPublic = priv.string();
    priv.string();
  } else {
    priv.text();
    embeddedPublic = priv.string();
    priv.string();
  }
  const comment = priv.text();
  return {
    cipher,
    kdf,
    keyCount,
    publicBlob,
    keyType,
    comment,
    checkintsMatch: a === b,
    padding: [...priv.rest],
    embeddedPublic,
  };
}

/* ------------------------------------------------------------------ */

describe("ssh-key-generator run()", () => {
  it("reproduces the OpenSSH public key line ssh-keygen derives from the same key", () => {
    const out = run(undefined, { algorithm: "ed25519", comment: COMMENT, seed: SEED });
    expect(out["Public key (OpenSSH)"]).toBe(PUB_ED25519);
    expect(out["Fingerprint (SHA256)"]).toBe(FP_ED25519);
  });

  it("reproduces the PKCS#8 and SPKI PEM blocks OpenSSL reads back", () => {
    const out = run(undefined, { algorithm: "ed25519", comment: COMMENT, seed: SEED });
    expect(out["Private key (PKCS#8 PEM)"]).toBe(PKCS8_ED25519);
    expect(out["Public key (PEM)"]).toBe(SPKI_ED25519);
  });

  it("generates an ECDSA P-256 key that matches ssh-keygen for the same seed", () => {
    const out = run(undefined, { algorithm: "ecdsa-p256", comment: COMMENT, seed: SEED });
    expect(out["Public key (OpenSSH)"]).toBe(PUB_ECDSA);
    expect(out["Fingerprint (SHA256)"]).toBe(FP_ECDSA);
    expect(out["Key type"]).toContain("ecdsa-sha2-nistp256");
  });

  it("defaults to Ed25519 with no options at all", () => {
    const out = run(undefined, {});
    expect(out["Public key (OpenSSH)"].startsWith("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5")).toBe(true);
    expect(out["Fingerprint (SHA256)"].startsWith("SHA256:")).toBe(true);
  });

  it("draws a different key every time when no seed is given", () => {
    const a = run(undefined, {})["Public key (OpenSSH)"];
    const b = run(undefined, {})["Public key (OpenSSH)"];
    expect(a).not.toBe(b);
  });

  it("omits the trailing comment when none is given, and trims one that is", () => {
    expect(run(undefined, { seed: SEED })["Public key (OpenSSH)"]).toBe(
      PUB_ED25519.replace(` ${COMMENT}`, ""),
    );
    expect(run(undefined, { seed: SEED, comment: "  a@b  " })["Public key (OpenSSH)"]).toMatch(
      / a@b$/,
    );
  });

  it("warns that a seeded key is reproducible and must not be used for real", () => {
    expect(run(undefined, { seed: SEED }).Warning).toContain("reproducible");
    expect(run(undefined, {}).Warning).toBeUndefined();
  });

  it("explains how to install the key and how to add a passphrase", () => {
    const out = run(undefined, { algorithm: "ed25519" });
    expect(out["Install the public key"]).toContain("authorized_keys");
    expect(out["Add a passphrase"]).toContain("ssh-keygen -p -f ~/.ssh/id_ed25519");
    expect(run(undefined, { algorithm: "ecdsa-p256" })["Add a passphrase"]).toContain("id_ecdsa");
  });
});

describe("ssh-key-generator openssh-key-v1 container", () => {
  it("writes an unencrypted single key container with matching checkints", () => {
    const out = run(undefined, { algorithm: "ed25519", comment: COMMENT, seed: SEED });
    const parsed = parseOpenSshPrivate(out["Private key (OpenSSH)"]!);
    expect(parsed.cipher).toBe("none");
    expect(parsed.kdf).toBe("none");
    expect(parsed.keyCount).toBe(1);
    expect(parsed.keyType).toBe("ssh-ed25519");
    expect(parsed.comment).toBe(COMMENT);
    expect(parsed.checkintsMatch).toBe(true);
  });

  it("pads the private block to the cipher block size with 1, 2, 3 and so on", () => {
    const parsed = parseOpenSshPrivate(
      run(undefined, { algorithm: "ed25519", comment: COMMENT, seed: SEED })[
        "Private key (OpenSSH)"
      ]!,
    );
    expect(parsed.padding).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.padding.length).toBeLessThan(8);
  });

  it("carries the same public key inside the private file as on the public line", () => {
    for (const algorithm of ["ed25519", "ecdsa-p256"]) {
      const out = run(undefined, { algorithm, comment: COMMENT, seed: SEED });
      const parsed = parseOpenSshPrivate(out["Private key (OpenSSH)"]!);
      expect(toBase64(parsed.publicBlob)).toBe(out["Public key (OpenSSH)"]!.split(" ")[1]);
      expect(parsed.embeddedPublic.length).toBe(algorithm === "ed25519" ? 32 : 65);
    }
  });

  it("wraps the OpenSSH block at 70 columns and PEM at 64", () => {
    const out = run(undefined, { algorithm: "ecdsa-p256", seed: SEED });
    const openssh = out["Private key (OpenSSH)"]!.split("\n").filter((l) => !l.startsWith("---"));
    expect(Math.max(...openssh.filter((l) => l).map((l) => l.length))).toBe(70);
    const pkcs8 = out["Private key (PKCS#8 PEM)"]!.split("\n").filter(
      (l) => l && !l.startsWith("---"),
    );
    expect(Math.max(...pkcs8.map((l) => l.length))).toBe(64);
  });
});

describe("ssh-key-generator errors", () => {
  it("throws on an unknown algorithm", () => {
    try {
      run(undefined, { algorithm: "rsa-4096" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("bad-option");
      expect((err as ToolError).fix).toContain("Ed25519");
    }
  });

  it("throws when the comment contains a line break", () => {
    expect(() => run(undefined, { comment: "a\nb" })).toThrow(/cannot contain a line break/);
  });
});

describe("ssh-key-generator helpers", () => {
  it("produces the same bytes for the same seed and different bytes for another", () => {
    expect(seededBytes("a", 8)).toEqual(seededBytes("a", 8));
    expect(seededBytes("a", 8)).not.toEqual(seededBytes("b", 8));
    expect(seededBytes("a", 40).length).toBe(40);
  });

  it("prepends a zero byte to an mpint whose top bit is set", () => {
    // 0x80... would read as negative, so a pad byte is required.
    expect([...sshMpint(new Uint8Array([0x80, 1]))]).toEqual([0, 0, 0, 3, 0, 0x80, 1]);
    // 0x7f... is already positive, so no pad.
    expect([...sshMpint(new Uint8Array([0x7f, 1]))]).toEqual([0, 0, 0, 2, 0x7f, 1]);
    // Redundant leading zeros are stripped first.
    expect([...sshMpint(new Uint8Array([0, 0, 5]))]).toEqual([0, 0, 0, 1, 5]);
  });

  it("builds a public key blob whose first field is the key type", () => {
    const key = generateKeypair("ed25519", SEED);
    const blob = publicKeyBlob(key);
    expect(new TextDecoder().decode(blob.subarray(4, 4 + 11))).toBe("ssh-ed25519");
    expect(fingerprint(key)).toBe(FP_ED25519);
    expect(openSshPublicKey(key, "")).not.toContain(" test@");
  });

  it("wraps PEM bodies at the column count it is given", () => {
    const bytes = new Uint8Array(100).fill(7);
    const lines = pem("TEST", bytes, 16).split("\n");
    expect(lines[0]).toBe("-----BEGIN TEST-----");
    expect(lines[1]!.length).toBe(16);
    expect(lines.at(-2)).toBe("-----END TEST-----");
  });
});

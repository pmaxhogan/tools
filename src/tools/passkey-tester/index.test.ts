import { Encoder } from "cbor-x";
import { describe, expect, it } from "vitest";
import { run, type PasskeyTesterResult } from "./index";

/**
 * cbor-x defaults to its own extensions (tag 259 for Maps, tag 64 for typed
 * arrays). WebAuthn payloads are plain canonical CBOR, so the fixtures use an
 * encoder with those extensions switched off. useTag259ForMaps is honored at
 * runtime but missing from the shipped Options type, hence the cast.
 */
const encoderOptions = {
  useTag259ForMaps: false,
  tagUint8Array: false,
  useRecords: false,
  variableMapSize: true,
} as ConstructorParameters<typeof Encoder>[0];

const encoder = new Encoder(encoderOptions);

/** cbor-x reuses an internal buffer, so every fixture gets its own copy. */
function cbor(value: unknown): Uint8Array {
  return Uint8Array.from(encoder.encode(value));
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-f]/gi, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function u16(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function filled(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (seed + i * 7) & 0xff;
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const RP_ID_HASH = filled(32, 1);
const ICLOUD_AAGUID = hexToBytes("fbfc3007154e4ecc8c0b6e020557d7bd");
const ZERO_AAGUID = new Uint8Array(16);
const CRED_ID = filled(20, 200);

/** A COSE_Key for an ES256 key on P-256. */
function es256Key(): Map<number, unknown> {
  return new Map<number, unknown>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, filled(32, 40)],
    [-3, filled(32, 90)],
  ]);
}

/** A COSE_Key for a 2048 bit RS256 key. */
function rs256Key(): Map<number, unknown> {
  return new Map<number, unknown>([
    [1, 3],
    [3, -257],
    [-1, filled(256, 3)],
    [-2, new Uint8Array([0x01, 0x00, 0x01])],
  ]);
}

interface AuthDataParts {
  flags: number;
  signCount?: number;
  aaguid?: Uint8Array;
  credentialId?: Uint8Array;
  coseKey?: Map<number, unknown>;
  extensions?: unknown;
}

function buildAuthData(parts: AuthDataParts): Uint8Array {
  const chunks: Uint8Array[] = [
    RP_ID_HASH,
    new Uint8Array([parts.flags]),
    u32(parts.signCount ?? 0),
  ];
  if (parts.flags & 0x40) {
    const credentialId = parts.credentialId ?? CRED_ID;
    chunks.push(parts.aaguid ?? ICLOUD_AAGUID);
    chunks.push(u16(credentialId.length));
    chunks.push(credentialId);
    chunks.push(cbor(parts.coseKey ?? es256Key()));
  }
  if (parts.flags & 0x80) chunks.push(cbor(parts.extensions ?? { credProtect: 2 }));
  return concat(chunks);
}

function attestationObject(fmt: string, attStmt: unknown, authData: Uint8Array): string {
  return toBase64Url(cbor({ fmt, attStmt, authData }));
}

const SUMMARY = { view: "summary" };
const FULL = { view: "full" };

function rows(input: string, opts = SUMMARY): PasskeyTesterResult {
  return run(input, opts);
}

describe("passkey-tester", () => {
  it("decodes a none attestation object with attested credential data", () => {
    const authData = buildAuthData({ flags: 0x45, signCount: 0 });
    const out = rows(attestationObject("none", {}, authData));

    expect(out["Detected input"]).toBe("attestation object (registration)");
    expect(out["Attestation format"]).toBe("none");
    expect(out["Attestation statement"]).toBe("empty, the authenticator sent no attestation");
    expect(out["Signature verification"]).toBe(
      "not performed, this tool decodes and explains only",
    );
    expect(out["Flags byte"]).toBe("0x45");
    expect(out["User present (UP)"]).toBe("yes");
    expect(out["User verified (UV)"]).toBe("yes");
    expect(out["Backup eligible (BE)"]).toBe("no");
    expect(out["Backed up (BS)"]).toBe("no");
    expect(out["Attested credential data (AT)"]).toBe("yes");
    expect(out["Extension data (ED)"]).toBe("no");
    expect(out["Signature counter"]).toBe("0");
    expect(out["AAGUID"]).toBe("fbfc3007-154e-4ecc-8c0b-6e020557d7bd");
    expect(out["Authenticator"]).toBe("iCloud Keychain");
    expect(out["Credential ID length"]).toBe("20 bytes");
    expect(out["Credential ID (base64url)"]).toBe(toBase64Url(CRED_ID));
    expect(out["Key type"]).toBe("EC2 (elliptic curve)");
    expect(out["Algorithm"]).toBe("ES256 (-7)");
    expect(out["Curve"]).toBe("P-256");
    expect(out["Public key x"]).toBe("32 bytes");
    expect(out["Public key y"]).toBe("32 bytes");
  });

  it("reads the backup flags and a non zero signature counter", () => {
    const authData = buildAuthData({ flags: 0x5d, signCount: 42 });
    const out = rows(attestationObject("none", {}, authData));

    expect(out["Backup eligible (BE)"]).toBe("yes");
    expect(out["Backed up (BS)"]).toBe("yes");
    expect(out["Signature counter"]).toBe("42");
  });

  it("reports the packed attestation algorithm and certificate chain", () => {
    const authData = buildAuthData({ flags: 0x45 });
    const attStmt = { alg: -7, sig: filled(70, 5), x5c: [filled(300, 9)] };
    const out = rows(attestationObject("packed", attStmt, authData));

    expect(out["Attestation format"]).toBe("packed");
    expect(out["Attestation algorithm"]).toBe("ES256 (-7)");
    expect(out["Certificate chain (x5c)"]).toBe("present, 1 certificate");
    expect(out["Attestation statement fields"]).toBe("alg, sig, x5c");
  });

  it("marks self attestation when packed carries no x5c", () => {
    const authData = buildAuthData({ flags: 0x45 });
    const out = rows(attestationObject("packed", { alg: -257, sig: filled(64, 2) }, authData));

    expect(out["Attestation algorithm"]).toBe("RS256 (-257)");
    expect(out["Certificate chain (x5c)"]).toBe("absent (self attestation or no certificate)");
  });

  it("names an all zero AAGUID and an unrecognised one", () => {
    const zero = rows(
      attestationObject("none", {}, buildAuthData({ flags: 0x45, aaguid: ZERO_AAGUID })),
    );
    expect(zero["AAGUID"]).toBe("00000000-0000-0000-0000-000000000000");
    expect(zero["Authenticator"]).toBe("none reported (all zero AAGUID)");

    const unknown = rows(
      attestationObject(
        "none",
        {},
        buildAuthData({ flags: 0x45, aaguid: hexToBytes("0102030405060708090a0b0c0d0e0f10") }),
      ),
    );
    expect(unknown["AAGUID"]).toBe("01020304-0506-0708-090a-0b0c0d0e0f10");
    expect(unknown["Authenticator"]).toBe("unknown AAGUID");
  });

  it("describes an RSA credential public key", () => {
    const authData = buildAuthData({ flags: 0x45, coseKey: rs256Key() });
    const out = rows(attestationObject("none", {}, authData));

    expect(out["Key type"]).toBe("RSA");
    expect(out["Algorithm"]).toBe("RS256 (-257)");
    expect(out["Modulus (n)"]).toBe("256 bytes (2048 bit key)");
    expect(out["Exponent (e)"]).toBe("3 bytes");
  });

  it("decodes raw authenticator data with no attested credential data", () => {
    const authData = buildAuthData({ flags: 0x05, signCount: 7 });
    const out = rows(toBase64Url(authData));

    expect(out["Detected input"]).toBe("authenticator data (raw bytes)");
    expect(out["Authenticator data size"]).toBe("37 bytes");
    expect(out["Attested credential data (AT)"]).toBe("no");
    expect(out["Signature counter"]).toBe("7");
    expect(out["AAGUID"]).toBeUndefined();
    expect(out["Attestation format"]).toBeUndefined();
  });

  it("decodes extension data when the ED flag is set", () => {
    const authData = buildAuthData({ flags: 0xc5, extensions: { credProtect: 2 } });
    const out = rows(attestationObject("none", {}, authData));

    expect(out["Extension data (ED)"]).toBe("yes");
    expect(out["Extensions"]).toBe('{"credProtect":2}');
  });

  it("decodes the registration JSON shape with clientDataJSON", () => {
    const clientData = {
      type: "webauthn.create",
      challenge: "Y2hhbGxlbmdl",
      origin: "https://tools.maxhogan.dev",
      crossOrigin: false,
    };
    const credential = {
      type: "public-key",
      id: toBase64Url(CRED_ID),
      response: {
        attestationObject: attestationObject("none", {}, buildAuthData({ flags: 0x45 })),
        clientDataJSON: toBase64Url(new TextEncoder().encode(JSON.stringify(clientData))),
      },
    };
    const out = rows(JSON.stringify(credential));

    expect(out["Detected input"]).toBe("credential JSON (registration)");
    expect(out["Credential type"]).toBe("public-key");
    expect(out["Credential ID from JSON"]).toBe(toBase64Url(CRED_ID));
    expect(out["Client data type"]).toBe("webauthn.create");
    expect(out["Challenge (base64url)"]).toBe("Y2hhbGxlbmdl");
    expect(out["Origin"]).toBe("https://tools.maxhogan.dev");
    expect(out["Cross origin"]).toBe("no");
    expect(out["Authenticator"]).toBe("iCloud Keychain");
  });

  it("decodes the assertion JSON shape", () => {
    const clientData = {
      type: "webauthn.get",
      challenge: "YXNzZXJ0",
      origin: "https://example.com",
      crossOrigin: true,
    };
    const credential = {
      type: "public-key",
      id: toBase64Url(CRED_ID),
      response: {
        authenticatorData: toBase64Url(buildAuthData({ flags: 0x1d, signCount: 3 })),
        clientDataJSON: toBase64Url(new TextEncoder().encode(JSON.stringify(clientData))),
        signature: toBase64Url(filled(71, 11)),
        userHandle: "dXNlci0x",
      },
    };
    const out = rows(JSON.stringify(credential));

    expect(out["Detected input"]).toBe("credential JSON (authentication)");
    expect(out["Client data type"]).toBe("webauthn.get");
    expect(out["Cross origin"]).toBe("yes");
    expect(out["Signature counter"]).toBe("3");
    expect(out["Signature"]).toBe("71 bytes");
    expect(out["User handle"]).toBe("dXNlci0x");
    expect(out["Attestation format"]).toBeUndefined();
  });

  it("reports a missing user handle on an assertion", () => {
    const out = rows(
      JSON.stringify({
        response: { authenticatorData: toBase64Url(buildAuthData({ flags: 0x05 })) },
      }),
    );
    expect(out["User handle"]).toBe("not provided");
  });

  it("adds raw hex rows in the full view", () => {
    const authData = buildAuthData({ flags: 0x45 });
    const summary = rows(attestationObject("none", {}, authData));
    const full = rows(attestationObject("none", {}, authData), FULL);

    expect(summary["RP ID hash (SHA-256)"]).toBe("01080f161d242b32...");
    expect(summary["Authenticator data (hex)"]).toBeUndefined();
    expect(summary["COSE public key (JSON)"]).toBeUndefined();

    expect(full["RP ID hash (SHA-256)"]).toHaveLength(64);
    expect(full["Authenticator data (hex)"]).toBe(
      Array.from(authData)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );
    expect(JSON.parse(full["COSE public key (JSON)"])).toMatchObject({
      kty: 2,
      alg: -7,
      crv: 1,
    });
    expect(full["Credential ID (hex)"]).toHaveLength(40);
  });

  it("accepts standard base64 with padding as well as base64url", () => {
    const bytes = cbor({ fmt: "none", attStmt: {}, authData: buildAuthData({ flags: 0x45 }) });
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    const standard = btoa(binary);

    expect(rows(standard)["Authenticator"]).toBe("iCloud Keychain");
    expect(rows(`  ${toBase64Url(bytes)}\n`)["Authenticator"]).toBe("iCloud Keychain");
  });

  it("throws empty-input on blank input", () => {
    expect(() => rows("")).toThrowError(expect.objectContaining({ code: "empty-input" }));
    expect(() => rows("   \n ")).toThrowError(expect.objectContaining({ code: "empty-input" }));
  });

  it("throws bad-base64 on characters that are not base64", () => {
    expect(() => rows("not base64 ***")).toThrowError(
      expect.objectContaining({ code: "bad-base64" }),
    );
  });

  it("throws bad-base64 on a truncated base64 group", () => {
    expect(() => rows("QUJDREU")).not.toThrowError(expect.objectContaining({ code: "bad-base64" }));
    expect(() => rows("Q")).toThrowError(expect.objectContaining({ code: "bad-base64" }));
  });

  it("throws bad-cbor when the bytes are not decodable CBOR", () => {
    // 0x68 opens an 8 byte text string but only two bytes follow.
    expect(() => rows(toBase64Url(new Uint8Array([0x68, 0x65, 0x6c])))).toThrowError(
      expect.objectContaining({ code: "bad-cbor" }),
    );
  });

  it("throws not-webauthn on CBOR that is not a credential", () => {
    expect(() => rows(toBase64Url(cbor({ hello: "world" })))).toThrowError(
      expect.objectContaining({ code: "not-webauthn" }),
    );
  });

  it("throws not-webauthn on JSON without a credential response", () => {
    expect(() => rows('{"type":"public-key","response":{}}')).toThrowError(
      expect.objectContaining({ code: "not-webauthn" }),
    );
    expect(() => rows("{not json at all")).toThrowError(
      expect.objectContaining({ code: "not-webauthn" }),
    );
  });

  it("throws not-webauthn when attested credential data is truncated", () => {
    const authData = buildAuthData({ flags: 0x45 });
    const cut = authData.slice(0, 45);
    expect(() => rows(toBase64Url(cut))).toThrowError(
      expect.objectContaining({ code: "not-webauthn" }),
    );
  });

  it("defaults to the summary view when no option is passed", () => {
    const out = run(attestationObject("none", {}, buildAuthData({ flags: 0x45 })), {
      view: "",
    });
    expect(out["RP ID hash (SHA-256)"]).toBe("01080f161d242b32...");
  });
});

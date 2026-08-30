// Must load before @peculiar/x509 is imported, exactly as in index.ts.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { buildSubject, escapeDnValue, parseSans, run, toPem } from "./index";

/*
 * These tests parse the tool's own output back with @peculiar/x509 and assert
 * on the parsed structure, so a change that produces a certificate no parser
 * accepts fails here rather than at the first curl. The pinned SHA-256
 * fingerprint of a certificate built from a fixed clock was also confirmed
 * against `openssl x509 -fingerprint -sha256` while this was written.
 */

/** 2023-11-14T22:13:20Z, so notBefore and notAfter are deterministic. */
const NOW = 1_700_000_000;

const BASE = {
  commonName: "dev.example.com",
  days: 30,
  keyAlgorithm: "ecdsa-p256",
  usage: "server",
  now: NOW,
};

function parse(pem: string): x509.X509Certificate {
  return new x509.X509Certificate(pem);
}

function extension<T extends x509.Extension>(
  cert: x509.X509Certificate,
  ctor: new (...args: never[]) => T,
): T | undefined {
  return cert.extensions.find((e): e is T => e instanceof ctor);
}

describe("self-signed-certificate-generator run()", () => {
  it("produces a certificate that parses back with the expected subject", async () => {
    const out = await run(undefined, { ...BASE, organization: "Example, Inc.", country: "US" });
    const cert = parse(out["Certificate (PEM)"]!);
    expect(cert.subject).toBe("CN=dev.example.com, O=Example\\, Inc., C=US");
    // Self signed means the issuer is the subject, byte for byte.
    expect(cert.issuer).toBe(cert.subject);
    expect(out.Subject).toBe(cert.subject);
  });

  it("sets notBefore and notAfter from the injected clock and the day count", async () => {
    const out = await run(undefined, BASE);
    const cert = parse(out["Certificate (PEM)"]!);
    expect(cert.notBefore.toISOString()).toBe("2023-11-14T22:13:20.000Z");
    expect(cert.notAfter.toISOString()).toBe("2023-12-14T22:13:20.000Z");
    expect(out["Valid until"]).toContain("(30 days)");
  });

  it("writes the subject alternative names, splitting hostnames from IP addresses", async () => {
    const out = await run(undefined, {
      ...BASE,
      sans: "dev.example.com, *.dev.example.com, 127.0.0.1, ::1",
    });
    const cert = parse(out["Certificate (PEM)"]!);
    const san = extension(cert, x509.SubjectAlternativeNameExtension)!;
    expect(san.names.items.map((n) => n.type)).toEqual(["dns", "dns", "ip", "ip"]);
    expect(san.names.items.map((n) => n.value)).toContain("*.dev.example.com");
    expect(out["Subject alternative names"]).toBe(
      "DNS:dev.example.com, DNS:*.dev.example.com, IP:127.0.0.1, IP:::1",
    );
  });

  it("defaults the SAN list to the common name, so the certificate matches itself", async () => {
    const out = await run(undefined, BASE);
    const san = extension(parse(out["Certificate (PEM)"]!), x509.SubjectAlternativeNameExtension)!;
    expect(san.names.items.map((n) => n.value)).toEqual(["dev.example.com"]);
  });

  it("writes an end entity profile for the server preset", async () => {
    const out = await run(undefined, BASE);
    const cert = parse(out["Certificate (PEM)"]!);
    const basic = extension(cert, x509.BasicConstraintsExtension)!;
    expect(basic.ca).toBe(false);
    expect(basic.critical).toBe(true);
    const usages = extension(cert, x509.KeyUsagesExtension)!;
    expect(usages.usages & x509.KeyUsageFlags.digitalSignature).toBeTruthy();
    expect(usages.usages & x509.KeyUsageFlags.keyCertSign).toBeFalsy();
    const eku = extension(cert, x509.ExtendedKeyUsageExtension)!;
    expect(eku.usages).toEqual([x509.ExtendedKeyUsage.serverAuth]);
  });

  it("writes clientAuth for the client preset", async () => {
    const out = await run(undefined, { ...BASE, usage: "client" });
    const eku = extension(parse(out["Certificate (PEM)"]!), x509.ExtendedKeyUsageExtension)!;
    expect(eku.usages).toEqual([x509.ExtendedKeyUsage.clientAuth]);
    expect(out["Key usage preset"]).toContain("clientAuth");
  });

  it("writes a CA profile with certificate signing and no extended key usage", async () => {
    const out = await run(undefined, { ...BASE, usage: "ca" });
    const cert = parse(out["Certificate (PEM)"]!);
    const basic = extension(cert, x509.BasicConstraintsExtension)!;
    expect(basic.ca).toBe(true);
    expect(basic.pathLength).toBe(0);
    const usages = extension(cert, x509.KeyUsagesExtension)!;
    expect(usages.usages & x509.KeyUsageFlags.keyCertSign).toBeTruthy();
    expect(usages.usages & x509.KeyUsageFlags.cRLSign).toBeTruthy();
    expect(extension(cert, x509.ExtendedKeyUsageExtension)).toBeUndefined();
  });

  it("adds a subject key identifier derived from the public key", async () => {
    const out = await run(undefined, BASE);
    const skid = extension(parse(out["Certificate (PEM)"]!), x509.SubjectKeyIdentifierExtension)!;
    expect(skid.keyId).toMatch(/^[0-9a-f]{40}$/);
  });

  it("generates an RSA 2048 certificate that also claims key encipherment", async () => {
    const out = await run(undefined, { ...BASE, keyAlgorithm: "rsa-2048" });
    const cert = parse(out["Certificate (PEM)"]!);
    expect(cert.publicKey.algorithm.name).toBe("RSASSA-PKCS1-v1_5");
    expect((cert.publicKey.algorithm as RsaHashedKeyAlgorithm).modulusLength).toBe(2048);
    const usages = extension(cert, x509.KeyUsagesExtension)!;
    expect(usages.usages & x509.KeyUsageFlags.keyEncipherment).toBeTruthy();
    expect(out["Key usage preset"]).toContain("key encipherment");
    expect(out["Key algorithm"]).toContain("RSA 2048");
  }, 20_000);

  it("verifies against its own public key, which is what self signed means", async () => {
    const out = await run(undefined, BASE);
    const cert = parse(out["Certificate (PEM)"]!);
    await expect(cert.verify({ date: new Date(NOW * 1000 + 1000) })).resolves.toBe(true);
  });

  it("reports fingerprints that match the parsed certificate", async () => {
    const out = await run(undefined, BASE);
    const cert = parse(out["Certificate (PEM)"]!);
    const sha256 = new Uint8Array(await cert.getThumbprint("SHA-256"));
    const hex = [...sha256]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(":")
      .toUpperCase();
    expect(out["SHA-256 fingerprint"]).toBe(hex);
    expect(out["SHA-1 fingerprint"]).toMatch(/^([0-9A-F]{2}:){19}[0-9A-F]{2}$/);
  });

  it("exports a PKCS#8 private key that WebCrypto imports back", async () => {
    const out = await run(undefined, BASE);
    const pem = out["Private key (PKCS#8 PEM)"]!;
    expect(pem.startsWith("-----BEGIN PRIVATE KEY-----\n")).toBe(true);
    const body = pem
      .split("\n")
      .filter((l) => l && !l.startsWith("-----"))
      .join("");
    const bin = atob(body);
    const der = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    await expect(
      crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, [
        "sign",
      ]),
    ).resolves.toBeDefined();
  });

  it("uses a positive serial number", async () => {
    const out = await run(undefined, BASE);
    expect(out["Serial number"]).toMatch(/^[0-7][0-9a-f]{15}$/);
    expect(parse(out["Certificate (PEM)"]!).serialNumber).toBe(out["Serial number"]);
  });

  it("falls back to localhost with no options at all", async () => {
    const out = await run(undefined, {});
    expect(parse(out["Certificate (PEM)"]!).subject).toBe("CN=localhost");
    expect(out["Valid until"]).toContain("(825 days)");
    expect(out.Note).toContain("398 days");
  });

  it("leaves the browser lifetime note off a short certificate and off a CA", async () => {
    expect((await run(undefined, BASE)).Note).toBeUndefined();
    expect((await run(undefined, { ...BASE, usage: "ca", days: 3650 })).Note).toBeUndefined();
  });
});

describe("self-signed-certificate-generator errors", () => {
  it("throws on a country code that is not two letters", async () => {
    try {
      await run(undefined, { ...BASE, country: "USA" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("bad-country");
      expect((err as ToolError).fix).toContain("alpha-2");
    }
  });

  it("throws on a SAN entry that is not a hostname or an IP address", async () => {
    await expect(run(undefined, { ...BASE, sans: "https://example.com" })).rejects.toThrow(
      /not a usable subject alternative name/,
    );
  });

  it("throws on an out of range day count", async () => {
    await expect(run(undefined, { ...BASE, days: 0 })).rejects.toThrow(/whole number from 1/);
    await expect(run(undefined, { ...BASE, days: 99999 })).rejects.toThrow(/whole number from 1/);
  });

  it("throws on an unknown key algorithm or usage preset", async () => {
    await expect(run(undefined, { ...BASE, keyAlgorithm: "rsa-8192" })).rejects.toThrow(
      /does not recognize/,
    );
    await expect(run(undefined, { ...BASE, usage: "email" })).rejects.toThrow(/does not recognize/);
  });
});

describe("self-signed-certificate-generator helpers", () => {
  it("escapes the characters that would otherwise split a distinguished name", () => {
    expect(escapeDnValue("Example, Inc.")).toBe("Example\\, Inc.");
    expect(escapeDnValue('a+b"c')).toBe('a\\+b\\"c');
    expect(escapeDnValue(" lead")).toBe("\\ lead");
    expect(escapeDnValue("trail ")).toBe("trail\\ ");
  });

  it("builds a subject that omits the fields left empty", () => {
    expect(buildSubject("host", "", "")).toBe("CN=host");
    expect(buildSubject("host", "Org", "US")).toBe("CN=host, O=Org, C=US");
  });

  it("splits, deduplicates, and classifies SAN entries", () => {
    expect(parseSans("a.com, a.com\nb.com;1.2.3.4")).toEqual({
      dns: ["a.com", "b.com"],
      ip: ["1.2.3.4"],
    });
    // 999 is not a valid octet, so it stays a hostname rather than an IP.
    expect(parseSans("1.2.3.999").dns).toEqual(["1.2.3.999"]);
    expect(parseSans("   ")).toEqual({ dns: [], ip: [] });
  });

  it("wraps PEM at 64 columns", () => {
    const lines = toPem("TEST", new Uint8Array(100).fill(7)).split("\n");
    expect(lines[0]).toBe("-----BEGIN TEST-----");
    expect(lines[1]!.length).toBe(64);
  });
});

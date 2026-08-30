// Must load before @peculiar/x509 is imported, exactly as in index.ts.
import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { run } from "./index";

/*
 * Fixtures: a three certificate chain plus one Ed25519 certificate, generated
 * once with OpenSSL 3.2.1 and pasted here verbatim. Only the certificates are
 * embedded; the private keys were never checked in. Every pinned fingerprint,
 * serial, and key identifier below comes from `openssl x509`, so the assertions
 * cross-check this tool against an independent implementation.
 *
 *   root   RSA 2048, self signed CA, 2026-08-19 to 2046-08-14
 *   inter  EC P-256 CA (pathlen 0) signed by root, 2026-08-19 to 2036-08-16
 *   leaf   EC P-256 end entity signed by inter, 2026-08-19 to 2026-11-27
 *   ed     Ed25519 self signed, 2026-08-19 to 2036-08-16
 */

const ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIDkzCCAnugAwIBAgICBNIwDQYJKoZIhvcNAQELBQAwWjELMAkGA1UEBhMCVVMx
ETAPBgNVBAgMCE1pc3NvdXJpMRkwFwYDVQQKDBBFeGFtcGxlIFRlc3QgT3JnMR0w
GwYDVQQDDBRFeGFtcGxlIFRlc3QgUm9vdCBDQTAeFw0yNjA4MTkwNDEwMjlaFw00
NjA4MTQwNDEwMjlaMFoxCzAJBgNVBAYTAlVTMREwDwYDVQQIDAhNaXNzb3VyaTEZ
MBcGA1UECgwQRXhhbXBsZSBUZXN0IE9yZzEdMBsGA1UEAwwURXhhbXBsZSBUZXN0
IFJvb3QgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCrK9swm5yM
HHw/VPU9EFxBdszkSydoSx79X+aa4nvIRLU35jZKjtLkAmnxK1j+ZHJWy12pddiz
YyT2iABiY4kb3rVjYLyru+ocaPfwvi5kuCX4bb7HojGU+uE6E3/T5beVEJ8eDAo8
ZqgRBqVSmfBYyFVP3lPhXER4ZnwnEhjKSvhFz3DAd/9cxHMBkyLKLCLDCksjbkfp
LfcfY8SJa+OigpKvG+ozP45DCaBs10b6CWacX3OB2BNUx58cSpn/s86z6u650aGj
llnF3pNXE4OZPTzY9G+FoaCXDz76/BAno6E5iCWVjM0GkOM57bP63uXTJsQHXZEw
+hqRpmw3v6n1AgMBAAGjYzBhMB8GA1UdIwQYMBaAFA/y/QiTxpVCn/X7/F3fgG6O
83C3MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMB0GA1UdDgQWBBQP
8v0Ik8aVQp/1+/xd34BujvNwtzANBgkqhkiG9w0BAQsFAAOCAQEAez4yBb9E0noe
RNEMvXP+hISz2XRWGfF7BjHHUo8dIgd0lfxvNwnWndeecaeR77GV0crpwjXZN7jC
91kfcKBbHj/2RH5pvq0x0RH4wjPgDuWt12uj4qVoQRdI/ueowVDn8sFF1CSzSbB0
SIHMDuLeDR5AJBnz8fL1QXNDfqM+x2tA8K6kr26mj2+rrTUxVVuSJn2t8lST3BNY
7RzmIt4U23ukhmXM5orMu/jqmHBjvuU1+mttdLOW1LHf5/7ct0D4ii3ymk1+dUVk
j3wswU5aTwgpdJRmtNIRAan2XCyul8x09hA9S0fSS4VLDFBFjII8trjRozpIcfhM
O5PN7qBMCw==
-----END CERTIFICATE-----`;

const INTER_PEM = `-----BEGIN CERTIFICATE-----
MIICwTCCAamgAwIBAgIDGis8MA0GCSqGSIb3DQEBCwUAMFoxCzAJBgNVBAYTAlVT
MREwDwYDVQQIDAhNaXNzb3VyaTEZMBcGA1UECgwQRXhhbXBsZSBUZXN0IE9yZzEd
MBsGA1UEAwwURXhhbXBsZSBUZXN0IFJvb3QgQ0EwHhcNMjYwODE5MDQxMDQ1WhcN
MzYwODE2MDQxMDQ1WjBPMQswCQYDVQQGEwJVUzEZMBcGA1UECgwQRXhhbXBsZSBU
ZXN0IE9yZzElMCMGA1UEAwwcRXhhbXBsZSBUZXN0IEludGVybWVkaWF0ZSBDQTBZ
MBMGByqGSM49AgEGCCqGSM49AwEHA0IABMuhPqftfw8AhrCcRspX7SkC2ZM4vL9Z
xrx6k9/GToNp0FIEUyujGPtypZP3svf2FPlWzrOCmjH1gNEzXxBZefejZjBkMBIG
A1UdEwEB/wQIMAYBAf8CAQAwDgYDVR0PAQH/BAQDAgGGMB0GA1UdDgQWBBRGdDeK
C1/uvBi/Mu55eDJATdfsmTAfBgNVHSMEGDAWgBQP8v0Ik8aVQp/1+/xd34BujvNw
tzANBgkqhkiG9w0BAQsFAAOCAQEAH92tzWdMFJR02S3fjcgv5wnDSTumnJQrswS4
aoVkmC1NKD6NzKwOBaaAeIZq/oV5GWDm/IRkugD25Rwdryml12z7NGwZ1VhON3Rc
nLxu9mxLDkCGPPJf0lFpq/rNMv/LPVNNbkQMK4fI5T+A12D4n9qs/7KdoPUVGsfO
kMA9r0N12ChgEfryZswdlfqxcb+azJ/GleFobgA3GMgBxO9qVHOfZca9FBqwwLF1
fMPmCwLvrpGoXnruiMmcOnyR1Wt5c2xlGVI2kUMA9bFrshKfGExNMc1m/m6sX6Km
9nP29pHgQGTPNeasM6gYPET/CTUZWgNGx+1/L4PKpk35IhGe7Q==
-----END CERTIFICATE-----`;

const LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIICbDCCAhKgAwIBAgIEC63A3jAKBggqhkjOPQQDAjBPMQswCQYDVQQGEwJVUzEZ
MBcGA1UECgwQRXhhbXBsZSBUZXN0IE9yZzElMCMGA1UEAwwcRXhhbXBsZSBUZXN0
IEludGVybWVkaWF0ZSBDQTAeFw0yNjA4MTkwNDEwNDVaFw0yNjExMjcwNDEwNDVa
MEMxCzAJBgNVBAYTAlVTMRkwFwYDVQQKDBBFeGFtcGxlIFRlc3QgT3JnMRkwFwYD
VQQDDBB0ZXN0LmV4YW1wbGUuY29tMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE
nClJt9B8HNJ8gLJgkpjfmhevsKJoPrnJg8G7QPi4nFj9Nwy+0u/TGQOXV1AmTkNk
vZ6ujvtnaq4m6U3FgmdTxaOB5zCB5DAMBgNVHRMBAf8EAjAAMA4GA1UdDwEB/wQE
AwIFoDAdBgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIwHQYDVR0OBBYEFLvV
I+DseIIbbldXjhzecxS2fbmAMB8GA1UdIwQYMBaAFEZ0N4oLX+68GL8y7nl4MkBN
1+yZMGUGA1UdEQReMFyCEHRlc3QuZXhhbXBsZS5jb22CFHd3dy50ZXN0LmV4YW1w
bGUuY29thwTAAAIKgRFhZG1pbkBleGFtcGxlLmNvbYYZaHR0cHM6Ly90ZXN0LmV4
YW1wbGUuY29tLzAKBggqhkjOPQQDAgNIADBFAiEA1IS8SCkbHgL/B7Ks4tobFgZP
wYfcJi7hfy+xqmbUmI4CIDNfnD1eCoZ5o2HoKAEXSFUas0jyYqRCg+GqczMKxrTf
-----END CERTIFICATE-----`;

const ED_PEM = `-----BEGIN CERTIFICATE-----
MIIBXjCCARCgAwIBAgIBezAFBgMrZXAwHjEcMBoGA1UEAwwTZWQyNTUxOS5leGFt
cGxlLmNvbTAeFw0yNjA4MTkwNDEwNTZaFw0zNjA4MTYwNDEwNTZaMB4xHDAaBgNV
BAMME2VkMjU1MTkuZXhhbXBsZS5jb20wKjAFBgMrZXADIQDbcyhPy/2VrIQrL4zE
t+stTeOazO5MpNGUT7i+paI+QqNzMHEwHQYDVR0OBBYEFBlfwoBjNdE3S1rYr4EA
fhI1D9NlMB8GA1UdIwQYMBaAFBlfwoBjNdE3S1rYr4EAfhI1D9NlMA8GA1UdEwEB
/wQFMAMBAf8wHgYDVR0RBBcwFYITZWQyNTUxOS5leGFtcGxlLmNvbTAFBgMrZXAD
QQCMohKrzfbluYKxG5tGMR2gsjdA1qTKqrZSGeJ88CMb0y46bYvqHNiELDPVPDBd
eq0tEmObcCknRn7lRtk1+m8O
-----END CERTIFICATE-----`;

/** 2026-10-16T00:00:00Z, 42 whole days before the leaf's notAfter. */
const NOW_VALID = Date.UTC(2026, 9, 16, 0, 0, 0);
/** 2026-12-07T12:00:00Z, 10 whole days after the leaf's notAfter. */
const NOW_EXPIRED = Date.UTC(2026, 11, 7, 12, 0, 0);
/** 2026-08-09T00:00:00Z, 10 whole days before the leaf's notBefore. */
const NOW_TOO_EARLY = Date.UTC(2026, 7, 9, 0, 0, 0);

const base64Of = (pem: string) => pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");

function derOf(pem: string): Uint8Array {
  const b64 = base64Of(pem);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

describe("certificate-decoder", () => {
  it("decodes a leaf certificate down to the pinned openssl values", async () => {
    const out = await run(LEAF_PEM, { now: NOW_VALID });

    expect(out["Subject"]).toBe("C=US, O=Example Test Org, CN=test.example.com");
    expect(out["Issuer"]).toBe("C=US, O=Example Test Org, CN=Example Test Intermediate CA");
    expect(out["Serial"]).toBe("0BADC0DE");
    expect(out["Not before"]).toBe("2026-08-19T04:10:45.000Z");
    expect(out["Not after"]).toBe("2026-11-27T04:10:45.000Z");
    expect(out["Public key"]).toBe("EC P-256");
    expect(out["Signature algorithm"]).toBe("ECDSA with SHA-256");
    expect(out["Subject alternative names"]).toBe(
      "DNS test.example.com, DNS www.test.example.com, IP 192.0.2.10, email admin@example.com, URI https://test.example.com/",
    );
    expect(out["Key usage"]).toBe("Digital signature, Key encipherment");
    expect(out["Extended key usage"]).toBe("TLS server authentication, TLS client authentication");
    expect(out["Basic constraints"]).toBe("CA: no (end entity certificate)");
    expect(out["Self signed"]).toMatch(/^No:/);
    expect(out["SHA-256 fingerprint"]).toBe(
      "5B:D3:C4:AC:9F:A5:C0:92:58:41:B3:0A:71:68:C4:2F:42:CE:1E:65:0A:CB:3E:19:B1:BE:57:E4:9C:CA:0E:2E",
    );
    expect(out["SHA-1 fingerprint"]).toBe(
      "CB:D7:74:7E:03:25:AB:65:61:A3:90:E7:27:FD:A0:8C:5C:6C:E8:23",
    );
    expect(out["Subject key identifier"]).toBe("BBD523E0EC78821B6E57578E1CDE7314B67DB980");
    expect(out["Authority key identifier"]).toBe("4674378A0B5FEEBC18BF32EE797832404DD7EC99");
    // Single certificate: no "Cert 1: " prefix and no chain rows.
    expect(Object.keys(out).some((k) => k.startsWith("Cert "))).toBe(false);
    expect(out["Chain order"]).toBeUndefined();
  });

  it("reports expiry in plain English on both sides of the window", async () => {
    expect((await run(LEAF_PEM, { now: NOW_VALID }))["Validity"]).toBe("expires in 42 days");
    expect((await run(LEAF_PEM, { now: NOW_EXPIRED }))["Validity"]).toBe("EXPIRED 10 days ago");
    expect((await run(LEAF_PEM, { now: NOW_TOO_EARLY }))["Validity"]).toBe(
      "not valid yet, starts in 10 days",
    );
  });

  it("falls back to the wall clock when no now is injected", async () => {
    expect((await run(LEAF_PEM))["Validity"]).toMatch(/expires in|EXPIRED|not valid yet/);
  });

  it("describes an RSA self signed root", async () => {
    const out = await run(ROOT_PEM, { now: NOW_VALID });
    expect(out["Serial"]).toBe("04D2");
    expect(out["Public key"]).toBe("RSA 2048");
    expect(out["Signature algorithm"]).toBe("RSA PKCS#1 v1.5 with SHA-256");
    expect(out["Key usage"]).toBe("Certificate signing, CRL signing");
    expect(out["Basic constraints"]).toBe("CA: yes, no path length limit");
    expect(out["Extended key usage"]).toBe("not restricted (no extended key usage extension)");
    expect(out["Subject alternative names"]).toBe("none");
    expect(out["Self signed"]).toBe(
      "Likely yes: subject equals issuer, and the authority key identifier matches the subject key identifier. The signature is not verified.",
    );
    expect(out["SHA-256 fingerprint"]).toBe(
      "8F:03:7C:7D:1E:77:6F:DB:DC:6E:23:1E:9B:BF:10:C7:19:E5:9B:91:86:FC:28:99:07:1A:7D:33:19:13:C4:E9",
    );
  });

  it("describes an EC intermediate with a path length constraint", async () => {
    const out = await run(INTER_PEM, { now: NOW_VALID });
    expect(out["Serial"]).toBe("1A2B3C");
    expect(out["Public key"]).toBe("EC P-256");
    expect(out["Signature algorithm"]).toBe("RSA PKCS#1 v1.5 with SHA-256");
    expect(out["Basic constraints"]).toBe("CA: yes, path length 0");
    expect(out["Key usage"]).toBe("Digital signature, Certificate signing, CRL signing");
  });

  it("describes an Ed25519 certificate that carries no key usage extension", async () => {
    const out = await run(ED_PEM, { now: NOW_VALID });
    expect(out["Serial"]).toBe("7B");
    expect(out["Public key"]).toBe("Ed25519");
    expect(out["Signature algorithm"]).toBe("Ed25519");
    expect(out["Key usage"]).toBe("not restricted (no key usage extension)");
    expect(out["Subject alternative names"]).toBe("DNS ed25519.example.com");
    expect(out["SHA-1 fingerprint"]).toBe(
      "25:90:96:32:43:C1:74:96:52:EC:B2:FC:13:63:57:C0:AA:7E:F2:26",
    );
  });

  it("numbers every certificate and reports a correct chain", async () => {
    const out = await run([LEAF_PEM, INTER_PEM, ROOT_PEM].join("\n"), { now: NOW_VALID });
    expect(out["Certificates found"]).toBe("3");
    expect(out["Cert 1: Subject"]).toBe("C=US, O=Example Test Org, CN=test.example.com");
    expect(out["Cert 2: Subject"]).toBe(
      "C=US, O=Example Test Org, CN=Example Test Intermediate CA",
    );
    expect(out["Cert 3: Subject"]).toBe(
      "C=US, ST=Missouri, O=Example Test Org, CN=Example Test Root CA",
    );
    expect(out["Chain 1 to 2"]).toContain("likely chain link");
    expect(out["Chain 2 to 3"]).toContain("likely chain link");
    expect(out["Chain order"]).toBe("leaf -> intermediate -> root order looks correct.");
    expect(out["Chain note"]).toContain("does not verify chain signatures");
  });

  it("flags a chain that is missing its root", async () => {
    const out = await run([LEAF_PEM, INTER_PEM].join("\n"), { now: NOW_VALID });
    expect(out["Chain order"]).toBe(
      "Order looks correct, but the last certificate is not self signed, so the chain is probably missing its root.",
    );
  });

  it("flags a reversed chain", async () => {
    const out = await run([ROOT_PEM, INTER_PEM, LEAF_PEM].join("\n"), { now: NOW_VALID });
    expect(out["Chain 1 to 2"]).toContain("does not match");
    expect(out["Chain order"]).toBe(
      "The chain looks reversed: the root is first. Put the leaf certificate first, then each issuer after it.",
    );
  });

  it("names the pair that does not chain", async () => {
    const out = await run([LEAF_PEM, ED_PEM].join("\n"), { now: NOW_VALID });
    expect(out["Chain 1 to 2"]).toContain("does not match");
    expect(out["Chain order"]).toBe(
      "Order is wrong: certificates 1 and 2 do not chain. Put the leaf first, then each issuer after it.",
    );
  });

  it("extracts certificates out of noisy surrounding text with CRLF line endings", async () => {
    const noisy = [
      "server {",
      "  ssl_certificate /etc/nginx/fullchain.pem;",
      "}",
      "",
      "0 s:C = US, O = Example Test Org, CN = test.example.com",
      "  i:C = US, O = Example Test Org, CN = Example Test Intermediate CA",
      LEAF_PEM,
      "1 s:C = US, O = Example Test Org, CN = Example Test Intermediate CA",
      INTER_PEM,
      "---",
      "Server certificate chain complete",
    ]
      .join("\n")
      .replace(/\n/g, "\r\n");

    const out = await run(noisy, { now: NOW_VALID });
    expect(out["Certificates found"]).toBe("2");
    expect(out["Cert 1: Serial"]).toBe("0BADC0DE");
    expect(out["Cert 2: Serial"]).toBe("1A2B3C");
  });

  it("accepts a bare base64 certificate with no PEM armor", async () => {
    const out = await run(base64Of(LEAF_PEM), { now: NOW_VALID });
    expect(out["Serial"]).toBe("0BADC0DE");
    expect(out["SHA-1 fingerprint"]).toBe(
      "CB:D7:74:7E:03:25:AB:65:61:A3:90:E7:27:FD:A0:8C:5C:6C:E8:23",
    );
  });

  it("accepts raw DER bytes from a dropped file", async () => {
    const out = await run(derOf(LEAF_PEM), { now: NOW_VALID });
    expect(out["Subject"]).toBe("C=US, O=Example Test Org, CN=test.example.com");
    expect(out["Public key"]).toBe("EC P-256");
  });

  it("accepts a dropped PEM file as bytes", async () => {
    const bytes = new TextEncoder().encode(`${LEAF_PEM}\n${INTER_PEM}\n`);
    const out = await run(bytes, { now: NOW_VALID });
    expect(out["Certificates found"]).toBe("2");
    expect(out["Cert 1: Serial"]).toBe("0BADC0DE");
  });

  it("adds RDN components and every extension in full view", async () => {
    const out = await run(LEAF_PEM, { now: NOW_VALID, view: "full" });
    expect(out["Subject components"]).toBe("C=US, O=Example Test Org, CN=test.example.com");
    expect(out["Issuer components"]).toBe(
      "C=US, O=Example Test Org, CN=Example Test Intermediate CA",
    );
    expect(out["Extension 2.5.29.19 (Basic constraints)"]).toBe("critical, value 3000");
    expect(out["Extension 2.5.29.17 (Subject alternative name)"]).toMatch(
      /^not critical, value [0-9A-F]+$/,
    );
    // Summary rows are still present in full view.
    expect(out["Serial"]).toBe("0BADC0DE");
  });

  it("leaves the extension rows out of summary view", async () => {
    const out = await run(LEAF_PEM, { now: NOW_VALID });
    expect(Object.keys(out).some((k) => k.startsWith("Extension "))).toBe(false);
    expect(out["Subject components"]).toBeUndefined();
  });

  describe("errors", () => {
    const codeOf = async (fn: () => unknown): Promise<string> => {
      try {
        await fn();
      } catch (err) {
        expect(err).toBeInstanceOf(ToolError);
        return (err as ToolError).code;
      }
      throw new Error("expected a ToolError");
    };

    it("throws empty-input on an empty string", async () => {
      expect(await codeOf(() => run("  \n  "))).toBe("empty-input");
    });

    it("throws empty-input on zero bytes", async () => {
      expect(await codeOf(() => run(new Uint8Array(0)))).toBe("empty-input");
    });

    it("throws no-cert when nothing certificate shaped is present", async () => {
      expect(await codeOf(() => run("hello world, no certificate here"))).toBe("no-cert");
    });

    it("throws no-cert on unrelated PEM armor", async () => {
      const dh = "-----BEGIN DH PARAMETERS-----\nAAAA\n-----END DH PARAMETERS-----";
      expect(await codeOf(() => run(dh))).toBe("no-cert");
    });

    it("names a private key block instead of decoding it", async () => {
      let caught: ToolError | undefined;
      try {
        await run("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----");
      } catch (err) {
        caught = err as ToolError;
      }
      expect(caught?.code).toBe("bad-der");
      expect(caught?.message).toContain("PRIVATE KEY");
      expect(caught?.fix).toContain("certificate signing request");
    });

    it("names a certificate signing request instead of decoding it", async () => {
      let caught: ToolError | undefined;
      try {
        await run("-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----");
      } catch (err) {
        caught = err as ToolError;
      }
      expect(caught?.code).toBe("bad-der");
      expect(caught?.message).toContain("CERTIFICATE REQUEST");
    });

    it("throws bad-der on a corrupt PEM body", async () => {
      const broken = "-----BEGIN CERTIFICATE-----\nQUJDREVGRw==\n-----END CERTIFICATE-----";
      expect(await codeOf(() => run(broken))).toBe("bad-der");
    });

    it("says which certificate of a bundle failed", async () => {
      const broken = "-----BEGIN CERTIFICATE-----\nQUJDREVGRw==\n-----END CERTIFICATE-----";
      let caught: ToolError | undefined;
      try {
        await run([LEAF_PEM, broken].join("\n"));
      } catch (err) {
        caught = err as ToolError;
      }
      expect(caught?.code).toBe("bad-der");
      expect(caught?.message).toBe("Certificate 2 of 2 could not be parsed as X.509 DER.");
    });

    it("throws bad-der on random bytes", async () => {
      expect(await codeOf(() => run(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])))).toBe("bad-der");
    });
  });
});

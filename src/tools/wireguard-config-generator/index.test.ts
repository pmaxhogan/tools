import { describe, expect, it } from "vitest";
import {
  buildPeerConfig,
  buildServerConfig,
  deriveAddresses,
  generateKeypair,
  generatePsk,
  listenPortFromEndpoint,
  resolveAllowedIps,
  run,
  subnetPrefix,
  toBase64,
} from "./index";
import { ToolError } from "../types";

/**
 * Known vector for generateKeypair(), precomputed once with @noble/curves
 * directly (not through this module, to avoid a circular check):
 *
 *   const { x25519 } = await import('@noble/curves/ed25519.js');
 *   const priv = Uint8Array.from({ length: 32 }, (_, i) => i + 1); // 1..32
 *   priv[0] &= 248; priv[31] &= 127; priv[31] |= 64;
 *   const pub = x25519.getPublicKey(priv);
 *   // base64(priv) === RAW_TO_PRIVATE_B64, base64(pub) === EXPECTED_PUBLIC_B64
 */
const RAW_VECTOR = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const EXPECTED_PRIVATE_B64 = "AAIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eH2A=";
const EXPECTED_PUBLIC_B64 = "B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=";

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

describe("generateKeypair", () => {
  it("clamps the injected bytes and derives the known public key", () => {
    const { privateKey, publicKey } = generateKeypair(RAW_VECTOR);
    expect(privateKey).toBe(EXPECTED_PRIVATE_B64);
    expect(publicKey).toBe(EXPECTED_PUBLIC_B64);
  });

  it("applies the WireGuard/RFC 7748 clamp at the bit level", () => {
    const { privateKey } = generateKeypair(RAW_VECTOR);
    const bytes = decodeBase64(privateKey);
    expect(bytes[0]! & 0b111).toBe(0); // low 3 bits of byte 0 cleared
    expect(bytes[31]! & 0b10000000).toBe(0); // top bit of byte 31 cleared
    expect(bytes[31]! & 0b01000000).toBe(0b01000000); // second-highest bit set
  });

  it("is deterministic for the same injected bytes", () => {
    const a = generateKeypair(RAW_VECTOR);
    const b = generateKeypair(RAW_VECTOR);
    expect(a).toEqual(b);
  });

  it('produces 44-char base64 keys ending in "="', () => {
    const { privateKey, publicKey } = generateKeypair(RAW_VECTOR);
    expect(privateKey).toHaveLength(44);
    expect(privateKey.endsWith("=")).toBe(true);
    expect(publicKey).toHaveLength(44);
    expect(publicKey.endsWith("=")).toBe(true);
  });

  it("draws from crypto.getRandomValues and differs across calls with no injection", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    expect(a.privateKey).not.toBe(b.privateKey);
  });

  it("rejects an injected buffer of the wrong length", () => {
    expect(() => generateKeypair(new Uint8Array(16))).toThrowError(ToolError);
  });
});

describe("generatePsk", () => {
  it("is not clamped: differs from a clamped private key derived from the same bytes", () => {
    const psk = generatePsk(RAW_VECTOR);
    const { privateKey } = generateKeypair(RAW_VECTOR);
    // Same input bytes, but the psk skips clamping, so the two diverge.
    expect(psk).not.toBe(privateKey);
    expect(psk).toBe(toBase64(RAW_VECTOR));
  });

  it("differs per call without an injected buffer", () => {
    const a = generatePsk();
    const b = generatePsk();
    expect(a).not.toBe(b);
  });

  it('is 44-char base64 ending in "="', () => {
    const psk = generatePsk(RAW_VECTOR);
    expect(psk).toHaveLength(44);
    expect(psk.endsWith("=")).toBe(true);
  });

  it("rejects an injected buffer of the wrong length", () => {
    expect(() => generatePsk(new Uint8Array(31))).toThrowError(ToolError);
  });
});

describe("deriveAddresses", () => {
  it("assigns .1 to the server and .2+ to peers", () => {
    expect(deriveAddresses("10.8.0.0/24", 4)).toEqual([
      "10.8.0.1",
      "10.8.0.2",
      "10.8.0.3",
      "10.8.0.4",
    ]);
  });

  it("works for a non-default base subnet", () => {
    expect(deriveAddresses("192.168.50.0/28", 2)).toEqual(["192.168.50.1", "192.168.50.2"]);
  });

  it("fills a /30 up to its 2-address capacity", () => {
    expect(deriveAddresses("10.0.0.0/30", 2)).toEqual(["10.0.0.1", "10.0.0.2"]);
  });

  it("rejects a /30 asked for more addresses than it can hold", () => {
    expect(() => deriveAddresses("10.0.0.0/30", 3)).toThrowError(ToolError);
    expect(() => deriveAddresses("10.0.0.0/30", 3)).toThrowError(/room for 2/);
  });

  it("rejects a malformed CIDR string", () => {
    expect(() => deriveAddresses("not-a-subnet", 2)).toThrowError(ToolError);
    expect(() => deriveAddresses("10.8.0.0", 2)).toThrowError(ToolError);
  });

  it("rejects an out-of-range octet or prefix", () => {
    expect(() => deriveAddresses("10.8.0.999/24", 2)).toThrowError(ToolError);
    expect(() => deriveAddresses("10.8.0.0/33", 2)).toThrowError(ToolError);
  });

  it("rejects a prefix too small to hold a server plus any peers", () => {
    expect(() => deriveAddresses("10.8.0.0/31", 2)).toThrowError(ToolError);
    expect(() => deriveAddresses("10.8.0.0/32", 1)).toThrowError(ToolError);
  });

  it("rejects a subnet address that is not the network address", () => {
    expect(() => deriveAddresses("10.8.0.5/24", 2)).toThrowError(ToolError);
  });
});

describe("subnetPrefix", () => {
  it("reads the prefix out of a valid CIDR string", () => {
    expect(subnetPrefix("10.8.0.0/24")).toBe(24);
    expect(subnetPrefix("10.0.0.0/30")).toBe(30);
  });
});

describe("listenPortFromEndpoint", () => {
  it("reads the port after the last colon", () => {
    expect(listenPortFromEndpoint("vpn.example.com:51820")).toBe(51820);
    expect(listenPortFromEndpoint("vpn.example.com:9999")).toBe(9999);
  });

  it("falls back to 51820 when no port, or no endpoint, is given", () => {
    expect(listenPortFromEndpoint("vpn.example.com")).toBe(51820);
    expect(listenPortFromEndpoint("")).toBe(51820);
  });
});

describe("resolveAllowedIps", () => {
  it('returns the full-tunnel routes for "full"', () => {
    expect(resolveAllowedIps("full", "10.8.0.0/24")).toBe("0.0.0.0/0, ::/0");
  });

  it('returns just the VPN subnet for "split"', () => {
    expect(resolveAllowedIps("split", "10.8.0.0/24")).toBe("10.8.0.0/24");
  });
});

describe("buildServerConfig", () => {
  it("renders an exact [Interface] plus one [Peer] block per client", () => {
    const out = buildServerConfig({
      privateKey: "SERVERPRIVATEKEYBASE64==",
      address: "10.8.0.1/24",
      listenPort: 51820,
      dns: "1.1.1.1",
      peers: [
        { publicKey: "PEER1PUBLICKEY==", presharedKey: "PEER1PSK==", allowedIps: "10.8.0.2/32" },
        { publicKey: "PEER2PUBLICKEY==", allowedIps: "10.8.0.3/32" },
      ],
    });

    expect(out).toBe(
      [
        "[Interface]",
        "PrivateKey = SERVERPRIVATEKEYBASE64==",
        "Address = 10.8.0.1/24",
        "ListenPort = 51820",
        "DNS = 1.1.1.1",
        "",
        "[Peer]",
        "PublicKey = PEER1PUBLICKEY==",
        "PresharedKey = PEER1PSK==",
        "AllowedIPs = 10.8.0.2/32",
        "",
        "[Peer]",
        "PublicKey = PEER2PUBLICKEY==",
        "AllowedIPs = 10.8.0.3/32",
        "",
      ].join("\n"),
    );
  });

  it("omits DNS when not given, and works with zero peers", () => {
    const out = buildServerConfig({
      privateKey: "PRIV==",
      address: "10.8.0.1/24",
      listenPort: 51820,
      peers: [],
    });
    expect(out).toBe(
      [
        "[Interface]",
        "PrivateKey = PRIV==",
        "Address = 10.8.0.1/24",
        "ListenPort = 51820",
        "",
      ].join("\n"),
    );
  });

  it("throws typed errors for missing required fields", () => {
    expect(() =>
      buildServerConfig({ privateKey: "", address: "10.8.0.1/24", listenPort: 51820, peers: [] }),
    ).toThrowError(ToolError);
    expect(() =>
      buildServerConfig({ privateKey: "PRIV==", address: "", listenPort: 51820, peers: [] }),
    ).toThrowError(ToolError);
    expect(() =>
      buildServerConfig({ privateKey: "PRIV==", address: "10.8.0.1/24", listenPort: 0, peers: [] }),
    ).toThrowError(ToolError);
    expect(() =>
      buildServerConfig({
        privateKey: "PRIV==",
        address: "10.8.0.1/24",
        listenPort: 51820,
        peers: [{ publicKey: "", allowedIps: "10.8.0.2/32" }],
      }),
    ).toThrowError(ToolError);
  });
});

describe("buildPeerConfig", () => {
  it("renders an exact [Interface] plus [Peer] block for a full-tunnel client", () => {
    const out = buildPeerConfig({
      privateKey: "PEERPRIVATEKEY==",
      address: "10.8.0.2/32",
      dns: "1.1.1.1",
      serverPublicKey: "SERVERPUBLICKEY==",
      presharedKey: "PEERPSK==",
      allowedIps: "0.0.0.0/0, ::/0",
      endpoint: "vpn.example.com:51820",
      persistentKeepalive: 25,
    });

    expect(out).toBe(
      [
        "[Interface]",
        "PrivateKey = PEERPRIVATEKEY==",
        "Address = 10.8.0.2/32",
        "DNS = 1.1.1.1",
        "",
        "[Peer]",
        "PublicKey = SERVERPUBLICKEY==",
        "PresharedKey = PEERPSK==",
        "AllowedIPs = 0.0.0.0/0, ::/0",
        "Endpoint = vpn.example.com:51820",
        "PersistentKeepalive = 25",
        "",
      ].join("\n"),
    );
  });

  it("omits optional fields when not given", () => {
    const out = buildPeerConfig({
      privateKey: "PEERPRIVATEKEY==",
      address: "10.8.0.2/32",
      serverPublicKey: "SERVERPUBLICKEY==",
      allowedIps: "10.8.0.0/24",
    });
    expect(out).toBe(
      [
        "[Interface]",
        "PrivateKey = PEERPRIVATEKEY==",
        "Address = 10.8.0.2/32",
        "",
        "[Peer]",
        "PublicKey = SERVERPUBLICKEY==",
        "AllowedIPs = 10.8.0.0/24",
        "",
      ].join("\n"),
    );
  });

  it("throws typed errors for missing required fields", () => {
    expect(() =>
      buildPeerConfig({
        privateKey: "",
        address: "10.8.0.2/32",
        serverPublicKey: "SPUB==",
        allowedIps: "10.8.0.0/24",
      }),
    ).toThrowError(ToolError);
    expect(() =>
      buildPeerConfig({
        privateKey: "PRIV==",
        address: "",
        serverPublicKey: "SPUB==",
        allowedIps: "10.8.0.0/24",
      }),
    ).toThrowError(ToolError);
    expect(() =>
      buildPeerConfig({
        privateKey: "PRIV==",
        address: "10.8.0.2/32",
        serverPublicKey: "",
        allowedIps: "10.8.0.0/24",
      }),
    ).toThrowError(ToolError);
  });
});

describe("run", () => {
  it("explains the tool is interactive and includes a fresh, unique sample keypair", async () => {
    const opts = {
      peers: 1,
      endpoint: "",
      subnet: "10.8.0.0/24",
      dns: "",
      psk: true,
      allowedIps: "full",
    };
    const a = await run(undefined, opts);
    const b = await run(undefined, opts);

    expect(a.Note).toMatch(/interactive/i);
    expect(a.Note).toMatch(/browser/i);
    expect(a["Sample private key"]).toBeTruthy();
    expect(a["Sample public key"]).toBeTruthy();
    expect(a["Sample preshared key"]).toBeTruthy();
    // Never the same "example" key twice, so nobody copies it into a real tunnel.
    expect(a["Sample private key"]).not.toBe(b["Sample private key"]);
  });
});

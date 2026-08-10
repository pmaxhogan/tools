import { x25519 } from "@noble/curves/ed25519.js";
import { ToolError, type ToolLogic } from "../types";

export interface WireguardOpts {
  peers: number;
  endpoint: string;
  subnet: string;
  dns: string;
  psk: boolean;
  allowedIps: string;
  [key: string]: unknown;
}

export interface Keypair {
  privateKey: string;
  publicKey: string;
}

/** Raw key length for both X25519 keys and WireGuard preshared keys. */
const KEY_BYTES = 32;

const DEFAULT_LISTEN_PORT = 51820;

/* -------------------------------------------------------------------------- */
/* Base64                                                                     */
/* -------------------------------------------------------------------------- */

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 (RFC 4648), written by hand so this file stays DOM/Buffer-free. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const chunk = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += B64_CHARS[(chunk >> 18) & 63];
    out += B64_CHARS[(chunk >> 12) & 63];
    out += b1 !== undefined ? B64_CHARS[(chunk >> 6) & 63] : "=";
    out += b2 !== undefined ? B64_CHARS[chunk & 63] : "=";
  }
  return out;
}

function randomBytesFromCrypto(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

/* -------------------------------------------------------------------------- */
/* Keys                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Generates one WireGuard X25519 keypair entirely from local randomness.
 * `randomBytes` is an injection point for deterministic tests only: real
 * callers must omit it so the private key comes from crypto.getRandomValues.
 *
 * WireGuard (RFC 7748 §5) clamps the 32 random bytes before use: clear the
 * low 3 bits of byte 0 (forces the scalar to a multiple of the curve's
 * cofactor 8), clear the top bit of byte 31 (keeps the scalar below 2^255),
 * and set the second-highest bit of byte 31 (keeps it at or above 2^254).
 * The clamped bytes, not the raw ones, are the private key that ships in the
 * config. @noble/curves reapplies the same clamp internally when deriving
 * the public key, which is a no-op on already-clamped input.
 */
export function generateKeypair(randomBytes?: Uint8Array): Keypair {
  const raw = randomBytes ? Uint8Array.from(randomBytes) : randomBytesFromCrypto(KEY_BYTES);
  if (raw.length !== KEY_BYTES)
    throw new ToolError(
      "bad-key-length",
      `A WireGuard private key needs exactly ${KEY_BYTES} random bytes, got ${raw.length}.`,
    );

  raw[0] &= 248;
  raw[31] &= 127;
  raw[31] |= 64;

  const publicKey = x25519.getPublicKey(raw);
  return { privateKey: toBase64(raw), publicKey: toBase64(publicKey) };
}

/**
 * Generates one WireGuard preshared key: 32 random bytes, base64, no clamp.
 * The preshared key is mixed into the handshake as a symmetric secret, not a
 * curve scalar, so RFC 7748 clamping does not apply to it.
 */
export function generatePsk(randomBytes?: Uint8Array): string {
  const raw = randomBytes ? Uint8Array.from(randomBytes) : randomBytesFromCrypto(KEY_BYTES);
  if (raw.length !== KEY_BYTES)
    throw new ToolError(
      "bad-key-length",
      `A WireGuard preshared key needs exactly ${KEY_BYTES} random bytes, got ${raw.length}.`,
    );
  return toBase64(raw);
}

/* -------------------------------------------------------------------------- */
/* Subnet math                                                                */
/* -------------------------------------------------------------------------- */

interface ParsedSubnet {
  /** Network address as an unsigned 32-bit integer. */
  base: number;
  prefix: number;
}

function ipToInt(a: number, b: number, c: number, d: number): number {
  return a * 2 ** 24 + b * 2 ** 16 + c * 256 + d;
}

function intToIp(n: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join(".");
}

const CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

/** Parses and validates an IPv4 CIDR subnet string like "10.8.0.0/24". */
function parseSubnet(subnet: string): ParsedSubnet {
  const s = (subnet ?? "").trim();
  const m = CIDR_RE.exec(s);
  if (!m)
    throw new ToolError(
      "bad-subnet",
      `"${subnet}" is not a valid CIDR subnet.`,
      "Use a form like 10.8.0.0/24.",
    );

  const octets = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
  if (octets.some((o) => o > 255))
    throw new ToolError(
      "bad-subnet",
      `"${subnet}" has an octet outside 0-255.`,
      "Use a form like 10.8.0.0/24.",
    );

  const prefix = Number(m[5]);
  if (prefix > 32)
    throw new ToolError(
      "bad-subnet",
      `"${subnet}" has a prefix outside 0-32.`,
      "Use a form like 10.8.0.0/24.",
    );

  if (prefix > 30)
    throw new ToolError(
      "subnet-too-small",
      `A /${prefix} subnet has no room for a server plus peers.`,
      "Use /30 or larger (a lower prefix number), such as 10.8.0.0/24.",
    );

  const base = ipToInt(...octets);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (base & mask) >>> 0;
  if (network !== base)
    throw new ToolError(
      "bad-subnet",
      `"${subnet}" is not the network address for a /${prefix}.`,
      `Did you mean ${intToIp(network)}/${prefix}?`,
    );

  return { base: network, prefix };
}

/**
 * Assigns IPv4 addresses inside `subnet`: index 0 (the server) gets .1, every
 * peer after it gets .2, .3, and so on. The network and broadcast addresses
 * are never handed out, so a /30 has room for 2 addresses, a /24 for 254.
 */
export function deriveAddresses(subnet: string, count: number): string[] {
  if (!Number.isInteger(count) || count < 1)
    throw new ToolError("bad-count", "Address count must be a positive integer.");

  const { base, prefix } = parseSubnet(subnet);
  const usable = 2 ** (32 - prefix) - 2;

  if (count > usable)
    throw new ToolError(
      "subnet-too-small",
      `A /${prefix} subnet has room for ${usable} address${usable === 1 ? "" : "es"} (1 server + ${Math.max(usable - 1, 0)} peer${usable - 1 === 1 ? "" : "s"}), but ${count} ${count === 1 ? "was" : "were"} requested.`,
      "Use a larger subnet (a lower prefix number) or fewer peers.",
    );

  return Array.from({ length: count }, (_, i) => intToIp(base + 1 + i));
}

/** The prefix length out of a validated CIDR string, e.g. 24 for "10.8.0.0/24". */
export function subnetPrefix(subnet: string): number {
  return parseSubnet(subnet).prefix;
}

/** Reads the port out of an "host:port" endpoint, falling back to the default. */
export function listenPortFromEndpoint(endpoint: string): number {
  const raw = (endpoint ?? "").trim();
  const idx = raw.lastIndexOf(":");
  if (idx === -1) return DEFAULT_LISTEN_PORT;
  const port = Number(raw.slice(idx + 1));
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_LISTEN_PORT;
}

/** What a peer routes through the tunnel: everything, or just the VPN subnet. */
export function resolveAllowedIps(mode: string, subnet: string): string {
  return mode === "split" ? subnet : "0.0.0.0/0, ::/0";
}

/* -------------------------------------------------------------------------- */
/* Config builders                                                            */
/* -------------------------------------------------------------------------- */

export interface ServerPeerEntry {
  publicKey: string;
  presharedKey?: string;
  allowedIps: string;
}

export interface ServerConfigOptions {
  privateKey: string;
  /** Interface address including prefix, e.g. "10.8.0.1/24". */
  address: string;
  listenPort: number;
  dns?: string;
  peers: ServerPeerEntry[];
}

export interface PeerConfigOptions {
  privateKey: string;
  /** Interface address including prefix, e.g. "10.8.0.2/32". */
  address: string;
  dns?: string;
  serverPublicKey: string;
  presharedKey?: string;
  allowedIps: string;
  endpoint?: string;
  persistentKeepalive?: number;
}

function section(lines: (string | undefined)[]): string {
  return lines.filter((l): l is string => l !== undefined).join("\n");
}

/** Builds the [Interface] + one [Peer] block per client for the server's wg0.conf. */
export function buildServerConfig(o: ServerConfigOptions): string {
  if (!o.privateKey)
    throw new ToolError("missing-private-key", "A server private key is required.");
  if (!o.address) throw new ToolError("missing-address", "A server interface address is required.");
  if (!Number.isInteger(o.listenPort) || o.listenPort < 1 || o.listenPort > 65535)
    throw new ToolError("bad-listen-port", "ListenPort must be between 1 and 65535.");

  const sections = [
    section([
      "[Interface]",
      `PrivateKey = ${o.privateKey}`,
      `Address = ${o.address}`,
      `ListenPort = ${o.listenPort}`,
      o.dns ? `DNS = ${o.dns}` : undefined,
    ]),
  ];

  for (const peer of o.peers) {
    if (!peer.publicKey)
      throw new ToolError("missing-peer-public-key", "Each peer needs a public key.");
    sections.push(
      section([
        "[Peer]",
        `PublicKey = ${peer.publicKey}`,
        peer.presharedKey ? `PresharedKey = ${peer.presharedKey}` : undefined,
        `AllowedIPs = ${peer.allowedIps}`,
      ]),
    );
  }

  return `${sections.join("\n\n")}\n`;
}

/** Builds one client's wgN.conf: its own [Interface] plus the server as its [Peer]. */
export function buildPeerConfig(o: PeerConfigOptions): string {
  if (!o.privateKey) throw new ToolError("missing-private-key", "A peer private key is required.");
  if (!o.address) throw new ToolError("missing-address", "A peer interface address is required.");
  if (!o.serverPublicKey)
    throw new ToolError("missing-server-public-key", "The server's public key is required.");

  const iface = section([
    "[Interface]",
    `PrivateKey = ${o.privateKey}`,
    `Address = ${o.address}`,
    o.dns ? `DNS = ${o.dns}` : undefined,
  ]);

  const peer = section([
    "[Peer]",
    `PublicKey = ${o.serverPublicKey}`,
    o.presharedKey ? `PresharedKey = ${o.presharedKey}` : undefined,
    `AllowedIPs = ${o.allowedIps}`,
    o.endpoint ? `Endpoint = ${o.endpoint}` : undefined,
    o.persistentKeepalive ? `PersistentKeepalive = ${o.persistentKeepalive}` : undefined,
  ]);

  return `${iface}\n\n${peer}\n`;
}

/* -------------------------------------------------------------------------- */
/* run()                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Textual fallback for the generic shell / curl-less environments. The real
 * tool is the interactive panel (server + N peers, QR codes, downloads); this
 * just proves the crypto works and points people at the browser page. Every
 * call generates a brand-new keypair so nobody is tempted to paste a "sample"
 * key from documentation into a real tunnel.
 */

export async function run(
  _input: undefined,
  _opts: WireguardOpts,
): Promise<Record<string, string>> {
  const { privateKey, publicKey } = generateKeypair();
  const presharedKey = generatePsk();
  return {
    Note: "This tool is interactive: open the WireGuard Config Generator page in a browser to build a full server and peer configuration with QR codes for mobile clients. The keys below were generated fresh for this response only, to show the output shape. They are real, unique keys, not placeholders, so do not reuse them in an actual tunnel: generate your own in the browser instead.",
    "Sample private key": privateKey,
    "Sample public key": publicKey,
    "Sample preshared key": presharedKey,
  };
}

export default { run } satisfies ToolLogic<undefined, Record<string, string>, WireguardOpts>;

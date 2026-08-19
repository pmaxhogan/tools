import { ToolError, type ToolLogic } from "../types";

export interface SubnetOpts {
  /** When > 0, split the network into the next power of two subnets >= this value. */
  split: number;
  [key: string]: unknown;
}

export type SubnetResult = Record<string, string>;

type IpVersion = 4 | 6;

const V4_BITS = 32;
const V6_BITS = 128;
const MAX_SPLIT_ROWS = 32;

/* -------------------------------------------------------------------------- */
/* Bit math                                                                   */
/* -------------------------------------------------------------------------- */

function pow2(n: number): bigint {
  return 1n << BigInt(n);
}

/** Prefix mask as a bigint with the top `prefix` bits set, over `bits` total bits. */
function maskFromPrefix(prefix: number, bits: number): bigint {
  if (prefix === 0) return 0n;
  return ((pow2(bits) - 1n) >> BigInt(bits - prefix)) << BigInt(bits - prefix);
}

function bitsFor(version: IpVersion): number {
  return version === 4 ? V4_BITS : V6_BITS;
}

/* -------------------------------------------------------------------------- */
/* IPv4                                                                       */
/* -------------------------------------------------------------------------- */

const V4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIPv4(token: string): bigint {
  const m = V4_RE.exec(token);
  if (!m)
    throw new ToolError(
      "bad-ip",
      `"${token}" is not a valid IPv4 address.`,
      "Use a form like 192.168.1.0.",
    );
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  if (octets.some((o) => o > 255))
    throw new ToolError(
      "bad-ip",
      `"${token}" has an octet outside 0-255.`,
      "Use a form like 192.168.1.0.",
    );
  return octets.reduce((acc, o) => (acc << 8n) | BigInt(o), 0n);
}

function formatV4(v: bigint): string {
  const n = v & 0xffffffffn;
  return [24n, 16n, 8n, 0n].map((shift) => ((n >> shift) & 0xffn).toString()).join(".");
}

/** True when a dotted-decimal string is a valid contiguous IPv4 subnet mask, e.g. 255.255.255.0. */
function netmaskToPrefixV4(token: string): number | null {
  const value = parseIPv4(token);
  const bin = value.toString(2).padStart(V4_BITS, "0");
  if (!/^1*0*$/.test(bin)) return null;
  return bin.split("").filter((b) => b === "1").length;
}

function binaryDotted(v: bigint): string {
  const bin = v.toString(2).padStart(V4_BITS, "0");
  return [0, 8, 16, 24].map((i) => bin.slice(i, i + 8)).join(".");
}

interface V4Range {
  name: string;
  net: bigint;
  prefix: number;
}

const V4_SPECIAL_RANGES: V4Range[] = [
  { name: "This network (RFC 1122)", net: parseIPv4("0.0.0.0"), prefix: 8 },
  { name: "Loopback", net: parseIPv4("127.0.0.0"), prefix: 8 },
  { name: "Link-local (APIPA, RFC 3927)", net: parseIPv4("169.254.0.0"), prefix: 16 },
  { name: "Private (RFC 1918)", net: parseIPv4("10.0.0.0"), prefix: 8 },
  { name: "Carrier-grade NAT (RFC 6598)", net: parseIPv4("100.64.0.0"), prefix: 10 },
  { name: "Private (RFC 1918)", net: parseIPv4("172.16.0.0"), prefix: 12 },
  { name: "Private (RFC 1918)", net: parseIPv4("192.168.0.0"), prefix: 16 },
  { name: "Documentation (TEST-NET-1, RFC 5737)", net: parseIPv4("192.0.2.0"), prefix: 24 },
  { name: "Documentation (TEST-NET-2, RFC 5737)", net: parseIPv4("198.51.100.0"), prefix: 24 },
  { name: "Documentation (TEST-NET-3, RFC 5737)", net: parseIPv4("203.0.113.0"), prefix: 24 },
  { name: "Broadcast", net: parseIPv4("255.255.255.255"), prefix: 32 },
  { name: "Multicast (Class D)", net: parseIPv4("224.0.0.0"), prefix: 4 },
  { name: "Reserved (Class E)", net: parseIPv4("240.0.0.0"), prefix: 4 },
];

function classifyV4Address(addr: bigint): string {
  for (const range of V4_SPECIAL_RANGES) {
    const m = maskFromPrefix(range.prefix, V4_BITS);
    if ((addr & m) === range.net) return range.name;
  }
  return "Public";
}

function ipClassV4(addr: bigint): string {
  const first = Number((addr >> 24n) & 0xffn);
  if (first < 128) return "A";
  if (first < 192) return "B";
  if (first < 224) return "C";
  if (first < 240) return "D (multicast)";
  return "E (reserved)";
}

/* -------------------------------------------------------------------------- */
/* IPv6                                                                       */
/* -------------------------------------------------------------------------- */

function parseIPv6(token: string): bigint {
  const bad = (): never =>
    (() => {
      throw new ToolError(
        "bad-ip",
        `"${token}" is not a valid IPv6 address.`,
        "Use a form like 2001:db8::1 or 2001:db8::/48.",
      );
    })();

  if (!token || !/^[0-9a-fA-F:]+$/.test(token)) return bad();
  const doubleColonCount = (token.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return bad();

  let groups: string[];
  if (doubleColonCount === 1) {
    const [left, right] = token.split("::");
    const head = left ? left.split(":") : [];
    const tail = right ? right.split(":") : [];
    const missing = 8 - (head.length + tail.length);
    if (missing < 1) return bad();
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  } else {
    groups = token.split(":");
    if (groups.length !== 8) return bad();
  }

  if (groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return bad();

  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

function toGroups(v: bigint): number[] {
  const n = v & (pow2(V6_BITS) - 1n);
  const groups: number[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) {
    groups.push(Number((n >> shift) & 0xffffn));
  }
  return groups;
}

function formatV6Expanded(v: bigint): string {
  return toGroups(v)
    .map((g) => g.toString(16).padStart(4, "0"))
    .join(":");
}

/** RFC 5952 canonical compressed form: lowercase, leading zeros trimmed, longest run of zero groups compressed. */
function formatV6Compressed(v: bigint): string {
  const groups = toGroups(v);
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < groups.length; i++) {
    if (groups[i] === 0) {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }

  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(":");

  const before = hex.slice(0, bestStart).join(":");
  const after = hex.slice(bestStart + bestLen).join(":");
  return `${before}::${after}`;
}

interface V6Range {
  name: string;
  net: bigint;
  prefix: number;
}

const V6_SPECIAL_RANGES: V6Range[] = [
  { name: "Unspecified address", net: parseIPv6("::"), prefix: 128 },
  { name: "Loopback", net: parseIPv6("::1"), prefix: 128 },
  { name: "Link-local", net: parseIPv6("fe80::"), prefix: 10 },
  { name: "Unique local (ULA, RFC 4193)", net: parseIPv6("fc00::"), prefix: 7 },
  { name: "Documentation (RFC 3849)", net: parseIPv6("2001:db8::"), prefix: 32 },
  { name: "Multicast", net: parseIPv6("ff00::"), prefix: 8 },
  { name: "Global unicast", net: parseIPv6("2000::"), prefix: 3 },
];

function classifyV6Address(addr: bigint): string {
  for (const range of V6_SPECIAL_RANGES) {
    const m = maskFromPrefix(range.prefix, V6_BITS);
    if ((addr & m) === range.net) return range.name;
  }
  return "Other / reserved";
}

/* -------------------------------------------------------------------------- */
/* Shared parsing                                                             */
/* -------------------------------------------------------------------------- */

function parseIpAny(token: string): { version: IpVersion; value: bigint } {
  if (token.includes(":")) return { version: 6, value: parseIPv6(token) };
  if (token.includes(".")) return { version: 4, value: parseIPv4(token) };
  throw new ToolError(
    "bad-ip",
    `"${token}" is not a recognizable IPv4 or IPv6 address.`,
    "Use a form like 192.168.1.0/24 or 2001:db8::/48.",
  );
}

function parsePrefixToken(token: string, maxBits: number): number {
  if (!/^\d{1,3}$/.test(token))
    throw new ToolError(
      "bad-prefix",
      `"${token}" is not a valid prefix length.`,
      `Use a whole number between 0 and ${maxBits}.`,
    );
  const prefix = Number(token);
  if (prefix > maxBits)
    throw new ToolError(
      "bad-prefix",
      `A /${prefix} prefix is out of range for IPv${maxBits === V4_BITS ? 4 : 6}.`,
      `Use a whole number between 0 and ${maxBits}.`,
    );
  return prefix;
}

interface ParsedCidr {
  version: IpVersion;
  ip: bigint;
  prefix: number;
  assumedDefault: boolean;
}

function parseCidrOrBareIp(token: string): ParsedCidr {
  if (token.includes("/")) {
    const idx = token.indexOf("/");
    const addrPart = token.slice(0, idx);
    const prefixPart = token.slice(idx + 1);
    const { version, value } = parseIpAny(addrPart);
    const prefix = parsePrefixToken(prefixPart, bitsFor(version));
    return { version, ip: value, prefix, assumedDefault: false };
  }
  const { version, value } = parseIpAny(token);
  return { version, ip: value, prefix: bitsFor(version), assumedDefault: true };
}

/* -------------------------------------------------------------------------- */
/* Split                                                                      */
/* -------------------------------------------------------------------------- */

function splitCount(split: number): { count: number; bitsNeeded: number } {
  let count = 1;
  let bitsNeeded = 0;
  while (count < split) {
    count *= 2;
    bitsNeeded++;
  }
  return { count, bitsNeeded };
}

function addSplitRows(
  rows: SubnetResult,
  version: IpVersion,
  network: bigint,
  prefix: number,
  split: number,
): void {
  if (!split || split <= 0) return;
  const bits = bitsFor(version);
  const { count, bitsNeeded } = splitCount(split);
  const newPrefix = prefix + bitsNeeded;

  if (newPrefix > bits)
    throw new ToolError(
      "bad-split",
      `Splitting a /${prefix} network into ${count} subnets needs a /${newPrefix} prefix, which is past /${bits}.`,
      `Request fewer subnets, or start from a larger network (a lower prefix number).`,
    );

  const blockSize = pow2(bits - newPrefix);
  const shown = Math.min(count, MAX_SPLIT_ROWS);
  const fmt = version === 4 ? formatV4 : formatV6Compressed;

  for (let i = 0; i < shown; i++) {
    const subnetNet = network + BigInt(i) * blockSize;
    rows[`Subnet ${i + 1}`] = `${fmt(subnetNet)}/${newPrefix}`;
  }
  if (count > MAX_SPLIT_ROWS) {
    rows["Split truncated"] =
      `Showing the first ${MAX_SPLIT_ROWS} of ${count} /${newPrefix} subnets.`;
  }
}

/* -------------------------------------------------------------------------- */
/* Single network description                                                */
/* -------------------------------------------------------------------------- */

function describeV4(parsed: ParsedCidr, opts: SubnetOpts): SubnetResult {
  const { ip, prefix, assumedDefault } = parsed;
  const mask = maskFromPrefix(prefix, V4_BITS);
  const wildcard = mask ^ 0xffffffffn;
  const network = ip & mask;
  const broadcast = network | wildcard;
  const total = pow2(V4_BITS - prefix);

  const rows: SubnetResult = {};
  rows["CIDR"] = `${formatV4(network)}/${prefix}`;

  if (assumedDefault) {
    rows["Note"] = "No prefix or netmask given; assuming /32, a single host.";
  }
  if (network !== ip) {
    rows["Containing network"] =
      `${formatV4(ip)} is a host address; its containing network is ${formatV4(network)}/${prefix}.`;
  }

  rows["Netmask"] = formatV4(mask);
  rows["Wildcard mask"] = formatV4(wildcard);
  rows["Network address"] = formatV4(network);

  if (prefix === 32) {
    rows["Broadcast address"] = "N/A (single host)";
    rows["First usable host"] = formatV4(network);
    rows["Last usable host"] = formatV4(network);
    rows["Usable host count"] = "1 (this address only)";
  } else if (prefix === 31) {
    rows["Broadcast address"] = "N/A (RFC 3021 point-to-point link; both addresses usable)";
    rows["First usable host"] = formatV4(network);
    rows["Last usable host"] = formatV4(broadcast);
    rows["Usable host count"] = "2 (RFC 3021 point-to-point, no network or broadcast reserved)";
  } else {
    rows["Broadcast address"] = formatV4(broadcast);
    rows["First usable host"] = formatV4(network + 1n);
    rows["Last usable host"] = formatV4(broadcast - 1n);
    rows["Usable host count"] = (total - 2n).toString();
  }

  rows["Total addresses"] = total.toString();
  rows["Binary netmask"] = binaryDotted(mask);
  rows["IP class"] = ipClassV4(network);
  rows["Address type"] = classifyV4Address(network);

  addSplitRows(rows, 4, network, prefix, opts.split);
  return rows;
}

function describeV6(parsed: ParsedCidr, opts: SubnetOpts): SubnetResult {
  const { ip, prefix, assumedDefault } = parsed;
  const mask = maskFromPrefix(prefix, V6_BITS);
  const network = ip & mask;
  const last = network | (mask ^ (pow2(V6_BITS) - 1n));

  const rows: SubnetResult = {};
  rows["Compressed address"] = formatV6Compressed(network);
  rows["Expanded address"] = formatV6Expanded(network);
  rows["Prefix length"] = `/${prefix}`;

  if (assumedDefault) {
    rows["Note"] = "No prefix given; assuming /128, a single host.";
  }
  if (network !== ip) {
    rows["Containing network"] =
      `${formatV6Compressed(ip)} is a host address; its containing network is ${formatV6Compressed(network)}/${prefix}.`;
  }

  rows["Network address"] = formatV6Compressed(network);
  rows["First address"] = formatV6Compressed(network);
  rows["Last address"] = formatV6Compressed(last);
  rows["Total addresses"] = `2^${V6_BITS - prefix}`;
  rows["Scope"] = classifyV6Address(network);

  addSplitRows(rows, 6, network, prefix, opts.split);
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Two-CIDR comparison                                                       */
/* -------------------------------------------------------------------------- */

function parseFullCidr(token: string): { version: IpVersion; network: bigint; prefix: number } {
  const idx = token.indexOf("/");
  const addrPart = token.slice(0, idx);
  const prefixPart = token.slice(idx + 1);
  const { version, value } = parseIpAny(addrPart);
  const prefix = parsePrefixToken(prefixPart, bitsFor(version));
  const mask = maskFromPrefix(prefix, bitsFor(version));
  return { version, network: value & mask, prefix };
}

/** Length of the common leading bits shared by two same-width bigints. */
function commonPrefixLen(a: bigint, b: bigint, bits: number): number {
  const diff = a ^ b;
  if (diff === 0n) return bits;
  const highestBit = diff.toString(2).length - 1;
  return bits - 1 - highestBit;
}

function compareMode(tokenA: string, tokenB: string): SubnetResult {
  const a = parseFullCidr(tokenA);
  const b = parseFullCidr(tokenB);

  if (a.version !== b.version)
    throw new ToolError(
      "bad-ip",
      `Cannot compare an IPv4 network (${tokenA}) with an IPv6 network (${tokenB}).`,
      "Use two IPv4 CIDRs or two IPv6 CIDRs.",
    );

  const bits = bitsFor(a.version);
  const fmt = a.version === 4 ? formatV4 : formatV6Compressed;
  const maskA = maskFromPrefix(a.prefix, bits);
  const maskB = maskFromPrefix(b.prefix, bits);

  const aContainsB = a.prefix <= b.prefix && (b.network & maskA) === a.network;
  const bContainsA = b.prefix <= a.prefix && (a.network & maskB) === b.network;

  const startA = a.network;
  const endA = a.network + pow2(bits - a.prefix) - 1n;
  const startB = b.network;
  const endB = b.network + pow2(bits - b.prefix) - 1n;
  const overlap = startA <= endB && startB <= endA;

  let relationship: string;
  if (a.network === b.network && a.prefix === b.prefix) relationship = "Equal networks";
  else if (aContainsB) relationship = `${fmt(a.network)}/${a.prefix} contains ${fmt(b.network)}/${b.prefix}`;
  else if (bContainsA) relationship = `${fmt(b.network)}/${b.prefix} contains ${fmt(a.network)}/${a.prefix}`;
  else if (overlap) relationship = "Overlapping (neither contains the other)";
  else relationship = "Disjoint (no overlap)";

  const commonLen = Math.min(commonPrefixLen(a.network, b.network, bits), a.prefix, b.prefix);
  const supernetMask = maskFromPrefix(commonLen, bits);
  const supernetNetwork = a.network & supernetMask;

  return {
    "Network A": `${fmt(a.network)}/${a.prefix}`,
    "Network B": `${fmt(b.network)}/${b.prefix}`,
    Relationship: relationship,
    Overlap: overlap ? "Yes" : "No",
    "Smallest common supernet": `${fmt(supernetNetwork)}/${commonLen}`,
  };
}

/* -------------------------------------------------------------------------- */
/* run()                                                                      */
/* -------------------------------------------------------------------------- */

export function run(input: string, opts: SubnetOpts): SubnetResult {
  const raw = (input ?? "").trim();
  if (!raw)
    throw new ToolError(
      "empty-input",
      "Enter an IP address, a CIDR, or two CIDRs to compare.",
      "Try 192.168.1.0/24, 192.168.1.37 255.255.255.0, or 10.0.0.0/24, 10.0.1.0/24.",
    );

  const tokens = raw.split(/[,\s]+/).filter(Boolean);

  if (tokens.length === 2 && tokens[0].includes("/") && tokens[1].includes("/")) {
    return compareMode(tokens[0], tokens[1]);
  }

  if (tokens.length === 2 && !tokens[0].includes("/") && !tokens[1].includes("/")) {
    const ip = parseIPv4(tokens[0]);
    const prefix = netmaskToPrefixV4(tokens[1]);
    if (prefix === null)
      throw new ToolError(
        "bad-prefix",
        `"${tokens[1]}" is not a valid contiguous IPv4 subnet mask.`,
        "Use a mask like 255.255.255.0.",
      );
    return describeV4({ version: 4, ip, prefix, assumedDefault: false }, opts);
  }

  if (tokens.length === 1) {
    const parsed = parseCidrOrBareIp(tokens[0]);
    return parsed.version === 4 ? describeV4(parsed, opts) : describeV6(parsed, opts);
  }

  throw new ToolError(
    "bad-ip",
    `Could not parse "${raw}" as an IP, a CIDR, or two CIDRs to compare.`,
    "Use a form like 192.168.1.0/24, 192.168.1.37 255.255.255.0, or 10.0.0.0/24, 10.0.1.0/24.",
  );
}

export default { run } satisfies ToolLogic<string, SubnetResult, SubnetOpts>;

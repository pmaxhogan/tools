import { ToolError, type ToolLogic } from "../types";

/** RTP (1) or RTCP (2), per RFC 5245. */
export type IceComponent = 1 | 2;

export type IceCandidateType = "host" | "srflx" | "prflx" | "relay";

export type AddressClass =
  | "ipv4-private"
  | "ipv4-public"
  | "ipv6-link-local"
  | "ipv6-ula"
  | "ipv6-global"
  | "mdns";

export interface AddressClassification {
  class: AddressClass;
  /** Human explanation of what the classification means, shown to the user. */
  note: string;
}

export interface ParsedCandidate {
  foundation: string;
  component: IceComponent;
  protocol: string;
  priority: number;
  address: string;
  port: number;
  type: IceCandidateType;
  relatedAddress?: string;
  relatedPort?: number;
  tcptype?: string;
  extensions: Record<string, string>;
  addressClass: AddressClass;
  addressNote: string;
}

export interface StunServer {
  id: string;
  label: string;
  urls: string;
}

/** Public STUN servers offered to the (future) live-gathering panel. */
export const STUN_SERVERS: StunServer[] = [
  { id: "google", label: "Google", urls: "stun:stun.l.google.com:19302" },
  { id: "cloudflare", label: "Cloudflare", urls: "stun:stun.cloudflare.com:3478" },
  { id: "twilio", label: "Twilio", urls: "stun:global.stun.twilio.com:3478" },
];

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Classify an ICE candidate address: private/public IPv4, IPv6 scope, or mDNS. */
export function classifyAddress(address: string): AddressClassification {
  const a = (address ?? "").trim();

  if (/\.local$/i.test(a)) {
    return {
      class: "mdns",
      note: "mDNS-obfuscated host candidate. Modern browsers hide a device's real local IP behind a random .local hostname for privacy, resolvable only by another device on the same LAN. This tool cannot recover the real address from the name alone.",
    };
  }

  const ipv4 = a.match(IPV4_RE);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    const outOfRange = octets.some((o) => o > 255);
    const [o1, o2] = octets;
    if (!outOfRange) {
      if (o1 === 10) {
        return { class: "ipv4-private", note: "RFC 1918 private address (10.0.0.0/8)." };
      }
      if (o1 === 172 && o2 >= 16 && o2 <= 31) {
        return { class: "ipv4-private", note: "RFC 1918 private address (172.16.0.0/12)." };
      }
      if (o1 === 192 && o2 === 168) {
        return { class: "ipv4-private", note: "RFC 1918 private address (192.168.0.0/16)." };
      }
      if (o1 === 100 && o2 >= 64 && o2 <= 127) {
        return {
          class: "ipv4-private",
          note: "Carrier-grade NAT address (100.64.0.0/10, RFC 6598), common behind mobile carriers and ISPs that share IPv4 addresses across customers.",
        };
      }
    }
    return { class: "ipv4-public", note: "Publicly routable IPv4 address." };
  }

  if (a.includes(":")) {
    const lower = a.toLowerCase();
    if (
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb")
    ) {
      return {
        class: "ipv6-link-local",
        note: "IPv6 link-local address (fe80::/10), only reachable from another device on the same link.",
      };
    }
    if (lower.startsWith("fc") || lower.startsWith("fd")) {
      return {
        class: "ipv6-ula",
        note: "IPv6 unique local address (fc00::/7), the IPv6 analog of RFC 1918 private space.",
      };
    }
    return {
      class: "ipv6-global",
      note: "Best-effort: treated as a globally routable IPv6 address because it falls outside fe80::/10 (link-local) and fc00::/7 (unique local). Documentation and other reserved ranges are not excluded.",
    };
  }

  return {
    class: "ipv4-public",
    note: `Address "${a}" did not match a recognized IPv4, IPv6, or mDNS pattern; treated as an opaque address.`,
  };
}

/** Parse one ICE candidate line, with or without a leading "candidate:" or "a=candidate:". */
export function parseCandidate(line: string): ParsedCandidate {
  const trimmed = (line ?? "").trim();
  if (!trimmed) {
    throw new ToolError(
      "bad-candidate",
      "Candidate line is empty.",
      'Paste a line like: candidate:842163049 1 udp 1677729535 192.168.1.5 54321 typ host',
    );
  }

  let body = trimmed;
  if (body.startsWith("a=")) body = body.slice(2);
  if (/^candidate:/i.test(body)) body = body.slice("candidate:".length);

  const tokens = body.split(/\s+/).filter(Boolean);
  if (tokens.length < 8) {
    throw new ToolError(
      "bad-candidate",
      `Candidate line has too few fields: "${trimmed}".`,
      "An ICE candidate needs foundation, component, protocol, priority, address, port, the literal \"typ\", and a type.",
    );
  }

  const [foundationTok, componentTok, protocolTok, priorityTok, addressTok, portTok, typTok, typeTok, ...rest] =
    tokens;

  if (componentTok !== "1" && componentTok !== "2") {
    throw new ToolError(
      "bad-candidate",
      `Invalid component id "${componentTok}" (expected 1 for RTP or 2 for RTCP).`,
    );
  }
  const component = Number(componentTok) as IceComponent;

  const protocol = protocolTok.toLowerCase();
  if (protocol !== "udp" && protocol !== "tcp") {
    throw new ToolError(
      "bad-candidate",
      `Invalid transport protocol "${protocolTok}" (expected udp or tcp).`,
    );
  }

  if (!/^\d+$/.test(priorityTok)) {
    throw new ToolError(
      "bad-candidate",
      `Invalid priority "${priorityTok}" (expected a non-negative integer).`,
    );
  }
  const priority = Number(priorityTok);

  if (!/^\d+$/.test(portTok)) {
    throw new ToolError("bad-candidate", `Invalid port "${portTok}" (expected a number 0-65535).`);
  }
  const port = Number(portTok);
  if (port > 65535) {
    throw new ToolError("bad-candidate", `Port "${portTok}" is out of range 0-65535.`);
  }

  if (typTok.toLowerCase() !== "typ") {
    throw new ToolError("bad-candidate", `Expected the literal "typ" but found "${typTok}".`);
  }

  const type = typeTok.toLowerCase();
  if (type !== "host" && type !== "srflx" && type !== "prflx" && type !== "relay") {
    throw new ToolError(
      "bad-candidate",
      `Unknown candidate type "${typeTok}" (expected host, srflx, prflx, or relay).`,
    );
  }

  let relatedAddress: string | undefined;
  let relatedPort: number | undefined;
  let tcptype: string | undefined;
  const extensions: Record<string, string> = {};

  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.toLowerCase();
    const value = rest[i + 1];
    if (!key || value === undefined) {
      throw new ToolError("bad-candidate", `Dangling attribute "${rest[i]}" with no value.`);
    }
    if (key === "raddr") {
      relatedAddress = value;
    } else if (key === "rport") {
      if (!/^\d+$/.test(value)) {
        throw new ToolError("bad-candidate", `Invalid related port "${value}".`);
      }
      relatedPort = Number(value);
    } else if (key === "tcptype") {
      tcptype = value;
    } else {
      extensions[key] = value;
    }
  }

  const { class: addressClass, note: addressNote } = classifyAddress(addressTok);

  return {
    foundation: foundationTok,
    component,
    protocol,
    priority,
    address: addressTok,
    port,
    type: type as IceCandidateType,
    relatedAddress,
    relatedPort,
    tcptype,
    extensions,
    addressClass,
    addressNote,
  };
}

function classLabel(c: AddressClass): string {
  switch (c) {
    case "ipv4-private":
      return "IPv4 private";
    case "ipv4-public":
      return "IPv4 public";
    case "ipv6-link-local":
      return "IPv6 link-local";
    case "ipv6-ula":
      return "IPv6 ULA";
    case "ipv6-global":
      return "IPv6 global";
    case "mdns":
      return "mDNS-hidden";
  }
}

export interface InterpretOpts {
  /** Parallel array to `candidates`: which STUN/TURN server URL produced each one, if known. */
  sourceUrls?: (string | undefined)[];
  [key: string]: unknown;
}

/** Turn a set of parsed candidates into hedged NAT/reachability verdicts. */
export function interpretGathering(
  candidates: ParsedCandidate[],
  opts: InterpretOpts = {},
): Record<string, string> {
  const out: Record<string, string> = {};

  if (candidates.length === 0) {
    out["NAT / reachability"] =
      "No candidates were gathered at all. This usually means ICE gathering failed or was blocked (browser permissions, an extension, or a firewall policy) rather than saying anything about NAT type.";
    return out;
  }

  const srflxIdx = candidates
    .map((c, i) => ({ c, i }))
    .filter((x) => x.c.type === "srflx");
  const relay = candidates.filter((c) => c.type === "relay");
  const srflx = srflxIdx.map((x) => x.c);

  if (srflx.length === 0 && relay.length === 0) {
    out["NAT / reachability"] =
      "Only host candidates were found (some possibly hidden behind mDNS .local names). No server-reflexive candidate came back, which suggests outbound UDP to the STUN server was blocked, or no STUN server was configured. This is not proof of no internet access, only that this test could not confirm STUN reachability.";
    return out;
  }

  if (srflx.length > 0) {
    out["NAT / reachability"] =
      "At least one server-reflexive (srflx) candidate came back, so outbound UDP to a STUN server works and a public address was discovered for this session.";

    srflx.forEach((c, i) => {
      out[`Reflexive address ${i + 1}`] = `${c.address}:${c.port}`;
    });

    const groups = new Map<string, { addr: string; port: number; url?: string }[]>();
    srflxIdx.forEach(({ c, i }) => {
      const key = c.relatedAddress
        ? `${c.relatedAddress}:${c.relatedPort ?? "?"}`
        : `unknown-base-${i}`;
      const arr = groups.get(key) ?? [];
      arr.push({ addr: c.address, port: c.port, url: opts.sourceUrls?.[i] });
      groups.set(key, arr);
    });

    const multiSourceGroups = [...groups.values()].filter((g) => g.length > 1);
    if (multiSourceGroups.length > 0) {
      const group = multiSourceGroups[0];
      const addrs = new Set(group.map((g) => g.addr));
      const ports = new Set(group.map((g) => g.port));
      if (addrs.size === 1 && ports.size === 1) {
        out["STUN consistency"] =
          "The same local base mapped to the same public ip:port across multiple STUN servers, consistent with endpoint-independent mapping, an easier NAT type to traverse.";
      } else if (addrs.size === 1 && ports.size > 1) {
        out["STUN consistency"] =
          "The same local base mapped to the same public IP but a different port on each STUN server, which suggests symmetric NAT: the port mapping depends on the destination. Symmetric NAT often needs a TURN relay to connect reliably.";
        out["Symmetric NAT hint"] =
          "Port varies per destination for the same local socket. Treat this as a hint, not a certainty, since only a couple of STUN servers were sampled.";
      } else {
        out["STUN consistency"] =
          "The public address differed entirely across STUN servers for what looks like the same local base. This can happen with multiple network paths or load-balanced STUN infrastructure and is not on its own proof of a particular NAT type.";
      }
    } else if (srflx.length > 1) {
      out["STUN consistency"] =
        "Multiple reflexive candidates were found but none share a recognizable local base (raddr/rport), so no cross-server comparison could be made.";
    }
  }

  if (relay.length > 0) {
    out["TURN (relay)"] =
      relay.length === 1
        ? `A relay candidate was allocated at ${relay[0].address}:${relay[0].port}, so TURN works and this connection should succeed even behind restrictive NATs or firewalls.`
        : `${relay.length} relay candidates were allocated, so TURN works and this connection should succeed even behind restrictive NATs or firewalls.`;
  } else if (srflx.length > 0) {
    out["TURN (relay)"] =
      "No relay candidate was found. That is expected if no TURN server was configured; if one was configured and still nothing came back, treat that as a possible TURN misconfiguration.";
  }

  return out;
}

interface RawCandidateSource {
  text: string;
  sourceUrl?: string;
}

function extractCandidates(raw: string): {
  sources: RawCandidateSource[];
  ufragCount: number;
  hasFingerprint: boolean;
} {
  if (raw.trimStart().startsWith("[")) {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new ToolError(
        "bad-candidate",
        "Input looks like a JSON array but failed to parse.",
        'Provide a JSON array of objects like [{"candidate": "candidate:...", "url": "stun:..."}].',
      );
    }
    if (!Array.isArray(data)) {
      throw new ToolError("bad-candidate", "JSON input must be an array of candidate objects.");
    }
    const sources: RawCandidateSource[] = data.map((item, i) => {
      if (typeof item === "string") return { text: item };
      if (
        item &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).candidate === "string"
      ) {
        const obj = item as Record<string, unknown>;
        const url = typeof obj.url === "string" ? obj.url : undefined;
        return { text: obj.candidate as string, sourceUrl: url };
      }
      throw new ToolError(
        "bad-candidate",
        `JSON array item ${i} is not a candidate string or a {candidate, url?} object.`,
      );
    });
    return { sources, ufragCount: 0, hasFingerprint: false };
  }

  const lines = raw.split(/\r?\n/);
  const sources: RawCandidateSource[] = [];
  const ufrags = new Set<string>();
  let hasFingerprint = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^(a=)?candidate:/i.test(t)) {
      sources.push({ text: t });
    } else if (/^a=ice-ufrag:/i.test(t)) {
      ufrags.add(t.slice("a=ice-ufrag:".length).trim());
    } else if (/^a=fingerprint:/i.test(t)) {
      hasFingerprint = true;
    }
  }
  return { sources, ufragCount: ufrags.size, hasFingerprint };
}

export interface WebrtcTesterOpts {
  [key: string]: unknown;
}

export function run(input: string, _opts: WebrtcTesterOpts = {}): Record<string, string> {
  const raw = (input ?? "").trim();
  if (!raw) {
    throw new ToolError(
      "empty-input",
      "Paste ICE candidate lines, a full SDP, or a JSON array of candidates to analyze.",
    );
  }

  const { sources, ufragCount, hasFingerprint } = extractCandidates(raw);
  if (sources.length === 0) {
    throw new ToolError(
      "no-candidates",
      "The input was parsed but no ICE candidate lines were found in it.",
      'Paste lines starting with candidate: or a=candidate:, a full SDP, or a JSON array of {candidate, url?} objects.',
    );
  }

  const parsed = sources.map((s) => parseCandidate(s.text));
  const sourceUrls = sources.map((s) => s.sourceUrl);

  const out: Record<string, string> = {};
  parsed.forEach((c, i) => {
    out[`Candidate ${i + 1} (${c.type})`] =
      `${c.protocol.toUpperCase()} ${c.address}:${c.port} - ${classLabel(c.addressClass)}`;
  });

  if (ufragCount > 0) out["ICE ufrag count (SDP)"] = String(ufragCount);
  if (hasFingerprint) out["DTLS fingerprint present (SDP)"] = "yes";

  Object.assign(out, interpretGathering(parsed, { sourceUrls }));

  return out;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, WebrtcTesterOpts>;

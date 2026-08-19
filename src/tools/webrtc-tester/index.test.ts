import { describe, expect, it } from "vitest";
import {
  classifyAddress,
  interpretGathering,
  parseCandidate,
  run,
  STUN_SERVERS,
} from "./index";
import { ToolError } from "../types";

const HOST = "candidate:842163049 1 udp 1677729535 192.168.1.5 54321 typ host generation 0 ufrag abcd network-id 1";
const MDNS =
  "candidate:1516069770 1 udp 2113937151 4a2f8bd3-9c1e-4f2a-8b3d-1234567890ab.local 51684 typ host generation 0 ufrag xyz1 network-id 1";
const SRFLX_A =
  "candidate:3319380930 1 udp 1677732095 203.0.113.5 54321 typ srflx raddr 192.168.1.5 rport 54321 generation 0 ufrag abcd";
const SRFLX_B_SAME_PORT =
  "candidate:3319380931 1 udp 1677732095 203.0.113.5 54321 typ srflx raddr 192.168.1.5 rport 54321 generation 0 ufrag abcd";
const SRFLX_B_DIFF_PORT =
  "candidate:3319380932 1 udp 1677732095 203.0.113.5 60000 typ srflx raddr 192.168.1.5 rport 54321 generation 0 ufrag abcd";
const RELAY =
  "candidate:2999745851 1 udp 41885439 198.51.100.9 3478 typ relay raddr 203.0.113.5 rport 54321 generation 0 ufrag abcd";
const TCP_ACTIVE =
  "candidate:842163050 1 tcp 1518280447 192.168.1.5 9 typ host tcptype active generation 0 ufrag abcd";

describe("parseCandidate", () => {
  it("parses a realistic host candidate", () => {
    const c = parseCandidate(HOST);
    expect(c.foundation).toBe("842163049");
    expect(c.component).toBe(1);
    expect(c.protocol).toBe("udp");
    expect(c.priority).toBe(1677729535);
    expect(c.address).toBe("192.168.1.5");
    expect(c.port).toBe(54321);
    expect(c.type).toBe("host");
    expect(c.addressClass).toBe("ipv4-private");
    expect(c.extensions.generation).toBe("0");
    expect(c.extensions.ufrag).toBe("abcd");
    expect(c.extensions["network-id"]).toBe("1");
  });

  it("parses a mDNS-hidden host candidate", () => {
    const c = parseCandidate(MDNS);
    expect(c.type).toBe("host");
    expect(c.addressClass).toBe("mdns");
    expect(c.addressNote).toMatch(/mDNS/);
  });

  it("parses a srflx candidate with raddr/rport", () => {
    const c = parseCandidate(SRFLX_A);
    expect(c.type).toBe("srflx");
    expect(c.address).toBe("203.0.113.5");
    expect(c.addressClass).toBe("ipv4-public");
    expect(c.relatedAddress).toBe("192.168.1.5");
    expect(c.relatedPort).toBe(54321);
  });

  it("parses a relay candidate", () => {
    const c = parseCandidate(RELAY);
    expect(c.type).toBe("relay");
    expect(c.relatedAddress).toBe("203.0.113.5");
    expect(c.relatedPort).toBe(54321);
  });

  it("parses a tcp candidate with tcptype", () => {
    const c = parseCandidate(TCP_ACTIVE);
    expect(c.protocol).toBe("tcp");
    expect(c.tcptype).toBe("active");
  });

  it("accepts a bare candidate line without a= or candidate: prefix stripped only once", () => {
    const c = parseCandidate("a=candidate:1 1 udp 100 10.0.0.1 5000 typ host");
    expect(c.address).toBe("10.0.0.1");
    expect(c.type).toBe("host");
  });

  it("throws bad-candidate naming the token for too few fields", () => {
    expect(() => parseCandidate("candidate:1 1 udp 100 typ host")).toThrowError(ToolError);
    try {
      parseCandidate("candidate:1 1 udp 100 typ host");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-candidate");
    }
  });

  it("throws bad-candidate naming the bad component token", () => {
    try {
      parseCandidate("candidate:1 9 udp 100 10.0.0.1 5000 typ host");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-candidate");
      expect((e as ToolError).message).toMatch(/"9"/);
    }
  });

  it("throws bad-candidate for an unknown candidate type", () => {
    try {
      parseCandidate("candidate:1 1 udp 100 10.0.0.1 5000 typ bogus");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-candidate");
      expect((e as ToolError).message).toMatch(/"bogus"/);
    }
  });

  it("throws bad-candidate for an empty line", () => {
    expect(() => parseCandidate("   ")).toThrowError(ToolError);
  });
});

describe("classifyAddress", () => {
  it("classifies 192.168.x as IPv4 private", () => {
    expect(classifyAddress("192.168.1.5").class).toBe("ipv4-private");
  });

  it("classifies 100.64.x as IPv4 private (CGNAT)", () => {
    const r = classifyAddress("100.64.0.1");
    expect(r.class).toBe("ipv4-private");
    expect(r.note).toMatch(/Carrier-grade NAT/);
  });

  it("classifies 10.x and 172.16-31.x as IPv4 private", () => {
    expect(classifyAddress("10.1.2.3").class).toBe("ipv4-private");
    expect(classifyAddress("172.20.0.1").class).toBe("ipv4-private");
    expect(classifyAddress("172.40.0.1").class).toBe("ipv4-public");
  });

  it("classifies a normal address as IPv4 public", () => {
    expect(classifyAddress("203.0.113.5").class).toBe("ipv4-public");
  });

  it("classifies fe80:: as IPv6 link-local", () => {
    expect(classifyAddress("fe80::1234:5678:9abc:def0").class).toBe("ipv6-link-local");
  });

  it("classifies fc00::/fd00:: as IPv6 ULA", () => {
    expect(classifyAddress("fd12:3456:789a::1").class).toBe("ipv6-ula");
  });

  it("classifies 2001:db8:: as IPv6 global (best effort)", () => {
    expect(classifyAddress("2001:db8::1").class).toBe("ipv6-global");
  });

  it("classifies a .local hostname as mDNS", () => {
    expect(classifyAddress("abc123.local").class).toBe("mdns");
  });
});

describe("interpretGathering", () => {
  it("reports gathering failed/blocked when there are no candidates", () => {
    const out = interpretGathering([]);
    expect(out["NAT / reachability"]).toMatch(/blocked/);
  });

  it("reports STUN unreachable when only host/mDNS candidates exist", () => {
    const out = interpretGathering([parseCandidate(HOST), parseCandidate(MDNS)]);
    expect(out["NAT / reachability"]).toMatch(/blocked|configured/);
    expect(out["Reflexive address 1"]).toBeUndefined();
  });

  it("reports STUN worked and the reflexive address when srflx is present", () => {
    const out = interpretGathering([parseCandidate(HOST), parseCandidate(SRFLX_A)]);
    expect(out["NAT / reachability"]).toMatch(/server-reflexive/);
    expect(out["Reflexive address 1"]).toBe("203.0.113.5:54321");
  });

  it("reports TURN works when a relay candidate is present", () => {
    const out = interpretGathering([parseCandidate(SRFLX_A), parseCandidate(RELAY)]);
    expect(out["TURN (relay)"]).toMatch(/TURN works/);
    expect(out["TURN (relay)"]).toMatch(/198\.51\.100\.9:3478/);
  });

  it("flags endpoint-independent mapping when multiple STUN servers agree", () => {
    const out = interpretGathering([parseCandidate(SRFLX_A), parseCandidate(SRFLX_B_SAME_PORT)]);
    expect(out["STUN consistency"]).toMatch(/endpoint-independent/);
    expect(out["Symmetric NAT hint"]).toBeUndefined();
  });

  it("flags a symmetric NAT hint when the same base maps to different ports", () => {
    const out = interpretGathering([parseCandidate(SRFLX_A), parseCandidate(SRFLX_B_DIFF_PORT)]);
    expect(out["STUN consistency"]).toMatch(/symmetric NAT/);
    expect(out["Symmetric NAT hint"]).toBeDefined();
  });
});

describe("run", () => {
  it("throws empty-input on blank input", () => {
    try {
      run("", {});
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("throws no-candidates when input parses but has no candidate lines", () => {
    try {
      run("v=0\no=- 1 1 IN IP4 0.0.0.0\ns=-\nt=0 0\n", {});
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("no-candidates");
    }
  });

  it("throws bad-candidate for a malformed candidate line in raw text", () => {
    try {
      run("candidate:1 1 udp 100 typ host", {});
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-candidate");
    }
  });

  it("extracts a=candidate lines from a full SDP and reports ufrag count and fingerprint", () => {
    const sdp = [
      "v=0",
      "o=- 1 1 IN IP4 0.0.0.0",
      "s=-",
      "t=0 0",
      "a=ice-ufrag:F7gI",
      "a=ice-pwd:x9cml/YzichV2+XlhiMu8g",
      "a=fingerprint:sha-256 4A:AD:B9:B1:3F:...",
      `a=${HOST}`,
      `a=${SRFLX_A}`,
    ].join("\n");
    const out = run(sdp, {});
    expect(out["ICE ufrag count (SDP)"]).toBe("1");
    expect(out["DTLS fingerprint present (SDP)"]).toBe("yes");
    expect(out["Candidate 1 (host)"]).toMatch(/192\.168\.1\.5:54321/);
    expect(out["Candidate 2 (srflx)"]).toMatch(/203\.0\.113\.5:54321/);
    expect(out["Reflexive address 1"]).toBe("203.0.113.5:54321");
  });

  it("accepts the JSON array shape the panel produces", () => {
    const input = JSON.stringify([
      { candidate: HOST, url: undefined },
      { candidate: SRFLX_A, url: "stun:stun.l.google.com:19302" },
    ]);
    const out = run(input, {});
    expect(out["Candidate 1 (host)"]).toMatch(/192\.168\.1\.5:54321 - IPv4 private/);
    expect(out["Candidate 2 (srflx)"]).toMatch(/203\.0\.113\.5:54321 - IPv4 public/);
    expect(out["NAT / reachability"]).toMatch(/server-reflexive/);
  });

  it("throws bad-candidate for a malformed JSON array item", () => {
    try {
      run(JSON.stringify([{ nope: "x" }]), {});
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-candidate");
    }
  });
});

describe("STUN_SERVERS", () => {
  it("lists Google, Cloudflare, and Twilio STUN servers", () => {
    const ids = STUN_SERVERS.map((s) => s.id);
    expect(ids).toContain("google");
    expect(ids).toContain("cloudflare");
    expect(ids).toContain("twilio");
    for (const s of STUN_SERVERS) {
      expect(s.urls.startsWith("stun:")).toBe(true);
    }
  });
});

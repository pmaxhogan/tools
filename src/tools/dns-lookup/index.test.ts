import { describe, expect, it } from "vitest";
import {
  RECORD_TYPES,
  RESOLVERS,
  buildQueryUrl,
  describeStatus,
  isIPv4,
  isIPv6,
  normalizeInput,
  parseDohResponse,
  rrTypeName,
  run,
  toPtrName,
} from "./index";
import { ToolError } from "../types";

/** A realistic Google JSON DoH answer for example.com MX. */
const GOOGLE_MX = {
  Status: 0,
  Question: [{ name: "example.com.", type: 15 }],
  Answer: [{ name: "example.com.", type: 15, TTL: 300, data: "10 mail.example.com." }],
};

/** A realistic Google JSON DoH answer for example.com TXT. */
const GOOGLE_TXT = {
  Status: 0,
  Question: [{ name: "example.com.", type: 16 }],
  Answer: [
    { name: "example.com.", type: 16, TTL: 300, data: '"v=spf1 -all"' },
    { name: "example.com.", type: 16, TTL: 300, data: '"google-site-verification=abc123"' },
  ],
};

const NXDOMAIN = { Status: 3, Question: [{ name: "nope.example.com.", type: 1 }] };

describe("buildQueryUrl", () => {
  it("builds every record type against Cloudflare with the ct param", () => {
    for (const type of RECORD_TYPES) {
      const url = buildQueryUrl("cloudflare", "example.com", type);
      expect(url).toBe(
        `https://cloudflare-dns.com/dns-query?name=example.com&type=${type}&ct=application%2Fdns-json`,
      );
    }
  });

  it("omits the ct param for Google and dns.sb", () => {
    expect(buildQueryUrl("google", "example.com", "MX")).toBe(
      "https://dns.google/resolve?name=example.com&type=MX",
    );
    expect(buildQueryUrl("dnssb", "example.com", "TXT")).toBe(
      "https://doh.sb/dns-query?name=example.com&type=TXT",
    );
  });

  it("accepts a resolver object and normalizes the name", () => {
    const cloudflare = RESOLVERS.find((r) => r.id === "cloudflare")!;
    expect(buildQueryUrl(cloudflare, "EXAMPLE.com.", "SRV")).toBe(
      "https://cloudflare-dns.com/dns-query?name=example.com&type=SRV&ct=application%2Fdns-json",
    );
  });

  it("throws ToolError on an unsupported record type", () => {
    try {
      buildQueryUrl("cloudflare", "example.com", "DNSKEY");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("invalid-type");
    }
  });

  it("throws ToolError on an unknown resolver id", () => {
    try {
      buildQueryUrl("opendns", "example.com", "A");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("invalid-resolver");
    }
  });
});

describe("normalizeInput", () => {
  it("strips protocol, path, port, and the trailing root dot", () => {
    expect(normalizeInput("https://WWW.Example.com:8443/a/b?q=1")).toBe("www.example.com");
    expect(normalizeInput("example.com.")).toBe("example.com");
  });

  it("does not mangle a bare IPv6 literal's colons", () => {
    expect(normalizeInput("2001:DB8::1")).toBe("2001:db8::1");
    expect(normalizeInput("::1")).toBe("::1");
  });

  it("strips a bracketed IPv6 host with a port", () => {
    expect(normalizeInput("[2001:db8::1]:8443/path")).toBe("2001:db8::1");
  });
});

describe("isIPv4 and isIPv6", () => {
  it("recognizes IPv4 addresses and rejects lookalikes", () => {
    expect(isIPv4("192.0.2.1")).toBe(true);
    expect(isIPv4("255.255.255.255")).toBe(true);
    expect(isIPv4("256.0.0.1")).toBe(false);
    expect(isIPv4("example.com")).toBe(false);
    expect(isIPv4("1.2.3")).toBe(false);
  });

  it("recognizes IPv6 addresses including compressed and full forms", () => {
    expect(isIPv6("2001:db8::1")).toBe(true);
    expect(isIPv6("::1")).toBe(true);
    expect(isIPv6("::")).toBe(true);
    expect(isIPv6("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe(true);
    expect(isIPv6("192.0.2.1")).toBe(false);
    expect(isIPv6("not:an:address")).toBe(false);
    expect(isIPv6("1:2:3::4:5:6:7:8")).toBe(false);
  });
});

describe("toPtrName", () => {
  it("builds the in-addr.arpa name for an IPv4 address", () => {
    expect(toPtrName("192.0.2.1")).toBe("1.2.0.192.in-addr.arpa");
  });

  it("builds the fully expanded ip6.arpa name for a compressed IPv6 address", () => {
    expect(toPtrName("2001:db8::1")).toBe(
      "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa",
    );
  });

  it("throws ToolError for a string that is neither IPv4 nor IPv6", () => {
    try {
      toPtrName("example.com");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("invalid-domain");
    }
  });
});

describe("parseDohResponse", () => {
  it("parses a Google MX answer", () => {
    const parsed = parseDohResponse(GOOGLE_MX);
    expect(parsed.statusCode).toBe("NOERROR");
    expect(parsed.question).toBe("example.com MX");
    expect(parsed.answers).toEqual([
      { name: "example.com", type: "MX", ttl: 300, data: "10 mail.example.com." },
    ]);
  });

  it("parses a Google TXT answer with two records", () => {
    const parsed = parseDohResponse(GOOGLE_TXT);
    expect(parsed.answers).toHaveLength(2);
    expect(parsed.answers[0]).toEqual({
      name: "example.com",
      type: "TXT",
      ttl: 300,
      data: '"v=spf1 -all"',
    });
  });

  it("reports NXDOMAIN with an empty answer list", () => {
    const parsed = parseDohResponse(NXDOMAIN);
    expect(parsed.statusCode).toBe("NXDOMAIN");
    expect(parsed.status).toBe("NXDOMAIN (the domain does not exist)");
    expect(parsed.answers).toEqual([]);
  });

  it("throws ToolError('invalid-json') on junk", () => {
    try {
      parseDohResponse("not json");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("invalid-json");
    }
    try {
      parseDohResponse([1, 2, 3]);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("invalid-json");
    }
  });
});

describe("rrTypeName and describeStatus", () => {
  it("maps known and unknown codes", () => {
    expect(rrTypeName(15)).toBe("MX");
    expect(rrTypeName(9999)).toBe("TYPE9999");
    expect(describeStatus(0)).toBe("NOERROR (the query succeeded)");
    expect(describeStatus(2)).toBe(
      "SERVFAIL (the resolver failed, often a broken or unsigned DNSSEC chain)",
    );
    expect(describeStatus(5)).toBe("REFUSED (the resolver refused to answer)");
  });
});

describe("run with a domain name", () => {
  it("returns the query, resolver, and request URL", () => {
    const out = run("example.com", { type: "A", resolver: "cloudflare" });
    expect(out["Query"]).toBe("example.com A");
    expect(out["Resolver"]).toBe("Cloudflare");
    expect(out["Request URL"]).toBe(
      "https://cloudflare-dns.com/dns-query?name=example.com&type=A&ct=application%2Fdns-json",
    );
    expect(out["Note"]).toContain("example.com");
    expect(out["Reverse lookup"]).toBeUndefined();
  });

  it("defaults to the Cloudflare resolver and A record, and normalizes a pasted URL", () => {
    const out = run("https://www.Example.com/pricing", {});
    expect(out["Query"]).toBe("www.example.com A");
    expect(out["Resolver"]).toBe("Cloudflare");
  });

  it("uses the selected resolver and type", () => {
    const out = run("example.com", { type: "MX", resolver: "google" });
    expect(out["Query"]).toBe("example.com MX");
    expect(out["Resolver"]).toBe("Google");
    expect(out["Request URL"]).toBe("https://dns.google/resolve?name=example.com&type=MX");
  });
});

describe("run with an IP address", () => {
  it("forces PTR for an IPv4 address and notes the override", () => {
    const out = run("192.0.2.1", { type: "A" });
    expect(out["Query"]).toBe("1.2.0.192.in-addr.arpa PTR");
    expect(out["Reverse lookup"]).toContain("instead of the A record you selected");
  });

  it("forces PTR for an IPv6 address", () => {
    const out = run("2001:db8::1", { type: "TXT" });
    expect(out["Query"]).toBe(
      "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa PTR",
    );
    expect(out["Reverse lookup"]).toContain("instead of the TXT record you selected");
  });

  it("does not claim an override when PTR was already selected", () => {
    const out = run("192.0.2.1", { type: "PTR" });
    expect(out["Reverse lookup"]).not.toContain("instead of");
  });
});

describe("run with a pasted DoH JSON response", () => {
  it("renders one row per answer plus the status", () => {
    const out = run(JSON.stringify(GOOGLE_MX), {});
    expect(out["Status"]).toBe("NOERROR (the query succeeded)");
    expect(out["Query"]).toBe("example.com MX");
    expect(out["Answer 1 (MX)"]).toBe("example.com -> 10 mail.example.com. (TTL 300s)");
  });

  it("renders multiple TXT answers as separate rows", () => {
    const out = run(JSON.stringify(GOOGLE_TXT), {});
    expect(out["Answer 1 (TXT)"]).toContain("v=spf1");
    expect(out["Answer 2 (TXT)"]).toContain("google-site-verification");
  });

  it("explains NXDOMAIN in plain English with no answer rows", () => {
    const out = run(JSON.stringify(NXDOMAIN), {});
    expect(out["Status"]).toBe("NXDOMAIN (the domain does not exist)");
    expect(out["Answers"]).toContain("no records returned");
  });

  it("throws ToolError('invalid-json') on junk JSON", () => {
    try {
      run("{not valid json", {});
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("invalid-json");
    }
  });
});

describe("run error branches", () => {
  it("throws ToolError('empty-input') on blank input", () => {
    try {
      run("   ", {});
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("empty-input");
    }
  });

  it("throws ToolError('invalid-domain') on input that is neither a domain nor an IP", () => {
    try {
      run("not a domain!", {});
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("invalid-domain");
    }
  });

  it("throws ToolError('invalid-type') on a bad record type option", () => {
    try {
      run("example.com", { type: "BOGUS" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("invalid-type");
    }
  });

  it("throws ToolError('invalid-resolver') on a bad resolver option", () => {
    try {
      run("example.com", { resolver: "opendns" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("invalid-resolver");
    }
  });
});

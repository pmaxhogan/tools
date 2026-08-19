import { describe, expect, it } from "vitest";
import {
  RESOLVERS,
  answerSignature,
  buildAllQueryUrls,
  buildQueryUrl,
  compareAnswers,
  describeStatus,
  normalizeDomain,
  parseDohResponse,
  rrTypeName,
  run,
} from "./index";
import { ToolError } from "../types";

/** A realistic Google JSON DoH answer for example.com A. */
const GOOGLE_A = {
  Status: 0,
  TC: false,
  RD: true,
  RA: true,
  AD: false,
  CD: false,
  Question: [{ name: "example.com.", type: 1 }],
  Answer: [
    { name: "example.com.", type: 1, TTL: 300, data: "93.184.216.34" },
    { name: "example.com.", type: 1, TTL: 300, data: "93.184.216.35" },
  ],
};

/** Same record set, different TTLs (a different cache age). Should still agree. */
const CLOUDFLARE_A = {
  Status: 0,
  Answer: [
    { name: "example.com", type: 1, TTL: 42, data: "93.184.216.35" },
    { name: "example.com", type: 1, TTL: 42, data: "93.184.216.34" },
  ],
};

/** A stale cache still serving the old address. */
const QUAD9_STALE = {
  Status: 0,
  Answer: [{ name: "example.com", type: 1, TTL: 120, data: "198.51.100.7" }],
};

const NXDOMAIN = { Status: 3, Question: [{ name: "nope.example.com.", type: 1 }] };

describe("buildQueryUrl", () => {
  it("builds the Cloudflare A lookup with encoded params", () => {
    expect(buildQueryUrl("cloudflare", "example.com", "A")).toBe(
      "https://cloudflare-dns.com/dns-query?name=example.com&type=A&ct=application%2Fdns-json",
    );
  });

  it("omits the content type param for the Google JSON endpoint", () => {
    expect(buildQueryUrl("google", "EXAMPLE.com.", "txt")).toBe(
      "https://dns.google/resolve?name=example.com&type=TXT",
    );
  });

  it("accepts a resolver object and encodes underscore labels", () => {
    const quad9 = RESOLVERS.find((r) => r.id === "quad9")!;
    expect(buildQueryUrl(quad9, "_dmarc.example.com", "TXT")).toBe(
      "https://dns.quad9.net/dns-query?name=_dmarc.example.com&type=TXT&ct=application%2Fdns-json",
    );
  });

  it("builds one URL per resolver in order", () => {
    const urls = buildAllQueryUrls("example.com", "MX");
    expect(urls.map((u) => u.id)).toEqual(["cloudflare", "google", "quad9"]);
    expect(urls.every((u) => u.url.includes("type=MX"))).toBe(true);
  });

  it("throws ToolError on an invalid domain", () => {
    expect(() => buildQueryUrl("cloudflare", "not a domain!", "A")).toThrowError(ToolError);
    try {
      buildQueryUrl("cloudflare", "not a domain!", "A");
    } catch (err) {
      expect((err as ToolError).code).toBe("invalid-domain");
    }
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
      expect((err as ToolError).code).toBe("unknown-resolver");
    }
  });
});

describe("normalizeDomain", () => {
  it("strips protocol, path, port, and the trailing root dot", () => {
    expect(normalizeDomain("https://WWW.Example.com:8443/a/b?q=1")).toBe("www.example.com");
    expect(normalizeDomain("example.com.")).toBe("example.com");
  });
});

describe("parseDohResponse", () => {
  it("maps numeric types, TTLs, and the status code", () => {
    const parsed = parseDohResponse(GOOGLE_A);
    expect(parsed.statusCode).toBe("NOERROR");
    expect(parsed.status).toBe("NOERROR (the query succeeded)");
    expect(parsed.answers).toEqual([
      { name: "example.com", type: "A", ttl: 300, data: "93.184.216.34" },
      { name: "example.com", type: "A", ttl: 300, data: "93.184.216.35" },
    ]);
  });

  it("returns an empty answer list when there is no Answer array", () => {
    const parsed = parseDohResponse(NXDOMAIN);
    expect(parsed.statusCode).toBe("NXDOMAIN");
    expect(parsed.status).toBe("NXDOMAIN (the domain does not exist)");
    expect(parsed.answers).toEqual([]);
  });

  it("maps the less common RR types by number", () => {
    const parsed = parseDohResponse({
      Status: 0,
      Answer: [
        { name: "example.com.", type: 15, TTL: 60, data: "10 mail.example.com." },
        { name: "example.com.", type: 28, TTL: 60, data: "2606:2800:220:1:248:1893:25c8:1946" },
        { name: "example.com.", type: 257, TTL: 60, data: '0 issue "letsencrypt.org"' },
      ],
    });
    expect(parsed.answers.map((a) => a.type)).toEqual(["MX", "AAAA", "CAA"]);
  });

  it("accepts a JSON string and throws ToolError on junk", () => {
    expect(parseDohResponse(JSON.stringify(GOOGLE_A)).answers).toHaveLength(2);
    expect(() => parseDohResponse("not json")).toThrowError(ToolError);
    expect(() => parseDohResponse([1, 2, 3])).toThrowError(ToolError);
  });
});

describe("rrTypeName and describeStatus", () => {
  it("falls back to TYPEn and RCODEn for unknown numbers", () => {
    expect(rrTypeName(1)).toBe("A");
    expect(rrTypeName(9999)).toBe("TYPE9999");
    expect(describeStatus(2)).toBe(
      "SERVFAIL (the resolver failed, often a broken or unsigned DNSSEC chain)",
    );
    expect(describeStatus(77)).toBe("RCODE77");
  });
});

describe("compareAnswers", () => {
  it("agrees when every resolver returns the same data set", () => {
    const summary = compareAnswers([
      { id: "cloudflare", parsed: parseDohResponse(CLOUDFLARE_A) },
      { id: "google", parsed: parseDohResponse(GOOGLE_A) },
    ]);
    expect(summary.agree).toBe(true);
    expect(summary.record).toBe("93.184.216.34, 93.184.216.35");
    expect(summary.note).toContain("propagated");
  });

  it("disagrees when one resolver is still serving the old value", () => {
    const summary = compareAnswers([
      { id: "cloudflare", parsed: parseDohResponse(CLOUDFLARE_A) },
      { id: "google", parsed: parseDohResponse(GOOGLE_A) },
      { id: "quad9", parsed: parseDohResponse(QUAD9_STALE) },
    ]);
    expect(summary.agree).toBe(false);
    expect(summary.record).toContain("Quad9: 198.51.100.7");
    expect(summary.note).toContain("still propagating");
  });

  it("treats an NXDOMAIN and an empty NOERROR as different", () => {
    const summary = compareAnswers([
      { id: "cloudflare", parsed: parseDohResponse(NXDOMAIN) },
      { id: "google", parsed: parseDohResponse({ Status: 0 }) },
    ]);
    expect(summary.agree).toBe(false);
  });

  it("ignores TXT quoting and case when comparing", () => {
    const a = parseDohResponse({
      Status: 0,
      Answer: [{ name: "example.com.", type: 16, TTL: 60, data: '"v=spf1 -all"' }],
    });
    const b = parseDohResponse({
      Status: 0,
      Answer: [{ name: "example.com", type: 16, TTL: 900, data: "v=spf1 -all" }],
    });
    expect(answerSignature(a)).toBe(answerSignature(b));
    expect(
      compareAnswers([
        { id: "cloudflare", parsed: a },
        { id: "google", parsed: b },
      ]).agree,
    ).toBe(true);
  });

  it("handles no responses and a single response", () => {
    expect(compareAnswers([]).agree).toBe(false);
    const one = compareAnswers([{ id: "google", parsed: parseDohResponse(GOOGLE_A) }]);
    expect(one.agree).toBe(true);
    expect(one.note).toContain("nothing to compare");
  });
});

describe("run with a domain name", () => {
  it("returns the query and one request URL per resolver", () => {
    const out = run("example.com", { type: "A" });
    expect(out["Query"]).toBe("example.com A");
    expect(out["Cloudflare"]).toBe(
      "https://cloudflare-dns.com/dns-query?name=example.com&type=A&ct=application%2Fdns-json",
    );
    expect(out["Google"]).toBe("https://dns.google/resolve?name=example.com&type=A");
    expect(out["Quad9"]).toBe(
      "https://dns.quad9.net/dns-query?name=example.com&type=A&ct=application%2Fdns-json",
    );
    expect(out["Note"]).toContain("example.com");
  });

  it("defaults to A and normalizes a pasted URL", () => {
    const out = run("https://www.Example.com/pricing", {});
    expect(out["Query"]).toBe("www.example.com A");
  });

  it("throws ToolError on empty input", () => {
    try {
      run("   ", {});
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("empty-input");
      expect((err as ToolError).fix).toBe("Try example.com.");
    }
  });

  it("throws ToolError on an invalid record type option", () => {
    expect(() => run("example.com", { type: "BOGUS" })).toThrowError(ToolError);
  });
});

describe("run with a JSON bundle", () => {
  it("reports agreement when all three resolvers match", () => {
    const out = run(
      JSON.stringify({ cloudflare: CLOUDFLARE_A, google: GOOGLE_A, quad9: CLOUDFLARE_A }),
      {},
    );
    expect(out["Propagation"]).toBe("all resolvers agree");
    expect(out["Cloudflare"]).toBe("93.184.216.34 (A, TTL 42s); 93.184.216.35 (A, TTL 42s)");
    expect(out["Google"]).toContain("TTL 300s");
    expect(out["Summary"]).toContain("propagated");
  });

  it("reports a difference when one resolver is stale", () => {
    const out = run(
      JSON.stringify({ cloudflare: CLOUDFLARE_A, google: GOOGLE_A, quad9: QUAD9_STALE }),
      {},
    );
    expect(out["Propagation"]).toBe("answers differ (still propagating)");
    expect(out["Quad9"]).toBe("198.51.100.7 (A, TTL 120s)");
  });

  it("renders an NXDOMAIN row without answers", () => {
    const out = run(
      JSON.stringify({ cloudflare: NXDOMAIN, google: NXDOMAIN, quad9: NXDOMAIN }),
      {},
    );
    expect(out["Cloudflare"]).toBe("no records returned (NXDOMAIN (the domain does not exist))");
    expect(out["Propagation"]).toBe("all resolvers agree");
  });

  it("throws ToolError when the JSON object has no resolver responses", () => {
    try {
      run("{}", {});
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("empty-bundle");
    }
  });
});

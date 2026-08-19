import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { describeIp, formatEcho, parseQuery, run, type EchoRequest } from "./index";

const fixture: EchoRequest = {
  method: "POST",
  url: "https://tools.maxhogan.dev/api/echo?foo=bar&tag=a&tag=b",
  path: "/api/echo",
  query: { foo: "bar", tag: ["a", "b"] },
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer abcdef123456",
    Cookie: "session=xyz789abc",
    "X-Api-Key": "sk-test-1234",
    "X-Custom-Header": "hello world",
  },
  ip: "203.0.113.7",
  country: "US",
  city: "Chicago",
  asn: 15169,
  colo: "ORD",
  tlsVersion: "TLSv1.3",
  httpProtocol: "HTTP/2",
  userAgent: "curl/8.4.0",
  body: '{"hello":"world"}',
  bodyBytes: 18,
  timestamp: "2026-08-19T12:00:00.000Z",
};

describe("formatEcho - json format", () => {
  it("renders a parseable JSON string with the basics present", () => {
    const out = formatEcho(fixture, { format: "json" });
    expect(typeof out).toBe("string");
    const parsed = JSON.parse(out as string);
    expect(parsed.method).toBe("POST");
    expect(parsed.url).toBe(fixture.url);
    expect(parsed.path).toBe("/api/echo");
    expect(parsed.query).toEqual({ foo: "bar", tag: ["a", "b"] });
    expect(parsed.ip).toBe("203.0.113.7");
    expect(parsed.country).toBe("US");
    expect(parsed.bodyBytes).toBe(18);
    expect(parsed.timestamp).toBe("2026-08-19T12:00:00.000Z");
  });

  it("redacts sensitive headers in the JSON output", () => {
    const out = JSON.parse(formatEcho(fixture, { format: "json" }) as string);
    expect(out.headers["Authorization"]).toBe("<redacted, 19 chars>");
    expect(out.headers["Cookie"]).toBe("<redacted, 17 chars>");
    expect(out.headers["X-Api-Key"]).toBe("<redacted, 12 chars>");
    expect(out.headers["Content-Type"]).toBe("application/json");
    expect(out.headers["X-Custom-Header"]).toBe("hello world");
  });

  it("defaults to json when format is omitted", () => {
    const out = formatEcho(fixture, { format: "" });
    expect(() => JSON.parse(out as string)).not.toThrow();
  });
});

describe("formatEcho - text format", () => {
  it("renders readable lines with method, path, and IP", () => {
    const out = formatEcho(fixture, { format: "text" }) as string;
    expect(out).toContain("POST /api/echo");
    expect(out).toContain("URL: " + fixture.url);
    expect(out).toContain("IP: 203.0.113.7");
    expect(out).toContain("Chicago, US");
    expect(out).toContain("Timestamp: 2026-08-19T12:00:00.000Z");
  });

  it("includes the query section and body", () => {
    const out = formatEcho(fixture, { format: "text" }) as string;
    expect(out).toContain("Query:");
    expect(out).toContain("foo = bar");
    expect(out).toContain("tag = a, b");
    expect(out).toContain("Body (18 bytes):");
    expect(out).toContain('{"hello":"world"}');
  });

  it("redacts sensitive headers in text output and keeps normal ones", () => {
    const out = formatEcho(fixture, { format: "text" }) as string;
    expect(out).toContain("Authorization: <redacted, 19 chars>");
    expect(out).toContain("Cookie: <redacted, 17 chars>");
    expect(out).toContain("X-Api-Key: <redacted, 12 chars>");
    expect(out).toContain("X-Custom-Header: hello world");
    expect(out).not.toContain("Bearer abcdef123456");
    expect(out).not.toContain("session=xyz789abc");
  });

  it("accepts a format synonym", () => {
    const out = formatEcho(fixture, { format: "plain" }) as string;
    expect(out).toContain("POST /api/echo");
  });
});

describe("formatEcho - table format", () => {
  it("renders a Record with labeled rows", () => {
    const out = formatEcho(fixture, { format: "table" }) as Record<string, string>;
    expect(out["Method"]).toBe("POST");
    expect(out["Path"]).toBe("/api/echo");
    expect(out["Cloudflare colo"]).toBe("ORD");
    expect(out["TLS version"]).toBe("TLSv1.3");
    expect(out["HTTP protocol"]).toBe("HTTP/2");
    expect(out["Body bytes"]).toBe("18");
  });

  it("redacts sensitive headers as their own rows", () => {
    const out = formatEcho(fixture, { format: "table" }) as Record<string, string>;
    expect(out["Header: Authorization"]).toBe("<redacted, 19 chars>");
    expect(out["Header: Cookie"]).toBe("<redacted, 17 chars>");
    expect(out["Header: X-Api-Key"]).toBe("<redacted, 12 chars>");
    expect(out["Header: X-Custom-Header"]).toBe("hello world");
  });

  it("accepts a format synonym", () => {
    const out = formatEcho(fixture, { format: "rows" }) as Record<string, string>;
    expect(out["Method"]).toBe("POST");
  });
});

describe("redaction rules", () => {
  it("redacts by exact name regardless of case", () => {
    const out = formatEcho(
      {
        ...fixture,
        headers: { authorization: "secretvalue", COOKIE: "abc", "Set-Cookie": "session=zzz" },
      },
      { format: "table" },
    ) as Record<string, string>;
    expect(out["Header: authorization"]).toBe("<redacted, 11 chars>");
    expect(out["Header: COOKIE"]).toBe("<redacted, 3 chars>");
    expect(out["Header: Set-Cookie"]).toBe("<redacted, 11 chars>");
  });

  it("redacts headers whose name merely contains token, secret, or key", () => {
    const out = formatEcho(
      {
        ...fixture,
        headers: {
          "X-Auth-Token": "abcd",
          "X-Client-Secret": "abcde",
          "Api-Key": "abcdef",
          "Proxy-Authorization": "abcdefg",
        },
      },
      { format: "table" },
    ) as Record<string, string>;
    expect(out["Header: X-Auth-Token"]).toBe("<redacted, 4 chars>");
    expect(out["Header: X-Client-Secret"]).toBe("<redacted, 5 chars>");
    expect(out["Header: Api-Key"]).toBe("<redacted, 6 chars>");
    expect(out["Header: Proxy-Authorization"]).toBe("<redacted, 7 chars>");
  });

  it("never redacts an unrelated header", () => {
    const out = formatEcho(
      { ...fixture, headers: { "Accept-Language": "en-US", Host: "tools.maxhogan.dev" } },
      { format: "table" },
    ) as Record<string, string>;
    expect(out["Header: Accept-Language"]).toBe("en-US");
    expect(out["Header: Host"]).toBe("tools.maxhogan.dev");
  });
});

describe("run - empty input", () => {
  it("returns usage rows instead of an error", () => {
    const out = run("", { format: "json" }) as Record<string, string>;
    expect(out["Usage"]).toContain("curl https://tools.maxhogan.dev/api/echo");
    expect(out["Usage"]).toContain("curl -X POST -d");
    expect(out["Usage"]).toContain('curl -H "X-Foo: bar"');
    expect(out["Endpoint"]).toBe("https://tools.maxhogan.dev/api/echo");
  });

  it("treats whitespace-only input the same as empty", () => {
    const out = run("   \n  ", { format: "json" }) as Record<string, string>;
    expect(out["Endpoint"]).toBe("https://tools.maxhogan.dev/api/echo");
  });
});

describe("run - ToolErrors", () => {
  it("throws bad-json for non-empty non-JSON input", () => {
    try {
      run("not json at all {{{", { format: "json" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("bad-json");
    }
  });

  it("throws not-echo for valid JSON missing method and url", () => {
    try {
      run(JSON.stringify({ hello: "world" }), { format: "json" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("not-echo");
    }
  });

  it("throws not-echo for a JSON array", () => {
    try {
      run(JSON.stringify([1, 2, 3]), { format: "json" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("not-echo");
    }
  });
});

describe("run - valid echo JSON", () => {
  it("formats a full EchoRequest by default as json", () => {
    const out = run(JSON.stringify(fixture), { format: "json" }) as string;
    const parsed = JSON.parse(out);
    expect(parsed.method).toBe("POST");
    expect(parsed.headers["Authorization"]).toBe("<redacted, 19 chars>");
  });

  it("tolerates a minimal object with only method and url", () => {
    const out = run(JSON.stringify({ method: "GET", url: "https://example.com/" }), {
      format: "table",
    }) as Record<string, string>;
    expect(out["Method"]).toBe("GET");
    expect(out["URL"]).toBe("https://example.com/");
    expect(out["Path"]).toBe("");
  });
});

describe("parseQuery", () => {
  it("parses single-value params as strings", () => {
    expect(parseQuery("https://example.com/api/echo?foo=bar&baz=qux")).toEqual({
      foo: "bar",
      baz: "qux",
    });
  });

  it("parses repeated params as arrays", () => {
    expect(parseQuery("https://example.com/?tag=a&tag=b&tag=c")).toEqual({
      tag: ["a", "b", "c"],
    });
  });

  it("returns an empty object when there is no query string", () => {
    expect(parseQuery("https://example.com/api/echo")).toEqual({});
  });

  it("works on a relative URL with a query string", () => {
    expect(parseQuery("/api/echo?x=1")).toEqual({ x: "1" });
  });
});

describe("describeIp", () => {
  it("identifies a public IPv4 address", () => {
    expect(describeIp("203.0.113.7")).toBe("IPv4, public");
  });

  it("identifies a private IPv4 range", () => {
    expect(describeIp("10.0.0.5")).toContain("private");
    expect(describeIp("192.168.1.1")).toContain("private");
    expect(describeIp("172.16.0.1")).toContain("private");
  });

  it("identifies IPv4 loopback and link local", () => {
    expect(describeIp("127.0.0.1")).toContain("loopback");
    expect(describeIp("169.254.1.1")).toContain("link local");
  });

  it("identifies IPv6 loopback and link local", () => {
    expect(describeIp("::1")).toContain("loopback");
    expect(describeIp("fe80::1")).toContain("link local");
  });

  it("identifies a public IPv6 address", () => {
    expect(describeIp("2606:4700:4700::1111")).toBe("IPv6, public");
  });

  it("handles an empty string", () => {
    expect(describeIp("")).toBe("no IP address given");
  });

  it("flags an invalid IPv4 address", () => {
    expect(describeIp("999.1.1.1")).toBe("not a valid IPv4 address");
  });
});

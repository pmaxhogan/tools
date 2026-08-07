import { describe, expect, it } from "vitest";
import {
  filterEntries,
  listSensitive,
  parseHar,
  renderWaterfall,
  run,
  sanitizeHar,
  summarize,
  type HarOpts,
} from "./index";
import { ToolError } from "../types";

const base: HarOpts = { view: "summary", filter: "", status: "all", minMs: 0 };
const o = (patch: Partial<HarOpts> = {}): HarOpts => ({ ...base, ...patch });

/* ------------------------------------------------------------------ */
/* fixture: 6 entries, 2 domains, one 404, one 2 s wait                */
/* ------------------------------------------------------------------ */

interface FixtureEntry {
  start: number;
  time: number;
  method?: string;
  url: string;
  status: number;
  statusText?: string;
  mimeType: string;
  size: number;
  bodySize: number;
  requestHeaders?: { name: string; value: string }[];
  responseHeaders?: { name: string; value: string }[];
  cookies?: { name: string; value: string }[];
  responseCookies?: { name: string; value: string }[];
  queryString?: { name: string; value: string }[];
  postData?: { mimeType: string; text?: string; params?: { name: string; value: string }[] };
  text?: string;
  timings?: Record<string, number>;
}

const T0 = Date.parse("2026-03-01T10:00:00.000Z");

function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

const FIXTURE_ENTRIES: FixtureEntry[] = [
  {
    start: 0,
    time: 120,
    url: "https://shop.example.com/",
    status: 200,
    statusText: "OK",
    mimeType: "text/html; charset=utf-8",
    size: 5000,
    bodySize: 1800,
    requestHeaders: [
      { name: "Host", value: "shop.example.com" },
      { name: "Cookie", value: "sid=abc123; theme=dark" },
    ],
    responseHeaders: [
      { name: "Content-Type", value: "text/html" },
      { name: "Set-Cookie", value: "sid=abc123; HttpOnly" },
    ],
    cookies: [
      { name: "sid", value: "abc123" },
      { name: "theme", value: "dark" },
    ],
    responseCookies: [{ name: "sid", value: "abc123" }],
    text: "<html>hello</html>",
    timings: { blocked: 1, dns: 9, connect: 20, ssl: 12, send: 1, wait: 80, receive: 9 },
  },
  {
    start: 140,
    time: 60,
    url: "https://shop.example.com/app.js",
    status: 200,
    mimeType: "application/javascript",
    size: 90000,
    bodySize: 32000,
    requestHeaders: [{ name: "Accept", value: "*/*" }],
    timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 1, wait: 40, receive: 19 },
  },
  {
    start: 150,
    time: 45,
    url: "https://shop.example.com/missing.png",
    status: 404,
    statusText: "Not Found",
    mimeType: "text/html",
    size: 300,
    bodySize: 300,
    timings: { blocked: 0, dns: 0, connect: 0, ssl: -1, send: 1, wait: 40, receive: 4 },
  },
  {
    start: 200,
    time: 2000,
    method: "POST",
    url: "https://api.metrics.test/v1/collect?session=zzz&debug=1",
    status: 200,
    mimeType: "application/json",
    size: 40,
    bodySize: 40,
    requestHeaders: [
      { name: "Authorization", value: "Bearer eyJraddishSECRET" },
      { name: "Content-Type", value: "application/json" },
    ],
    queryString: [
      { name: "session", value: "zzz" },
      { name: "debug", value: "1" },
    ],
    postData: { mimeType: "application/json", text: '{"user":"max","password":"hunter2"}' },
    timings: { blocked: 0, dns: 5, connect: 10, ssl: 5, send: 1, wait: 1900, receive: 84 },
  },
  {
    start: 260,
    time: 90,
    method: "POST",
    url: "https://api.metrics.test/v1/login",
    status: 302,
    mimeType: "text/plain",
    size: 0,
    bodySize: -1,
    requestHeaders: [{ name: "Proxy-Authorization", value: "Basic Zm9vOmJhcg==" }],
    postData: {
      mimeType: "application/x-www-form-urlencoded",
      params: [
        { name: "user", value: "max" },
        { name: "password", value: "hunter2" },
      ],
    },
    timings: { blocked: 0, dns: 0, connect: 0, ssl: 0, send: 1, wait: 80, receive: 9 },
  },
  {
    start: 400,
    time: 500,
    url: "https://shop.example.com/hero.jpg",
    status: 500,
    statusText: "Server Error",
    mimeType: "image/jpeg",
    size: 250000,
    bodySize: 250000,
    timings: { blocked: 2, dns: 0, connect: 0, ssl: -1, send: 1, wait: 100, receive: 397 },
  },
];

function buildHar(entries: FixtureEntry[] = FIXTURE_ENTRIES): string {
  return JSON.stringify({
    log: {
      version: "1.2",
      creator: { name: "Fixture", version: "1.0" },
      pages: [{ id: "page_1", title: "https://shop.example.com/", startedDateTime: iso(0) }],
      entries: entries.map((e) => ({
        pageref: "page_1",
        startedDateTime: iso(e.start),
        time: e.time,
        request: {
          method: e.method ?? "GET",
          url: e.url,
          httpVersion: "HTTP/2",
          headers: e.requestHeaders ?? [],
          cookies: e.cookies ?? [],
          queryString: e.queryString ?? [],
          headersSize: -1,
          bodySize: -1,
          ...(e.postData ? { postData: e.postData } : {}),
        },
        response: {
          status: e.status,
          statusText: e.statusText ?? "",
          httpVersion: "HTTP/2",
          headers: e.responseHeaders ?? [],
          cookies: e.responseCookies ?? [],
          content: {
            size: e.size,
            mimeType: e.mimeType,
            ...(e.text ? { text: e.text } : {}),
          },
          redirectURL: "",
          headersSize: -1,
          bodySize: e.bodySize,
        },
        cache: {},
        timings: e.timings ?? { send: 0, wait: e.time, receive: 0 },
      })),
    },
  });
}

const HAR = buildHar();

/* ------------------------------------------------------------------ */

describe("har-viewer parseHar", () => {
  it("parses entries, pages and derived fields", () => {
    const model = parseHar(HAR);
    expect(model.entries).toHaveLength(6);
    expect(model.pages).toEqual([
      { id: "page_1", title: "https://shop.example.com/", startedDateTime: iso(0) },
    ]);
    expect(model.creator).toBe("Fixture 1.0");

    const first = model.entries[0]!;
    expect(first.request.method).toBe("GET");
    expect(first.host).toBe("shop.example.com");
    expect(first.startMs).toBe(0);
    expect(first.bytes).toBe(1800);
    expect(first.response.content.mimeType).toBe("text/html; charset=utf-8");
    expect(first.request.cookies).toHaveLength(2);

    // Offsets are relative to the first request, not absolute timestamps.
    expect(model.entries[3]!.startMs).toBe(200);
    expect(model.entries[5]!.startMs).toBe(400);
  });

  it('clamps the -1 "not applicable" timings to zero', () => {
    const model = parseHar(HAR);
    expect(model.entries[1]!.timings).toEqual({
      blocked: 0,
      dns: 0,
      connect: 0,
      ssl: 0,
      send: 1,
      wait: 40,
      receive: 19,
    });
  });

  it("falls back to the uncompressed size when bodySize is -1", () => {
    const model = parseHar(HAR);
    // bodySize -1 and content.size 0 means nothing measurable was transferred.
    expect(model.entries[4]!.bytes).toBe(0);
  });

  it("throws on empty input", () => {
    expect(() => parseHar("   ")).toThrow(ToolError);
    try {
      parseHar("");
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("throws invalid-har on broken JSON", () => {
    try {
      parseHar("{ not json");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("invalid-har");
    }
  });

  it("throws invalid-har when log.entries is missing", () => {
    try {
      parseHar('{"log":{"version":"1.2"}}');
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-har");
      expect((e as ToolError).message).toContain("log.entries");
    }
  });
});

describe("har-viewer summarize", () => {
  const s = summarize(parseHar(HAR).entries);

  it("counts requests and bytes", () => {
    expect(s.requests).toBe(6);
    // 1800 + 32000 + 300 + 40 + 0 + 250000
    expect(s.transferred).toBe(284140);
    // 5000 + 90000 + 300 + 40 + 0 + 250000
    expect(s.contentBytes).toBe(345340);
  });

  it("measures the capture span from the last request to finish", () => {
    // The 2 s POST starts at 200 ms, so it ends at 2200 ms, later than anything else.
    expect(s.spanMs).toBe(2200);
    expect(s.totalTimeMs).toBe(120 + 60 + 45 + 2000 + 90 + 500);
  });

  it("buckets by status class", () => {
    expect(s.byStatus).toEqual([
      { key: "2xx", count: 3 },
      { key: "3xx", count: 1 },
      { key: "4xx", count: 1 },
      { key: "5xx", count: 1 },
    ]);
  });

  it("buckets by MIME type", () => {
    const map = Object.fromEntries(s.byMime.map((b) => [b.key, b.count]));
    expect(map["text/html"]).toBe(2);
    expect(map["application/javascript"]).toBe(1);
    expect(map["application/json"]).toBe(1);
    expect(map["image/jpeg"]).toBe(1);
    expect(map["text/plain"]).toBe(1);
  });

  it("ranks the slowest and largest", () => {
    expect(s.slowest[0]!.time).toBe(2000);
    expect(s.slowest[1]!.time).toBe(500);
    expect(s.largest[0]!.bytes).toBe(250000);
    expect(s.largest[1]!.bytes).toBe(32000);
    expect(s.slowest).toHaveLength(6);
  });

  it("lists domains with counts and computes the third party share", () => {
    expect(s.domains).toEqual([
      { host: "shop.example.com", count: 4, bytes: 1800 + 32000 + 300 + 250000 },
      { host: "api.metrics.test", count: 2, bytes: 40 },
    ]);
    expect(s.primaryHost).toBe("shop.example.com");
    expect(s.thirdPartyRequests).toBe(2);
    expect(s.thirdPartyShare).toBeCloseTo(2 / 6, 6);
  });

  it("handles an empty entry list", () => {
    const empty = summarize([]);
    expect(empty.requests).toBe(0);
    expect(empty.spanMs).toBe(0);
    expect(empty.thirdPartyShare).toBe(0);
  });
});

describe("har-viewer filterEntries", () => {
  const entries = parseHar(HAR).entries;

  it("matches a substring of the URL", () => {
    expect(filterEntries(entries, { filter: "metrics" })).toHaveLength(2);
    expect(filterEntries(entries, { filter: "METRICS" })).toHaveLength(2);
  });

  it("filters by status class", () => {
    expect(filterEntries(entries, { status: "4xx" })).toHaveLength(1);
    expect(filterEntries(entries, { status: "2xx" })).toHaveLength(3);
    expect(filterEntries(entries, { status: "all" })).toHaveLength(6);
  });

  it("filters by MIME type and minimum duration", () => {
    expect(filterEntries(entries, { mime: "image/" })).toHaveLength(1);
    expect(filterEntries(entries, { minMs: 100 })).toHaveLength(3);
    expect(filterEntries(entries, { minMs: 1000 })).toHaveLength(1);
  });

  it("combines filters", () => {
    expect(filterEntries(entries, { filter: "shop", status: "2xx", minMs: 100 })).toHaveLength(1);
  });
});

describe("har-viewer renderWaterfall", () => {
  const entries = parseHar(HAR).entries;

  it("draws one bar per request with phase characters", () => {
    const out = renderWaterfall(entries, { width: 160 });
    const rows = out.split("\n").filter((l) => l.startsWith("GET") || l.startsWith("POST"));
    expect(rows).toHaveLength(6);
    expect(out).toContain("Timeline 0 to");
    expect(out).toMatch(/[░▒▓█]/);
    // The long POST is dominated by wait, so its bar is mostly the wait char.
    const slow = rows.find((l) => l.includes("collect"))!;
    expect(slow.split("▓").length - 1).toBeGreaterThan(10);
  });

  it("indents later requests along the capture timeline", () => {
    const out = renderWaterfall(entries, { width: 160 });
    const rows = out.split("\n").filter((l) => l.startsWith("GET") || l.startsWith("POST"));
    const barStart = (row: string) => row.length - row.trimEnd().length + row.search(/[░▒▓█]/);
    // The first request begins at offset 0 of the timeline, the last one later.
    expect(barStart(rows[0]!)).toBeLessThan(barStart(rows[5]!));
  });

  it("respects the URL filter, the status filter and minMs", () => {
    const filtered = renderWaterfall(entries, { width: 160, filter: "metrics" });
    expect(filtered).toContain("collect");
    expect(filtered).not.toContain("hero.jpg");

    const notFound = renderWaterfall(entries, { width: 160, status: "4xx" });
    expect(notFound).toContain("missing.png");
    expect(notFound).not.toContain("app.js");

    const slow = renderWaterfall(entries, { width: 160, minMs: 1000 });
    const rows = slow.split("\n").filter((l) => l.startsWith("GET") || l.startsWith("POST"));
    expect(rows).toHaveLength(1);
  });

  it("reports when nothing matches", () => {
    expect(renderWaterfall(entries, { filter: "nothing-here" })).toBe(
      "No requests match these filters.",
    );
  });

  it("survives a zero length capture without dividing by zero", () => {
    const flat = parseHar(
      buildHar([
        {
          start: 0,
          time: 0,
          url: "https://a.test/",
          status: 200,
          mimeType: "text/html",
          size: 0,
          bodySize: 0,
        },
        {
          start: 0,
          time: 0,
          url: "https://a.test/b",
          status: 200,
          mimeType: "text/html",
          size: 0,
          bodySize: 0,
        },
      ]),
    );
    const out = renderWaterfall(flat.entries, { width: 80 });
    expect(out).toContain("a.test/b");
    expect(out).not.toContain("NaN");
  });
});

describe("har-viewer sanitizeHar", () => {
  it("removes every credential from the exported copy", () => {
    const model = parseHar(HAR);
    const sanitized = sanitizeHar(model) as {
      log: { entries: Record<string, never>[] };
    };
    const text = JSON.stringify(sanitized);

    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("eyJraddishSECRET");
    expect(text).not.toContain("Zm9vOmJhcg==");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("<html>hello</html>");
    expect(text).not.toContain("session=zzz");
  });

  it("empties cookie arrays and redacts sensitive headers by exact marker", () => {
    const model = parseHar(HAR);
    const sanitized = sanitizeHar(model) as {
      log: {
        entries: {
          request: {
            url: string;
            cookies: unknown[];
            headers: { name: string; value: string }[];
            queryString: { name: string; value: string }[];
            postData?: { text?: string; params?: { name: string; value: string }[] };
          };
          response: {
            cookies: unknown[];
            headers: { name: string; value: string }[];
            content: { text?: string; size: number };
          };
        }[];
      };
    };
    const entries = sanitized.log.entries;

    expect(entries[0]!.request.cookies).toEqual([]);
    expect(entries[0]!.response.cookies).toEqual([]);
    expect(entries[0]!.request.headers.find((h) => h.name === "Cookie")!.value).toBe("[redacted]");
    expect(entries[0]!.response.headers.find((h) => h.name === "Set-Cookie")!.value).toBe(
      "[redacted]",
    );
    expect(entries[0]!.response.content.text).toBeUndefined();
    // Untouched fields survive the round trip.
    expect(entries[0]!.response.content.size).toBe(5000);
    expect(entries[0]!.request.headers.find((h) => h.name === "Host")!.value).toBe(
      "shop.example.com",
    );

    expect(entries[3]!.request.headers.find((h) => h.name === "Authorization")!.value).toBe(
      "[redacted]",
    );
    expect(entries[3]!.request.queryString.find((q) => q.name === "session")!.value).toBe(
      "[redacted]",
    );
    expect(entries[3]!.request.queryString.find((q) => q.name === "debug")!.value).toBe("1");
    expect(entries[3]!.request.url).toContain("session=[redacted]");
    expect(entries[3]!.request.url).toContain("debug=1");
    expect(entries[3]!.request.postData!.text).toBe("[redacted 35 bytes]");

    expect(entries[4]!.request.headers.find((h) => h.name === "Proxy-Authorization")!.value).toBe(
      "[redacted]",
    );
    expect(entries[4]!.request.postData!.params).toEqual([
      { name: "user", value: "[redacted]" },
      { name: "password", value: "[redacted]" },
    ]);
  });

  it("matches header names case insensitively", () => {
    const model = parseHar(
      buildHar([
        {
          start: 0,
          time: 10,
          url: "https://a.test/",
          status: 200,
          mimeType: "text/html",
          size: 1,
          bodySize: 1,
          requestHeaders: [{ name: "authorization", value: "Bearer lowercase" }],
          responseHeaders: [{ name: "set-cookie", value: "sid=nope" }],
        },
      ]),
    );
    expect(JSON.stringify(sanitizeHar(model))).not.toContain("Bearer");
    expect(JSON.stringify(sanitizeHar(model))).not.toContain("sid=nope");
  });

  it("never mutates the model it was given", () => {
    const model = parseHar(HAR);
    const before = JSON.stringify(model.raw);
    sanitizeHar(model);
    expect(JSON.stringify(model.raw)).toBe(before);
    expect(model.entries[0]!.request.cookies).toHaveLength(2);
    expect(model.entries[3]!.request.headers[0]!.value).toContain("Bearer");
  });
});

describe("har-viewer listSensitive", () => {
  it("counts each category", () => {
    const report = listSensitive(parseHar(HAR));
    // 2 request cookies + 1 response cookie on the first entry.
    expect(report.cookies).toBe(3);
    // Cookie on the request, Set-Cookie on the response.
    expect(report.cookieHeaders).toBe(2);
    // Authorization and Proxy-Authorization.
    expect(report.authHeaders).toBe(2);
    // The JSON body and the form post.
    expect(report.requestBodies).toBe(2);
    // "session" is credential shaped, "debug" is not.
    expect(report.queryParams).toBe(1);
    expect(report.responseBodies).toBe(1);
    expect(report.responseBodyChars).toBe("<html>hello</html>".length);
    expect(report.entries).toBe(3);
    expect(report.total).toBe(3 + 2 + 2 + 2 + 1 + 1);
  });

  it("reports zero for a clean capture", () => {
    const clean = parseHar(
      buildHar([
        {
          start: 0,
          time: 10,
          url: "https://a.test/logo.svg",
          status: 200,
          mimeType: "image/svg+xml",
          size: 100,
          bodySize: 100,
          requestHeaders: [{ name: "Accept", value: "*/*" }],
        },
      ]),
    );
    const report = listSensitive(clean);
    expect(report.total).toBe(0);
    expect(report.entries).toBe(0);
  });

  it("finds credentials hidden in a URL with no queryString array", () => {
    const model = parseHar(
      buildHar([
        {
          start: 0,
          time: 10,
          url: "https://a.test/cb?code=xyz&state=1",
          status: 200,
          mimeType: "text/html",
          size: 1,
          bodySize: 1,
        },
      ]),
    );
    expect(listSensitive(model).queryParams).toBe(1);
    expect(JSON.stringify(sanitizeHar(model))).not.toContain("code=xyz");
  });
});

describe("har-viewer run", () => {
  it("renders the summary, a waterfall and the sensitive section", () => {
    const out = run(HAR, o());
    expect(out).toContain("Capture summary");
    expect(out).toContain("Requests: 6");
    expect(out).toContain("Domains: 2");
    expect(out).toContain("Third party: 2 of 6 requests (33%)");
    expect(out).toContain("Phases:");
    expect(out).toContain("Sensitive content");
    expect(out).toContain("Authorization headers: 2");
    expect(out).toContain("Download sanitized copy");
  });

  it("switches views", () => {
    expect(run(HAR, o({ view: "slowest" }))).toContain("Slowest requests");
    expect(run(HAR, o({ view: "largest" }))).toContain("Largest responses");

    const domains = run(HAR, o({ view: "domains" }));
    expect(domains).toContain("shop.example.com");
    expect(domains).toContain("third party");

    const waterfall = run(HAR, o({ view: "waterfall" }));
    expect(waterfall).toContain("Timeline 0 to");
  });

  it("applies the options to the summary as well as the rows", () => {
    const out = run(HAR, o({ status: "4xx" }));
    expect(out).toContain("Requests: 1");
    expect(out).toContain("missing.png");
    expect(out).not.toContain("hero.jpg");
  });

  it("respects minMs", () => {
    const out = run(HAR, o({ view: "slowest", minMs: 1000 }));
    expect(out).toContain("Requests: 1");
    expect(out).toContain("collect");
  });

  it("says so when a capture has no credentials in it", () => {
    const clean = buildHar([
      {
        start: 0,
        time: 10,
        url: "https://a.test/logo.svg",
        status: 200,
        mimeType: "image/svg+xml",
        size: 100,
        bodySize: 100,
      },
    ]);
    expect(run(clean, o())).toContain("Nothing that looks like a credential");
  });

  it("throws for empty and invalid input", () => {
    expect(() => run("", o())).toThrow(ToolError);
    expect(() => run("[]", o())).toThrow(ToolError);
  });
});

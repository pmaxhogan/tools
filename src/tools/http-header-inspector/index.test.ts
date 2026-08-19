import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { analyzeHeaders, parseAcceptLanguage, parseHeaderText, run, summarizeUserAgent } from "./index";

const CHROME_HEADERS: [string, string][] = [
  ["host", "example.com"],
  [
    "user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  ],
  ["accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"],
  ["accept-language", "en-US,en;q=0.9"],
  ["accept-encoding", "gzip, deflate, br"],
  ["sec-ch-ua", '"Chromium";v="125", "Not.A/Brand";v="24", "Google Chrome";v="125"'],
  ["sec-ch-ua-mobile", "?0"],
  ["sec-ch-ua-platform", '"Windows"'],
  ["sec-fetch-site", "none"],
  ["sec-fetch-mode", "navigate"],
  ["sec-fetch-dest", "document"],
  ["sec-fetch-user", "?1"],
  ["upgrade-insecure-requests", "1"],
  ["cookie", "session=abc123; theme=dark"],
  ["dnt", "1"],
];

const CHROME_HEADER_TEXT = CHROME_HEADERS.map(([name, value]) => `${name}: ${value}`).join("\n");

describe("parseHeaderText", () => {
  it("parses a curl -v transcript, tolerating '> ' prefixes and the request line", () => {
    const transcript = [
      "* Trying 93.184.216.34:443...",
      "* Connected to example.com (93.184.216.34) port 443",
      "> GET / HTTP/1.1",
      "> Host: example.com",
      "> user-agent: curl/8.4.0",
      "> Accept: */*",
      ">",
      "< HTTP/1.1 200 OK",
      "< content-type: text/html",
    ].join("\n");

    const pairs = parseHeaderText(transcript);

    expect(pairs).toEqual([
      ["host", "example.com"],
      ["user-agent", "curl/8.4.0"],
      ["accept", "*/*"],
      ["content-type", "text/html"],
    ]);
  });

  it("parses a JSON object of headers, normalizing names to lowercase and keeping order", () => {
    const json = '{"User-Agent": "curl/8.4.0", "Accept": "*/*", "X-Custom": "42"}';

    const pairs = parseHeaderText(json);

    expect(pairs).toEqual([
      ["user-agent", "curl/8.4.0"],
      ["accept", "*/*"],
      ["x-custom", "42"],
    ]);
  });

  it("parses plain 'Name: value' lines with no curl framing", () => {
    const pairs = parseHeaderText("Host: example.com\nAccept-Language: en-US,en;q=0.9\n");

    expect(pairs).toEqual([
      ["host", "example.com"],
      ["accept-language", "en-US,en;q=0.9"],
    ]);
  });

  it("returns an empty array for text with no header-shaped lines and no JSON object", () => {
    expect(parseHeaderText("just some prose about headers, no colons here")).toEqual([]);
    expect(parseHeaderText("")).toEqual([]);
    expect(parseHeaderText("   \n  ")).toEqual([]);
  });

  it("returns an empty array for a JSON value that is not an object (e.g. an array)", () => {
    expect(parseHeaderText('["not", "an", "object"]')).toEqual([]);
  });
});

describe("parseAcceptLanguage", () => {
  it("formats tags to readable locale names, most preferred first", () => {
    expect(parseAcceptLanguage("en-US,en;q=0.9")).toBe("English (United States), English");
  });

  it("honors explicit q values over textual order", () => {
    expect(parseAcceptLanguage("fr;q=0.5, de;q=0.9")).toBe("German, French");
  });

  it("falls back to the raw tag for an unrecognized language or region code", () => {
    expect(parseAcceptLanguage("xx-ZZ")).toBe("xx-ZZ (xx-ZZ)");
  });
});

describe("summarizeUserAgent", () => {
  it("identifies a common Chrome-on-Windows string", () => {
    const summary = summarizeUserAgent(CHROME_HEADERS[1][1]);
    expect(summary).toContain("Chrome on Windows");
    expect(summary).toContain("User-Agent Parser tool");
  });

  it("reports not sent for an empty string", () => {
    expect(summarizeUserAgent("")).toBe("not sent.");
  });
});

describe("analyzeHeaders", () => {
  const rows = analyzeHeaders(CHROME_HEADERS);

  it("explains a known header with its privacy tag", () => {
    expect(rows["User-Agent"]).toContain(CHROME_HEADERS[1][1]);
    expect(rows["User-Agent"]).toContain("Identifies the browser");
    expect(rows["User-Agent"]).toContain("[privacy: medium]");
  });

  it("explains a Sec-CH-UA client hint", () => {
    expect(rows["Sec-CH-UA"]).toContain("Client Hints");
    expect(rows["Sec-CH-UA"]).toContain("[privacy: medium]");
  });

  it("redacts the Cookie value to its length instead of showing it", () => {
    const cookieValue = "session=abc123; theme=dark";
    expect(rows.Cookie).not.toContain(cookieValue);
    expect(rows.Cookie).toContain(`(redacted, ${cookieValue.length} characters)`);
    expect(rows.Cookie).toContain("[privacy: high]");
  });

  it("marks an unrecognized header with the no-description fallback", () => {
    const withUnknown = analyzeHeaders([...CHROME_HEADERS, ["x-totally-made-up", "value"]]);
    expect(withUnknown["X-Totally-Made-Up"]).toBe("value [(no description)]");
  });

  it("builds a Summary row with counts, client hints, DNT, Accept-Language, and User-Agent", () => {
    const summary = rows.Summary;
    expect(summary).toContain(`${CHROME_HEADERS.length} headers`);
    expect(summary).toContain("1 high-privacy, 5 medium-privacy, and 9 low-privacy");
    expect(summary).toContain("Client Hints are on");
    expect(summary).toContain("Do Not Track is on");
    expect(summary).toContain("English (United States), English");
    expect(summary).toContain("Chrome on Windows");
  });

  it("accepts a Record<string,string> as well as an array of pairs", () => {
    const asRecord = Object.fromEntries(CHROME_HEADERS);
    const fromRecord = analyzeHeaders(asRecord);
    expect(fromRecord["User-Agent"]).toBe(rows["User-Agent"]);
  });
});

describe("run", () => {
  it("returns an explained report by default", () => {
    const result = run(CHROME_HEADER_TEXT, { view: "explained" });
    expect(typeof result).toBe("object");
    const rows = result as Record<string, string>;
    expect(rows["User-Agent"]).toContain("Identifies the browser");
    expect(rows.Summary).toContain("Client Hints are on");
  });

  it("returns raw unexplained values when view is raw, including cookie in full", () => {
    const result = run(CHROME_HEADER_TEXT, { view: "raw" }) as Record<string, string>;
    expect(result["User-Agent"]).toBe(CHROME_HEADERS[1][1]);
    expect(result.Cookie).toBe("session=abc123; theme=dark");
    expect(result.Summary).toBeUndefined();
  });

  it("accepts a view synonym ('values only' for raw)", () => {
    const result = run(CHROME_HEADER_TEXT, { view: "values only" }) as Record<string, string>;
    expect(result["User-Agent"]).toBe(CHROME_HEADERS[1][1]);
  });

  it("produces a curl command with one -H per header, omitting Cookie with a comment", () => {
    const result = run(CHROME_HEADER_TEXT, { view: "curl" });
    expect(typeof result).toBe("string");
    const curl = result as string;

    expect(curl).toContain('curl \\');
    expect(curl).toContain('-H "User-Agent: ' + CHROME_HEADERS[1][1] + '" \\');
    expect(curl).toContain('-H "DNT: 1" \\');
    expect(curl).toContain('"https://example.com/"');
    expect(curl).not.toContain("session=abc123");
    expect(curl).not.toContain('-H "Cookie:');
    expect(curl).not.toContain('-H "Host:');
    expect(curl.toLowerCase()).toContain("cookie header omitted");
  });

  it("returns a Note with a fetch hint and example curl command for empty input", () => {
    const result = run("", { view: "explained" }) as Record<string, string>;
    expect(result.Note).toContain("Show my headers");
    expect(result.Example).toContain("curl");

    const resultWhitespace = run("   \n  ", { view: "explained" }) as Record<string, string>;
    expect(resultWhitespace.Note).toBeDefined();
  });

  it("throws a bad-input ToolError for text that is neither header lines nor JSON", () => {
    expect(() => run("just some prose about headers, no colons here", { view: "explained" })).toThrow(
      ToolError,
    );
    try {
      run("just some prose about headers, no colons here", { view: "explained" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("bad-input");
    }
  });
});

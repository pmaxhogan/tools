import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  detectFormat,
  detectLevel,
  durationToMs,
  formatDuration,
  isoUtc,
  maskAddress,
  parseClfTime,
  parseIsoTime,
  run,
} from "./index";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const COMBINED = [
  '203.0.113.14 - - [30/Aug/2026:06:00:00 +0000] "GET / HTTP/1.1" 200 5120 "-" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0" 0.031',
  '203.0.113.14 - - [30/Aug/2026:06:00:12 +0000] "GET /styles.css HTTP/1.1" 200 2048 "https://example.com/" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0" 0.008',
  '198.51.100.23 - - [30/Aug/2026:06:05:00 +0000] "GET /missing HTTP/1.1" 404 310 "-" "curl/8.7.1" 0.004',
  '198.51.100.23 - - [30/Aug/2026:06:30:00 +0000] "POST /api/report HTTP/1.1" 500 512 "-" "curl/8.7.1" 4.250',
  '192.0.2.7 - - [30/Aug/2026:07:00:00 +0000] "GET /search?q=alpha HTTP/1.1" 200 900 "-" "curl/8.7.1" 0.120',
  '192.0.2.7 - - [30/Aug/2026:07:00:30 +0000] "GET /search?q=beta HTTP/1.1" 200 950 "-" "curl/8.7.1" 0.130',
].join("\n");

const COMMON = [
  '203.0.113.14 - frank [30/Aug/2026:06:00:00 +0000] "GET /index.html HTTP/1.0" 200 2326',
  '203.0.113.14 - frank [30/Aug/2026:06:01:00 +0000] "GET /logo.png HTTP/1.0" 200 4096',
  '198.51.100.9 - - [30/Aug/2026:06:02:00 +0000] "GET /nope HTTP/1.0" 404 199',
].join("\n");

const JSON_LINES = [
  '{"timestamp":"2026-08-30T06:00:00Z","level":"info","method":"GET","path":"/health","status":200,"bytes":15,"duration_ms":3,"remote_addr":"203.0.113.14","user_agent":"kube-probe/1.30"}',
  '{"timestamp":"2026-08-30T06:00:30Z","level":"info","method":"GET","path":"/users","status":200,"bytes":4096,"duration_ms":42,"remote_addr":"198.51.100.23","user_agent":"curl/8.7.1"}',
  '{"timestamp":"2026-08-30T06:01:00Z","level":"error","method":"POST","path":"/users","status":500,"bytes":210,"duration_ms":1900,"remote_addr":"198.51.100.23","user_agent":"curl/8.7.1","message":"database connection refused"}',
].join("\n");

const TIMESTAMPED = [
  "2026-08-30T06:00:00.100Z INFO  worker started with 4 threads",
  "2026-08-30T06:00:01.250Z DEBUG picked up job 8812",
  "2026-08-30T06:04:11.000Z ERROR job 8812 failed: connection reset by peer",
  "2026-08-30T06:04:11.010Z WARN  retrying job 8812 in 30s",
].join("\n");

const SYSLOG = [
  "Aug 30 06:00:00 host sshd[2211]: Accepted publickey for deploy from 203.0.113.14",
  "Aug 30 06:04:00 host sshd[2213]: Connection closed by 198.51.100.23",
].join("\n");

/* ------------------------------------------------------------------ */
/* timestamp helpers                                                   */
/* ------------------------------------------------------------------ */

describe("parseClfTime", () => {
  it("reads a bracketed common log timestamp as UTC", () => {
    expect(parseClfTime("30/Aug/2026:06:00:00 +0000")).toBe(Date.UTC(2026, 7, 30, 6, 0, 0));
  });

  it("subtracts a positive zone offset and adds a negative one", () => {
    // 13:55:36 at -0700 is 20:55:36 UTC.
    expect(parseClfTime("10/Oct/2000:13:55:36 -0700")).toBe(Date.UTC(2000, 9, 10, 20, 55, 36));
    expect(parseClfTime("10/Oct/2000:13:55:36 +0200")).toBe(Date.UTC(2000, 9, 10, 11, 55, 36));
  });

  it("rejects anything that is not a common log timestamp", () => {
    expect(parseClfTime("2026-08-30T06:00:00Z")).toBeUndefined();
    expect(parseClfTime("30/Xxx/2026:06:00:00 +0000")).toBeUndefined();
  });
});

describe("parseIsoTime", () => {
  it("treats a timestamp with no zone as UTC rather than local time", () => {
    expect(parseIsoTime("2026-08-30 06:00:00 hello")?.ms).toBe(Date.UTC(2026, 7, 30, 6, 0, 0));
  });

  it("applies an explicit offset", () => {
    expect(parseIsoTime("2026-08-30T06:00:00+02:00")?.ms).toBe(Date.UTC(2026, 7, 30, 4, 0, 0));
    expect(parseIsoTime("2026-08-30T06:00:00-0530")?.ms).toBe(Date.UTC(2026, 7, 30, 11, 30, 0));
  });

  it("keeps fractional seconds, including a comma separator", () => {
    expect(parseIsoTime("2026-08-30T06:00:00,250Z")?.ms).toBe(Date.UTC(2026, 7, 30, 6, 0, 0, 250));
  });

  it("returns undefined when the line does not start with a timestamp", () => {
    expect(parseIsoTime("worker started 2026-08-30T06:00:00Z")).toBeUndefined();
  });
});

describe("isoUtc and formatDuration", () => {
  it("renders an instant as ISO 8601 in UTC", () => {
    expect(isoUtc(Date.UTC(2026, 7, 30, 6, 0, 0))).toBe("2026-08-30T06:00:00Z");
  });

  it("breaks a span into days, hours, minutes and seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(3_600_000 * 26 + 61_000)).toBe("1d 2h 1m 1s");
  });
});

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

describe("maskAddress", () => {
  it("drops the last octet of an IPv4 address", () => {
    expect(maskAddress("203.0.113.14")).toBe("203.0.113.x");
  });

  it("drops the last group of an IPv6 address", () => {
    expect(maskAddress("2001:db8:3c4d:15::1a2f")).toBe("2001:db8:3c4d:15::x");
  });

  it("leaves anything that is not an address alone", () => {
    expect(maskAddress("unix:")).toBe("unix:x");
    expect(maskAddress("localhost")).toBe("localhost");
  });
});

describe("durationToMs", () => {
  it("reads a bare number as milliseconds by default", () => {
    expect(durationToMs("duration", 250)).toBe(250);
  });

  it("reads nginx second fields as seconds", () => {
    expect(durationToMs("request_time", 1.5)).toBe(1500);
    expect(durationToMs("upstream_response_time", 0.25)).toBe(250);
  });

  it("honors a unit suffix on the key", () => {
    expect(durationToMs("duration_us", 2500)).toBe(2.5);
    expect(durationToMs("duration_ns", 2_500_000)).toBe(2.5);
  });

  it("parses a string with a unit", () => {
    expect(durationToMs("took", "250ms")).toBe(250);
    expect(durationToMs("took", "1.5s")).toBe(1500);
    expect(durationToMs("took", "2m")).toBe(120_000);
    expect(durationToMs("took", "not a duration")).toBeUndefined();
  });
});

describe("detectLevel", () => {
  it("prefers an explicit logfmt level", () => {
    expect(detectLevel('ts=2026-08-30 level=warn msg="ERROR was mentioned"')).toBe("WARN");
  });

  it("falls back to an uppercase severity token", () => {
    expect(detectLevel("2026-08-30T06:00:00Z ERROR boom")).toBe("ERROR");
    expect(detectLevel("2026-08-30T06:00:00Z nothing severe here")).toBeUndefined();
  });
});

describe("detectFormat", () => {
  it("picks the combined format when referer and agent are present", () => {
    expect(detectFormat(COMBINED.split("\n")).format).toBe("combined");
  });

  it("picks the common format when they are not", () => {
    expect(detectFormat(COMMON.split("\n")).format).toBe("common");
  });

  it("picks JSON lines and generic timestamped lines", () => {
    expect(detectFormat(JSON_LINES.split("\n")).format).toBe("json");
    expect(detectFormat(TIMESTAMPED.split("\n")).format).toBe("timestamped");
  });
});

/* ------------------------------------------------------------------ */
/* run: access logs                                                    */
/* ------------------------------------------------------------------ */

describe("run on a combined access log", () => {
  const out = run(COMBINED, {});

  it("names the format and its confidence", () => {
    expect(out["Format detected"]).toContain("Apache/nginx combined access log");
    expect(out["Format detected"]).toContain("100% of the first 6 lines");
  });

  it("counts every line as parsed", () => {
    expect(out["Lines"]).toContain("6 non-empty lines");
    expect(out["Lines"]).toContain("6 parsed, 0 skipped");
  });

  it("reports the span in UTC, never in the runner's zone", () => {
    expect(out["Time span"]).toContain("first: 2026-08-30T06:00:00Z");
    expect(out["Time span"]).toContain("last:  2026-08-30T07:00:30Z");
    expect(out["Time span"]).toContain("span:  1h 30s");
    expect(out["Time span"]).toContain("All times are UTC.");
  });

  it("groups status codes into classes with percentages", () => {
    expect(out["Status classes"]).toContain("2xx success: 4 (67%)");
    expect(out["Status classes"]).toContain("4xx client error: 1 (17%)");
    expect(out["Status classes"]).toContain("5xx server error: 1 (17%)");
    expect(out["Status classes"]).toContain("by code: 200 x4");
  });

  it("totals the bytes served through the shared formatter", () => {
    // 5120 + 2048 + 310 + 512 + 900 + 950 = 9840 bytes.
    expect(out["Bytes served"]).toContain("9.6 KB");
    expect(out["Bytes served"]).toContain("9,840 bytes");
  });

  it("ranks the slowest requests from the trailing request time", () => {
    const slowest = out["Slowest 10 requests"] ?? "";
    expect(slowest.split("\n")[0]).toContain("4250.0 ms  POST /api/report");
    expect(slowest).toContain("6 lines carried a duration");
  });

  it("samples the error lines and counts them", () => {
    expect(out["Error lines"]).toContain("2 error lines");
    expect(out["Error lines"]).toContain("GET /missing HTTP/1.1");
  });

  it("counts the methods it saw", () => {
    expect(out["Methods"]).toContain("GET");
    expect(out["Methods"]).toContain("POST");
  });
});

describe("run on a common access log", () => {
  const out = run(COMMON, {});

  it("detects the format and still reads status and bytes", () => {
    expect(out["Format detected"]).toContain("common access log");
    expect(out["Status classes"]).toContain("2xx success: 2");
    expect(out["Bytes served"]).toContain("6,621 bytes");
  });

  it("has no user agents to report", () => {
    expect(out["Top 10 user agents"]).toBe("no user agents recorded");
  });
});

/* ------------------------------------------------------------------ */
/* run: JSON lines                                                     */
/* ------------------------------------------------------------------ */

describe("run on JSON lines", () => {
  const out = run(JSON_LINES, {});

  it("detects the format and finds the fields by name", () => {
    expect(out["Format detected"]).toContain("JSON lines");
    expect(out["Lines"]).toContain("3 parsed, 0 skipped");
    expect(out["Top 10 paths"]).toContain("/users");
    expect(out["Top 10 addresses"]).toContain("198.51.100.x");
    expect(out["Top 10 user agents"]).toContain("curl/8.7.1");
  });

  it("counts the severity levels the objects declare", () => {
    expect(out["Severity levels"]).toContain("INFO");
    expect(out["Severity levels"]).toContain("ERROR");
  });

  it("reads duration_ms as milliseconds and states the assumption", () => {
    const slowest = out["Slowest 10 requests"] ?? "";
    expect(slowest).toContain("1900.0 ms  POST /users");
    expect(slowest).toContain("read as milliseconds");
  });

  it("quotes the message field in the error sample", () => {
    expect(out["Error lines"]).toContain("database connection refused");
  });
});

/* ------------------------------------------------------------------ */
/* run: generic lines                                                  */
/* ------------------------------------------------------------------ */

describe("run on generic timestamped lines", () => {
  const out = run(TIMESTAMPED, {});

  it("detects the format and spans the timestamps", () => {
    expect(out["Format detected"]).toContain("generic timestamped lines");
    expect(out["Time span"]).toContain("first: 2026-08-30T06:00:00.100Z");
    expect(out["Time span"]).toContain("last:  2026-08-30T06:04:11.010Z");
  });

  it("counts severity levels and finds the error line", () => {
    expect(out["Severity levels"]).toContain("INFO");
    expect(out["Severity levels"]).toContain("ERROR");
    expect(out["Error lines"]).toContain("1 error lines");
    expect(out["Error lines"]).toContain("connection reset by peer");
  });

  it("says plainly that there are no statuses, sizes or durations", () => {
    expect(out["Status classes"]).toBe("no status codes in this log");
    expect(out["Bytes served"]).toBe("no response size field in this log");
    expect(out["Slowest 10 requests"]).toBe("no duration field found in this log");
  });
});

describe("run on syslog lines with no year", () => {
  const out = run(SYSLOG, {});

  it("reports the raw timestamps instead of inventing a year", () => {
    expect(out["Time span"]).toContain("first: Aug 30 06:00:00");
    expect(out["Time span"]).toContain("last:  Aug 30 06:04:00");
    expect(out["Time span"]).toContain("no year or time zone");
    expect(out["Time span"]).not.toContain("span:");
  });
});

/* ------------------------------------------------------------------ */
/* options                                                             */
/* ------------------------------------------------------------------ */

describe("options", () => {
  it("masks addresses by default and shows them in full when asked", () => {
    expect(run(COMBINED, {})["Top 10 addresses"]).toContain("203.0.113.x");
    const unmasked = run(COMBINED, { maskIps: false })["Top 10 addresses"] ?? "";
    expect(unmasked).toContain("203.0.113.14");
    expect(unmasked).not.toContain("The host part of every address");
  });

  it("folds query strings into one path by default and splits them when asked", () => {
    expect(run(COMBINED, {})["Top 10 paths"]).toContain("/search");
    const kept = run(COMBINED, { stripQuery: false })["Top 10 paths"] ?? "";
    expect(kept).toContain("/search?q=alpha");
    expect(kept).toContain("/search?q=beta");
  });

  it("resizes and renames the top lists", () => {
    const out = run(COMBINED, { top: 2 });
    expect(out["Top 2 paths"]?.split("\n")).toHaveLength(2);
    expect(out["Top 10 paths"]).toBeUndefined();
  });

  it("clamps an out of range top value instead of failing", () => {
    expect(run(COMBINED, { top: 0 })["Top 1 paths"]).toBeDefined();
    expect(run(COMBINED, { top: 9999 })["Top 50 paths"]).toBeDefined();
  });

  it("drops the sections the view does not ask for", () => {
    const errors = run(COMBINED, { view: "errors" });
    expect(errors["Error lines"]).toBeDefined();
    expect(errors["Top 10 paths"]).toBeUndefined();
    expect(errors["Slowest 10 requests"]).toBeUndefined();

    const timing = run(COMBINED, { view: "timing" });
    expect(timing["Slowest 10 requests"]).toBeDefined();
    expect(timing["Error lines"]).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* edge cases                                                          */
/* ------------------------------------------------------------------ */

describe("edge cases", () => {
  it("accepts bytes as well as text", () => {
    const bytes = new TextEncoder().encode(COMBINED);
    expect(run(bytes, {})["Lines"]).toContain("6 parsed");
  });

  it("handles CRLF endings, a trailing newline and blank lines", () => {
    const out = run(`\r\n${COMBINED.split("\n").join("\r\n")}\r\n\r\n`, {});
    expect(out["Lines"]).toContain("6 non-empty lines");
    expect(out["Lines"]).toContain("6 parsed, 0 skipped");
  });

  it("counts lines the chosen parser cannot read as skipped", () => {
    const mixed = `${COMBINED}\nnot a log line at all\nanother stray line`;
    const out = run(mixed, {});
    expect(out["Lines"]).toContain("8 non-empty lines");
    expect(out["Lines"]).toContain("6 parsed, 2 skipped");
  });

  it("still surfaces an error inside a line it could not parse", () => {
    const mixed = `${COMBINED}\nERROR unhandled rejection in worker pool`;
    expect(run(mixed, {})["Error lines"]).toContain("unhandled rejection in worker pool");
  });

  it("reads a quote escaped inside a request or user agent", () => {
    const line =
      '203.0.113.14 - - [30/Aug/2026:06:00:00 +0000] "GET /a\\"b HTTP/1.1" 200 10 "-" "agent \\"x\\"" 0.001';
    const out = run(line, {});
    expect(out["Lines"]).toContain("1 parsed, 0 skipped");
    expect(out["Top 10 paths"]).toContain('/a\\"b');
  });

  it("handles a dash for a missing size and a missing status", () => {
    const line = '203.0.113.14 - - [30/Aug/2026:06:00:00 +0000] "GET / HTTP/1.1" - - "-" "curl" ';
    const out = run(line, {});
    expect(out["Lines"]).toContain("1 parsed");
    expect(out["Bytes served"]).toBe("no response size field in this log");
  });

  it("takes the first address out of an X-Forwarded-For list", () => {
    const line =
      '203.0.113.14, 198.51.100.9 - - [30/Aug/2026:06:00:00 +0000] "GET / HTTP/1.1" 200 10 "-" "curl" 0.001';
    expect(run(line, { maskIps: false })["Top 10 addresses"]).toContain("203.0.113.14");
  });
});

/* ------------------------------------------------------------------ */
/* errors                                                              */
/* ------------------------------------------------------------------ */

describe("errors", () => {
  it("refuses an empty input", () => {
    expect(() => run("", {})).toThrow(ToolError);
    try {
      run("   \n\n  ", {});
      expect.unreachable("whitespace only input should throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
      expect((e as ToolError).fix).toContain("Paste some log lines");
    }
  });

  it("refuses text past the size cap", () => {
    const oversized = new Uint8Array(50 * 1024 * 1024 + 1);
    try {
      run(oversized, {});
      expect.unreachable("an oversized file should throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("too-large");
      expect((e as ToolError).message).toContain("50 MB");
      expect((e as ToolError).fix).toContain("Split the log");
    }
  });

  it("refuses a pasted string past the size cap", () => {
    const oversized = "x".repeat(50 * 1024 * 1024 + 1);
    try {
      run(oversized, {});
      expect.unreachable("oversized text should throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("too-large");
      expect((e as ToolError).fix).toContain("Take a slice of the log");
    }
  });

  it("refuses content with no readable log line in it", () => {
    try {
      run("the quick brown fox\njumped over the lazy dog\nnothing here is a log", {});
      expect.unreachable("prose should throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("unrecognized-format");
      expect((e as ToolError).fix).toContain("Apache and nginx access logs");
    }
  });
});

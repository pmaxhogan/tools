import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

describe("user-agent-parser", () => {
  it("parses a current Chrome-on-Windows UA", () => {
    const out = run(CHROME_WINDOWS, {});
    expect(out.Browser).toBe("Chrome 128.0.0.0");
    expect(out.Engine).toBe("Blink 128.0.0.0");
    expect(out.OS).toBe("Windows 10");
    expect(out.Device).toBe("Desktop (no device markers)");
    expect(out["CPU architecture"]).toBe("amd64");
    expect(out["Bot?"]).toBeUndefined();
  });

  it("parses an iPhone Safari UA, including device info", () => {
    const out = run(IPHONE_SAFARI, {});
    expect(out.Browser).toBe("Mobile Safari 17.5");
    expect(out.Engine).toBe("WebKit 605.1.15");
    expect(out.OS).toBe("iOS 17.5.1");
    expect(out.Device).toMatch(/Apple/);
    expect(out.Device).toMatch(/iPhone/);
    expect(out["Bot?"]).toBeUndefined();
  });

  it("flags a Googlebot UA with a Bot row", () => {
    const out = run(GOOGLEBOT, {});
    expect(out["Bot?"]).toBeDefined();
    expect(out["Bot?"]).toMatch(/bot|crawler/i);
  });

  it("flags common CLI/bot substrings even when ua-parser-js itself has no record", () => {
    const out = run("SomeUnknownSpider/1.0", {});
    expect(out["Bot?"]).toBeDefined();
  });

  it('returns "Unknown" rows for unrecognized but non-empty UAs instead of throwing', () => {
    const out = run("not a real user agent string at all", {});
    expect(out.Browser).toBe("Unknown");
    expect(out.Engine).toBe("Unknown");
    expect(out.OS).toBe("Unknown");
    expect(out.Device).toBe("Desktop (no device markers)");
    expect(out["CPU architecture"]).toBeUndefined();
  });

  it("throws a typed, actionable error on empty input", () => {
    expect(() => run("", {})).toThrowError(ToolError);
    try {
      run("   ", {});
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
      expect((e as ToolError).fix).toMatch(/what is my user agent/);
    }
  });
});

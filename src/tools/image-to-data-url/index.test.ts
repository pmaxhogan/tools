import { describe, expect, it } from "vitest";
import {
  buildDataUrl,
  cssSnippet,
  decodeBase64,
  encodeBase64,
  estimateDataUrlLength,
  extensionForMediaType,
  htmlSnippet,
  looksLikeDataUrl,
  parseDataUrl,
  run,
  sniffFormat,
} from "./index";
import { ToolError } from "../types";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

/** The eight byte PNG signature plus a stub IHDR length, enough to sniff. */
const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const GIF_HEAD = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

function webpHead(): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x20], 12);
  return bytes;
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/* ------------------------------------------------------------------ */
/* base64                                                              */
/* ------------------------------------------------------------------ */

describe("encodeBase64", () => {
  it("matches the RFC 4648 test vectors", () => {
    expect(encodeBase64(bytesOf(""))).toBe("");
    expect(encodeBase64(bytesOf("f"))).toBe("Zg==");
    expect(encodeBase64(bytesOf("fo"))).toBe("Zm8=");
    expect(encodeBase64(bytesOf("foo"))).toBe("Zm9v");
    expect(encodeBase64(bytesOf("foob"))).toBe("Zm9vYg==");
    expect(encodeBase64(bytesOf("fooba"))).toBe("Zm9vYmE=");
    expect(encodeBase64(bytesOf("foobar"))).toBe("Zm9vYmFy");
  });

  it("round trips every byte value", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(Array.from(decodeBase64(encodeBase64(all)))).toEqual(Array.from(all));
  });
});

describe("decodeBase64", () => {
  it("ignores whitespace and missing padding", () => {
    expect(new TextDecoder().decode(decodeBase64("Zm9v\n YmFy"))).toBe("foobar");
    expect(new TextDecoder().decode(decodeBase64("Zm9vYg"))).toBe("foob");
  });

  it("accepts the URL safe alphabet", () => {
    // 0xfb 0xff encodes as "+/8=" in standard base64 and "-_8=" URL safe.
    expect(Array.from(decodeBase64("-_8="))).toEqual([0xfb, 0xff]);
  });

  it("throws on a character outside the alphabet", () => {
    expect(() => decodeBase64("Zm9v$$")).toThrow(ToolError);
    expect(() => decodeBase64("Zm9v$$")).toThrow(/not a base64 character/);
  });
});

/* ------------------------------------------------------------------ */
/* sniffing                                                            */
/* ------------------------------------------------------------------ */

describe("sniffFormat", () => {
  it("reads the media type off the magic bytes", () => {
    expect(sniffFormat(PNG_HEAD).mediaType).toBe("image/png");
    expect(sniffFormat(JPEG_HEAD).mediaType).toBe("image/jpeg");
    expect(sniffFormat(GIF_HEAD).mediaType).toBe("image/gif");
    expect(sniffFormat(webpHead()).mediaType).toBe("image/webp");
  });

  it("recognizes SVG markup with or without an XML declaration", () => {
    expect(sniffFormat(bytesOf('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).label).toBe(
      "SVG",
    );
    expect(sniffFormat(bytesOf('<?xml version="1.0"?><svg></svg>')).label).toBe("SVG");
  });

  it("falls back to octet-stream for bytes it does not know", () => {
    expect(sniffFormat(new Uint8Array([1, 2, 3, 4, 5])).mediaType).toBe("application/octet-stream");
  });
});

describe("extensionForMediaType", () => {
  it("ignores parameters and case", () => {
    expect(extensionForMediaType("IMAGE/JPEG; charset=binary")).toBe("jpg");
  });

  it("falls back to bin for an unknown type", () => {
    expect(extensionForMediaType("application/x-nonsense")).toBe("bin");
  });
});

/* ------------------------------------------------------------------ */
/* building                                                            */
/* ------------------------------------------------------------------ */

describe("buildDataUrl", () => {
  it("builds a base64 data URL with the sniffed media type", () => {
    const built = buildDataUrl(PNG_HEAD);
    expect(built.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(built.mediaType).toBe("image/png");
    expect(built.sourceBytes).toBe(PNG_HEAD.length);
    expect(built.urlLength).toBe(built.dataUrl.length);
  });

  it("honors an explicit media type over the sniffed one", () => {
    expect(buildDataUrl(PNG_HEAD, "image/webp").mediaType).toBe("image/webp");
  });

  it("throws on empty input", () => {
    expect(() => buildDataUrl(new Uint8Array(0))).toThrow(ToolError);
  });
});

describe("estimateDataUrlLength", () => {
  it("predicts the exact length of the built URL", () => {
    for (const size of [1, 2, 3, 4, 100, 999]) {
      const bytes = new Uint8Array(size).fill(0x41);
      const built = buildDataUrl(bytes, "image/png");
      expect(estimateDataUrlLength(size, "image/png")).toBe(built.dataUrl.length);
    }
  });
});

describe("snippets", () => {
  it("quotes the URL inside a CSS rule and uses the given selector", () => {
    const css = cssSnippet("data:image/png;base64,AAA", "#banner");
    expect(css).toContain("#banner {");
    expect(css).toContain('url("data:image/png;base64,AAA")');
  });

  it("falls back to a default selector when the given one is blank", () => {
    expect(cssSnippet("data:,x", "   ")).toContain(".hero {");
  });

  it("escapes quotes in the alt text of an img tag", () => {
    expect(htmlSnippet("data:,x", 'a "quoted" name')).toContain("&quot;quoted&quot;");
  });
});

/* ------------------------------------------------------------------ */
/* parsing                                                             */
/* ------------------------------------------------------------------ */

describe("parseDataUrl", () => {
  it("parses a base64 payload", () => {
    const parsed = parseDataUrl("data:image/png;base64,Zm9vYmFy");
    expect(parsed.mediaType).toBe("image/png");
    expect(parsed.encoding).toBe("base64");
    expect(new TextDecoder().decode(parsed.bytes)).toBe("foobar");
    expect(parsed.extension).toBe("png");
  });

  it("parses a percent encoded payload and keeps its parameters", () => {
    const parsed = parseDataUrl("data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E");
    expect(parsed.encoding).toBe("percent");
    expect(parsed.parameters).toEqual(["charset=utf-8"]);
    expect(new TextDecoder().decode(parsed.bytes)).toBe("<svg></svg>");
  });

  it("defaults the media type when the header is bare", () => {
    expect(parseDataUrl("data:,hello").mediaType).toBe("text/plain");
  });

  it("throws when the text is not a data URL", () => {
    expect(() => parseDataUrl("https://example.com/a.png")).toThrow(ToolError);
  });

  it("throws when the payload is empty", () => {
    expect(() => parseDataUrl("data:image/png;base64,")).toThrow(/carries no bytes/);
  });

  it("throws on a broken percent escape", () => {
    expect(() => parseDataUrl("data:text/plain,100%zz")).toThrow(/hex digits/);
  });
});

describe("looksLikeDataUrl", () => {
  it("is true only for a well formed head", () => {
    expect(looksLikeDataUrl("  data:image/png;base64,AA  ")).toBe(true);
    expect(looksLikeDataUrl("data:image/png;base64")).toBe(false);
    expect(looksLikeDataUrl("not a url")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

describe("run", () => {
  it("encodes dropped bytes and reports the overhead", () => {
    const out = run(PNG_HEAD, {});
    expect(out["Direction"]).toBe("Encoded to a data URL");
    expect(out["Format"]).toBe("PNG (image/png)");
    expect(out["Data URL"]?.startsWith("data:image/png;base64,")).toBe(true);
    expect(out["Overhead"]).toMatch(/% larger than the file/);
  });

  it("emits a CSS rule or an img tag on request", () => {
    expect(run(PNG_HEAD, { snippet: "css", selector: "#logo" })["CSS background"]).toContain(
      "#logo {",
    );
    expect(run(PNG_HEAD, { snippet: "html" })["HTML img tag"]).toContain("<img src=");
  });

  it("warns once the inline form passes 100 KB", () => {
    const big = new Uint8Array(120 * 1024).fill(0x41);
    expect(run(big, { mediaType: "image/png" })["Size warning"]).toMatch(/inline image usually/);
    expect(run(PNG_HEAD, {})["Size warning"]).toBeUndefined();
  });

  it("decodes a pasted data URL", () => {
    const out = run("data:image/gif;base64,R0lGODlh", {});
    expect(out["Direction"]).toBe("Decoded from a data URL");
    expect(out["Media type"]).toBe("image/gif");
    expect(out["Suggested filename"]).toBe("image.gif");
  });

  it("flags a payload whose bytes disagree with the declared type", () => {
    const out = run(`data:image/jpeg;base64,${encodeBase64(PNG_HEAD)}`, {});
    expect(out["Actual bytes"]).toContain("looks like PNG");
  });

  it("treats pasted text as file content when the direction forces encoding", () => {
    const out = run("<svg></svg>", { direction: "encode" });
    expect(out["Format"]).toBe("SVG (image/svg+xml)");
  });

  it("throws on empty input", () => {
    expect(() => run("   ", {})).toThrow(ToolError);
    expect(() => run("   ", {})).toThrow(/Nothing to convert/);
  });

  it("throws when asked to decode text that is not a data URL", () => {
    expect(() => run("hello world", {})).toThrow(/not a data URL/);
  });
});

import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { compressBytes, detectFormat, run, shannonEntropy } from "./index";

describe("gzip-compression-test", () => {
  describe("run: compressing plain input", () => {
    it("produces rows for all three algorithms and gzip is smaller than the input", async () => {
      const input = "hello ".repeat(100);
      const out = await run(input, { preview: true });

      expect(out.gzip).toBeDefined();
      expect(out.deflate).toBeDefined();
      expect(out["deflate-raw"]).toBeDefined();
      expect(out["Input size"]).toContain(String(new TextEncoder().encode(input).length));

      const gzipBytes = Number(out.gzip!.match(/^([\d,]+) byte/)![1]!.replace(/,/g, ""));
      expect(gzipBytes).toBeLessThan(new TextEncoder().encode(input).length);
      expect(out["Best algorithm"]).toBeDefined();
      expect(out["Entropy estimate"]).toBeDefined();
    });

    it("includes a gzip hex preview row when preview is true", async () => {
      const out = await run("hello ".repeat(100), { preview: true });
      expect(out["Gzip hex preview (first 64 bytes)"]).toMatch(/^[0-9a-f]{2}( [0-9a-f]{2})*$/);
    });

    it("omits the hex preview row when preview is false", async () => {
      const out = await run("hello ".repeat(100), { preview: false });
      expect(out["Gzip hex preview (first 64 bytes)"]).toBeUndefined();
    });

    it("accepts raw bytes as well as strings", async () => {
      const bytes = new TextEncoder().encode("hello ".repeat(100));
      const out = await run(bytes, { preview: false });
      expect(out.gzip).toBeDefined();
    });
  });

  describe("round-trip: compress then feed the compressed bytes back in", () => {
    it("detects gzip and recovers the original text on decompression", async () => {
      const original = "The quick brown fox jumps over the lazy dog. ".repeat(10);
      const gzipped = await compressBytes(new TextEncoder().encode(original), "gzip");

      expect(detectFormat(gzipped)).toBe("gzip");

      const out = await run(gzipped, { preview: false });
      expect(out["Detected format"]).toBe("gzip");
      expect(out["Content preview"]).toBe(original);
      expect(out["Original (compressed) size"]).toBeDefined();
      expect(out["Decompressed size"]).toContain(String(new TextEncoder().encode(original).length));
    });

    it("truncates the preview to 500 chars with an ellipsis for long decompressed text", async () => {
      const original = "x".repeat(600);
      const gzipped = await compressBytes(new TextEncoder().encode(original), "gzip");

      const out = await run(gzipped, { preview: false });
      expect(out["Content preview"]).toBe(`${"x".repeat(500)}...`);
    });

    it("detects a zlib (deflate) header and decompresses it too", async () => {
      const original = "zlib round trip test ".repeat(20);
      const deflated = await compressBytes(new TextEncoder().encode(original), "deflate");

      expect(detectFormat(deflated)).toBe("zlib");

      const out = await run(deflated, { preview: false });
      expect(out["Detected format"]).toBe("zlib (deflate)");
      expect(out["Content preview"]).toBe(original);
    });
  });

  describe("deflate vs deflate-raw", () => {
    it("deflate is larger than deflate-raw by roughly the zlib header/checksum overhead", async () => {
      const bytes = new TextEncoder().encode("compress me please ".repeat(50));
      const deflate = await compressBytes(bytes, "deflate");
      const deflateRaw = await compressBytes(bytes, "deflate-raw");

      const diff = deflate.length - deflateRaw.length;
      // zlib (RFC 1950) adds a 2-byte header and a 4-byte Adler-32 trailer.
      expect(diff).toBeGreaterThanOrEqual(4);
      expect(diff).toBeLessThanOrEqual(8);
    });
  });

  describe("shannonEntropy", () => {
    it("is low for highly repetitive data", () => {
      const bytes = new TextEncoder().encode("a".repeat(1000));
      expect(shannonEntropy(bytes)).toBeLessThan(1);
    });

    it("is above 7 bits/byte for cryptographically random data", () => {
      const bytes = new Uint8Array(2048);
      globalThis.crypto.getRandomValues(bytes);
      expect(shannonEntropy(bytes)).toBeGreaterThan(7);
    });

    it("is 0 for empty input", () => {
      expect(shannonEntropy(new Uint8Array(0))).toBe(0);
    });
  });

  describe("empty input", () => {
    it("throws a ToolError for an empty string", async () => {
      await expect(run("", { preview: true })).rejects.toThrow(ToolError);
    });

    it("throws a ToolError for an empty Uint8Array", async () => {
      await expect(run(new Uint8Array(0), { preview: true })).rejects.toThrow(ToolError);
    });
  });
});

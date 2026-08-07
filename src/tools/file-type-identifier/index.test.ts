import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

/** Minimal PNG: signature + a valid 13-byte IHDR chunk header (file-type stops there). */
function pngBytes(): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const length = [0, 0, 0, 13];
  const type = [0x49, 0x48, 0x44, 0x52]; // "IHDR"
  const data = new Array(13).fill(0);
  const crc = [0, 0, 0, 0];
  return Uint8Array.from([...sig, ...length, ...type, ...data, ...crc]);
}

/** Minimal gzip member: magic + deflate method + flags + mtime + extra flags + OS. */
function gzipBytes(): Uint8Array {
  return Uint8Array.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0, ...new Array(10).fill(0)]);
}

/** Minimal ZIP local file header, enough for file-type to sniff the family. */
function zipBytes(): Uint8Array {
  const header = [0x50, 0x4b, 0x03, 0x04];
  return Uint8Array.from([...header, ...new Array(36).fill(0)]);
}

describe("file-type-identifier", () => {
  it("detects PNG from magic bytes", async () => {
    const out = await run(pngBytes(), {});
    expect(out["MIME type"]).toBe("image/png");
    expect(out["Detected type"]).toMatch(/PNG/);
    expect(out["Detection basis"]).toBe("magic bytes");
    expect(out.Size).toBeTruthy();
    expect(out["First bytes"]).toMatch(/^89 50 4E 47/);
  });

  it("detects gzip from magic bytes", async () => {
    const out = await run(gzipBytes(), {});
    expect(out["MIME type"]).toBe("application/gzip");
    expect(out["Detected type"]).toMatch(/GZIP/i);
  });

  it("detects a minimal zip as part of the zip family", async () => {
    const out = await run(zipBytes(), {});
    expect(out["MIME type"]).toBe("application/zip");
    expect(out["Typical extension"]).toBe(".zip");
  });

  it("classifies JSON text", async () => {
    const out = await run('{"hello": "world", "n": 1}', {});
    expect(out["Detected type"]).toBe("JSON");
    expect(out.Encoding).toBe("UTF-8");
  });

  it("classifies CSV text with a consistent column count", async () => {
    const csv = "name,age,city\nAda,30,London\nGrace,40,NYC\n";
    const out = await run(csv, {});
    expect(out["Detected type"]).toBe("CSV");
  });

  it("reports a UTF-16LE byte order mark", async () => {
    const text = "hello";
    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16[0] = 0xff;
    utf16[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      utf16[2 + i * 2] = code & 0xff;
      utf16[2 + i * 2 + 1] = (code >> 8) & 0xff;
    }
    const out = await run(utf16, {});
    expect(out.Encoding).toBe("UTF-16LE (BOM)");
  });

  it("reports Unknown binary for bytes that match no signature and are not valid text", async () => {
    const bytes = new Uint8Array(32).fill(0x80);
    const out = await run(bytes, {});
    expect(out["Detected type"]).toBe("Unknown binary");
    expect(out["First bytes"]).toBeTruthy();
    expect(out["First bytes"].split(" ")).toHaveLength(16);
  });

  it("throws ToolError on empty input", async () => {
    await expect(run(new Uint8Array(0), {})).rejects.toThrow(ToolError);
    await expect(run("", {})).rejects.toThrow(ToolError);
  });

  it("handles string (pasted) input through the same text pipeline", async () => {
    const out = await run("plain sentence with no structure at all", {});
    expect(out["Detected type"]).toBe("Plain text");
    expect(out.Encoding).toBe("UTF-8");
  });
});

import { describe, expect, it } from "vitest";
import { run, stripExif } from "./index";
import { ToolError } from "../types";

/* ------------------------------------------------------------------ */
/* hand-built fixtures                                                 */
/* ------------------------------------------------------------------ */

function be16(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}

function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function le32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function asciiBytes(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

type BytePart = number | number[] | string;

/** Flatten numbers, nested arrays, and ASCII strings into one byte list. */
function pack(...parts: BytePart[]): number[] {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "number") out.push(part & 0xff);
    else if (typeof part === "string") out.push(...asciiBytes(part));
    else out.push(...part);
  }
  return out;
}

function packU8(...parts: BytePart[]): Uint8Array {
  return new Uint8Array(pack(...parts));
}

/** PNG chunk with a placeholder CRC (nothing in this tool verifies CRCs). */
function pngChunk(type: string, data: number[]): number[] {
  return [...be32(data.length), ...asciiBytes(type), ...data, 0xde, 0xad, 0xbe, 0xef];
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 2 x 3 RGBA PNG carrying one tEXt chunk. */
function makePng(): Uint8Array {
  return new Uint8Array([
    ...PNG_SIGNATURE,
    // width 2, height 3, bit depth 8, color type 6 (RGBA), no interlace
    ...pngChunk("IHDR", [...be32(2), ...be32(3), 8, 6, 0, 0, 0]),
    ...pngChunk("tEXt", asciiBytes("Comment\0taken at home")),
    ...pngChunk("IDAT", [0x78, 0x9c, 0x01, 0x00]),
    ...pngChunk("IEND", []),
  ]);
}

/**
 * Little-endian TIFF block with IFD0 = { Make, Model, Orientation = 6 }.
 * Tags must appear in ascending numeric order for a strict reader.
 */
function makeTiff(): number[] {
  const make = "ACME\0";
  const model = "Cam 1\0";
  const entryCount = 3;
  const ifdSize = 2 + entryCount * 12 + 4;
  const dataStart = 8 + ifdSize;
  const makeOffset = dataStart;
  const modelOffset = dataStart + make.length;

  const le16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
  const entry = (tag: number, type: number, count: number, value: number[]): number[] =>
    pack(le16(tag), le16(type), le32(count), value);

  return pack(
    "II", // little-endian byte order
    [0x2a, 0x00], // TIFF magic 42
    le32(8), // IFD0 starts at byte 8
    le16(entryCount),
    entry(0x010f, 2, make.length, le32(makeOffset)), // Make (ASCII)
    entry(0x0110, 2, model.length, le32(modelOffset)), // Model (ASCII)
    entry(0x0112, 3, 1, [6, 0, 0, 0]), // Orientation (SHORT) = 6
    le32(0), // no IFD1
    make,
    model,
  );
}

/** Baseline 60 x 40 JPEG with APP0 JFIF, APP1 Exif, an ICC APP2, and a COM. */
function makeJpeg(): Uint8Array {
  const exif = pack("Exif\0\0", makeTiff());
  const icc = pack("ICC_PROFILE\0", [0x01, 0x01, 0x00, 0x00]);
  const jfif = pack("JFIF\0", [0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const comment = pack("hi\0");
  const sof0 = pack(
    [0x08],
    be16(40),
    be16(60),
    [0x03],
    [0x01, 0x22, 0x00],
    [0x02, 0x11, 0x01],
    [0x03, 0x11, 0x01],
  );
  const sos = pack([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);

  const segment = (marker: number, payload: number[]): number[] =>
    pack([0xff, marker], be16(payload.length + 2), payload);

  return packU8(
    [0xff, 0xd8], // SOI
    segment(0xe0, jfif), // APP0 JFIF, must survive stripping
    segment(0xe1, exif), // APP1 Exif
    segment(0xe2, icc), // APP2 ICC profile, must survive stripping
    segment(0xfe, comment), // COM
    segment(0xc0, sof0), // SOF0: precision 8, height 40, width 60, 3 components
    segment(0xda, sos), // SOS
    [0x12, 0x34, 0x56], // stand-in for entropy coded scan data
    [0xff, 0xd9], // EOI
  );
}

/** GIF87a, 4 x 5, one frame, 4 entry global color table. */
function makeGif(): Uint8Array {
  return packU8(
    "GIF87a",
    [4, 0], // logical screen width 4 (LE)
    [5, 0], // logical screen height 5 (LE)
    [0xf1], // GCT present, color resolution 8, table size 2^2 = 4
    [0x00, 0x00], // background color index, pixel aspect ratio
    [0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0, 255], // global color table
    [0x2c, 0, 0, 0, 0, 4, 0, 5, 0, 0x00], // image descriptor, one frame
    [0x02, 0x02, 0x44, 0x01, 0x00], // LZW code size, one sub-block, terminator
    [0x3b], // trailer
  );
}

/** RIFF/WEBP with a VP8L chunk describing a 7 x 11 lossless image. */
function makeWebpLossless(): Uint8Array {
  const width = 7;
  const height = 11;
  const bits = (width - 1) | ((height - 1) << 14);
  const chunkData = pack([0x2f], le32(bits >>> 0), [0x00]);
  const body = pack("WEBP", "VP8L", le32(chunkData.length), chunkData);
  return packU8("RIFF", le32(body.length), body);
}

const SVG_TEXT =
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60"><rect width="120" height="60"/></svg>';

function indexOfAscii(bytes: Uint8Array, needle: string): number {
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

const NO_STRIP = { stripExif: false };

/* ------------------------------------------------------------------ */
/* tests                                                               */
/* ------------------------------------------------------------------ */

describe("image-toolbox: header parsing", () => {
  it("reads PNG dimensions and color type from IHDR", async () => {
    const out = await run(makePng(), NO_STRIP);
    expect(out.Format).toBe("PNG");
    expect(out.Dimensions).toBe("2 x 3 px");
    expect(out["Bit depth / color type"]).toBe("8 bits per channel, Truecolor with alpha (RGBA)");
    expect(out["Interlace/progressive"]).toMatch(/^None/);
    expect(out["Aspect ratio"]).toBe("2:3 (0.67)");
    expect(out["File size"]).toMatch(/bytes/);
  });

  it("reads JPEG dimensions from SOF0 and notes baseline encoding", async () => {
    const out = await run(makeJpeg(), NO_STRIP);
    expect(out.Format).toBe("JPEG");
    expect(out.Dimensions).toBe("60 x 40 px");
    expect(out["Bit depth / color type"]).toBe("8 bits per channel, YCbCr color");
    expect(out["Interlace/progressive"]).toMatch(/^Baseline/);
    expect(out["Aspect ratio"]).toBe("3:2 (1.50)");
  });

  it("reads GIF dimensions and counts frames", async () => {
    const out = await run(makeGif(), NO_STRIP);
    expect(out.Format).toBe("GIF (GIF87a)");
    expect(out.Dimensions).toBe("4 x 5 px");
    expect(out.Frames).toBe("1 (still)");
    expect(out.Palette).toBe("Global color table, 4 colors");
  });

  it("reads WebP lossless dimensions from the VP8L header", async () => {
    const out = await run(makeWebpLossless(), NO_STRIP);
    expect(out.Format).toBe("WebP (lossless VP8L)");
    expect(out.Dimensions).toBe("7 x 11 px");
  });

  it("reports SVG as a vector with no fixed pixel size", async () => {
    const out = await run(new TextEncoder().encode(SVG_TEXT), NO_STRIP);
    expect(out.Format).toBe("SVG (vector)");
    expect(out.Dimensions).toBe("Scalable vector, no fixed pixel size");
    expect(out["Declared size"]).toBe("120px x 60px");
    expect(out.viewBox).toBe("0 0 120 60");
  });

  it("reports ICO entry count and sizes", async () => {
    // ICO entry: width, height (0 means 256), colors, reserved, planes, bpp, size, offset
    const icoEntry = (w: number, h: number): number[] =>
      pack([w, h, 0, 0], [1, 0], [32, 0], le32(100), le32(38));
    const ico = packU8(
      [0x00, 0x00, 0x01, 0x00], // ICO signature
      [0x02, 0x00], // two images
      icoEntry(16, 16),
      icoEntry(0, 0), // 0 means 256
    );
    const out = await run(ico, NO_STRIP);
    expect(out.Format).toBe("ICO (Windows icon)");
    expect(out.Images).toBe("2");
    expect(out["Icon sizes"]).toBe("16 x 16, 256 x 256");
    expect(out.Dimensions).toBe("256 x 256 px");
  });

  it("reads BMP dimensions from a BITMAPINFOHEADER", async () => {
    const bmp = packU8(
      "BM",
      le32(70), // file size
      le32(0), // reserved
      le32(54), // pixel data offset
      le32(40), // BITMAPINFOHEADER size
      le32(9), // width
      le32(6), // height
      [1, 0], // planes
      [24, 0], // bits per pixel
      le32(0), // compression: BI_RGB
      le32(16), // image size
      le32(0),
      le32(0),
      le32(0),
      le32(0),
    );
    const out = await run(bmp, NO_STRIP);
    expect(out.Format).toBe("BMP (BITMAPINFOHEADER)");
    expect(out.Dimensions).toBe("9 x 6 px");
    expect(out["Bit depth / color type"]).toBe("24 bits per pixel, uncompressed (BI_RGB)");
  });
});

describe("image-toolbox: EXIF reading", () => {
  it("surfaces camera and orientation from a hand-built APP1 Exif segment", async () => {
    const out = await run(makeJpeg(), NO_STRIP);
    expect(out.Orientation).toBe("6 (rotated 90 degrees clockwise)");
    expect(out.Camera).toBe("ACME Cam 1");
    expect(out.EXIF).toBeUndefined();
  });

  it('reports "None found" when the file carries no EXIF', async () => {
    const out = await run(makeGif(), NO_STRIP);
    expect(out.EXIF).toBe("None found");
  });
});

describe("image-toolbox: metadata stripping", () => {
  it("removes the APP1 Exif segment from a JPEG and keeps the ICC profile", async () => {
    const original = makeJpeg();
    expect(indexOfAscii(original, "Exif\0\0")).toBeGreaterThan(-1);

    const { bytes, removed } = stripExif(original);
    expect(indexOfAscii(bytes, "Exif\0\0")).toBe(-1);
    expect(indexOfAscii(bytes, "ICC_PROFILE\0")).toBeGreaterThan(-1);
    expect(indexOfAscii(bytes, "JFIF\0")).toBeGreaterThan(-1);
    expect(bytes.length).toBeLessThan(original.length);
    expect(removed.join(" ")).toMatch(/APP1 Exif/);
    expect(removed.join(" ")).toMatch(/COM comment/);
  });

  it("leaves the stripped JPEG parseable with identical dimensions", async () => {
    const { bytes } = stripExif(makeJpeg());
    const out = await run(bytes, NO_STRIP);
    expect(out.Format).toBe("JPEG");
    expect(out.Dimensions).toBe("60 x 40 px");
    expect(out.EXIF).toBe("None found");
    expect(out.Orientation).toBeUndefined();
  });

  it("preserves the entropy coded scan data byte for byte", () => {
    const original = makeJpeg();
    const { bytes } = stripExif(original);
    const scanStart = indexOfAscii(bytes, "\x12\x34\x56");
    expect(scanStart).toBeGreaterThan(-1);
    expect([...bytes.slice(scanStart)]).toEqual([0x12, 0x34, 0x56, 0xff, 0xd9]);
  });

  it("drops tEXt chunks from a PNG and keeps IHDR and IEND", () => {
    const original = makePng();
    const { bytes, removed } = stripExif(original);
    expect(indexOfAscii(original, "tEXt")).toBeGreaterThan(-1);
    expect(indexOfAscii(bytes, "tEXt")).toBe(-1);
    expect(indexOfAscii(bytes, "IHDR")).toBe(12);
    expect(indexOfAscii(bytes, "IEND")).toBeGreaterThan(-1);
    expect(removed.join(" ")).toMatch(/tEXt chunk/);
  });

  it("emits a cleaned data URL and a summary when the strip option is on", async () => {
    const out = await run(makeJpeg(), { stripExif: true });
    expect(out["Cleaned image"]).toMatch(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/);
    expect(out.Stripped).toMatch(/Removed APP1 Exif/);
    expect(out.Stripped).toMatch(/Kept ICC color profile/);
    expect(out.Stripped).toMatch(/no quality loss/);
  });

  it("reports nothing to remove for a clean PNG", async () => {
    const clean = stripExif(makePng()).bytes;
    const out = await run(clean, { stripExif: true });
    expect(out.Stripped).toMatch(/Nothing to remove/);
  });
});

describe("image-toolbox: errors", () => {
  it("rejects pasted text that is not an image", async () => {
    await expect(run("just some notes I pasted", NO_STRIP)).rejects.toThrowError(ToolError);
    await expect(run("just some notes I pasted", NO_STRIP)).rejects.toMatchObject({
      code: "not-an-image",
    });
  });

  it("accepts pasted SVG markup as a string", async () => {
    const out = await run(SVG_TEXT, NO_STRIP);
    expect(out.Format).toBe("SVG (vector)");
  });

  it("rejects empty input", async () => {
    await expect(run(new Uint8Array(0), NO_STRIP)).rejects.toMatchObject({ code: "empty-input" });
    await expect(run("", NO_STRIP)).rejects.toMatchObject({ code: "empty-input" });
    await expect(run("   ", NO_STRIP)).rejects.toMatchObject({ code: "empty-input" });
  });

  it("rejects unknown bytes with a named guess where possible", async () => {
    await expect(run(new Uint8Array(asciiBytes("%PDF-1.7\n%abc")), NO_STRIP)).rejects.toMatchObject(
      {
        code: "unsupported-format",
      },
    );
    await expect(
      run(new Uint8Array([0x00, 0x13, 0x37, 0x99, 0xab, 0xcd, 0xef, 0x42]), NO_STRIP),
    ).rejects.toMatchObject({ code: "unsupported-format" });
  });

  it("throws a clean ToolError (never a RangeError) on truncated files", async () => {
    const truncatedPng = makePng().slice(0, 20);
    await expect(run(truncatedPng, NO_STRIP)).rejects.toThrowError(ToolError);

    const truncatedJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    await expect(run(truncatedJpeg, NO_STRIP)).rejects.toThrowError(ToolError);

    // JPEG whose SOF0 header is cut off mid-way.
    const cutSof = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00]);
    await expect(run(cutSof, NO_STRIP)).rejects.toThrowError(ToolError);

    const truncatedGif = new Uint8Array(asciiBytes("GIF89a").concat([4, 0]));
    await expect(run(truncatedGif, NO_STRIP)).rejects.toThrowError(ToolError);

    const truncatedWebp = new Uint8Array([
      ...asciiBytes("RIFF"),
      ...le32(4),
      ...asciiBytes("WEBP"),
    ]);
    await expect(run(truncatedWebp, NO_STRIP)).rejects.toThrowError(ToolError);
  });

  it("refuses to strip formats that cannot be rewritten in place", async () => {
    await expect(run(makeGif(), { stripExif: true })).rejects.toMatchObject({
      code: "strip-unsupported",
    });
    expect(() => stripExif(makeWebpLossless())).toThrowError(ToolError);
  });
});

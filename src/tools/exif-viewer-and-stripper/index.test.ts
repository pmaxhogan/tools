import { describe, expect, it } from "vitest";
import {
  cleanFilename,
  commonFields,
  detectContainer,
  parseIptc,
  prettyXml,
  readMetadata,
  run,
  stripMetadata,
} from "./index";
import { ToolError } from "../types";

/* ------------------------------------------------------------------ */
/* fixture builders                                                    */
/* ------------------------------------------------------------------ */

interface Field {
  tag: number;
  type: number;
  count: number;
  data: Uint8Array;
}

function bytesOf(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** An ASCII field, NUL terminated the way TIFF stores it. */
function asciiField(tag: number, text: string): Field {
  const data = new Uint8Array(text.length + 1);
  data.set(bytesOf(text));
  return { tag, type: 2, count: text.length + 1, data };
}

function shortField(tag: number, ...values: number[]): Field {
  const data = new Uint8Array(values.length * 2);
  const view = new DataView(data.buffer);
  values.forEach((v, i) => view.setUint16(i * 2, v, false));
  return { tag, type: 3, count: values.length, data };
}

function rationalField(tag: number, ...pairs: [number, number][]): Field {
  const data = new Uint8Array(pairs.length * 8);
  const view = new DataView(data.buffer);
  pairs.forEach(([n, d], i) => {
    view.setUint32(i * 8, n, false);
    view.setUint32(i * 8 + 4, d, false);
  });
  return { tag, type: 5, count: pairs.length, data };
}

function byteField(tag: number, ...values: number[]): Field {
  return { tag, type: 1, count: values.length, data: new Uint8Array(values) };
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 };

interface TiffSpec {
  ifd0: Field[];
  exif?: Field[];
  gps?: Field[];
  thumbnail?: Uint8Array;
}

/**
 * A big endian TIFF block with an IFD0, optional Exif and GPS sub directories,
 * and an optional IFD1 pointing at a thumbnail. Written by hand so the tests
 * depend on nothing but the bytes.
 */
function buildTiff(spec: TiffSpec): Uint8Array {
  const dirs: { fields: Field[]; dirAt: number; dataAt: number }[] = [];
  const sizeOf = (fields: Field[]): number => 2 + fields.length * 12 + 4;
  const dataSizeOf = (fields: Field[]): number =>
    fields.reduce((n, f) => {
      const size = TYPE_SIZE[f.type]! * f.count;
      return n + (size > 4 ? size + (size % 2) : 0);
    }, 0);

  // IFD0 gains a pointer field per sub directory, so lay them out after it.
  const ifd0 = spec.ifd0.slice();
  const pointerSlots: { tag: number; index: number }[] = [];
  if (spec.exif) {
    pointerSlots.push({ tag: 0x8769, index: ifd0.length });
    ifd0.push({ tag: 0x8769, type: 4, count: 1, data: new Uint8Array(4) });
  }
  if (spec.gps) {
    pointerSlots.push({ tag: 0x8825, index: ifd0.length });
    ifd0.push({ tag: 0x8825, type: 4, count: 1, data: new Uint8Array(4) });
  }

  const ifd1: Field[] = spec.thumbnail
    ? [
        shortField(0x0103, 6),
        { tag: 0x0201, type: 4, count: 1, data: new Uint8Array(4) },
        { tag: 0x0202, type: 4, count: 1, data: new Uint8Array(4) },
      ]
    : [];

  let at = 8;
  const order: Field[][] = [ifd0];
  if (spec.exif) order.push(spec.exif);
  if (spec.gps) order.push(spec.gps);
  if (spec.thumbnail) order.push(ifd1);
  for (const fields of order) {
    const dirAt = at;
    at += sizeOf(fields);
    const dataAt = at;
    at += dataSizeOf(fields);
    dirs.push({ fields, dirAt, dataAt });
  }
  const thumbnailAt = at;
  const total = at + (spec.thumbnail?.length ?? 0);

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x4d;
  bytes[1] = 0x4d;
  view.setUint16(2, 42, false);
  view.setUint32(4, dirs[0]!.dirAt, false);

  const indexOf = (fields: Field[]): number => dirs.findIndex((d) => d.fields === fields);

  dirs.forEach((dir, dirIndex) => {
    view.setUint16(dir.dirAt, dir.fields.length, false);
    let cursor = dir.dataAt;
    dir.fields.forEach((field, i) => {
      const entryAt = dir.dirAt + 2 + i * 12;
      view.setUint16(entryAt, field.tag, false);
      view.setUint16(entryAt + 2, field.type, false);
      view.setUint32(entryAt + 4, field.count, false);
      const size = TYPE_SIZE[field.type]! * field.count;
      if (size <= 4) bytes.set(field.data.subarray(0, 4), entryAt + 8);
      else {
        view.setUint32(entryAt + 8, cursor, false);
        bytes.set(field.data, cursor);
        cursor += size + (size % 2);
      }
    });
    // The IFD0 to IFD1 link, and the terminator on every other directory.
    const nextAt = dir.dirAt + 2 + dir.fields.length * 12;
    const isIfd0 = dirIndex === 0;
    const ifd1Index = spec.thumbnail ? indexOf(ifd1) : -1;
    view.setUint32(nextAt, isIfd0 && ifd1Index > 0 ? dirs[ifd1Index]!.dirAt : 0, false);
  });

  // Fill in the sub directory pointers now that every offset is known.
  for (const slot of pointerSlots) {
    const target = slot.tag === 0x8769 ? spec.exif! : spec.gps!;
    const entryAt = dirs[0]!.dirAt + 2 + slot.index * 12;
    view.setUint32(entryAt + 8, dirs[indexOf(target)]!.dirAt, false);
  }

  if (spec.thumbnail) {
    const dir = dirs[indexOf(ifd1)]!;
    const offsetEntry = dir.dirAt + 2 + 1 * 12;
    const lengthEntry = dir.dirAt + 2 + 2 * 12;
    view.setUint32(offsetEntry + 8, thumbnailAt, false);
    view.setUint32(lengthEntry + 8, spec.thumbnail.length, false);
    bytes.set(spec.thumbnail, thumbnailAt);
  }

  return bytes;
}

const THUMBNAIL = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4, 0xff, 0xd9]);

function fullTiff(): Uint8Array {
  return buildTiff({
    ifd0: [
      asciiField(0x010f, "Aperture Labs"),
      asciiField(0x0110, "Pinhole 35 Mark II"),
      shortField(0x0112, 6),
      asciiField(0x0132, "2024:09:14 17:42:08"),
      asciiField(0x0131, "sample generator"),
    ],
    exif: [
      rationalField(0x829a, [1, 250]),
      rationalField(0x829d, [56, 10]),
      shortField(0x8827, 200),
      asciiField(0x9003, "2024:09:14 17:42:08"),
      rationalField(0x920a, [35, 1]),
      shortField(0x9207, 5),
    ],
    gps: [
      byteField(0x0000, 2, 3, 0, 0),
      asciiField(0x0001, "N"),
      rationalField(0x0002, [38, 1], [37, 1], [37200, 1000]),
      asciiField(0x0003, "W"),
      rationalField(0x0004, [90, 1], [11, 1], [58000, 1000]),
      byteField(0x0005, 0),
      rationalField(0x0006, [1425, 10]),
    ],
    thumbnail: THUMBNAIL,
  });
}

/** A JPEG segment: marker, big endian length, payload. */
function segment(marker: number, payload: Uint8Array): Uint8Array {
  const length = 2 + payload.length;
  const out = new Uint8Array(4 + payload.length);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = (length >> 8) & 0xff;
  out[3] = length & 0xff;
  out.set(payload, 4);
  return out;
}

function join(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const XMP_TEXT =
  '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description><dc:title>Sample</dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';

function iptcPayload(): Uint8Array {
  const record = (dataset: number, text: string): Uint8Array => {
    const value = bytesOf(text);
    const out = new Uint8Array(5 + value.length);
    out[0] = 0x1c;
    out[1] = 2;
    out[2] = dataset;
    out[3] = (value.length >> 8) & 0xff;
    out[4] = value.length & 0xff;
    out.set(value, 5);
    return out;
  };
  const iptc = join([record(5, "Sample landscape"), record(80, "Sample Photographer")]);
  const padded = iptc.length % 2 === 1 ? join([iptc, new Uint8Array(1)]) : iptc;
  const header = bytesOf("Photoshop 3.0\0");
  const resource = new Uint8Array(12);
  resource.set(bytesOf("8BIM"), 0);
  new DataView(resource.buffer).setUint16(4, 0x0404, false);
  new DataView(resource.buffer).setUint32(8, iptc.length, false);
  return join([header, resource, padded]);
}

/** A JPEG carrying Exif, XMP, IPTC, an ICC profile, an Adobe marker, and a comment. */
function jpegFixture(): Uint8Array {
  return join([
    new Uint8Array([0xff, 0xd8]),
    segment(0xe0, join([bytesOf("JFIF\0"), new Uint8Array([1, 1, 0, 0, 1, 0, 1, 0, 0])])),
    segment(0xe1, join([bytesOf("Exif\0\0"), fullTiff()])),
    segment(0xe1, join([bytesOf("http://ns.adobe.com/xap/1.0/\0"), bytesOf(XMP_TEXT)])),
    segment(0xed, iptcPayload()),
    segment(0xe2, join([bytesOf("ICC_PROFILE\0"), new Uint8Array([1, 0, 0, 0, 12])])),
    segment(0xee, join([bytesOf("Adobe"), new Uint8Array([0, 100, 0, 0, 0, 0, 0])])),
    segment(0xfe, bytesOf("a comment nobody wanted")),
    segment(0xdb, new Uint8Array([0, 1, 2, 3])),
    new Uint8Array([0xff, 0xda, 0x00, 0x08, 1, 1, 1, 1, 1, 1]),
    new Uint8Array([0xff, 0xd9]),
  ]);
}

/**
 * A PNG chunk. The CRC is left at zero on purpose: nothing in this tool
 * validates it, and the stripper only ever copies or omits whole chunks, so
 * every surviving chunk keeps whatever CRC it arrived with.
 */
function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(bytesOf(type), 4);
  out.set(payload, 8);
  return out;
}

function pngFixture(): Uint8Array {
  return join([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", new Uint8Array(13)),
    pngChunk("tEXt", bytesOf("Author\0Sample Photographer")),
    pngChunk(
      "iTXt",
      join([
        bytesOf("Description\0"),
        new Uint8Array([0, 0]),
        bytesOf("en\0\0"),
        bytesOf("A synthetic landscape"),
      ]),
    ),
    pngChunk("eXIf", fullTiff()),
    pngChunk("iCCP", bytesOf("profile\0\0")),
    pngChunk("IDAT", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

function riffChunk(id: string, payload: Uint8Array): Uint8Array {
  const padded = payload.length % 2 === 1 ? payload.length + 1 : payload.length;
  const out = new Uint8Array(8 + padded);
  out.set(bytesOf(id.padEnd(4, " ")), 0);
  new DataView(out.buffer).setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

function webpFixture(): Uint8Array {
  const vp8x = new Uint8Array(10);
  // ICC, EXIF and XMP all advertised in the flag byte.
  vp8x[0] = 0x20 | 0x08 | 0x04;
  const body = join([
    bytesOf("WEBP"),
    riffChunk("VP8X", vp8x),
    riffChunk("ICCP", new Uint8Array([1, 2, 3, 4])),
    riffChunk("VP8 ", new Uint8Array([9, 9, 9, 9, 9])),
    riffChunk("EXIF", fullTiff()),
    riffChunk("XMP ", bytesOf(XMP_TEXT)),
  ]);
  const out = new Uint8Array(8 + body.length);
  out.set(bytesOf("RIFF"), 0);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

/* ------------------------------------------------------------------ */
/* detection                                                           */
/* ------------------------------------------------------------------ */

describe("detectContainer", () => {
  it("names each container from its magic bytes", () => {
    expect(detectContainer(jpegFixture())).toBe("jpeg");
    expect(detectContainer(pngFixture())).toBe("png");
    expect(detectContainer(webpFixture())).toBe("webp");
    expect(detectContainer(fullTiff())).toBe("tiff");
    expect(detectContainer(new Uint8Array([1, 2, 3, 4]))).toBe("unknown");
  });
});

/* ------------------------------------------------------------------ */
/* reading                                                             */
/* ------------------------------------------------------------------ */

describe("readMetadata on a JPEG", () => {
  const report = readMetadata(jpegFixture());

  function value(name: string): string | undefined {
    return report.fields.find((f) => f.name === name)?.value;
  }

  it("decodes IFD0 and the Exif sub directory", () => {
    expect(value("Make")).toBe("Aperture Labs");
    expect(value("Model")).toBe("Pinhole 35 Mark II");
    expect(value("DateTimeOriginal")).toBe("2024:09:14 17:42:08");
    expect(report.fields.some((f) => f.group === "Exif")).toBe(true);
  });

  it("prints photographic values the way a photographer writes them", () => {
    expect(value("ExposureTime")).toBe("1/250 s");
    expect(value("FNumber")).toBe("f/5.6");
    expect(value("FocalLength")).toBe("35 mm");
    expect(value("ISOSpeedRatings")).toBe("200");
  });

  it("spells out an enumeration rather than showing the bare number", () => {
    expect(value("Orientation")).toBe("6 (rotated 90 degrees clockwise)");
    expect(value("MeteringMode")).toBe("5 (pattern)");
  });

  it("converts GPS to signed decimal degrees and builds a map link", () => {
    expect(report.gps?.latitude).toBeCloseTo(38.627, 4);
    expect(report.gps?.longitude).toBeCloseTo(-90.199444, 4);
    expect(report.gps?.altitude).toBeCloseTo(142.5, 3);
    expect(report.gps?.mapUrl).toContain("openstreetmap.org");
  });

  it("pulls out the XMP packet and the IPTC datasets", () => {
    expect(report.xmp).toContain("<dc:title>Sample</dc:title>");
    expect(report.text.find((t) => t.keyword === "Object name")?.value).toBe("Sample landscape");
    expect(report.text.find((t) => t.keyword === "Byline")?.value).toBe("Sample Photographer");
  });

  it("finds the IFD1 thumbnail", () => {
    expect(Array.from(report.thumbnail ?? [])).toEqual(Array.from(THUMBNAIL));
  });

  it("lists every segment and flags only the metadata ones", () => {
    const ids = report.segments.map((s) => s.id);
    expect(ids).toContain("APP0");
    expect(ids).toContain("APP1");
    expect(ids).toContain("APP13");
    expect(ids).toContain("SOS");
    const flagged = report.segments.filter((s) => s.metadata).map((s) => s.id);
    expect(flagged).toContain("APP1");
    expect(flagged).toContain("APP13");
    expect(flagged).toContain("COM");
    expect(flagged).not.toContain("APP2");
  });
});

describe("readMetadata on a PNG", () => {
  const report = readMetadata(pngFixture());

  it("reads the eXIf chunk as a TIFF block", () => {
    expect(report.fields.find((f) => f.name === "Make")?.value).toBe("Aperture Labs");
  });

  it("reads tEXt and iTXt chunks", () => {
    expect(report.text.find((t) => t.keyword === "Author")?.value).toBe("Sample Photographer");
    expect(report.text.find((t) => t.keyword === "Description")?.value).toBe(
      "A synthetic landscape",
    );
  });

  it("flags the metadata chunks and leaves the color profile alone", () => {
    const flagged = report.segments.filter((s) => s.metadata).map((s) => s.id);
    expect(flagged.sort()).toEqual(["eXIf", "iTXt", "tEXt"]);
  });
});

describe("readMetadata on a WebP", () => {
  const report = readMetadata(webpFixture());

  it("reads the EXIF chunk and the XMP chunk", () => {
    expect(report.fields.find((f) => f.name === "Model")?.value).toBe("Pinhole 35 Mark II");
    expect(report.xmp).toContain("xmpmeta");
  });

  it("lists the RIFF chunks", () => {
    expect(report.segments.map((s) => s.id)).toEqual(["VP8X", "ICCP", "VP8", "EXIF", "XMP"]);
  });
});

describe("readMetadata edge cases", () => {
  it("reports a clean file as empty rather than as an error", () => {
    const clean = join([
      new Uint8Array([0xff, 0xd8]),
      segment(0xdb, new Uint8Array([0, 1])),
      new Uint8Array([0xff, 0xda, 0x00, 0x04, 1, 1]),
      new Uint8Array([0xff, 0xd9]),
    ]);
    const report = readMetadata(clean);
    expect(report.empty).toBe(true);
    expect(report.fields).toHaveLength(0);
  });

  it("throws on an empty input", () => {
    expect(() => readMetadata(new Uint8Array(0))).toThrow(ToolError);
    expect(() => readMetadata(new Uint8Array(0))).toThrow(/No file loaded/);
  });

  it("throws with a specific message for a HEIC and a GIF", () => {
    const heic = new Uint8Array(16);
    heic.set(bytesOf("ftyp"), 4);
    heic.set(bytesOf("heic"), 8);
    expect(() => readMetadata(heic)).toThrow(/HEIC, AVIF, or MP4/);
    expect(() => readMetadata(bytesOf("GIF89a....."))).toThrow(/GIF/);
  });

  it("throws when the Exif block has a broken byte order mark", () => {
    const broken = join([
      new Uint8Array([0xff, 0xd8]),
      segment(0xe1, join([bytesOf("Exif\0\0"), new Uint8Array([0x41, 0x41, 0, 42, 0, 0, 0, 8])])),
      new Uint8Array([0xff, 0xd9]),
    ]);
    expect(() => readMetadata(broken)).toThrow(/byte order mark/);
  });
});

describe("commonFields", () => {
  it("keeps the fields people ask about and drops the rest", () => {
    const fields = readMetadata(jpegFixture()).fields;
    const common = commonFields(fields);
    expect(common.some((f) => f.name === "Make")).toBe(true);
    expect(common.some((f) => f.name === "Compression")).toBe(false);
    expect(common.length).toBeLessThanOrEqual(fields.length);
  });
});

/* ------------------------------------------------------------------ */
/* IPTC and XMP helpers                                                */
/* ------------------------------------------------------------------ */

describe("parseIptc", () => {
  it("names the datasets it knows", () => {
    const records = parseIptc(iptcPayload());
    expect(records.map((r) => r.keyword)).toEqual(["Object name", "Byline"]);
  });

  it("returns nothing for a payload with no IPTC resource", () => {
    expect(parseIptc(bytesOf("not a photoshop block"))).toEqual([]);
  });
});

describe("prettyXml", () => {
  it("indents nested elements and keeps every character", () => {
    const out = prettyXml("<a><b>text</b><c/></a>");
    expect(out).toBe("<a>\n  <b>text</b>\n  <c/>\n</a>");
  });

  it("leaves a processing instruction at the outer level", () => {
    expect(prettyXml('<?xpacket begin=""?><a/>')).toBe('<?xpacket begin=""?>\n<a/>');
  });
});

/* ------------------------------------------------------------------ */
/* stripping                                                           */
/* ------------------------------------------------------------------ */

describe("stripMetadata on a JPEG", () => {
  const source = jpegFixture();
  const result = stripMetadata(source);

  it("removes Exif, XMP, IPTC and the comment", () => {
    expect(result.removed.join(" ")).toContain("APP1 Exif");
    expect(result.removed.join(" ")).toContain("APP1 XMP");
    expect(result.removed.join(" ")).toContain("APP13");
    expect(result.removed.join(" ")).toContain("COM");
    expect(result.bytesSaved).toBeGreaterThan(0);
  });

  it("keeps the ICC profile and the Adobe marker", () => {
    expect(result.kept.join(" ")).toContain("ICC");
    expect(result.kept.join(" ")).toContain("Adobe");
    const after = readMetadata(result.bytes);
    expect(after.segments.map((s) => s.id)).toContain("APP2");
    expect(after.segments.map((s) => s.id)).toContain("APP14");
  });

  it("leaves the cleaned file with no metadata at all", () => {
    const after = readMetadata(result.bytes);
    expect(after.empty).toBe(true);
    expect(after.gps).toBeNull();
    expect(after.xmp).toBeNull();
  });

  it("copies the scan data byte for byte and never touches the input", () => {
    const tail = Array.from(result.bytes.subarray(result.bytes.length - 12));
    expect(tail).toEqual(Array.from(source.subarray(source.length - 12)));
    expect(readMetadata(source).gps).not.toBeNull();
  });
});

describe("stripMetadata on a PNG", () => {
  const result = stripMetadata(pngFixture());

  it("removes the text and eXIf chunks and keeps the rest", () => {
    const after = readMetadata(result.bytes);
    expect(after.segments.map((s) => s.id)).toEqual(["IHDR", "iCCP", "IDAT", "IEND"]);
    expect(after.empty).toBe(true);
    expect(result.kept.join(" ")).toContain("iCCP");
  });
});

describe("stripMetadata on a WebP", () => {
  const result = stripMetadata(webpFixture());

  it("drops the EXIF and XMP chunks", () => {
    const after = readMetadata(result.bytes);
    expect(after.segments.map((s) => s.id)).toEqual(["VP8X", "ICCP", "VP8"]);
    expect(after.empty).toBe(true);
  });

  it("clears the EXIF and XMP flag bits in the VP8X header", () => {
    // The VP8X payload starts 8 bytes past the chunk header, which itself sits
    // 12 bytes into the file.
    const flags = result.bytes[12 + 8]!;
    expect(flags & 0x08).toBe(0);
    expect(flags & 0x04).toBe(0);
    expect(flags & 0x20).toBe(0x20);
  });

  it("rewrites the RIFF size to match the shorter file", () => {
    const declared = new DataView(
      result.bytes.buffer,
      result.bytes.byteOffset,
      result.bytes.byteLength,
    ).getUint32(4, true);
    expect(declared).toBe(result.bytes.length - 8);
  });
});

describe("stripMetadata refusals", () => {
  it("refuses a bare TIFF with an explanation", () => {
    expect(() => stripMetadata(fullTiff())).toThrow(ToolError);
    expect(() => stripMetadata(fullTiff())).toThrow(/metadata all the way down/);
  });

  it("refuses a format it does not know", () => {
    expect(() => stripMetadata(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a JPEG, PNG, WebP/);
  });
});

describe("cleanFilename", () => {
  it("inserts the suffix before the extension", () => {
    expect(cleanFilename("photo.jpg")).toBe("photo-clean.jpg");
    expect(cleanFilename("no-extension")).toBe("no-extension-clean");
    expect(cleanFilename("  ")).toBe("image-clean");
  });
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

describe("run", () => {
  it("reports the common fields, the GPS fix, and the segment list", () => {
    const out = run(jpegFixture(), {});
    expect(out["Format"]).toBe("JPEG");
    expect(out["IFD0 Make"]).toBe("Aperture Labs");
    expect(out["GPS coordinates"]).toMatch(/^38\.627/);
    expect(out["GPS map link"]).toContain("openstreetmap.org");
    expect(out["Segments"]).toContain("APP1");
    expect(out["Embedded thumbnail"]).toContain("JPEG preview");
  });

  it("hides uncommon tags until asked", () => {
    const brief = run(jpegFixture(), {});
    const full = run(jpegFixture(), { showAll: true });
    expect(brief["Hidden tags"]).toMatch(/more tags are present/);
    expect(Object.keys(full).length).toBeGreaterThan(Object.keys(brief).length);
    expect(full["IFD1 Compression"]).toBeDefined();
  });

  it("reports the strip when the option is on", () => {
    const out = run(jpegFixture(), { strip: true });
    expect(out["Stripped"]).toContain("APP1 Exif");
    expect(out["Kept on purpose"]).toContain("ICC");
  });

  it("says plainly when a file carries no metadata", () => {
    const clean = stripMetadata(jpegFixture()).bytes;
    expect(run(clean, {})["Metadata"]).toMatch(/^None/);
  });

  it("accepts a base64 or data URL string", () => {
    const bytes = jpegFixture();
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    const base64 = btoa(binary);
    expect(run(base64, {})["IFD0 Make"]).toBe("Aperture Labs");
    expect(run(`data:image/jpeg;base64,${base64}`, {})["IFD0 Make"]).toBe("Aperture Labs");
  });

  it("throws on text that is not an image", () => {
    expect(() => run("hello world!!", {})).toThrow(ToolError);
    expect(() => run("", {})).toThrow(/not an image/);
  });
});

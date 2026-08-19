import { describe, expect, it } from "vitest";
import exifr from "exifr";
import { run, shiftExifBytes } from "./index";
import { ToolError } from "../types";

/* ------------------------------------------------------------------ */
/* synthetic fixtures                                                  */
/* ------------------------------------------------------------------ */

interface FixtureValues {
  make?: string;
  model?: string;
  dateTime?: string;
  dateTimeOriginal?: string;
  dateTimeDigitized?: string;
}

const DEFAULTS: Required<FixtureValues> = {
  make: "Canon",
  model: "Canon EOS 5D",
  dateTime: "2023:06:15 12:00:00",
  dateTimeOriginal: "2024:02:28 23:30:00",
  dateTimeDigitized: "2024:02:28 23:30:05",
};

/** ASCII string plus its NUL terminator, as TIFF stores it. */
function asciiValue(text: string): Uint8Array {
  const out = new Uint8Array(text.length + 1);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/**
 * Build a TIFF block by hand: IFD0 with Make, Model, DateTime and the Exif
 * sub-IFD pointer, then an Exif IFD with DateTimeOriginal and DateTimeDigitized.
 * Entries stay sorted by tag, values that do not fit in four bytes live in a
 * data area after the directory, exactly like a camera writes them.
 */
function buildTiff(little: boolean, values: FixtureValues = {}): Uint8Array {
  const v = { ...DEFAULTS, ...values };
  const has = (x: string | undefined): x is string => typeof x === "string" && x.length > 0;

  interface Field {
    tag: number;
    type: number;
    data: Uint8Array;
  }

  const ifd0Fields: Field[] = [];
  if (has(v.make)) ifd0Fields.push({ tag: 0x010f, type: 2, data: asciiValue(v.make) });
  if (has(v.model)) ifd0Fields.push({ tag: 0x0110, type: 2, data: asciiValue(v.model) });
  if (has(v.dateTime)) ifd0Fields.push({ tag: 0x0132, type: 2, data: asciiValue(v.dateTime) });

  const exifFields: Field[] = [];
  if (has(v.dateTimeOriginal))
    exifFields.push({ tag: 0x9003, type: 2, data: asciiValue(v.dateTimeOriginal) });
  if (has(v.dateTimeDigitized))
    exifFields.push({ tag: 0x9004, type: 2, data: asciiValue(v.dateTimeDigitized) });

  const wantExifIfd = exifFields.length > 0;
  const ifd0Count = ifd0Fields.length + (wantExifIfd ? 1 : 0);

  // Layout: header(8) | IFD0 dir | IFD0 data | Exif dir | Exif data
  const ifd0DirAt = 8;
  const ifd0DirSize = 2 + ifd0Count * 12 + 4;
  const ifd0DataAt = ifd0DirAt + ifd0DirSize;
  const ifd0DataSize = ifd0Fields.reduce((n, f) => n + f.data.length, 0);
  const exifDirAt = ifd0DataAt + ifd0DataSize;
  const exifDirSize = wantExifIfd ? 2 + exifFields.length * 12 + 4 : 0;
  const exifDataAt = exifDirAt + exifDirSize;
  const exifDataSize = exifFields.reduce((n, f) => n + f.data.length, 0);
  const total = exifDataAt + exifDataSize;

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  const put16 = (at: number, n: number) => view.setUint16(at, n, little);
  const put32 = (at: number, n: number) => view.setUint32(at, n, little);

  // TIFF header.
  bytes[0] = little ? 0x49 : 0x4d;
  bytes[1] = little ? 0x49 : 0x4d;
  put16(2, 42);
  put32(4, ifd0DirAt);

  const writeDir = (dirAt: number, fields: Field[], dataAt: number, extra?: () => void) => {
    let cursor = dataAt;
    let entryAt = dirAt + 2;
    for (const f of fields) {
      put16(entryAt, f.tag);
      put16(entryAt + 2, f.type);
      put32(entryAt + 4, f.data.length);
      if (f.data.length <= 4) bytes.set(f.data, entryAt + 8);
      else {
        put32(entryAt + 8, cursor);
        bytes.set(f.data, cursor);
        cursor += f.data.length;
      }
      entryAt += 12;
    }
    if (extra) extra();
    return entryAt;
  };

  put16(ifd0DirAt, ifd0Count);
  const afterIfd0 = writeDir(ifd0DirAt, ifd0Fields, ifd0DataAt);
  if (wantExifIfd) {
    put16(afterIfd0, 0x8769);
    put16(afterIfd0 + 2, 4); // LONG
    put32(afterIfd0 + 4, 1);
    put32(afterIfd0 + 8, exifDirAt);
  }
  put32(ifd0DirAt + 2 + ifd0Count * 12, 0); // no IFD1

  if (wantExifIfd) {
    put16(exifDirAt, exifFields.length);
    writeDir(exifDirAt, exifFields, exifDataAt);
    put32(exifDirAt + 2 + exifFields.length * 12, 0);
  }

  return bytes;
}

/** SOI, an APP1 Exif segment wrapping the TIFF, then EOI. */
function wrapJpeg(tiff: Uint8Array): Uint8Array {
  const header = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
  const segmentLength = 2 + header.length + tiff.length;
  const out = new Uint8Array(4 + segmentLength + 2);
  out[0] = 0xff;
  out[1] = 0xd8;
  out[2] = 0xff;
  out[3] = 0xe1;
  out[4] = (segmentLength >> 8) & 0xff;
  out[5] = segmentLength & 0xff;
  out.set(header, 6);
  out.set(tiff, 6 + header.length);
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9;
  return out;
}

function jpegFixture(little: boolean, values: FixtureValues = {}): Uint8Array {
  return wrapJpeg(buildTiff(little, values));
}

const LE = () => jpegFixture(true);
const BE = () => jpegFixture(false);

/** The three datetime strings, read back straight out of the patched bytes. */
function readDatetimes(bytes: Uint8Array): string[] {
  const text = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return text.match(/\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}/g) ?? [];
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const ONE_HOUR = { days: 0, hours: 1, minutes: 0, seconds: 0 };

/** exifr types ifd0 as an options object, so {} is how you enable it. */
const EXIFR_OPTS = { ifd0: {}, exif: true, reviveValues: false };

/* ------------------------------------------------------------------ */
/* shiftExifBytes                                                      */
/* ------------------------------------------------------------------ */

describe("shiftExifBytes", () => {
  it("shifts all three datetime tags in a little endian JPEG", () => {
    const { changed } = shiftExifBytes(LE(), 3600);
    expect(changed).toEqual([
      { tag: "DateTime", from: "2023:06:15 12:00:00", to: "2023:06:15 13:00:00" },
      { tag: "DateTimeOriginal", from: "2024:02:28 23:30:00", to: "2024:02:29 00:30:00" },
      { tag: "DateTimeDigitized", from: "2024:02:28 23:30:05", to: "2024:02:29 00:30:05" },
    ]);
  });

  it("shifts all three datetime tags in a big endian JPEG", () => {
    const { changed } = shiftExifBytes(BE(), 3600);
    expect(changed.map((c) => c.to)).toEqual([
      "2023:06:15 13:00:00",
      "2024:02:29 00:30:00",
      "2024:02:29 00:30:05",
    ]);
  });

  it("crosses midnight onto the leap day 2024-02-29", () => {
    const { bytes } = shiftExifBytes(LE(), 3600);
    expect(readDatetimes(bytes)).toContain("2024:02:29 00:30:00");
  });

  it("crosses the month boundary off the leap day", () => {
    const fixture = jpegFixture(true, {
      dateTime: "2024:02:29 12:00:00",
      dateTimeOriginal: "2024:02:29 12:00:00",
      dateTimeDigitized: "2024:02:29 12:00:00",
    });
    const { changed } = shiftExifBytes(fixture, 86400);
    expect(changed.map((c) => c.to)).toEqual([
      "2024:03:01 12:00:00",
      "2024:03:01 12:00:00",
      "2024:03:01 12:00:00",
    ]);
  });

  it("crosses a year boundary on a one second shift", () => {
    const fixture = jpegFixture(false, {
      dateTime: "2023:12:31 23:59:59",
      dateTimeOriginal: "2023:12:31 23:59:59",
      dateTimeDigitized: "2023:12:31 23:59:59",
    });
    const { changed } = shiftExifBytes(fixture, 1);
    expect(changed[0].to).toBe("2024:01:01 00:00:00");
    expect(changed[1].to).toBe("2024:01:01 00:00:00");
  });

  it("shifts backwards across a non leap February", () => {
    const fixture = jpegFixture(true, {
      dateTime: "2023:03:01 00:15:00",
      dateTimeOriginal: "2023:03:01 00:15:00",
      dateTimeDigitized: "2023:03:01 00:15:00",
    });
    const { changed } = shiftExifBytes(fixture, -3600);
    expect(changed[0].to).toBe("2023:02:28 23:15:00");
  });

  it("never changes the file length and touches only the date bytes", () => {
    const input = LE();
    const { bytes } = shiftExifBytes(input, 3600);
    expect(bytes.length).toBe(input.length);
    let differing = 0;
    for (let i = 0; i < input.length; i++) if (input[i] !== bytes[i]) differing++;
    // Three timestamps, and only the hour and day digits move.
    expect(differing).toBeGreaterThan(0);
    expect(differing).toBeLessThanOrEqual(3 * 19);
  });

  it("leaves the input array untouched", () => {
    const input = LE();
    const before = Uint8Array.from(input);
    shiftExifBytes(input, 3600);
    expect(Array.from(input)).toEqual(Array.from(before));
  });

  it("accepts a bare TIFF file with no JPEG wrapper", () => {
    const { changed, bytes } = shiftExifBytes(buildTiff(true), 3600);
    expect(changed.map((c) => c.tag)).toEqual([
      "DateTime",
      "DateTimeOriginal",
      "DateTimeDigitized",
    ]);
    expect(bytes[0]).toBe(0x49);
  });

  it("leaves a blank placeholder timestamp alone", () => {
    const fixture = jpegFixture(true, {
      dateTime: "    :  :     :  :  ",
      dateTimeOriginal: "2024:02:28 23:30:00",
      dateTimeDigitized: "    :  :     :  :  ",
    });
    const { changed } = shiftExifBytes(fixture, 3600);
    expect(changed).toHaveLength(1);
    expect(changed[0].tag).toBe("DateTimeOriginal");
  });
});

/* ------------------------------------------------------------------ */
/* independent verification with exifr                                 */
/* ------------------------------------------------------------------ */

describe("exifr reads the patched file", () => {
  it("parses the shifted DateTimeOriginal back out of the little endian JPEG", async () => {
    const input = LE();
    const { bytes } = shiftExifBytes(input, 3600);

    const before = await exifr.parse(input, EXIFR_OPTS);
    expect(before?.DateTimeOriginal).toBe("2024:02:28 23:30:00");

    const after = await exifr.parse(bytes, EXIFR_OPTS);
    expect(after?.DateTimeOriginal).toBe("2024:02:29 00:30:00");
    // exifr renames 0x9004 to CreateDate and 0x0132 to ModifyDate.
    expect(after?.CreateDate ?? after?.DateTimeDigitized).toBe("2024:02:29 00:30:05");
    expect(after?.ModifyDate ?? after?.DateTime).toBe("2023:06:15 13:00:00");
    // The untouched tags survive the patch, so the structure is still valid.
    expect(after?.Make).toBe("Canon");
    expect(after?.Model).toBe("Canon EOS 5D");
  });

  it("parses the shifted big endian JPEG too", async () => {
    const { bytes } = shiftExifBytes(BE(), -90000);
    const after = await exifr.parse(bytes, EXIFR_OPTS);
    expect(after?.DateTimeOriginal).toBe("2024:02:27 22:30:00");
  });
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

describe("run", () => {
  it("returns a row per patched tag plus the shift and the camera", () => {
    const out = run(LE(), { days: 0, hours: 1, minutes: 30, seconds: 0 });
    expect(out).toEqual({
      "Shift applied": "+1 hour 30 minutes",
      DateTime: "2023:06:15 12:00:00 -> 2023:06:15 13:30:00",
      DateTimeOriginal: "2024:02:28 23:30:00 -> 2024:02:29 01:00:00",
      DateTimeDigitized: "2024:02:28 23:30:05 -> 2024:02:29 01:00:05",
      "Camera make": "Canon",
      "Camera model": "Canon EOS 5D",
      "Saving the file": expect.stringContaining("download button") as unknown as string,
    });
  });

  it("describes a negative shift with a leading minus", () => {
    const out = run(LE(), { days: -1, hours: 0, minutes: 0, seconds: -30 });
    expect(out["Shift applied"]).toBe("-1 day 30 seconds");
    expect(out.DateTimeOriginal).toBe("2024:02:28 23:30:00 -> 2024:02:27 23:29:30");
  });

  it("accepts base64 text as well as bytes", () => {
    const out = run(toBase64(LE()), ONE_HOUR);
    expect(out.DateTimeOriginal).toBe("2024:02:28 23:30:00 -> 2024:02:29 00:30:00");
  });

  it("accepts a base64 data URL", () => {
    const out = run(`data:image/jpeg;base64,${toBase64(LE())}`, ONE_HOUR);
    expect(out.DateTime).toBe("2023:06:15 12:00:00 -> 2023:06:15 13:00:00");
  });

  it("omits the camera rows when the file has no Make or Model", () => {
    const fixture = jpegFixture(true, { make: "", model: "" });
    const out = run(fixture, ONE_HOUR);
    expect(out["Camera make"]).toBeUndefined();
    expect(out["Camera model"]).toBeUndefined();
    expect(out.DateTime).toBeDefined();
  });

  it("treats missing and non numeric options as zero", () => {
    expect(() => run(LE(), {} as never)).toThrow(/shift is zero/);
    const out = run(LE(), {
      days: "" as never,
      hours: 2,
      minutes: NaN,
      seconds: undefined as never,
    });
    expect(out["Shift applied"]).toBe("+2 hours");
  });
});

/* ------------------------------------------------------------------ */
/* every ToolError branch                                              */
/* ------------------------------------------------------------------ */

describe("errors", () => {
  const expectCode = (fn: () => unknown, code: string) => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe(code);
      expect((err as ToolError).fix).toBeTruthy();
      return;
    }
    throw new Error(`expected a ToolError with code ${code}`);
  };

  it("zero-shift when every field is zero", () => {
    expectCode(() => run(LE(), { days: 0, hours: 0, minutes: 0, seconds: 0 }), "zero-shift");
    try {
      run(LE(), { days: 0, hours: 0, minutes: 0, seconds: 0 });
    } catch (err) {
      expect((err as ToolError).fix).toBe("Set at least one of days, hours, minutes or seconds.");
    }
  });

  it("empty-input for an empty string", () => {
    expectCode(() => run("", ONE_HOUR), "empty-input");
    expectCode(() => run("   \n ", ONE_HOUR), "empty-input");
  });

  it("empty-input for an empty byte array", () => {
    expectCode(() => run(new Uint8Array(0), ONE_HOUR), "empty-input");
    expectCode(() => shiftExifBytes(new Uint8Array(0), 3600), "empty-input");
  });

  it("not-base64 for pasted prose", () => {
    expectCode(() => run("this is not a photo!", ONE_HOUR), "not-base64");
  });

  it("unsupported-format for a PNG", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    expectCode(() => run(png, ONE_HOUR), "unsupported-format");
    try {
      run(png, ONE_HOUR);
    } catch (err) {
      expect((err as ToolError).fix).toContain("JPEG");
    }
  });

  it("unsupported-format for WebP and HEIC", () => {
    const webp = new Uint8Array(16);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expectCode(() => run(webp, ONE_HOUR), "unsupported-format");

    const heic = new Uint8Array(16);
    heic.set([0x66, 0x74, 0x79, 0x70], 4);
    heic.set([0x68, 0x65, 0x69, 0x63], 8);
    expectCode(() => run(heic, ONE_HOUR), "unsupported-format");
  });

  it("no-exif for a JPEG with no APP1 Exif segment", () => {
    const bare = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    expectCode(() => run(bare, ONE_HOUR), "no-exif");
  });

  it("no-exif when the only APP1 segment is XMP", () => {
    // A real XMP APP1 payload starts with its namespace URI and a NUL terminator.
    const ns = "http://ns.adobe.com/xap/1.0/";
    const xmp = new Uint8Array(ns.length + 1 + 12);
    for (let k = 0; k < ns.length; k++) xmp[k] = ns.charCodeAt(k);
    const out = new Uint8Array(4 + 2 + xmp.length + 2);
    out.set([0xff, 0xd8, 0xff, 0xe1], 0);
    const len = 2 + xmp.length;
    out[4] = (len >> 8) & 0xff;
    out[5] = len & 0xff;
    out.set(xmp, 6);
    out.set([0xff, 0xd9], out.length - 2);
    expectCode(() => run(out, ONE_HOUR), "no-exif");
  });

  it("corrupt-exif for a bad TIFF byte order mark", () => {
    const broken = wrapJpeg(new Uint8Array([0x58, 0x58, 0x00, 0x2a, 0, 0, 0, 8, 0, 0]));
    expectCode(() => run(broken, ONE_HOUR), "corrupt-exif");
  });

  it("corrupt-exif for a missing TIFF magic number", () => {
    const tiff = buildTiff(true);
    tiff[2] = 99;
    tiff[3] = 0;
    expectCode(() => run(wrapJpeg(tiff), ONE_HOUR), "corrupt-exif");
  });

  it("no-datetime when the Exif block has no datetime tags", () => {
    const fixture = jpegFixture(true, {
      dateTime: "",
      dateTimeOriginal: "",
      dateTimeDigitized: "",
    });
    expectCode(() => run(fixture, ONE_HOUR), "no-datetime");
  });

  it("out-of-range when the shifted year would need five digits", () => {
    const fixture = jpegFixture(true, {
      dateTime: "9999:12:31 23:00:00",
      dateTimeOriginal: "9999:12:31 23:00:00",
      dateTimeDigitized: "9999:12:31 23:00:00",
    });
    expectCode(
      () => run(fixture, { days: 3650, hours: 0, minutes: 0, seconds: 0 }),
      "out-of-range",
    );
  });
});

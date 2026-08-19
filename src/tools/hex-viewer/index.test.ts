import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  MAX_INPUT_BYTES,
  applyTemplate,
  detectType,
  entropy,
  entropyBlocks,
  extractStrings,
  hexDump,
  hexDumpRows,
  parseTemplate,
  run,
  toBytes,
} from "./index";
import { meta } from "./meta";
import { BUILTIN_TEMPLATES } from "./templates";

/* ------------------------------------------------------------------ */
/* fixtures                                                           */
/* ------------------------------------------------------------------ */

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

/** "Hello, hex viewer!\n" plus a NUL: 20 bytes, so the dump is two rows. */
const SAMPLE = new Uint8Array([...ascii("Hello, hex viewer!\n"), 0x00]);

/**
 * A minimal but real PNG layout: the signature, a 13 byte IHDR describing a
 * 16 by 8 RGBA image, and an empty IEND. 45 bytes in total.
 */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
  0x00, 0x00, 0x00, 0x0d, ...ascii("IHDR"),       // chunk length 13, type IHDR
  0x00, 0x00, 0x00, 0x10,                         // width 16
  0x00, 0x00, 0x00, 0x08,                         // height 8
  0x08, 0x06, 0x00, 0x00, 0x00,                   // bit depth, color type, the three zeros
  0xde, 0xad, 0xbe, 0xef,                         // crc
  0x00, 0x00, 0x00, 0x00, ...ascii("IEND"),       // chunk length 0, type IEND
  0xae, 0x42, 0x60, 0x82,                         // crc
]);

/** 64 bit little endian ELF, type EXEC, machine x86-64, entry 0x401000. */
const ELF = (() => {
  const out = new Uint8Array(64);
  out.set([0x7f, ...ascii("ELF"), 2, 1, 1, 0, 0], 0);
  const view = new DataView(out.buffer);
  view.setUint16(16, 2, true); // e_type
  view.setUint16(18, 62, true); // e_machine
  view.setUint32(20, 1, true); // e_version
  view.setBigUint64(24, 0x401000n, true); // e_entry
  view.setBigUint64(32, 0x40n, true); // e_phoff
  view.setBigUint64(40, 0x1000n, true); // e_shoff
  return out;
})();

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

/* ------------------------------------------------------------------ */
/* input decoding                                                     */
/* ------------------------------------------------------------------ */

describe("hex-viewer: input decoding", () => {
  it("passes raw bytes straight through", () => {
    expect(toBytes(SAMPLE)).toEqual({ bytes: SAMPLE, encoding: "raw bytes" });
  });

  it("reads an even run of hex digits as hex, with 0x and spacing ignored", () => {
    expect(toBytes("48 65 6c 6c 6f")).toEqual({
      bytes: bytes(0x48, 0x65, 0x6c, 0x6c, 0x6f),
      encoding: "hex text",
    });
    expect(toBytes("0xdeadbeef").bytes).toEqual(bytes(0xde, 0xad, 0xbe, 0xef));
  });

  it("reads base64 only when it carries a character hex cannot", () => {
    expect(toBytes("aGVsbG8=")).toEqual({
      bytes: new TextEncoder().encode("hello"),
      encoding: "base64 text",
    });
    expect(toBytes("data:application/octet-stream;base64,aGVsbG8=").encoding).toBe("base64 text");
  });

  it("falls back to the UTF-8 bytes of whatever was pasted", () => {
    expect(toBytes("Hello")).toEqual({
      bytes: new TextEncoder().encode("Hello"),
      encoding: "UTF-8 text",
    });
    // Two bytes in UTF-8, and not mistaken for hex or base64.
    expect(toBytes("é").bytes).toEqual(bytes(0xc3, 0xa9));
  });
});

/* ------------------------------------------------------------------ */
/* hex dump                                                           */
/* ------------------------------------------------------------------ */

describe("hex-viewer: hexDump", () => {
  it("renders a 20 byte sample as two padded rows", () => {
    const expected = [
      "00000000  48 65 6c 6c 6f 2c 20 68  65 78 20 76 69 65 77 65  |Hello, hex viewe|",
      `00000010  72 21 0a 00${" ".repeat(39)}|r!..|`,
    ].join("\n");
    expect(hexDump(SAMPLE)).toBe(expected);
  });

  it("honours uppercase, bytesPerRow, and a starting offset", () => {
    expect(hexDump(SAMPLE, { bytesPerRow: 8, uppercase: true, offset: 16 })).toBe(
      `00000010  72 21 0A 00${" ".repeat(14)}|r!..|`,
    );
  });

  it("drops the gutter and the padding when ascii is off", () => {
    expect(hexDump(SAMPLE, { offset: 18, ascii: false })).toBe("00000012  0a 00");
  });

  it("returns structured rows with one hex cell per real byte", () => {
    const rows = hexDumpRows(SAMPLE);
    expect(rows).toHaveLength(2);
    expect(rows[0].offset).toBe(0);
    expect(rows[0].hex).toHaveLength(16);
    expect(rows[0].ascii).toBe("Hello, hex viewe");
    expect(rows[1]).toEqual({ offset: 16, hex: ["72", "21", "0a", "00"], ascii: "r!.." });
  });
});

/* ------------------------------------------------------------------ */
/* templates: parsing                                                 */
/* ------------------------------------------------------------------ */

describe("hex-viewer: parseTemplate", () => {
  it("parses fields, comments, blocks, and field backed counts", () => {
    const nodes = parseTemplate(`# a header
u8 count      # trailing comment
bytes[count] payload
@0x10
repeat * {
  u16le pair
}
`);
    expect(nodes.map((n) => n.kind)).toEqual(["field", "field", "seek", "repeat"]);
    expect(nodes[1]).toMatchObject({
      kind: "field",
      type: "bytes",
      name: "payload",
      count: { literal: null, field: "count", delta: 0 },
    });
    expect(nodes[2]).toMatchObject({ kind: "seek", to: { literal: 16, delta: 0 } });
  });

  it("parses a constant added to a field reference", () => {
    const nodes = parseTemplate("skip size - 8");
    expect(nodes[0]).toMatchObject({ kind: "skip", amount: { field: "size", delta: -8 } });
  });

  it("every built in template parses", () => {
    for (const template of BUILTIN_TEMPLATES) {
      expect(() => parseTemplate(template.text), template.id).not.toThrow();
    }
  });

  it("rejects an unknown type and names the line", () => {
    try {
      parseTemplate("u8 version\nu24le weird\n");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("bad-template");
      expect((error as ToolError).message).toContain("Line 2");
      expect((error as ToolError).message).toContain('"u24le" is not a known field type');
    }
  });

  it("rejects a sized type with no length and a fixed type with one", () => {
    expect(() => parseTemplate("bytes hash")).toThrowError(/needs a length in brackets/);
    expect(() => parseTemplate("u8[4] version")).toThrowError(/takes no length in brackets/);
  });

  it("rejects an unbalanced block and a stray brace", () => {
    expect(() => parseTemplate("repeat 2 {\n  u8 a\n")).toThrowError(/never closed/);
    expect(() => parseTemplate("u8 a\n}\n")).toThrowError(/no open block/);
  });

  it("rejects an empty template and a line that is not a statement", () => {
    expect(() => parseTemplate("   ")).toThrowError(/template is empty/);
    expect(() => parseTemplate("u8 a\nhello there you\n")).toThrowError(/Line 2/);
  });
});

/* ------------------------------------------------------------------ */
/* templates: applying                                                */
/* ------------------------------------------------------------------ */

describe("hex-viewer: applyTemplate", () => {
  it("parses a PNG signature and IHDR from a hand written template", () => {
    const result = applyTemplate(
      PNG,
      parseTemplate(`bytes[8] signature
u32be ihdrLength
char[4] ihdrType
u32be width
u32be height
u8 bitDepth
u8 colorType
`),
    );
    expect(result.warnings).toEqual([]);
    expect(result.endOffset).toBe(26);
    expect(result.fields.map((f) => [f.name, f.value])).toEqual([
      ["signature", "89504e470d0a1a0a"],
      ["ihdrLength", 13],
      ["ihdrType", "IHDR"],
      ["width", 16],
      ["height", 8],
      ["bitDepth", 8],
      ["colorType", 6],
    ]);
    expect(result.fields[3]).toMatchObject({ type: "u32be", offset: 16, size: 4, hex: "00000010" });
  });

  it("walks every chunk with the built in PNG template", () => {
    const png = BUILTIN_TEMPLATES.find((t) => t.id === "png");
    const result = applyTemplate(PNG, parseTemplate(png?.text ?? ""));
    expect(result.warnings).toEqual([]);
    expect(result.endOffset).toBe(PNG.length);
    const byName = new Map(result.fields.map((f) => [f.name, f.value]));
    expect(byName.get("width")).toBe(16);
    expect(byName.get("height")).toBe(8);
    // The repeat picked up exactly the one chunk after IHDR.
    expect(byName.get("type[0]")).toBe("IEND");
    expect(byName.get("length[0]")).toBe(0);
    expect(byName.has("type[1]")).toBe(false);
  });

  it("reads the ELF ident and takes only the branch its class selects", () => {
    const elf = BUILTIN_TEMPLATES.find((t) => t.id === "elf");
    const result = applyTemplate(ELF, parseTemplate(elf?.text ?? ""));
    const byName = new Map(result.fields.map((f) => [f.name, f.value]));
    expect(byName.get("magic")).toBe(".ELF");
    expect(byName.get("class")).toBe(2);
    expect(byName.get("endian")).toBe(1);
    expect(byName.get("type")).toBe(2);
    expect(byName.get("machine")).toBe(62);
    expect(byName.get("entryPoint")).toBe(0x401000n);
    // The 32 bit branch never ran, so entryPoint was written exactly once.
    expect(result.fields.filter((f) => f.name === "entryPoint")).toHaveLength(1);
    expect(result.endOffset).toBe(48);
  });

  it("repeats a block the number of times a earlier field says", () => {
    const data = bytes(3, 1, 0, 2, 0, 3, 0);
    const result = applyTemplate(
      data,
      parseTemplate("u8 count\nrepeat count {\n  u16le value\n}\n"),
    );
    expect(result.fields.map((f) => f.name)).toEqual([
      "count",
      "value[0]",
      "value[1]",
      "value[2]",
    ]);
    expect(result.fields.map((f) => f.value)).toEqual([3, 1, 2, 3]);
    expect(result.endOffset).toBe(7);
  });

  it("handles skip, align, seek, cstring, octal and a string comparison", () => {
    const data = new Uint8Array([
      ...ascii("AB"), 0x07, 0x00, // tag, flags, one byte of padding for align 4
      0x02, 0x00, 0x00, 0x00, // count
      ...ascii("hi"), 0x00, // cstring
      0xde, 0xad, // tail
      0x99, // only read when the if matches
    ]);
    const result = applyTemplate(
      data,
      parseTemplate(`char[2] tag
u8 flags
align 4
u32le count
cstring label
bytes[2] tail
if tag == "AB" {
  u8 extra
}
`),
    );
    expect(result.warnings).toEqual([]);
    expect(result.fields.map((f) => [f.name, f.value])).toEqual([
      ["tag", "AB"],
      ["flags", 7],
      ["count", 2],
      ["label", "hi"],
      ["tail", "dead"],
      ["extra", 0x99],
    ]);
    expect(result.endOffset).toBe(14);
  });

  it("reads tar style ASCII octal as an ordinary number", () => {
    const data = new Uint8Array([...ascii("0000644"), 0x00]);
    const result = applyTemplate(data, parseTemplate("octal[8] mode"));
    expect(result.fields[0]).toMatchObject({ name: "mode", type: "octal[8]", value: "420" });
  });

  it("stops an unbounded repeat cleanly at an exact boundary", () => {
    const result = applyTemplate(bytes(1, 0, 2, 0), parseTemplate("repeat * {\n  u16le pair\n}\n"));
    expect(result.warnings).toEqual([]);
    expect(result.fields).toHaveLength(2);
    expect(result.endOffset).toBe(4);
  });

  it("warns instead of throwing when an unbounded repeat runs out mid record", () => {
    const result = applyTemplate(bytes(1, 0, 2, 0, 9), parseTemplate("repeat * {\n  u16le pair\n}\n"));
    expect(result.fields).toHaveLength(2);
    expect(result.endOffset).toBe(4);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("stopped after 2 full passes");
  });

  it("stops an unbounded repeat whose body reads nothing", () => {
    const result = applyTemplate(new Uint8Array(8), parseTemplate("repeat * {\n  align 4\n}\n"));
    expect(result.fields).toEqual([]);
    expect(result.warnings[0]).toContain("read no bytes");
  });

  it("starts where startOffset says", () => {
    const result = applyTemplate(PNG, parseTemplate("u32be width"), 16);
    expect(result.fields[0]).toMatchObject({ name: "width", offset: 16, value: 16 });
  });

  it("reads correctly from a subarray view of a larger buffer", () => {
    const padded = new Uint8Array(PNG.length + 5);
    padded.set(PNG, 5);
    const viewOnly = padded.subarray(5);
    const result = applyTemplate(viewOnly, parseTemplate("bytes[8] signature\nu32be len"));
    expect(result.fields[0].value).toBe("89504e470d0a1a0a");
    expect(result.fields[1].value).toBe(13);
  });

  it("walks MP4 atoms, which needs the constant subtracted from a field", () => {
    const mp4 = new Uint8Array([
      0x00, 0x00, 0x00, 0x10, ...ascii("ftyp"), ...ascii("isom   "),
      0x00, 0x00, 0x00, 0x08, ...ascii("free"),
    ]);
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "mp4");
    const result = applyTemplate(mp4, parseTemplate(template?.text ?? ""));
    expect(result.warnings).toEqual([]);
    expect(result.endOffset).toBe(24);
    expect(result.fields.map((f) => [f.name, f.value])).toEqual([
      ["size[0]", 16],
      ["type[0]", "ftyp"],
      ["size[1]", 8],
      ["type[1]", "free"],
    ]);
  });

  it("reads a ZIP file name whose length comes from an earlier field", () => {
    const zip = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, // signature
      0x14, 0x00, 0x00, 0x00, 0x08, 0x00, // versionNeeded, flags, method
      0x00, 0x00, 0x00, 0x00, // modTime, modDate
      0x78, 0x56, 0x34, 0x12, // crc32
      0x64, 0x00, 0x00, 0x00, // compressedSize 100
      0xc8, 0x00, 0x00, 0x00, // uncompressedSize 200
      0x05, 0x00, // nameLength 5
      0x00, 0x00, // extraLength 0
      ...ascii("a.txt"),
    ]);
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "zip");
    const result = applyTemplate(zip, parseTemplate(template?.text ?? ""));
    const byName = new Map(result.fields.map((f) => [f.name, f.value]));
    expect(byName.get("nameLength")).toBe(5);
    expect(byName.get("fileName")).toBe("a.txt");
    expect(byName.get("uncompressedSize")).toBe(200);
    expect(byName.get("extraField")).toBe("");
    expect(result.endOffset).toBe(zip.length);
  });

  it("throws template-overflow naming the field that ran off the end", () => {
    try {
      applyTemplate(bytes(3, 1, 0), parseTemplate("u8 count\nrepeat count {\n  u16le value\n}\n"));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("template-overflow");
      expect((error as ToolError).message).toContain('Field "value[1]"');
      expect((error as ToolError).message).toContain("line 3");
    }
  });

  it("rejects a forward reference to a field that has not been read", () => {
    expect(() => applyTemplate(bytes(1, 2, 3, 4), parseTemplate("bytes[later] head\nu8 later"))).toThrowError(
      /has not been parsed yet/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* detection, strings, entropy                                        */
/* ------------------------------------------------------------------ */

describe("hex-viewer: detectType", () => {
  it("identifies the formats that have a template", () => {
    expect(detectType(PNG)).toEqual({ id: "png", label: "PNG image", templateId: "png" });
    expect(detectType(ZIP)).toEqual({ id: "zip", label: "ZIP archive", templateId: "zip" });
    expect(detectType(ELF)).toMatchObject({ id: "elf", templateId: "elf" });
  });

  it("matches a signature that is not at offset zero", () => {
    const mp4 = new Uint8Array([0, 0, 0, 0x18, ...ascii("ftypisom")]);
    expect(detectType(mp4)).toMatchObject({ id: "mp4", templateId: "mp4" });
  });

  it("returns null when nothing matches", () => {
    expect(detectType(bytes(0x01, 0x02, 0x03, 0x04))).toBeNull();
  });
});

describe("hex-viewer: extractStrings", () => {
  const data = new Uint8Array([0x00, 0x00, ...ascii("Hello"), 0x00, ...ascii("world"), 0x01]);

  it("lists printable ASCII runs with their offsets", () => {
    expect(extractStrings(data)).toEqual([
      { offset: 2, text: "Hello", encoding: "ascii" },
      { offset: 8, text: "world", encoding: "ascii" },
    ]);
  });

  it("respects minLength and the cap", () => {
    expect(extractStrings(data, { minLength: 6 })).toEqual([]);
    expect(extractStrings(data, { limit: 1 })).toHaveLength(1);
  });

  it("finds UTF-16LE runs", () => {
    const wide = new Uint8Array([]);
    const source = [...ascii("Menu")].flatMap((c) => [c, 0x00]);
    const found = extractStrings(new Uint8Array([...wide, ...source]), { encoding: "utf16le" });
    expect(found).toEqual([{ offset: 0, text: "Menu", encoding: "utf16le" }]);
  });
});

describe("hex-viewer: entropy", () => {
  it("is zero for a run of one byte value and eight for a flat histogram", () => {
    expect(entropy(new Uint8Array(1024))).toBe(0);
    const flat = new Uint8Array(256);
    for (let i = 0; i < 256; i++) flat[i] = i;
    expect(entropy(flat)).toBe(8);
    expect(entropy(new Uint8Array(0))).toBe(0);
  });

  it("splits a file into per block readings", () => {
    const flat = new Uint8Array(512);
    for (let i = 0; i < 256; i++) flat[i] = i;
    expect(entropyBlocks(flat, 256)).toEqual([8, 0]);
  });
});

/* ------------------------------------------------------------------ */
/* run: the four views                                                */
/* ------------------------------------------------------------------ */

describe("hex-viewer: run", () => {
  it("dumps by default", () => {
    const output = run(SAMPLE, {});
    expect(typeof output).toBe("string");
    expect(output as string).toContain("00000000  48 65 6c 6c 6f");
    expect(output as string).toContain("|Hello, hex viewe|");
  });

  it("notes the window when a start offset moves it", () => {
    const output = run(SAMPLE, { view: "dump", offset: 16 }) as string;
    expect(output).toContain("00000010  72 21 0a 00");
    expect(output).toContain("Showing 4 bytes of 20 bytes");
  });

  it("pulls the window back when the offset is past the end", () => {
    const output = run(SAMPLE, { view: "dump", offset: 500 }) as string;
    expect(output).toContain("is past the end");
    expect(output).toContain("00000013  00");
  });

  it("applies the template the magic bytes point at", () => {
    const rows = run(PNG, { view: "template" }) as Record<string, string>;
    expect(rows.Template).toBe("PNG image (matched by magic bytes)");
    expect(rows["Detected type"]).toBe("PNG image");
    expect(rows.width).toBe("16 (u32be @ 0x10, raw 00000010)");
    expect(rows["type[0]"]).toBe("IEND (char[4] @ 0x25, raw 49454e44)");
  });

  it("applies a custom template when asked", () => {
    const rows = run(PNG, {
      view: "template",
      template: "custom",
      customTemplate: "@8\nu32be length\nchar[4] type",
    }) as Record<string, string>;
    expect(rows.Template).toBe("Custom");
    expect(rows.length).toBe("13 (u32be @ 0x8, raw 0000000d)");
    expect(rows.type).toBe("IHDR (char[4] @ 0xc, raw 49484452)");
  });

  it("says so rather than erroring when no built in template fits", () => {
    const rows = run(bytes(1, 2, 3, 4, 5, 6), { view: "template" }) as Record<string, string>;
    expect(rows.Template).toContain("No built in template matches");
    expect(rows["Detected type"]).toBe("Not recognized by magic bytes");
  });

  it("lists both ASCII and UTF-16LE strings", () => {
    const output = run(SAMPLE, { view: "strings" }) as string;
    expect(output).toContain("ASCII runs of 4 characters or more: 1");
    expect(output).toContain("00000000  Hello, hex viewer!");
    expect(output).toContain("UTF-16LE runs of 4 characters or more: 0");
  });

  it("summarises the file", () => {
    const rows = run(PNG, { view: "info" }) as Record<string, string>;
    expect(rows.Size).toBe("45 bytes");
    expect(rows.Input).toBe("raw bytes");
    expect(rows["Detected type"]).toBe("PNG image");
    expect(rows["Suggested template"]).toBe("PNG image");
    expect(rows["SHA-256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(rows["First 16 bytes"]).toBe(
      "89 50 4e 47 0d 0a 1a 0a 00 00 00 0d 49 48 44 52  |.PNG........IHDR|",
    );
    expect(rows.Entropy).toMatch(/^\d\.\d{3} bits per byte, /);
    expect(rows["Entropy map"]).toContain("(1 block of 45 bytes, low to high)");
  });

  it("accepts pasted hex and reports it as such", () => {
    const rows = run("89504e470d0a1a0a", { view: "info" }) as Record<string, string>;
    expect(rows.Input).toBe("hex text");
    expect(rows["Detected type"]).toBe("PNG image");
  });
});

/* ------------------------------------------------------------------ */
/* every ToolError branch                                             */
/* ------------------------------------------------------------------ */

describe("hex-viewer: errors", () => {
  it("empty-input for no bytes at all", () => {
    for (const input of ["", "   ", new Uint8Array(0)]) {
      try {
        run(input, {});
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ToolError);
        expect((error as ToolError).code).toBe("empty-input");
        expect((error as ToolError).fix).toBeTruthy();
      }
    }
  });

  it("bad-template for an empty custom template", () => {
    try {
      run(PNG, { view: "template", template: "custom", customTemplate: "  " });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ToolError).code).toBe("bad-template");
      expect((error as ToolError).message).toContain("custom template is empty");
    }
  });

  it("bad-template for a line the parser cannot read", () => {
    try {
      run(PNG, { view: "template", template: "custom", customTemplate: "u8 ok\nnot a field\n" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ToolError).code).toBe("bad-template");
      expect((error as ToolError).message).toContain("Line 2");
    }
  });

  it("template-overflow when the template outruns the file", () => {
    try {
      run(bytes(1, 2, 3), { view: "template", template: "custom", customTemplate: "bytes[64] blob" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ToolError).code).toBe("template-overflow");
      expect((error as ToolError).message).toContain('Field "blob"');
    }
  });

  it("too-large past the 64 MB ceiling", () => {
    try {
      run(new Uint8Array(MAX_INPUT_BYTES + 1), {});
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ToolError).code).toBe("too-large");
      expect((error as ToolError).message).toContain("over the 64 MB limit");
    }
  });
});

/* ------------------------------------------------------------------ */
/* meta                                                               */
/* ------------------------------------------------------------------ */

describe("hex-viewer: meta", () => {
  it("lists exactly the built in template ids plus auto and custom", () => {
    const spec = meta.options?.find((o) => o.id === "template");
    const values: string[] = [];
    const walkGroups = (groups: { options?: { value: string }[] }[] | undefined) => {
      for (const group of groups ?? []) {
        for (const option of group.options ?? []) values.push(option.value);
      }
    };
    walkGroups(spec && "groups" in spec ? spec.groups : undefined);
    expect(values.sort()).toEqual(
      ["auto", "custom", ...BUILTIN_TEMPLATES.map((t) => t.id)].sort(),
    );
  });

  it("has no em or en dashes in its user facing prose", () => {
    const prose = [
      meta.description,
      meta.copy.what,
      meta.copy.how,
      meta.copy.why,
      ...meta.copy.faq.flatMap((f) => [f.q, f.a]),
      ...BUILTIN_TEMPLATES.map((t) => t.text),
    ].join(" ");
    expect(prose).not.toMatch(/[–—]/);
    expect(meta.copy.faq).toHaveLength(3);
  });
});

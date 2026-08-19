import { encode as encodeMsgpack } from "@msgpack/msgpack";
import { encode as encodeCbor } from "cbor-x";
import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { asPrintableText, decodeProtobuf, renderJson, run, toBytes, toJsonValue } from "./index";

/**
 * The CBOR and msgpack fixtures are round trips through the real encoders. The
 * protobuf fixtures are hand built byte arrays with the layout commented at the
 * construction site, because the whole point of the tool is that there is no
 * schema and no encoder to lean on.
 */

const AUTO = { format: "auto" };

/** A message exercising every wire type this decoder reads. */
// prettier-ignore
const PB_ALL = Uint8Array.from([
  0x08, 0x96, 0x01,                                     // 1: varint 150
  0x12, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f,             // 2: string "hello"
  0x1a, 0x04, 0x08, 0x2a, 0x10, 0x01,                   // 3: nested message { 1: 42, 2: 1 }
  0x20, 0x01,                                           // 4: varint 1
  0x20, 0x02,                                           // 4: varint 2, repeated
  0x29, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f, // 5: fixed64, double 1.0
  0x35, 0x00, 0x00, 0x80, 0x3f,                         // 6: fixed32, float 1.0
  0x3a, 0x03, 0xff, 0xfe, 0xfd,                         // 7: bytes that are not valid UTF-8
  0x40, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, // 8: varint 2^64 - 1
]);

/** The smallest useful message: field 1, a length delimited "hi". */
const PB_SMALL = Uint8Array.from([0x0a, 0x02, 0x68, 0x69]);

function hexOf(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function decodedOf(rows: Record<string, string>): unknown {
  return JSON.parse(rows.Decoded);
}

describe("protobuf-decoder: protobuf wire format", () => {
  it("decodes every wire type into keyed rows", () => {
    const rows = run(PB_ALL, { format: "protobuf" });
    expect(rows.Format).toBe("Protobuf");
    expect(rows["Byte length"]).toBe("50 bytes");
    expect(rows["Top level fields"]).toBe("9 (field numbers 1, 2, 3, 4, 5, 6, 7, 8)");
    expect(rows["Opaque fields"]).toBe(
      "1 shown as a hex preview: not readable text and not a nested message",
    );
    expect(decodedOf(rows)).toEqual({
      "1 (varint)": 150,
      "2 (string)": "hello",
      "3 (message)": { "1 (varint)": 42, "2 (varint)": 1 },
      "4 (varint)": [1, 2],
      "5 (fixed64)": { uint: "4607182418800017408", double: 1 },
      "6 (fixed32)": { uint: 1065353216, float: 1 },
      "7 (bytes)": { $bytes: "fffefd", length: 3 },
      "8 (varint)": "18446744073709551615",
    });
  });

  it("pretty prints the decoded JSON with two space indent", () => {
    const rows = run(PB_SMALL, { format: "protobuf" });
    expect(rows.Decoded).toBe('{\n  "1 (string)": "hi"\n}');
  });

  it("reads a repeated field number as an array only when it repeats", () => {
    // 1: varint 7, then 1: varint 8, then 2: varint 9
    const rows = run(Uint8Array.from([0x08, 0x07, 0x08, 0x08, 0x10, 0x09]), { format: "protobuf" });
    expect(decodedOf(rows)).toEqual({ "1 (varint)": [7, 8], "2 (varint)": 9 });
  });

  it("recurses into nested messages and stops at the depth limit", () => {
    // Three levels: 1 { 1 { 1: "ok" } }
    const inner = [0x0a, 0x02, 0x6f, 0x6b];
    const mid = [0x0a, inner.length, ...inner];
    const rows = run(Uint8Array.from([0x0a, mid.length, ...mid]), { format: "protobuf" });
    expect(decodedOf(rows)).toEqual({
      "1 (message)": { "1 (message)": { "1 (string)": "ok" } },
    });
  });

  it("keeps an unreadable payload as a hex preview with its full length", () => {
    const blob = new Uint8Array(80).fill(0xff);
    const rows = run(Uint8Array.from([0x0a, 80, ...blob]), { format: "protobuf" });
    expect(decodedOf(rows)).toEqual({
      "1 (bytes)": { $bytes: "ff".repeat(64), length: 80, truncated: true },
    });
  });

  it("reads strictly printable bytes as a string even when they parse as a message", () => {
    // "hi" is 0x68 0x69, which is also a valid message (field 13, varint 105).
    // Strictly printable text wins, because a short string is far and away the
    // more common payload.
    expect(decodedOf(run(PB_SMALL, { format: "protobuf" }))).toEqual({ "1 (string)": "hi" });
  });

  it("reads a nested message whose tag and length bytes look like whitespace", () => {
    // Payload 0x0a 0x0a "0123456789" is a real nested message, but a lenient
    // text check would read the leading tag and length as two newlines and call
    // the whole thing a string. Tabs and newlines are why the string tier is
    // strict.
    const digits = [0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39];
    const payload = [0x0a, 0x0a, ...digits];
    const rows = run(Uint8Array.from([0x0a, payload.length, ...payload]), { format: "protobuf" });
    expect(decodedOf(rows)).toEqual({ "1 (message)": { "1 (string)": "0123456789" } });
  });

  it("falls back to text with newlines when the payload is not a message", () => {
    // "a\nb" is not a valid message (0x61 opens a fixed64 with only 2 bytes left).
    const rows = run(Uint8Array.from([0x0a, 0x03, 0x61, 0x0a, 0x62]), { format: "protobuf" });
    expect(decodedOf(rows)).toEqual({ "1 (string)": "a\nb" });
  });

  it("treats an empty length delimited field as an empty string", () => {
    const rows = run(Uint8Array.from([0x0a, 0x00]), { format: "protobuf" });
    expect(decodedOf(rows)).toEqual({ "1 (string)": "" });
  });

  it("rejects field number zero, reserved wire types, and truncated payloads", () => {
    expect(decodeProtobuf(Uint8Array.from([0x00, 0x01]))).toBeNull(); // field 0
    expect(decodeProtobuf(Uint8Array.from([0x0b, 0x01]))).toBeNull(); // wire type 3 (group)
    expect(decodeProtobuf(Uint8Array.from([0x0a, 0x05, 0x61]))).toBeNull(); // length runs off the end
    expect(decodeProtobuf(Uint8Array.from([0x08]))).toBeNull(); // varint with no value
  });

  it("reads text only when it is valid UTF-8 without control characters", () => {
    expect(asPrintableText(Uint8Array.from([0x68, 0x69]))).toBe("hi");
    expect(asPrintableText(Uint8Array.from([0xc3, 0xa9]))).toBe("é");
    expect(asPrintableText(Uint8Array.from([0xff, 0xfe]))).toBeNull(); // not UTF-8
    expect(asPrintableText(Uint8Array.from([0x61, 0x00]))).toBeNull(); // NUL byte
  });
});

describe("protobuf-decoder: CBOR", () => {
  const cbor = new Uint8Array(
    encodeCbor({
      id: 7,
      name: "wire",
      tags: ["a", "b"],
      when: new Date(0),
      blob: new Uint8Array([1, 2, 3]),
      big: 12345678901234567890n,
      nothing: null,
    }),
  );

  it("decodes a CBOR map, with bytes, dates, and bignums rendered safely", () => {
    const rows = run(cbor, { format: "cbor" });
    expect(rows.Format).toBe("CBOR");
    expect(decodedOf(rows)).toEqual({
      id: 7,
      name: "wire",
      tags: ["a", "b"],
      when: "1970-01-01T00:00:00.000Z",
      blob: { $bytes: "010203", length: 3 },
      big: "12345678901234567890",
      nothing: null,
    });
  });

  it("auto detects CBOR from the map header", () => {
    const rows = run(cbor, AUTO);
    expect(rows.Format).toBe("CBOR (auto detected)");
    expect(rows.Detection).toContain("CBOR map header");
    expect(rows["Also decodes as"]).toBeUndefined();
  });
});

describe("protobuf-decoder: msgpack", () => {
  const packed = new Uint8Array(
    encodeMsgpack({ id: 7, name: "wire", tags: ["a", "b"], blob: new Uint8Array([1, 2, 3]) }),
  );

  it("decodes a msgpack map", () => {
    const rows = run(packed, { format: "msgpack" });
    expect(rows.Format).toBe("MessagePack");
    expect(rows["Byte length"]).toBe("35 bytes");
    expect(decodedOf(rows)).toEqual({
      id: 7,
      name: "wire",
      tags: ["a", "b"],
      blob: { $bytes: "010203", length: 3 },
    });
  });

  it("keeps a 64 bit msgpack integer exact", () => {
    const big = new Uint8Array(encodeMsgpack({ big: 2n ** 63n - 1n }, { useBigInt64: true }));
    expect(decodedOf(run(big, { format: "msgpack" }))).toEqual({ big: "9223372036854775807" });
  });

  it("auto detects msgpack from the fixmap header", () => {
    const rows = run(packed, AUTO);
    expect(rows.Format).toBe("MessagePack (auto detected)");
    expect(rows.Detection).toContain("msgpack map header");
  });
});

describe("protobuf-decoder: auto detection", () => {
  it("prefers protobuf when the tags line up and nothing is left over", () => {
    const rows = run(PB_ALL, AUTO);
    expect(rows.Format).toBe("Protobuf (auto detected)");
    expect(rows.Detection).toBe(
      "first byte 0x08 is a protobuf field key (field 1, varint), and every byte was consumed with nothing left over.",
    );
  });

  it("notes the ambiguity when a short payload decodes as more than one format", () => {
    const rows = run(Uint8Array.from([0x01]), AUTO);
    expect(rows.Format).toBe("CBOR (auto detected)");
    expect(rows["Also decodes as"]).toContain("MessagePack");
    expect(rows["Also decodes as"]).toContain("share byte patterns");
    expect(rows.Decoded).toBe("1");
  });

  it("lets a clean CBOR decode beat a protobuf parse that fell back to hex", () => {
    // 0xa1 0x61 0x78 0xf5 is CBOR { "x": true }. As protobuf it is field 20,
    // wire type 1 is ruled out, so this leans on the byte level ordering rather
    // than on protobuf winning by position.
    const bytes = new Uint8Array(encodeCbor({ x: true }));
    const rows = run(bytes, AUTO);
    expect(rows.Format).toBe("CBOR (auto detected)");
    expect(decodedOf(rows)).toEqual({ x: true });
  });

  it("still reports a protobuf message whose payload could only be shown as hex", () => {
    const rows = run(Uint8Array.from([0x0a, 0x02, 0xff, 0xfe]), AUTO);
    expect(rows.Format).toBe("Protobuf (auto detected)");
    expect(rows["Opaque fields"]).toContain("1 shown as a hex preview");
  });
});

describe("protobuf-decoder: text input", () => {
  it("accepts a hex dump with a 0x prefix and whitespace", () => {
    const rows = run(`0x${hexOf(PB_SMALL)}`, AUTO);
    expect(rows.Input).toBe("hex text");
    expect(decodedOf(rows)).toEqual({ "1 (string)": "hi" });
    expect(run(" 0a 02 68 69 ", AUTO).Decoded).toBe(rows.Decoded);
  });

  it("accepts base64 and base64url", () => {
    const cbor = new Uint8Array(encodeCbor({ ok: true }));
    const rows = run(base64Of(cbor), AUTO);
    expect(rows.Input).toBe("base64 text");
    expect(decodedOf(rows)).toEqual({ ok: true });

    const urlSafe = base64Of(Uint8Array.from([0xfb, 0xef, 0xbe]))
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(toBytes(urlSafe).bytes).toEqual(Uint8Array.from([0xfb, 0xef, 0xbe]));
  });

  it("reads an all hex string as hex rather than base64", () => {
    expect(toBytes("deadbeef")).toEqual({
      bytes: Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
      encoding: "hex",
    });
  });

  it("accepts a base64 data URL", () => {
    const url = `data:application/octet-stream;base64,${base64Of(PB_SMALL)}`;
    expect(toBytes(url).bytes).toEqual(PB_SMALL);
  });
});

describe("protobuf-decoder: JSON rendering", () => {
  it("never crashes on values JSON.stringify cannot take", () => {
    const map = new Map<unknown, unknown>([
      ["a", 1n],
      [{}, "first object key"],
      [{}, "second object key"],
    ]);
    expect(toJsonValue(map)).toEqual({
      a: "1",
      "[object]": "first object key",
      "[object] #2": "second object key",
    });
    expect(toJsonValue(new Set([1, 2]))).toEqual([1, 2]);
    expect(toJsonValue(Number.NaN)).toBe("NaN");
    expect(toJsonValue(Number.POSITIVE_INFINITY)).toBe("Infinity");
    expect(toJsonValue(undefined)).toBeNull();
    expect(renderJson(undefined)).toBe("null");
  });

  it("breaks reference cycles instead of overflowing the stack", () => {
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    expect(renderJson(loop)).toBe('{\n  "name": "loop",\n  "self": "[circular reference]"\n}');
  });

  it("renders an unknown CBOR tag as a labelled object", () => {
    // Tag 888 wrapping the array [1, 2].
    const rows = run(Uint8Array.from([0xd9, 0x03, 0x78, 0x82, 0x01, 0x02]), { format: "cbor" });
    expect(decodedOf(rows)).toEqual({ $tag: 888, value: [1, 2] });
  });
});

describe("protobuf-decoder: errors", () => {
  it("throws empty-input for no bytes at all", () => {
    expect(() => run("", AUTO)).toThrow(ToolError);
    expect(() => run("   \n ", AUTO)).toThrowError(
      expect.objectContaining({ code: "empty-input" }),
    );
    expect(() => run(new Uint8Array(0), AUTO)).toThrowError(
      expect.objectContaining({ code: "empty-input" }),
    );
  });

  it("throws bad-encoding for text that is neither hex nor base64", () => {
    expect(() => run("hello world!", AUTO)).toThrowError(
      expect.objectContaining({ code: "bad-encoding" }),
    );
    expect(() => run("0xZZ", AUTO)).toThrowError(expect.objectContaining({ code: "bad-encoding" }));
    expect(() => run("data:text/plain,notbase64", AUTO)).toThrowError(
      expect.objectContaining({ code: "bad-encoding" }),
    );
  });

  it("throws undecodable when nothing parses, and names each decoder", () => {
    let thrown: ToolError | undefined;
    try {
      run(Uint8Array.from([0xc1]), AUTO);
    } catch (error) {
      thrown = error as ToolError;
    }
    expect(thrown?.code).toBe("undecodable");
    expect(thrown?.message).toContain("Protobuf:");
    expect(thrown?.message).toContain("CBOR:");
    expect(thrown?.message).toContain("MessagePack:");
    expect(thrown?.fix).toContain("Format option");
  });

  it("throws undecodable naming the format the user picked", () => {
    let thrown: ToolError | undefined;
    try {
      run(PB_ALL, { format: "msgpack" });
    } catch (error) {
      thrown = error as ToolError;
    }
    expect(thrown?.code).toBe("undecodable");
    expect(thrown?.message).toContain("not valid MessagePack");
  });

  it("throws too-large past the 8 MiB cap", () => {
    const huge = new Uint8Array(8 * 1024 * 1024 + 1);
    expect(() => run(huge, AUTO)).toThrowError(expect.objectContaining({ code: "too-large" }));
  });

  it("falls back to auto for an unknown format option", () => {
    expect(run(PB_SMALL, { format: "yaml" }).Format).toBe("Protobuf (auto detected)");
  });
});

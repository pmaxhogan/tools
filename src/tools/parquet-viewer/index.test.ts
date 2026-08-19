import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  asyncBufferFrom,
  formatValue,
  readParquet,
  renderSchema,
  run,
  summarizeColumn,
  toBytes,
  toCsv,
  type ParquetOpts,
} from "./index";

/**
 * A real 892 byte Parquet file, written once with hyparquet-writer and pasted
 * here as base64 so the suite needs no binary fixture and no extra dependency.
 * Six columns, eight rows, snappy compressed, one row group:
 *
 *   name   STRING   Alice, Bob, Carol, Dan, Erin, Frank, Gina, Hugo
 *   age    INT32    34, 28, 45, 19, 61, 52, 23, 40
 *   score  DOUBLE   91.5, 78.25, 88, 64.75, 99.125, 70.5, 82, 55.25
 *   active BOOLEAN  true, false, true, true, false, true, false, true
 *   city   STRING   Paris, null, Tokyo, Paris, null, Lima, Tokyo, Paris
 *   joined TIMESTAMP_MILLIS
 */
const FIXTURE_B64 =
  "UEFSMRUGFYYBFYIBXBUQFQAVEBUAFQQVAAAAEAFBPAUAAABBbGljZQMAAABCb2IBEBBDYXJvbAEQKERhbgQAAABFcmluARgQ" +
  "RnJhbmsBESxHaW5hBAAAAEh1Z28VBhVEFUhcFRAVABUQFQAVBBUAAAAQASB8IgAAABwAAAAtAAAAEwAAAD0AAAA0AAAAFwAA" +
  "ACgAAAAVBhWEARVoXBUQFQAVEBUAFQQVAAAAEAFAAAABAQjgVkABBwgAkFMJCAgAVkAFEAQwUAkIBMhYCQgEoFEJCCiAVEAA" +
  "AAAAAKBLQBUGFQYVClwVEBUAFRAVABUEFQAAABABAQCtFQYVbhVmXBUQFQQVEBUAFQQVAAAAA+01IAUAAABQYXJpcwEJEFRv" +
  "a3lvAQkFEhwEAAAATGltYQERNFRva3lvBQAAAFBhcmlzFQYVhAEVflwVEBUAFRAVABUEFQAAABABQDAA4NfPdgEAAAA8lR54" +
  "AQgMIMETggEIDOBAhnUBCAxU9GmIAQgMjE3paAEIOKThqpEBAAAARJRGhQEAABUEGXxIBHJvb3QVDAAVDCUCGARuYW1lJQAA" +
  "FQIlAhgDYWdlABUKJQIYBXNjb3JlABUAJQIYBmFjdGl2ZQAVDCUCGARjaXR5JQAAFQQlAhgGam9pbmVkJRIAFhAZHBlsJggc" +
  "FQwZFQAZGARuYW1lFQIWEBawARawASYIPDYAKARIdWdvGAVBbGljZQAZHBUGFQAVAgAAACa4ARwVAhkVABkYA2FnZRUCFhAW" +
  "chZyJrgBPDYAKAQ9AAAAGAQTAAAAABkcFQYVABUCAAAAJqoCHBUKGRUAGRgFc2NvcmUVAhYQFpQBFpQBJqoCPDYAKAgAAAAA" +
  "AMhYQBgIAAAAAACgS0AAGRwVBhUAFQIAAAAmvgMcFQAZFQAZGAZhY3RpdmUVAhYQFjQWNCa+Azw2ACgBARgBAAAZHBUGFQAV" +
  "AgAAACbyAxwVDBkVABkYBGNpdHkVAhYQFpABFpABJvIDPDYEKAVUb2t5bxgETGltYQAZHBUGFQAVAgAAACaCBRwVBBkVABkY" +
  "BmpvaW5lZBUCFhAWqgEWqgEmggU8NgAAGRwVBhUAFQIAAAAWpAYWEAAZHBgGc291cmNlGBp0b29scy5tYXhob2dhbi5kZXYg" +
  "Zml4dHVyZQAYCWh5cGFycXVldADeAQAAUEFSMQ==";

const fixture = (): Uint8Array => Uint8Array.from(Buffer.from(FIXTURE_B64, "base64"));

const ascii = (text: string): Uint8Array => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));

const opts = (over: Partial<ParquetOpts> = {}): ParquetOpts => ({
  rows: 20,
  stats: false,
  view: "summary",
  ...over,
});

/** A file with valid magic at both ends and nothing readable in between. */
function corruptParquet(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set(ascii("PAR1"), 0);
  for (let i = 4; i < 56; i++) bytes[i] = (i * 37) & 0xff;
  new DataView(bytes.buffer).setUint32(56, 40, true);
  bytes.set(ascii("PAR1"), 60);
  return bytes;
}

describe("fixture sanity", () => {
  it("is an 892 byte file with PAR1 at both ends", () => {
    const bytes = fixture();
    expect(bytes.length).toBe(892);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("PAR1");
    expect(String.fromCharCode(...bytes.subarray(-4))).toBe("PAR1");
  });
});

describe("readParquet", () => {
  it("reads metadata, schema and rows", async () => {
    const parsed = await readParquet(fixture());

    expect(parsed.rowCount).toBe(8);
    expect(parsed.rowGroups).toBe(1);
    expect(parsed.columns).toEqual(["name", "age", "score", "active", "city", "joined"]);
    expect(parsed.metadata.fileSize).toBe(892);
    expect(parsed.metadata.createdBy).toBe("hyparquet");
    expect(parsed.metadata.codecs).toEqual(["SNAPPY"]);
    expect(parsed.metadata.version).toBe(2);
    expect(parsed.metadata.keyValue).toEqual([
      { key: "source", value: "tools.maxhogan.dev fixture" },
    ]);
    expect(parsed.metadata.uncompressedSize).toBeGreaterThan(0);
  });

  it("describes every column with type, annotation and repetition", async () => {
    const parsed = await readParquet(fixture());

    expect(parsed.schema).toHaveLength(6);
    expect(parsed.schema[0]).toEqual({
      name: "name",
      type: "BYTE_ARRAY",
      logicalType: "UTF8",
      repetition: "OPTIONAL",
    });
    expect(parsed.schema[1]).toEqual({ name: "age", type: "INT32", repetition: "OPTIONAL" });
    expect(parsed.schema[5]).toEqual({
      name: "joined",
      type: "INT64",
      logicalType: "TIMESTAMP_MILLIS",
      repetition: "OPTIONAL",
    });
  });

  it("decodes only the requested rows and columns", async () => {
    const parsed = await readParquet(fixture(), { rows: 3, columns: ["name", "age"] });

    expect(parsed.rowCount).toBe(8);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.columns).toEqual(["name", "age"]);
    expect(parsed.rows[0]).toEqual({ name: "Alice", age: 34 });
  });

  it("decodes timestamps as dates and keeps nulls null", async () => {
    const parsed = await readParquet(fixture(), { rows: 2 });
    const first = parsed.rows[0] ?? {};
    const second = parsed.rows[1] ?? {};

    expect(first.joined).toBeInstanceOf(Date);
    expect((first.joined as Date).toISOString()).toBe("2021-01-05T00:00:00.000Z");
    expect(second.city).toBeNull();
  });

  it("reads a view into a larger buffer, not just a whole one", async () => {
    const bytes = fixture();
    const padded = new Uint8Array(bytes.length + 9);
    padded.set(bytes, 5);
    const view = padded.subarray(5, 5 + bytes.length);

    expect(view.byteOffset).toBe(5);
    const parsed = await readParquet(view);
    expect(parsed.rowCount).toBe(8);
  });
});

describe("asyncBufferFrom", () => {
  it("slices a view without leaking neighboring bytes", async () => {
    const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const buffer = asyncBufferFrom(source.subarray(2, 6));

    expect(buffer.byteLength).toBe(4);
    expect([...new Uint8Array(await buffer.slice(0, 4))]).toEqual([3, 4, 5, 6]);
    expect([...new Uint8Array(await buffer.slice(1))]).toEqual([4, 5, 6]);
  });
});

describe("run", () => {
  it("summarizes the file", async () => {
    const out = (await run(fixture(), opts())) as Record<string, string>;

    expect(out.File).toContain("892 B");
    expect(out.File).toContain("Parquet format version 2");
    expect(out.Rows).toBe("8");
    expect(out["Row groups"]).toContain("1 group");
    expect(out.Columns).toBe("6");
    expect(out["Compression codecs seen"]).toBe("SNAPPY");
    expect(out["Created by"]).toBe("hyparquet");
    expect(out["Key value metadata"]).toBe("source = tools.maxhogan.dev fixture");
    expect(out.Schema).toContain("name:   BYTE_ARRAY (UTF8) OPTIONAL");
    expect(out.Schema).toContain("age:    INT32 OPTIONAL");
    expect(out["Preview (first 8 rows)"]).toContain("| Alice | 34  |");
  });

  it("accepts the same file pasted as base64 text", async () => {
    const fromBytes = (await run(fixture(), opts())) as Record<string, string>;
    const fromText = (await run(
      `${FIXTURE_B64.slice(0, 40)}\n${FIXTURE_B64.slice(40)}`,
      opts(),
    )) as Record<string, string>;

    expect(fromText).toEqual(fromBytes);
  });

  it("caps the preview and says how many rows were left out", async () => {
    const out = (await run(fixture(), opts({ rows: 5 }))) as Record<string, string>;
    const preview = out["Preview (first 5 rows)"] ?? "";

    expect(preview).toContain("| Erin  |");
    expect(preview).not.toContain("Frank");
    expect(preview).toContain("... 3 more rows (8 total)");
  });

  it("clamps a silly row count into range", async () => {
    const low = (await run(fixture(), opts({ rows: 0 }))) as Record<string, string>;
    const high = (await run(fixture(), opts({ rows: 9999 }))) as Record<string, string>;

    expect(low["Preview (first 5 rows)"]).toBeDefined();
    expect(high["Preview (first 8 rows)"]).toBeDefined();
  });

  it("narrows to the schema", async () => {
    const out = (await run(fixture(), opts({ view: "schema" }))) as Record<string, string>;

    expect(out.Schema).toBeDefined();
    expect(out["Preview (first 8 rows)"]).toBeUndefined();
    expect(out["Created by"]).toBeUndefined();
  });

  it("narrows to the rows", async () => {
    const out = (await run(fixture(), opts({ view: "preview" }))) as Record<string, string>;

    expect(out["Preview (first 8 rows)"]).toBeDefined();
    expect(out.Schema).toBeUndefined();
  });

  it("returns the preview as CSV", async () => {
    const csv = (await run(fixture(), opts({ view: "csv", rows: 5 }))) as string;
    const lines = csv.split("\n");

    expect(typeof csv).toBe("string");
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("name,age,score,active,city,joined");
    expect(lines[1]).toBe("Alice,34,91.5,true,Paris,2021-01-05T00:00:00.000Z");
    expect(lines[2]).toBe("Bob,28,78.25,false,,2021-03-11T00:00:00.000Z");
  });

  it("adds per column stats on request and says they are a sample", async () => {
    const out = (await run(fixture(), opts({ stats: true }))) as Record<string, string>;

    expect(out["Column stats"]).toContain("Sampled from the 8 rows in the preview");
    expect(out["Stats: city"]).toBe("8 values, 2 null, 3 distinct, min Lima, max Tokyo");
    expect(out["Stats: age"]).toBe("8 values, 0 null, 8 distinct, min 19, max 61");
    expect(out["Stats: joined"]).toContain("min 2019-02-14T00:00:00.000Z");
  });

  it("leaves the stats rows out by default", async () => {
    const out = (await run(fixture(), opts())) as Record<string, string>;
    expect(out["Column stats"]).toBeUndefined();
    expect(out["Stats: city"]).toBeUndefined();
  });
});

describe("toBytes", () => {
  it("passes bytes through untouched", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(toBytes(bytes)).toBe(bytes);
  });

  it("accepts a data URL prefix and base64url characters", () => {
    const decoded = toBytes("data:application/octet-stream;base64,-_-_");
    expect([...decoded]).toEqual([...Uint8Array.from(Buffer.from("+/+/", "base64"))]);
  });
});

describe("formatValue", () => {
  it("renders the types Parquet carries that JSON does not", () => {
    expect(formatValue(null)).toBe("NULL");
    expect(formatValue(undefined)).toBe("NULL");
    expect(formatValue(9007199254740993n)).toBe("9007199254740993");
    expect(formatValue(new Date("2020-01-02T03:04:05Z"))).toBe("2020-01-02T03:04:05.000Z");
    expect(formatValue(new Uint8Array([1, 2, 3]))).toBe("<binary 3 bytes>");
    expect(formatValue(new Uint8Array([7]))).toBe("<binary 1 byte>");
    expect(formatValue({ a: 1n })).toBe('{"a":"1"}');
    expect(formatValue(["x", 2])).toBe('["x",2]');
    expect(formatValue(false)).toBe("false");
  });
});

describe("summarizeColumn", () => {
  it("counts nulls and distinct values", () => {
    expect(summarizeColumn(["a", null, "b", "a", undefined])).toEqual({
      total: 5,
      nulls: 2,
      distinct: 2,
      distinctCapped: false,
      min: "a",
      max: "b",
    });
  });

  it("caps the distinct count instead of building a huge set", () => {
    const values = Array.from({ length: 5000 }, (_, i) => `id-${i}`);
    const summary = summarizeColumn(values);

    expect(summary.distinct).toBe(1000);
    expect(summary.distinctCapped).toBe(true);
  });

  it("ranges over numbers, bigints and dates", () => {
    expect(summarizeColumn([3, -1, 10]).min).toBe("-1");
    expect(summarizeColumn([3, -1, 10]).max).toBe("10");
    expect(summarizeColumn([5n, 2n, 9n]).max).toBe("9");
    expect(summarizeColumn([new Date("2021-01-01Z"), new Date("2020-01-01Z")]).min).toBe(
      "2020-01-01T00:00:00.000Z",
    );
  });

  it("skips the range for columns with no useful order", () => {
    const mixed = summarizeColumn([1, "two", { three: 3 }]);
    expect(mixed.min).toBeUndefined();
    expect(mixed.max).toBeUndefined();

    const empty = summarizeColumn([null, null]);
    expect(empty).toEqual({ total: 2, nulls: 2, distinct: 0, distinctCapped: false });
  });
});

describe("toCsv", () => {
  it("quotes commas, quotes and newlines, and blanks nulls", () => {
    const rows = [
      { a: 'say "hi"', b: "x,y", c: null },
      { a: "line\nbreak", b: 1n, c: new Date("2020-06-01T00:00:00Z") },
    ];
    expect(toCsv(rows, ["a", "b", "c"])).toBe(
      ["a,b,c", '"say ""hi""","x,y",', '"line\nbreak",1,2020-06-01T00:00:00.000Z'].join("\n"),
    );
  });

  it("emits a header even with no rows", () => {
    expect(toCsv([], ["a", "b"])).toBe("a,b");
  });
});

describe("renderSchema", () => {
  it("says so when there are no columns", () => {
    expect(renderSchema([])).toBe("This file declares no columns.");
  });
});

describe("errors", () => {
  it("empty-input on empty text", async () => {
    await expect(run("   ", opts())).rejects.toMatchObject({
      name: "ToolError",
      code: "empty-input",
    });
  });

  it("empty-input on an empty file", async () => {
    await expect(run(new Uint8Array(0), opts())).rejects.toMatchObject({
      code: "empty-input",
    });
  });

  it("bad-encoding on text that is not base64", async () => {
    await expect(run("this is clearly not a parquet file!", opts())).rejects.toMatchObject({
      code: "bad-encoding",
    });
  });

  it("not-parquet on a file without the magic bytes", async () => {
    const bytes = ascii("id,name\n1,Alice\n2,Bob\n");
    await expect(run(bytes, opts())).rejects.toMatchObject({ code: "not-parquet" });
  });

  it("not-parquet on a file too short to hold a footer", async () => {
    await expect(run(ascii("PAR1"), opts())).rejects.toMatchObject({ code: "not-parquet" });
  });

  it("arrow-unsupported on an Arrow IPC file", async () => {
    const bytes = new Uint8Array(64);
    bytes.set(ascii("ARROW1"), 0);
    const error = await run(bytes, opts()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe("arrow-unsupported");
    expect((error as ToolError).message).toBe(
      "Arrow IPC files are not supported yet; export as Parquet.",
    );
  });

  it("read-failed when the magic is right but the footer is not", async () => {
    const error = await run(corruptParquet(), opts()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe("read-failed");
    expect((error as ToolError).message.length).toBeGreaterThan(30);
    expect((error as ToolError).fix).toBeTruthy();
  });

  it("too-large past 200 MB", async () => {
    const bytes = new Uint8Array(200 * 1024 * 1024 + 1);
    bytes.set(ascii("PAR1"), 0);
    await expect(run(bytes, opts())).rejects.toMatchObject({ code: "too-large" });
  });

  it("too-large before decoding an oversized base64 paste", async () => {
    const text = "A".repeat(Math.ceil((200 * 1024 * 1024 * 4) / 3) + 8);
    await expect(run(text, opts())).rejects.toMatchObject({ code: "too-large" });
  });
});

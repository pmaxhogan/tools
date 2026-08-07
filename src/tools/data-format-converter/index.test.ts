import { describe, expect, it } from "vitest";
import { detectFormat, run, type ConvertOpts } from "./index";
import { ToolError } from "../types";

const base: ConvertOpts = { from: "auto", to: "json", indent: 2, csvHeader: true };
const opts = (over: Partial<ConvertOpts> = {}): ConvertOpts => ({ ...base, ...over });

describe("data-format-converter", () => {
  it("converts CSV with a header row to a JSON array with typed numbers", () => {
    const csv = "name,age,active\nalice,30,true\nbob,25,false";
    const out = JSON.parse(run(csv, opts({ from: "csv", to: "json" })));
    expect(out).toEqual([
      { name: "alice", age: 30, active: true },
      { name: "bob", age: 25, active: false },
    ]);
  });

  it("names headerless CSV columns col1, col2, and so on", () => {
    const out = JSON.parse(
      run("alice,30\nbob,25", opts({ from: "csv", to: "json", csvHeader: false })),
    );
    expect(out).toEqual([
      { col1: "alice", col2: 30 },
      { col1: "bob", col2: 25 },
    ]);
  });

  it("flattens one level of nesting into dotted CSV columns", () => {
    const json = JSON.stringify([
      { id: 1, user: { name: "alice", city: "Oslo" } },
      { id: 2, user: { name: "bob", city: "Lima" } },
    ]);
    const csv = run(json, opts({ from: "json", to: "csv" }));
    expect(csv).toBe("id,user.name,user.city\n1,alice,Oslo\n2,bob,Lima");
  });

  it("serialises deeper nesting and arrays as inline JSON cells", () => {
    const json = JSON.stringify([{ id: 1, meta: { tags: ["a", "b"], deep: { x: 1 } } }]);
    const csv = run(json, opts({ from: "json", to: "csv" }));
    expect(csv.split("\n")[0]).toBe("id,meta.tags,meta.deep");
    expect(csv).toContain('"[""a"",""b""]"');
    expect(csv).toContain('"{""x"":1}"');
  });

  it("turns a single object into a one row CSV", () => {
    const csv = run('{"a":1,"b":"two"}', opts({ from: "json", to: "csv" }));
    expect(csv).toBe("a,b\n1,two");
  });

  it("round trips JSON to YAML and back without losing structure", () => {
    const value = { name: "tools", count: 3, tags: ["a", "b"], nested: { ok: true, n: 1.5 } };
    const yaml = run(JSON.stringify(value), opts({ from: "json", to: "yaml" }));
    expect(yaml).toContain("name: tools");
    const back = run(yaml, opts({ from: "yaml", to: "json" }));
    expect(JSON.parse(back)).toEqual(value);
  });

  it("converts TOML to JSON with dates as ISO strings", () => {
    const toml = 'title = "spec"\nreleased = 1979-05-27T07:32:00Z\n\n[owner]\nname = "tom"';
    const out = JSON.parse(run(toml, opts({ from: "toml", to: "json" })));
    expect(out).toEqual({
      title: "spec",
      released: "1979-05-27T07:32:00.000Z",
      owner: { name: "tom" },
    });
  });

  it("drops null keys when writing TOML and says which ones", () => {
    const out = run('{"a":1,"b":null,"c":{"d":null,"e":2}}', opts({ from: "json", to: "toml" }));
    expect(out).toMatch(/^# TOML has no null/m);
    expect(out).toContain("b");
    expect(out).toContain("c.d");
    expect(out).toMatch(/^a = 1$/m);
    expect(out).not.toMatch(/^b =/m);
  });

  it("wraps a root array for TOML and notes the wrap", () => {
    const out = run("[1, 2, 3]", opts({ from: "json", to: "toml" }));
    expect(out).toMatch(/^# Root array wrapped under an "items" key/m);
    expect(out).toContain("items = [");
  });

  it("auto-detects a TSV via the tab delimiter", () => {
    const tsv = "name\tscore\nalice\t10\nbob\t20";
    expect(detectFormat(tsv)).toBe("csv");
    expect(JSON.parse(run(tsv, opts({ from: "auto", to: "json" })))).toEqual([
      { name: "alice", score: 10 },
      { name: "bob", score: 20 },
    ]);
  });

  it("classifies JSON, YAML, TOML, and CSV correctly", () => {
    expect(detectFormat('{"a": 1, "b": [2, 3]}')).toBe("json");
    expect(detectFormat("name: tools\ntags:\n  - a\n  - b\n")).toBe("yaml");
    expect(detectFormat('title = "spec"\n\n[owner]\nname = "tom"\n')).toBe("toml");
    expect(detectFormat("name,age\nalice,30\nbob,25")).toBe("csv");
  });

  it("applies the indent option, and minifies JSON at indent 0", () => {
    const pretty = run('{"a":{"b":1}}', opts({ from: "json", to: "json", indent: 4 }));
    expect(pretty).toBe('{\n    "a": {\n        "b": 1\n    }\n}');
    expect(run('{"a":{"b":1}}', opts({ from: "json", to: "json", indent: 0 }))).toBe(
      '{"a":{"b":1}}',
    );
  });

  it("still writes valid YAML when the indent is 0", () => {
    expect(run('{"a":{"b":1}}', opts({ from: "json", to: "yaml", indent: 0 }))).toBe(
      "a:\n  b: 1\n",
    );
  });

  it("rejects a mixed scalar array as not tabular", () => {
    expect(() => run('[1, "two", 3]', opts({ from: "json", to: "csv" }))).toThrowError(ToolError);
    try {
      run('[1, "two", 3]', opts({ from: "json", to: "csv" }));
    } catch (e) {
      expect((e as ToolError).code).toBe("not-tabular");
      expect((e as ToolError).fix).toMatch(/JSON or YAML/);
    }
  });

  it("rejects a bare scalar as not tabular", () => {
    try {
      run("42", opts({ from: "json", to: "csv" }));
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("not-tabular");
    }
  });

  it("throws undetected-format for text that is no format at all", () => {
    try {
      run("lorem ipsum dolor sit amet", opts({ from: "auto", to: "json" }));
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("undetected-format");
      expect((e as ToolError).fix).toMatch(/source format/);
    }
  });

  it("throws empty-input for blank input", () => {
    expect(() => run("   \n  ", opts())).toThrowError(ToolError);
    try {
      run("", opts());
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("reports invalid JSON, YAML, TOML, and CSV by code", () => {
    const codes = (fn: () => unknown): string => {
      try {
        fn();
      } catch (e) {
        return (e as ToolError).code;
      }
      return "no-error";
    };
    expect(codes(() => run("{'a': 1,}", opts({ from: "json" })))).toBe("invalid-json");
    expect(codes(() => run("a:\n- b\n  c: 1\n [", opts({ from: "yaml" })))).toBe("invalid-yaml");
    expect(codes(() => run("key = ", opts({ from: "toml" })))).toBe("invalid-toml");
    expect(codes(() => run('a,b\n"unclosed,2', opts({ from: "csv" })))).toBe("invalid-csv");
  });

  it("accepts a single column CSV even though the delimiter is unknowable", () => {
    expect(JSON.parse(run("name\nalice\nbob", opts({ from: "csv", to: "json" })))).toEqual([
      { name: "alice" },
      { name: "bob" },
    ]);
  });

  it("rejects an unknown target format", () => {
    try {
      run('{"a":1}', opts({ to: "xml" as never }));
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("unknown-format");
    }
  });

  it("reports a conversion that cannot be written out", () => {
    // A YAML anchor pointing at its own parent makes a circular structure,
    // which no text format can represent.
    try {
      run("a: &x\n  b: *x\n", opts({ from: "yaml", to: "json" }));
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("conversion-failed");
    }
  });

  it("reformats in place when from and to match", () => {
    // Redundant quoting and CRLF line endings are normalised away.
    const csv = run('"a","b"\r\n1,2\r\n', opts({ from: "csv", to: "csv" }));
    expect(csv).toBe("a,b\n1,2");
  });
});

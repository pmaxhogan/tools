import { describe, expect, it } from "vitest";
import type { OptionSpec } from "../tools/types";
import {
  exampleOptsToState,
  isTextLike,
  pickExample,
  quickEntryPlaceholder,
  type ExampleMeta,
} from "./examples";

const options: OptionSpec[] = [
  {
    kind: "select",
    id: "mode",
    label: "Mode",
    default: "format",
    options: [
      { value: "format", label: "Format", synonyms: ["pretty"] },
      { value: "minify", label: "Minify", synonyms: ["compact"] },
    ],
  },
  { kind: "number", id: "indent", label: "Indent", default: 2 },
  { kind: "slider", id: "quality", label: "Quality", default: 80, min: 1, max: 100 },
  { kind: "boolean", id: "header", label: "First row is a header", default: true },
  { kind: "text", id: "sort", label: "Sort by", default: "" },
];

const textMeta: ExampleMeta = {
  input: "application/json",
  examples: [
    { label: "Minified order", input: '{"id":1}', opts: { mode: "format", indent: "4" } },
    { label: "Nested invoice", input: '{"items":[]}' },
  ],
};

describe("isTextLike", () => {
  it("accepts every type the textarea can hold", () => {
    expect(isTextLike("text/plain")).toBe(true);
    expect(isTextLike("application/json")).toBe(true);
    expect(isTextLike("text/csv")).toBe(true);
    expect(isTextLike("text/html")).toBe(true);
    expect(isTextLike("image/svg+xml")).toBe(true);
  });

  it("rejects byte inputs and tools with no input", () => {
    expect(isTextLike("File")).toBe(false);
    expect(isTextLike("image/*")).toBe(false);
    expect(isTextLike("image/png")).toBe(false);
    expect(isTextLike("audio/*")).toBe(false);
    expect(isTextLike("video/*")).toBe(false);
    expect(isTextLike("application/octet-stream")).toBe(false);
    expect(isTextLike("none")).toBe(false);
  });
});

describe("pickExample", () => {
  it("returns the first example on a clean load", () => {
    expect(pickExample(textMeta, false, false)?.label).toBe("Minified order");
  });

  it("never overrides a shared link", () => {
    expect(pickExample(textMeta, true, false)).toBeNull();
  });

  it("never overrides a loaded file", () => {
    expect(pickExample(textMeta, false, true)).toBeNull();
  });

  it("never pre-fills a secret input", () => {
    expect(pickExample({ ...textMeta, sensitiveInput: true }, false, false)).toBeNull();
  });

  it("returns null for byte inputs, which use a sample file instead", () => {
    expect(pickExample({ ...textMeta, input: "image/*" }, false, false)).toBeNull();
  });

  it("returns null when the tool has no examples", () => {
    expect(pickExample({ input: "text/plain" }, false, false)).toBeNull();
    expect(pickExample({ input: "text/plain", examples: [] }, false, false)).toBeNull();
  });

  it("skips file-only examples and picks the first one with text", () => {
    const meta: ExampleMeta = {
      input: "text/csv",
      examples: [
        { label: "Sample file", file: "sample.csv" },
        { label: "Pasted rows", input: "a,b\n1,2" },
      ],
    };
    expect(pickExample(meta, false, false)?.label).toBe("Pasted rows");
  });
});

describe("exampleOptsToState", () => {
  it("coerces each value to the kind its option declares", () => {
    const state = exampleOptsToState(
      {
        label: "All kinds",
        opts: {
          mode: "minify",
          indent: "4",
          quality: "55",
          header: "false",
          sort: "-price",
        },
      },
      options,
    );
    expect(state).toEqual({
      mode: "minify",
      indent: 4,
      quality: 55,
      header: false,
      sort: "-price",
    });
  });

  it("leaves options the example does not mention alone", () => {
    expect(
      exampleOptsToState({ label: "Just the mode", opts: { mode: "minify" } }, options),
    ).toEqual({ mode: "minify" });
  });

  it("drops ids the tool does not declare", () => {
    expect(exampleOptsToState({ label: "Stale", opts: { nope: "1" } }, options)).toEqual({});
  });

  it("returns an empty state for an example with no opts", () => {
    expect(exampleOptsToState({ label: "Text only", input: "hi" }, options)).toEqual({});
    expect(exampleOptsToState({ label: "Text only", input: "hi" }, undefined)).toEqual({});
  });
});

describe("quickEntryPlaceholder", () => {
  it("uses the first quoted example from the hint", () => {
    expect(
      quickEntryPlaceholder(
        'Optional. Type a shorthand like "6x4TB raidz2" to set the drive count.',
      ),
    ).toBe("6x4TB raidz2");
  });

  it("keeps arrows and paths intact", () => {
    expect(quickEntryPlaceholder('Type "app.example.com -> http://127.0.0.1:3000" here.')).toBe(
      "app.example.com -> http://127.0.0.1:3000",
    );
  });

  it("falls back to the whole hint when nothing is quoted", () => {
    expect(quickEntryPlaceholder("Paste a slicer summary.")).toBe("Paste a slicer summary.");
  });
});

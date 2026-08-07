import { describe, expect, it } from "vitest";
import type { SelectOptionSpec } from "../tools/types";
import {
  SEARCH_THRESHOLD,
  filterSelectTree,
  flattenSelectOptions,
  shouldShowSearch,
} from "./select-options";

const flat: SelectOptionSpec = {
  kind: "select",
  id: "dir",
  label: "Direction",
  default: "escape",
  options: [
    { value: "escape", label: "Escape", synonyms: ["encode"] },
    { value: "unescape", label: "Unescape", synonyms: ["decode"] },
  ],
};

const grouped: SelectOptionSpec = {
  kind: "select",
  id: "format",
  label: "Format",
  default: "json",
  groups: [
    {
      label: "Markup and data",
      synonyms: ["web", "serialization"],
      options: [
        { value: "json", label: "JSON string escape", synonyms: ["javascript object notation"] },
        { value: "html", label: "HTML entities", synonyms: ["web page", "ampersand"] },
      ],
    },
    {
      label: "Binary to text",
      synonyms: ["encoding"],
      groups: [
        {
          label: "Base families",
          synonyms: ["radix"],
          options: [
            { value: "base64", label: "Base64", synonyms: ["b64"] },
            { value: "base32", label: "Base32", synonyms: [] },
          ],
        },
      ],
    },
  ],
};

describe("flattenSelectOptions", () => {
  it("flattens a flat options list", () => {
    expect(flattenSelectOptions(flat).map((o) => o.value)).toEqual(["escape", "unescape"]);
  });

  it("flattens nested groups depth first, in reading order", () => {
    expect(flattenSelectOptions(grouped).map((o) => o.value)).toEqual([
      "json",
      "html",
      "base64",
      "base32",
    ]);
  });

  it("returns an empty list for a select with no options at all", () => {
    const empty: SelectOptionSpec = { kind: "select", id: "e", label: "E", default: "" };
    expect(flattenSelectOptions(empty)).toEqual([]);
  });
});

describe("shouldShowSearch", () => {
  it("is false at or below the threshold", () => {
    expect(shouldShowSearch(flat)).toBe(false);
    expect(SEARCH_THRESHOLD).toBe(6);
  });

  it("is true above the threshold", () => {
    const big: SelectOptionSpec = {
      kind: "select",
      id: "b",
      label: "B",
      default: "0",
      options: Array.from({ length: 7 }, (_, i) => ({
        value: String(i),
        label: `Opt ${i}`,
        synonyms: [],
      })),
    };
    expect(shouldShowSearch(big)).toBe(true);
  });
});

describe("filterSelectTree", () => {
  it("empty query returns everything with the full count", () => {
    const r = filterSelectTree(grouped, "");
    expect(r.count).toBe(4);
    expect(r.groups).toHaveLength(2);
  });

  it("whitespace-only query is treated as empty", () => {
    expect(filterSelectTree(grouped, "   ").count).toBe(4);
  });

  it("matches an option label and keeps only its group path", () => {
    const r = filterSelectTree(grouped, "html");
    expect(r.count).toBe(1);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].label).toBe("Markup and data");
    expect(r.groups[0].options.map((o) => o.value)).toEqual(["html"]);
  });

  it("matches on an option synonym", () => {
    const r = filterSelectTree(grouped, "b64");
    expect(r.count).toBe(1);
    expect(r.groups[0].label).toBe("Binary to text");
    expect(r.groups[0].groups[0].options.map((o) => o.value)).toEqual(["base64"]);
  });

  it("matching a group label surfaces all of its options", () => {
    const r = filterSelectTree(grouped, "markup");
    expect(r.count).toBe(2);
    expect(r.groups[0].options.map((o) => o.value)).toEqual(["json", "html"]);
  });

  it("matching a group synonym surfaces its whole subtree", () => {
    const r = filterSelectTree(grouped, "encoding");
    expect(r.count).toBe(2);
    expect(r.groups[0].label).toBe("Binary to text");
    expect(r.groups[0].groups[0].options.map((o) => o.value)).toEqual(["base64", "base32"]);
  });

  it("AND-combines tokens across group path and option text", () => {
    // "binary" hits the ancestor group, "32" hits the option label.
    const r = filterSelectTree(grouped, "binary 32");
    expect(r.count).toBe(1);
    expect(r.groups[0].groups[0].options.map((o) => o.value)).toEqual(["base32"]);
  });

  it("returns a zero count when nothing matches", () => {
    const r = filterSelectTree(grouped, "zzz-nope");
    expect(r.count).toBe(0);
    expect(r.groups).toEqual([]);
    expect(r.options).toEqual([]);
  });

  it("filters a flat options list by label and synonym", () => {
    expect(filterSelectTree(flat, "decode").options.map((o) => o.value)).toEqual(["unescape"]);
    expect(filterSelectTree(flat, "Unescape").options.map((o) => o.value)).toEqual(["unescape"]);
  });
});

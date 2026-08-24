import { describe, expect, it } from "vitest";
import type { OptionSpec } from "../tools/types";
import { coerceOptValue, coerceOpts } from "./fragment";

const numberSpec: OptionSpec = { kind: "number", id: "indent", label: "Indent", default: 2 };
const sliderSpec: OptionSpec = {
  kind: "slider",
  id: "quality",
  label: "Quality",
  default: 80,
  min: 1,
  max: 100,
};
const booleanSpec: OptionSpec = { kind: "boolean", id: "header", label: "Header", default: true };
const textSpec: OptionSpec = { kind: "text", id: "sort", label: "Sort by", default: "" };
const selectSpec: OptionSpec = {
  kind: "select",
  id: "mode",
  label: "Mode",
  default: "format",
  options: [
    { value: "format", label: "Format", synonyms: ["pretty"] },
    { value: "minify", label: "Minify", synonyms: ["compact"] },
  ],
};

describe("coerceOptValue", () => {
  it("turns number and slider values into numbers", () => {
    expect(coerceOptValue(numberSpec, "4")).toBe(4);
    expect(coerceOptValue(sliderSpec, "55")).toBe(55);
    expect(coerceOptValue(numberSpec, "0.5")).toBe(0.5);
  });

  it("treats only the exact string true as true", () => {
    expect(coerceOptValue(booleanSpec, "true")).toBe(true);
    expect(coerceOptValue(booleanSpec, "false")).toBe(false);
    expect(coerceOptValue(booleanSpec, "1")).toBe(false);
  });

  it("leaves text and select values as strings", () => {
    expect(coerceOptValue(textSpec, "-price")).toBe("-price");
    expect(coerceOptValue(selectSpec, "minify")).toBe("minify");
  });
});

describe("coerceOpts", () => {
  it("coerces every declared id it finds", () => {
    expect(
      coerceOpts([numberSpec, booleanSpec, selectSpec], {
        indent: "4",
        header: "false",
        mode: "minify",
      }),
    ).toEqual({ indent: 4, header: false, mode: "minify" });
  });

  it("skips ids the raw bag does not carry", () => {
    expect(coerceOpts([numberSpec, booleanSpec], { indent: "4" })).toEqual({ indent: 4 });
  });

  it("drops ids the tool does not declare", () => {
    expect(coerceOpts([numberSpec], { indent: "4", ghost: "true" })).toEqual({ indent: 4 });
  });

  it("handles a tool with no options", () => {
    expect(coerceOpts(undefined, { indent: "4" })).toEqual({});
  });
});

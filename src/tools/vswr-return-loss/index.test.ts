import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { run } from "./index";

const optsFor = (quantity: string) => ({ quantity }) as never;

describe("vswr-return-loss: from VSWR", () => {
  it("converts VSWR 1.5:1 to return loss, gamma, and reflected power", () => {
    const out = run("1.5", optsFor("vswr"));
    expect(out["VSWR"]).toBe("1.500:1");
    expect(parseFloat(out["Return loss"])).toBeCloseTo(13.98, 1);
    expect(out["Reflection coefficient (gamma)"]).toBe("0.2000");
    expect(parseFloat(out["Reflected power"])).toBeCloseTo(4, 2);
  });

  it("treats VSWR 1:1 as a perfect match with infinite return loss", () => {
    const out = run("1", optsFor("vswr"));
    expect(out["Return loss"]).toContain("infinite");
    expect(out["Reflection coefficient (gamma)"]).toBe("0.0000");
  });

  it("throws on a VSWR below 1", () => {
    expect(() => run("0.8", optsFor("vswr"))).toThrow(ToolError);
  });
});

describe("vswr-return-loss: from return loss", () => {
  it("converts a return loss of 13.98 dB back to VSWR 1.5:1", () => {
    const out = run("13.98", optsFor("return-loss"));
    expect(parseFloat(out["VSWR"])).toBeCloseTo(1.5, 2);
  });

  it("throws on a negative return loss", () => {
    expect(() => run("-3", optsFor("return-loss"))).toThrow(ToolError);
  });
});

describe("vswr-return-loss: from reflection coefficient", () => {
  it("converts gamma 0.2 to VSWR 1.5:1", () => {
    const out = run("0.2", optsFor("reflection-coefficient"));
    expect(parseFloat(out["VSWR"])).toBeCloseTo(1.5, 2);
  });

  it("throws when gamma is out of the 0 to 1 range", () => {
    expect(() => run("-0.1", optsFor("reflection-coefficient"))).toThrow(ToolError);
    expect(() => run("1", optsFor("reflection-coefficient"))).toThrow(ToolError);
  });
});

describe("vswr-return-loss: from mismatch loss and power ratio", () => {
  it("round trips reflected power percent back to the same VSWR", () => {
    const out = run("4", optsFor("power-ratio"));
    expect(parseFloat(out["VSWR"])).toBeCloseTo(1.5, 2);
  });

  it("throws on reflected power percent outside 0 to 100", () => {
    expect(() => run("0", optsFor("power-ratio"))).toThrow(ToolError);
    expect(() => run("100", optsFor("power-ratio"))).toThrow(ToolError);
  });

  it("computes VSWR from a mismatch loss figure", () => {
    const out = run("0.177", optsFor("mismatch-loss"));
    expect(parseFloat(out["VSWR"])).toBeCloseTo(1.5, 1);
  });
});

describe("vswr-return-loss: reference table and errors", () => {
  it("includes a reference table from 1.0 to 3.0 VSWR", () => {
    const out = run("1.5", optsFor("vswr"));
    const table = out["Reference table (VSWR -> RL, gamma, reflected %, mismatch loss)"];
    expect(table).toContain("1.00:1");
    expect(table).toContain("3.00:1");
  });

  it("throws on empty input", () => {
    expect(() => run("", optsFor("vswr"))).toThrow(ToolError);
  });

  it("throws on an unparseable value", () => {
    expect(() => run("not a number", optsFor("vswr"))).toThrow(ToolError);
  });

  it("accepts a trailing :1 or dB suffix", () => {
    const a = run("1.5:1", optsFor("vswr"));
    const b = run("1.5", optsFor("vswr"));
    expect(a["VSWR"]).toBe(b["VSWR"]);
    const c = run("20dB", optsFor("return-loss"));
    const d = run("20", optsFor("return-loss"));
    expect(c["VSWR"]).toBe(d["VSWR"]);
  });
});

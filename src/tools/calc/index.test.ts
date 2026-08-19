import { describe, expect, it } from "vitest";
import { EXAMPLES, mentionsCurrency, run } from "./index";
import { FX_DATE, FX_RATES } from "./rates";
import { ToolError } from "../types";

describe("calc", () => {
  it("does plain arithmetic", () => {
    expect(run("2 + 2", {}).Result).toBe("4");
  });

  it("converts units", () => {
    const out = run("20 miles to km", {});
    expect(out.Result).toContain("km");
    expect(out.Result.startsWith("32.18")).toBe(true);
    expect(out.Unit).toBe("km");
    expect(Number(out.Value)).toBeCloseTo(32.1869, 3);
  });

  it("converts currency from the dated snapshot", () => {
    const out = run("100 USD to EUR", { precision: 8 });
    expect(out.Result).toContain("EUR");
    expect(Number(out.Value)).toBeCloseTo(100 * FX_RATES.EUR, 6);
    expect(out["Rates as of"]).toBe(FX_DATE);
  });

  it("adds mixed currencies and converts the total", () => {
    const out = run("5 GBP + 3 EUR in USD", { precision: 10 });
    const expected = 5 / FX_RATES.GBP + 3 / FX_RATES.EUR;
    expect(out.Unit).toBe("USD");
    expect(Number(out.Value)).toBeCloseTo(expected, 6);
    expect(out["Rates as of"]).toBe(FX_DATE);
  });

  it("does trigonometry in degrees", () => {
    expect(run("sin(90 deg)", {}).Result).toBe("1");
  });

  it("honours the significant digits option", () => {
    expect(run("1/3", { precision: 3 }).Result).toBe("0.333");
    expect(run("1/3", { precision: 8 }).Result).toBe("0.33333333");
  });

  it("clamps an out-of-range precision instead of throwing", () => {
    expect(run("1/3", { precision: 0 }).Result).toBe("0.3");
    expect(run("2 + 2", { precision: 99 }).Result).toBe("4");
  });

  it("omits the rates disclosure for non-currency expressions", () => {
    const out = run("20 miles to km", {});
    expect(out["Rates as of"]).toBeUndefined();
    expect(mentionsCurrency("3 ft + 4 in to cm")).toBe(false);
    expect(mentionsCurrency("100 jpy to usd")).toBe(true);
  });

  it("rejects empty input", () => {
    expect(() => run("", {})).toThrowError(ToolError);
    expect(() => run("   ", {})).toThrowError(ToolError);
    try {
      run("", {});
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
      expect((e as ToolError).fix).toMatch(/20 miles to km/);
    }
  });

  it("rejects an undefined unit", () => {
    expect(() => run("3 flurbs", {})).toThrowError(ToolError);
    try {
      run("3 flurbs", {});
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-expression");
      expect((e as ToolError).message).toMatch(/flurbs/);
      expect((e as ToolError).fix).toMatch(/3 ft \+ 4 in to cm/);
    }
  });

  it("rejects a syntax error", () => {
    try {
      run("(2 +", {});
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-expression");
    }
  });

  it("rejects an expression with no result", () => {
    try {
      run("# just a comment", {});
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-expression");
      expect((e as ToolError).message).toMatch(/did not produce a result/);
    }
  });

  it("evaluates every shipped example", () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(6);
    for (const example of EXAMPLES) {
      expect(() => run(example, {})).not.toThrow();
    }
  });
});

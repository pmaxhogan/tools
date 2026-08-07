import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

const auto = { inputBase: "auto" };

describe("base-converter", () => {
  it("converts a decimal value with exact nibble grouping (172 = 0xAC)", () => {
    const out = run("172", auto);
    expect(out.Hex).toBe("0xac");
    expect(out.Binary).toBe("1010 1100");
    expect(out.Octal).toBe("254");
    expect(out.Base36).toBe("4s");
    expect(out.Bits).toBe("8");
    expect(out.Bytes).toBe("ac");
  });

  it("round-trips a 128-bit value through hex -> decimal -> hex", () => {
    const hexIn = "0x" + "f".repeat(32); // 2^128 - 1, exactly 128 bits
    const out = run(hexIn, auto);
    const expectedDecimal = (2n ** 128n - 1n).toString();
    expect(out.Decimal).toBe(expectedDecimal);
    expect(out.Hex).toBe(hexIn);
    expect(out.Bits).toBe("128");
    // Too wide for a 64-bit byte dump.
    expect(out.Bytes).toBeUndefined();

    // Round-trip: feed the decimal back in as base 10 and confirm hex matches.
    const roundTrip = run(expectedDecimal, { inputBase: "10" });
    expect(roundTrip.Hex).toBe(hexIn);
  });

  it("converts a negative decimal to hex/binary with a leading sign", () => {
    const out = run("-255", auto);
    expect(out.Decimal).toBe("-255");
    expect(out.Hex).toBe("-0xff");
    expect(out.Binary).toBe("-1111 1111");
    expect(out.Bits).toBe("8");
    expect(out.Bytes).toBe("-ff");
  });

  it("auto-detects 0x/0b/0o prefixes regardless of the selected input base", () => {
    expect(run("0b1010", { inputBase: "16" }).Decimal).toBe("10");
    expect(run("0o17", { inputBase: "2" }).Decimal).toBe("15");
    expect(run("0x1F", { inputBase: "2" }).Decimal).toBe("31");
  });

  it("uses the input base option when unprefixed, defaulting auto to base 10", () => {
    expect(run("ff", { inputBase: "16" }).Decimal).toBe("255");
    expect(run("101", auto).Decimal).toBe("101"); // auto -> base 10
    expect(run("101", { inputBase: "2" }).Decimal).toBe("5");
  });

  it("adds thousands separators in the grouped decimal row", () => {
    const out = run("1234567", auto);
    expect(out["Decimal (grouped)"]).toBe("1,234,567");
  });

  it("throws an actionable error naming the offending character and position for an invalid digit", () => {
    expect(() => run("102", { inputBase: "2" })).toThrowError(ToolError);
    try {
      run("102", { inputBase: "2" });
      expect.unreachable();
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("invalid-digit");
      expect(err.message).toContain("'2'");
      expect(err.message).toContain("position 3");
    }
  });

  it("throws an actionable error for non-integer (decimal point) input", () => {
    expect(() => run("12.5", auto)).toThrowError(ToolError);
    try {
      run("12.5", auto);
      expect.unreachable();
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("non-integer");
      expect(err.fix).toMatch(/fractional|round/);
    }
  });

  it("throws an actionable error for empty input", () => {
    expect(() => run("", auto)).toThrowError(ToolError);
    try {
      run("   ", auto);
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("handles zero", () => {
    const out = run("0", auto);
    expect(out.Decimal).toBe("0");
    expect(out.Hex).toBe("0x0");
    expect(out.Binary).toBe("0000");
    expect(out.Bits).toBe("1");
    expect(out.Bytes).toBe("00");
  });
});

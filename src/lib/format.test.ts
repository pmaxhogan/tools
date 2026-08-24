import { describe, expect, it } from "vitest";
import { formatByteCount, formatBytes } from "./format";

describe("formatBytes", () => {
  it("keeps sub-kilobyte values in bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("steps up at 1024, not 1000", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1000)).toBe("1000 B");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
  });

  it("drops the decimal once the value reaches 10", () => {
    expect(formatBytes(9.5 * 1024)).toBe("9.5 KB");
    expect(formatBytes(10 * 1024)).toBe("10 KB");
    expect(formatBytes(512 * 1024 * 1024)).toBe("512 MB");
  });

  it("stops scaling at maxUnit and keeps counting there", () => {
    expect(formatBytes(1024 ** 4, { maxUnit: "GB" })).toBe("1024 GB");
    expect(formatBytes(5 * 1024 * 1024, { maxUnit: "KB" })).toBe("5120 KB");
  });

  it("honors a wider precision on both sides of 10", () => {
    expect(formatBytes(1234, { precision: 2 })).toBe("1.21 KB");
    expect(formatBytes(20 * 1024, { largePrecision: 1 })).toBe("20.0 KB");
  });

  it("clamps negatives and fractional bytes by default", () => {
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(1.6)).toBe("2 B");
  });

  it("preserves sign and magnitude for deltas when clamp is off", () => {
    expect(formatBytes(-500, { clamp: false })).toBe("-500 B");
    expect(formatBytes(-2048, { clamp: false })).toBe("-2.0 KB");
    expect(formatBytes(-5 * 1024 * 1024, { clamp: false, maxUnit: "MB" })).toBe("-5.0 MB");
  });

  it("does not pretend a non-finite size is a real one", () => {
    expect(formatBytes(Number.NaN, { clamp: false })).toBe("NaN B");
    expect(formatBytes(Number.POSITIVE_INFINITY, { clamp: false })).toBe("Infinity B");
  });
});

describe("formatByteCount", () => {
  it("separates thousands and agrees with itself on the singular", () => {
    expect(formatByteCount(0)).toBe("0 bytes");
    expect(formatByteCount(1)).toBe("1 byte");
    expect(formatByteCount(1234)).toBe("1,234 bytes");
    expect(formatByteCount(1048576)).toBe("1,048,576 bytes");
  });
});

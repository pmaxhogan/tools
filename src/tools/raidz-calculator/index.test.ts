import { describe, expect, it } from "vitest";
import { parseShorthand, run, type RaidzOpts } from "./index";

const base: RaidzOpts = {
  disks: 6,
  diskSizeUnit: "TB",
  diskSize: 4,
  level: "raidz2",
  vdevs: 1,
  zfsOverhead: false,
};

describe("raidz-calculator", () => {
  it("computes usable capacity, efficiency, and fault tolerance for 6x4TB raidz2", () => {
    const out = run("", base);
    expect(out["Layout"]).toBe("1x (6-disk raidz2)");
    expect(out["Raw capacity"]).toContain("24.00 TB");
    expect(out["Usable capacity"]).toContain("16.00 TB");
    expect(out["Storage efficiency"]).toBe("66.7%");
    expect(out["Fault tolerance"]).toBe("2 disks per vdev");
    expect(out["Parity overhead"]).toContain("8.00 TB");
    expect(out["Parity overhead"]).toContain("33.3%");
  });

  it("throws too-few-disks when raidz2 does not have enough disks", () => {
    expect(() => run("", { ...base, disks: 2 })).toThrowError(/raidz2 needs at least 3 disks/);
  });

  it("computes a mirror as one disk's worth of usable space with 1 disk of tolerance", () => {
    const out = run("", { ...base, disks: 2, level: "mirror" });
    expect(out["Usable capacity"]).toContain("4.00 TB");
    expect(out["Fault tolerance"]).toBe("1 disk per vdev");
  });

  it("computes an n-way mirror's tolerance as disks minus one", () => {
    const out = run("", { ...base, disks: 4, level: "mirror" });
    expect(out["Usable capacity"]).toContain("4.00 TB");
    expect(out["Fault tolerance"]).toBe("3 disks per vdev");
  });

  it("gives a stripe 100% efficiency and warns about no redundancy", () => {
    const out = run("", { ...base, disks: 4, level: "stripe" });
    expect(out["Storage efficiency"]).toBe("100.0%");
    expect(out["Fault tolerance"]).toBe("0 disks per vdev (no redundancy)");
    expect(out["Notes"]).toMatch(/no redundancy/);
  });

  it("distinguishes decimal TB from binary TiB when converting disk size to bytes", () => {
    const tb = run("", { ...base, disks: 1, level: "stripe", diskSize: 1, diskSizeUnit: "TB" });
    const tib = run("", { ...base, disks: 1, level: "stripe", diskSize: 1, diskSizeUnit: "TiB" });
    expect(tb["Raw capacity"]).toContain("1.00 TB");
    expect(tib["Raw capacity"]).toContain("1.10 TB");
    expect(tb["Raw capacity"]).not.toBe(tib["Raw capacity"]);
  });

  it("derates usable capacity by about 2.4% when zfsOverhead is enabled", () => {
    const withoutOverhead = run("", base);
    const withOverhead = run("", { ...base, zfsOverhead: true });
    const parseTB = (s: string) => Number(s.match(/\(([\d.]+) TB\)/)![1]);
    const without = parseTB(withoutOverhead["Usable capacity"]!);
    const withOh = parseTB(withOverhead["Usable capacity"]!);
    expect(withOh).toBeLessThan(without);
    expect(withOh / without).toBeCloseTo(0.976, 2);
    expect(withOverhead["Notes"]).toMatch(/derated/);
  });

  it("parses a shorthand string like 6x4TB raidz2 and ignores the numeric options", () => {
    const out = run("6x4TB raidz2", { ...base, disks: 60, diskSize: 0.1, level: "stripe" });
    expect(out["Layout"]).toBe("1x (6-disk raidz2)");
    expect(out["Usable capacity"]).toContain("16.00 TB");
  });

  it("parseShorthand returns null for unrecognized text", () => {
    expect(parseShorthand("not a valid layout")).toBeNull();
    expect(parseShorthand("")).toBeNull();
  });

  it("throws bad-disks for zero or negative disk counts", () => {
    expect(() => run("", { ...base, disks: 0 })).toThrowError(/at least 1/);
  });

  it("throws bad-disk-size for a non-positive disk size", () => {
    expect(() => run("", { ...base, diskSize: 0 })).toThrowError(/greater than 0/);
  });

  it("throws bad-vdevs for a vdev count below 1", () => {
    expect(() => run("", { ...base, vdevs: 0 })).toThrowError(/at least 1/);
  });

  it("throws bad-level for an unrecognized RAIDZ level", () => {
    expect(() => run("", { ...base, level: "raidz9" })).toThrowError(/Unknown RAIDZ level/);
  });

  it("throws bad-unit for an unrecognized disk size unit", () => {
    expect(() => run("", { ...base, diskSizeUnit: "PB" })).toThrowError(/Unknown disk size unit/);
  });

  it("multiplies usable capacity by the number of striped vdevs", () => {
    const one = run("", { ...base, vdevs: 1 });
    const two = run("", { ...base, vdevs: 2 });
    const parseTB = (s: string) => Number(s.match(/\(([\d.]+) TB\)/)![1]);
    expect(parseTB(two["Usable capacity"]!)).toBeCloseTo(parseTB(one["Usable capacity"]!) * 2, 5);
  });
});

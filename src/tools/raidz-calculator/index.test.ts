import { describe, expect, it } from "vitest";
import { parseShorthand, run, type RaidzOpts } from "./index";
import { ToolError } from "../types";

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

const parseTB = (s: string) => Number(s.match(/\(([\d.]+) TB\)/)![1]);

describe("raidz-calculator v2 rows", () => {
  it("shows the ZFS overhead as its own row once the toggle is on", () => {
    const off = run("", base);
    const on = run("", { ...base, zfsOverhead: true });
    expect(off["ZFS overhead"]).toBeUndefined();
    expect(parseTB(on["ZFS overhead"]!)).toBeCloseTo(16 * 0.024, 1);
    expect(on["ZFS overhead"]).toContain("1.6%");
  });

  it("keeps the parity row as parity alone rather than every derate combined", () => {
    const on = run("", { ...base, zfsOverhead: true });
    expect(parseTB(on["Parity overhead"]!)).toBeCloseTo(8, 6);
    expect(on["Parity overhead"]).toContain("33.3%");
  });

  it("adds a usable-after-OS-reserve row only when a reserve is asked for", () => {
    expect(run("", base)["Usable after OS reserve"]).toBeUndefined();
    const out = run("", { ...base, osReservePercent: 10 });
    expect(parseTB(out["Usable capacity"]!)).toBeCloseTo(16, 6);
    expect(parseTB(out["Usable after OS reserve"]!)).toBeCloseTo(14.4, 6);
    expect(out["Usable after OS reserve"]).toContain("10% held back");
    expect(out["Notes"]).toMatch(/OS and filesystem reserve/);
  });

  it("counts hot spares in raw capacity, in a spare row, and in efficiency", () => {
    const out = run("", { ...base, hotSpares: 2 });
    expect(parseTB(out["Raw capacity"]!)).toBeCloseTo(32, 6);
    expect(parseTB(out["Spare capacity"]!)).toBeCloseTo(8, 6);
    expect(out["Spare capacity"]).toContain("2 hot spares");
    expect(out["Storage efficiency"]).toBe("50.0%");
    expect(out["Fault tolerance"]).toBe("2 disks per vdev");
    expect(out["Notes"]).toMatch(/never raises the number of drives a vdev can lose/);
  });

  it("makes every capacity slice add up to the raw capacity", () => {
    const out = run("", {
      ...base,
      level: "draid2",
      disks: 11,
      hotSpares: 1,
      zfsOverhead: true,
      osReservePercent: 5,
    });
    // "Usable capacity" is the post-ZFS figure, so the OS reserve is the gap
    // between it and the after-reserve row. Those five slices are the pie.
    const usable = parseTB(out["Usable after OS reserve"]!);
    const osReserve = parseTB(out["Usable capacity"]!) - usable;
    const slices =
      usable +
      osReserve +
      parseTB(out["Parity overhead"]!) +
      parseTB(out["ZFS overhead"]!) +
      parseTB(out["Spare capacity"]!);
    expect(osReserve).toBeGreaterThan(0);
    expect(slices).toBeCloseTo(parseTB(out["Raw capacity"]!), 1);
    expect(parseTB(out["Raw capacity"]!)).toBeCloseTo(44, 6);
  });

  it("reads spares as dRAID distributed spares and excludes them from usable space", () => {
    const out = run("", { ...base, level: "draid2", disks: 11, hotSpares: 1 });
    expect(out["Layout"]).toBe("1x (11-disk draid2 with 1 distributed spare)");
    expect(parseTB(out["Usable capacity"]!)).toBeCloseTo(32, 6);
    expect(parseTB(out["Spare capacity"]!)).toBeCloseTo(4, 6);
    expect(parseTB(out["Raw capacity"]!)).toBeCloseTo(44, 6);
    expect(out["Fault tolerance"]).toBe("2 disks per vdev");
    expect(out["Notes"]).toMatch(/distributed spare/);
  });

  it("rejects a dRAID vdev too narrow once its spares are counted", () => {
    expect(() => run("", { ...base, level: "draid2", disks: 4, hotSpares: 2 })).toThrowError(
      /draid2 needs at least 5 disks/,
    );
  });

  it("names dRAID in the unknown-level fix text", () => {
    try {
      run("", { ...base, level: "raidz9" });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-level");
      expect((err as ToolError).fix).toContain("draid1");
    }
  });

  it("reports MTTDL and annual data loss risk from the default reliability inputs", () => {
    const out = run("", base);
    expect(out["MTTDL (pool)"]).toMatch(/years/);
    expect(out["MTTDL (pool)"]).toContain("24 h resilver");
    expect(out["MTTDL (pool)"]).toContain("1,200,000 h");
    expect(out["Annual data loss risk"]).toMatch(/%$/);
  });

  it("makes a wider stripe far riskier than a raidz2 of the same width", () => {
    const stripe = run("", { ...base, level: "stripe" });
    const raidz2 = run("", base);
    const risk = (s: string) => Number(s.replace("%", ""));
    expect(risk(stripe["Annual data loss risk"]!)).toBeGreaterThan(
      risk(raidz2["Annual data loss risk"]!),
    );
  });

  it("prefers an AFR over the MTBF and shows the drive figures it used", () => {
    const out = run("", { ...base, afrPercent: 2 });
    expect(out["MTTDL (pool)"]).toContain("2.00% AFR");
    expect(out["MTTDL (pool)"]).not.toContain("1,200,000 h");
  });

  it("improves the reliability numbers when a hot spare removes the wait for a human", () => {
    const bare = run("", base);
    const spared = run("", { ...base, hotSpares: 1 });
    const risk = (s: string) => Number(s.replace("%", ""));
    expect(risk(spared["Annual data loss risk"]!)).toBeLessThan(
      risk(bare["Annual data loss risk"]!),
    );
    expect(bare["MTTDL (pool)"]).toContain("million years");
    expect(spared["MTTDL (pool)"]).toContain("billion years");
  });

  it("drops the reliability rows when the resilver time is zero", () => {
    const out = run("", { ...base, resilverHours: 0 });
    expect(out["MTTDL (pool)"]).toBeUndefined();
    expect(out["Annual data loss risk"]).toBeUndefined();
    expect(out["Notes"]).toMatch(/UREs/);
  });

  it("always says unrecoverable read errors are ignored", () => {
    expect(run("", base)["Notes"]).toMatch(/Unrecoverable read errors \(UREs\) are ignored/);
  });

  it("still accepts option values that arrive as strings from the query API", () => {
    const out = run("", {
      ...base,
      hotSpares: "2" as unknown as number,
      osReservePercent: "10" as unknown as number,
      resilverHours: "48" as unknown as number,
    });
    expect(parseTB(out["Spare capacity"]!)).toBeCloseTo(8, 6);
    expect(out["Usable after OS reserve"]).toContain("10% held back");
    expect(out["MTTDL (pool)"]).toContain("48 h resilver");
  });
});

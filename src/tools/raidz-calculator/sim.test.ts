import { describe, expect, it } from "vitest";
import {
  decodeFailures,
  driveId,
  encodeFailures,
  isDraid,
  largestDiskBytes,
  minDisks,
  parityDisks,
  poolCapacity,
  simulate,
  toleratedFailures,
  vdevDataDisks,
  vdevParityBytes,
  vdevSpareBytes,
  vdevUsableBytes,
  type PoolSpec,
  type VdevSpec,
} from "./sim";

const TB = 1e12;

function vdev(partial: Partial<VdevSpec> = {}): VdevSpec {
  return { level: "raidz2", disks: 6, diskBytes: 4 * TB, ...partial };
}

function pool(vdevs: VdevSpec[], hotSpares = 0): PoolSpec {
  return { vdevs, hotSpares };
}

/** The pie invariant: the five slices are exhaustive and add up to every drive. */
function expectSlicesSumToRaw(spec: PoolSpec, osReservePercent = 0, zfsOverhead = false) {
  const c = poolCapacity(spec, { zfsOverhead, osReservePercent });
  const sum = c.usableBytes + c.parityBytes + c.zfsOverheadBytes + c.osReserveBytes + c.spareBytes;
  expect(sum / c.rawBytes).toBeCloseTo(1, 10);
  return c;
}

describe("raidz-calculator/sim parity and tolerance", () => {
  it("reports nominal parity per level", () => {
    expect(parityDisks("stripe")).toBe(0);
    expect(parityDisks("mirror")).toBe(1);
    expect(parityDisks("raidz1")).toBe(1);
    expect(parityDisks("raidz2")).toBe(2);
    expect(parityDisks("raidz3")).toBe(3);
    expect(parityDisks("draid1")).toBe(1);
    expect(parityDisks("draid2")).toBe(2);
    expect(parityDisks("draid3")).toBe(3);
  });

  it("separates nominal parity from how many drives a vdev survives losing", () => {
    expect(toleratedFailures(vdev({ level: "mirror", disks: 3 }))).toBe(2);
    expect(parityDisks("mirror")).toBe(1);
    expect(toleratedFailures(vdev({ level: "stripe", disks: 4 }))).toBe(0);
    expect(toleratedFailures(vdev({ level: "raidz2", disks: 6 }))).toBe(2);
    expect(toleratedFailures(vdev({ level: "draid3", disks: 12, spares: 2 }))).toBe(3);
  });

  it("knows which levels are dRAID", () => {
    expect(isDraid("draid2")).toBe(true);
    expect(isDraid("raidz2")).toBe(false);
    expect(isDraid("mirror")).toBe(false);
  });

  it("computes the smallest legal width per level, spares included", () => {
    expect(minDisks("stripe")).toBe(1);
    expect(minDisks("mirror")).toBe(2);
    expect(minDisks("raidz1")).toBe(2);
    expect(minDisks("raidz2")).toBe(3);
    expect(minDisks("raidz3")).toBe(4);
    expect(minDisks("draid2", 0)).toBe(3);
    expect(minDisks("draid2", 2)).toBe(5);
  });
});

describe("raidz-calculator/sim capacity", () => {
  it("computes raidz2 usable space as data disks times drive size", () => {
    const v = vdev({ level: "raidz2", disks: 6 });
    expect(vdevDataDisks(v)).toBe(4);
    expect(vdevUsableBytes(v)).toBe(16 * TB);
    expect(vdevParityBytes(v)).toBe(8 * TB);
    expect(vdevSpareBytes(v)).toBe(0);
  });

  it("computes a mirror as one drive of usable space regardless of width", () => {
    expect(vdevUsableBytes(vdev({ level: "mirror", disks: 2 }))).toBe(4 * TB);
    expect(vdevUsableBytes(vdev({ level: "mirror", disks: 4 }))).toBe(4 * TB);
    expect(vdevParityBytes(vdev({ level: "mirror", disks: 4 }))).toBe(12 * TB);
  });

  it("gives a stripe every byte as usable", () => {
    const v = vdev({ level: "stripe", disks: 4 });
    expect(vdevUsableBytes(v)).toBe(16 * TB);
    expect(vdevParityBytes(v)).toBe(0);
  });

  it("excludes dRAID distributed spare capacity from usable space", () => {
    const v = vdev({ level: "draid2", disks: 11, spares: 1 });
    expect(vdevDataDisks(v)).toBe(8);
    expect(vdevUsableBytes(v)).toBe(32 * TB);
    expect(vdevSpareBytes(v)).toBe(4 * TB);
    expect(vdevParityBytes(v)).toBe(8 * TB);
  });

  it("ignores a spare count on levels that have no distributed spares", () => {
    expect(vdevSpareBytes(vdev({ level: "raidz2", disks: 6, spares: 2 }))).toBe(0);
    expect(vdevUsableBytes(vdev({ level: "raidz2", disks: 6, spares: 2 }))).toBe(16 * TB);
  });

  it("sums every slice to raw capacity for every level", () => {
    const levels = ["stripe", "mirror", "raidz1", "raidz2", "raidz3"] as const;
    for (const level of levels) {
      const c = expectSlicesSumToRaw(pool([vdev({ level, disks: 8 })]), 0, true);
      expect(c.rawBytes).toBe(32 * TB);
    }
  });

  it("sums every slice to raw capacity with dRAID spares, hot spares and both derates", () => {
    const spec = pool([vdev({ level: "draid2", disks: 11, spares: 1 })], 2);
    const c = expectSlicesSumToRaw(spec, 10, true);
    expect(c.rawBytes).toBe(44 * TB + 8 * TB);
    expect(c.spareBytes).toBe(4 * TB + 8 * TB);
  });

  it("counts pool-wide hot spares in raw capacity so the pie still totals 100%", () => {
    const spec = pool([vdev({ level: "raidz2", disks: 6 })], 2);
    const c = poolCapacity(spec, { zfsOverhead: false });
    expect(c.rawBytes).toBe(32 * TB);
    expect(c.spareBytes).toBe(8 * TB);
    expect(c.usableBytes).toBe(16 * TB);
    expect(c.efficiency).toBeCloseTo(0.5, 10);
  });

  it("sizes pool-wide hot spares at the largest member drive", () => {
    const spec = pool([vdev({ diskBytes: 4 * TB }), vdev({ diskBytes: 10 * TB })], 1);
    expect(largestDiskBytes(spec)).toBe(10 * TB);
    const c = poolCapacity(spec, { zfsOverhead: false });
    expect(c.spareBytes).toBe(10 * TB);
  });

  it("takes the OS reserve after the ZFS derate, not off raw", () => {
    const spec = pool([vdev({ level: "raidz2", disks: 6 })]);
    const c = poolCapacity(spec, { zfsOverhead: true, osReservePercent: 10 });
    expect(c.zfsOverheadBytes / TB).toBeCloseTo(16 * 0.024, 8);
    expect(c.osReserveBytes / TB).toBeCloseTo(16 * 0.976 * 0.1, 8);
    expect(c.usableBytes / TB).toBeCloseTo(16 * 0.976 * 0.9, 8);
  });

  it("adds mixed vdevs of different widths and levels", () => {
    const spec = pool([
      vdev({ level: "raidz2", disks: 6 }),
      vdev({ level: "mirror", disks: 2 }),
      vdev({ level: "raidz1", disks: 3, diskBytes: 8 * TB }),
    ]);
    const c = poolCapacity(spec, { zfsOverhead: false });
    expect(c.rawBytes).toBe(24 * TB + 8 * TB + 24 * TB);
    expect(c.usableBytes).toBe(16 * TB + 4 * TB + 16 * TB);
    expectSlicesSumToRaw(spec);
  });

  it("rejects a pool with no vdevs", () => {
    expect(() => poolCapacity(pool([]), { zfsOverhead: false })).toThrowError(/at least one vdev/);
  });

  it("rejects a vdev too narrow for its level", () => {
    expect(() =>
      poolCapacity(pool([vdev({ level: "raidz3", disks: 3 })]), { zfsOverhead: false }),
    ).toThrowError(/raidz3 needs at least 4 disks/);
  });

  it("counts distributed spares toward the dRAID minimum width", () => {
    expect(() =>
      poolCapacity(pool([vdev({ level: "draid2", disks: 4, spares: 2 })]), { zfsOverhead: false }),
    ).toThrowError(/draid2 needs at least 5 disks/);
  });

  it("rejects an OS reserve outside 0 to 100 percent", () => {
    const spec = pool([vdev()]);
    expect(() => poolCapacity(spec, { zfsOverhead: false, osReservePercent: 100 })).toThrowError(
      /below 100 percent/,
    );
    expect(() => poolCapacity(spec, { zfsOverhead: false, osReservePercent: -1 })).toThrowError(
      /below 100 percent/,
    );
  });
});

describe("raidz-calculator/sim failure simulation", () => {
  const twoRaidz2 = pool([
    vdev({ level: "raidz2", disks: 6 }),
    vdev({ level: "raidz2", disks: 6 }),
  ]);

  it("reports an untouched pool as online with full headroom", () => {
    const s = simulate(twoRaidz2, new Set());
    expect(s.health).toBe("online");
    expect(s.dataLoss).toBe(false);
    expect(s.failuresLeftMin).toBe(2);
    expect(s.vdevs).toHaveLength(2);
    expect(s.vdevs[0]!.disks).toHaveLength(6);
    expect(s.vdevs[0]!.disks[0]!.id).toBe("v0d0");
    expect(s.vdevs[0]!.disks.every((d) => d.state === "online")).toBe(true);
  });

  it("degrades the vdev and the pool on the first failure", () => {
    const s = simulate(twoRaidz2, new Set(["v0d3"]));
    expect(s.vdevs[0]!.health).toBe("degraded");
    expect(s.vdevs[0]!.failedCount).toBe(1);
    expect(s.vdevs[0]!.failuresLeft).toBe(1);
    expect(s.vdevs[1]!.health).toBe("online");
    expect(s.health).toBe("degraded");
    expect(s.failuresLeftMin).toBe(1);
    expect(s.dataLoss).toBe(false);
    expect(s.vdevs[0]!.disks[3]!.state).toBe("failed");
  });

  it("stays degraded at exactly the tolerated number of failures, with zero left", () => {
    const s = simulate(twoRaidz2, new Set(["v0d3", "v0d4"]));
    expect(s.vdevs[0]!.health).toBe("degraded");
    expect(s.vdevs[0]!.failuresLeft).toBe(0);
    expect(s.health).toBe("degraded");
    expect(s.failuresLeftMin).toBe(0);
    expect(s.dataLoss).toBe(false);
  });

  it("faults the vdev and the whole pool one failure past tolerance", () => {
    const s = simulate(twoRaidz2, new Set(["v0d3", "v0d4", "v0d5"]));
    expect(s.vdevs[0]!.health).toBe("faulted");
    expect(s.vdevs[0]!.failedCount).toBe(3);
    expect(s.vdevs[0]!.failuresLeft).toBe(0);
    expect(s.vdevs[1]!.health).toBe("online");
    expect(s.health).toBe("faulted");
    expect(s.dataLoss).toBe(true);
  });

  it("spreads failures across vdevs without faulting either", () => {
    const s = simulate(twoRaidz2, new Set(["v0d0", "v0d1", "v1d0", "v1d1"]));
    expect(s.vdevs.every((v) => v.health === "degraded")).toBe(true);
    expect(s.health).toBe("degraded");
    expect(s.dataLoss).toBe(false);
    expect(s.failuresLeftMin).toBe(0);
  });

  it("faults a stripe on its first failure", () => {
    const s = simulate(pool([vdev({ level: "stripe", disks: 4 })]), new Set(["v0d2"]));
    expect(s.vdevs[0]!.toleratedFailures).toBe(0);
    expect(s.vdevs[0]!.health).toBe("faulted");
    expect(s.dataLoss).toBe(true);
  });

  it("lets a three way mirror lose two drives before faulting", () => {
    const spec = pool([vdev({ level: "mirror", disks: 3 })]);
    expect(simulate(spec, new Set(["v0d0", "v0d1"])).health).toBe("degraded");
    expect(simulate(spec, new Set(["v0d0", "v0d1", "v0d2"])).health).toBe("faulted");
  });

  it("gives dRAID the tolerance of its parity, not its spares", () => {
    const spec = pool([vdev({ level: "draid2", disks: 11, spares: 1 })]);
    expect(simulate(spec, new Set(["v0d0", "v0d1"])).vdevs[0]!.failuresLeft).toBe(0);
    expect(simulate(spec, new Set(["v0d0", "v0d1", "v0d2"])).dataLoss).toBe(true);
  });

  it("does not let pool-wide hot spares add tolerance to a vdev", () => {
    const bare = simulate(pool([vdev({ disks: 6 })], 0), new Set(["v0d0", "v0d1", "v0d2"]));
    const spared = simulate(pool([vdev({ disks: 6 })], 4), new Set(["v0d0", "v0d1", "v0d2"]));
    expect(bare.dataLoss).toBe(true);
    expect(spared.dataLoss).toBe(true);
    expect(spared.vdevs[0]!.toleratedFailures).toBe(2);
  });

  it("ignores drive ids the pool does not have", () => {
    const s = simulate(twoRaidz2, new Set(["v9d9", "v0d99", "junk"]));
    expect(s.health).toBe("online");
    expect(s.dataLoss).toBe(false);
  });
});

describe("raidz-calculator/sim failure encoding", () => {
  it("builds stable drive ids", () => {
    expect(driveId(0, 3)).toBe("v0d3");
    expect(driveId(12, 0)).toBe("v12d0");
  });

  it("round trips a failure set", () => {
    const set = new Set(["v0d3", "v1d0", "v10d2"]);
    expect(decodeFailures(encodeFailures(set))).toEqual(set);
  });

  it("encodes canonically no matter what order the drives were clicked", () => {
    const a = encodeFailures(new Set(["v1d0", "v0d3", "v0d1"]));
    const b = encodeFailures(new Set(["v0d1", "v1d0", "v0d3"]));
    expect(a).toBe("v0d1,v0d3,v1d0");
    expect(a).toBe(b);
  });

  it("sorts numerically rather than as text", () => {
    expect(encodeFailures(["v10d0", "v2d0", "v0d10", "v0d2"])).toBe("v0d2,v0d10,v2d0,v10d0");
  });

  it("drops entries it cannot parse instead of throwing", () => {
    expect(decodeFailures("v0d1, nonsense, ,v1d2")).toEqual(new Set(["v0d1", "v1d2"]));
    expect(decodeFailures("")).toEqual(new Set());
    expect(encodeFailures(["v0d1", "oops"])).toBe("v0d1");
  });

  it("encodes an empty set as an empty string", () => {
    expect(encodeFailures(new Set())).toBe("");
    expect(decodeFailures(encodeFailures(new Set()))).toEqual(new Set());
  });
});

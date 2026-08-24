import { describe, expect, it } from "vitest";
import {
  afrToMtbfHours,
  annualLossProbability,
  draidRebuildSpeedup,
  formatMttdl,
  formatProbability,
  HOURS_PER_YEAR,
  MANUAL_REPLACEMENT_DELAY_HOURS,
  MTBF_REFERENCE,
  mtbfToAfrPercent,
  mttdl,
  vdevMttdlHours,
} from "./reliability";
import { parityDisks, type PoolSpec, type VdevSpec } from "./sim";

const TB = 1e12;

function vdev(partial: Partial<VdevSpec> = {}): VdevSpec {
  return { level: "raidz2", disks: 6, diskBytes: 4 * TB, ...partial };
}

function pool(vdevs: VdevSpec[], hotSpares = 0): PoolSpec {
  return { vdevs, hotSpares };
}

describe("raidz-calculator/reliability AFR conversion", () => {
  it("converts AFR to MTBF with the exponential relation, not the naive divide", () => {
    // 8766 / ln(1 / 0.99) = 872209.9...
    expect(afrToMtbfHours(1)).toBeCloseTo(HOURS_PER_YEAR / Math.log(1 / 0.99), 6);
    expect(afrToMtbfHours(1)).toBeGreaterThan(870_000);
    expect(afrToMtbfHours(1)).toBeLessThan(875_000);
    // The naive 8766 / 0.01 would be 876600, which is what this deliberately avoids.
    expect(afrToMtbfHours(1)).not.toBeCloseTo(876_600, -2);
  });

  it("round trips AFR to MTBF and back", () => {
    for (const afr of [0.3, 0.5, 1, 1.5, 2, 10]) {
      expect(mtbfToAfrPercent(afrToMtbfHours(afr))).toBeCloseTo(afr, 8);
    }
  });

  it("gives a lower failure rate for a longer MTBF", () => {
    expect(mtbfToAfrPercent(2_500_000)).toBeLessThan(mtbfToAfrPercent(1_000_000));
    expect(mtbfToAfrPercent(1_000_000)).toBeCloseTo((1 - Math.exp(-0.008766)) * 100, 10);
  });

  it("rejects failure rates outside 0 to 100 percent", () => {
    expect(() => afrToMtbfHours(0)).toThrowError(/above 0 and below 100/);
    expect(() => afrToMtbfHours(100)).toThrowError(/above 0 and below 100/);
    expect(() => afrToMtbfHours(-1)).toThrowError(/above 0 and below 100/);
  });

  it("rejects a non-positive MTBF", () => {
    expect(() => mtbfToAfrPercent(0)).toThrowError(/greater than 0 hours/);
  });
});

describe("raidz-calculator/reliability MTTDL formulas", () => {
  it("matches the hand computed single parity formula", () => {
    // MTBF^2 / (n(n-1) MTTR) = 1e12 / (4*3*10) = 8.3333e9
    expect(vdevMttdlHours(4, 1, 1e6, 10)).toBeCloseTo(1e12 / 120, 0);
  });

  it("matches the hand computed double parity formula", () => {
    // MTBF^3 / (n(n-1)(n-2) MTTR^2) = 1e18 / (6*5*4*100) = 8.3333e13
    expect(vdevMttdlHours(6, 2, 1e6, 10)).toBeCloseTo(1e18 / 12_000, 0);
  });

  it("matches the hand computed triple parity formula", () => {
    // MTBF^4 / (n(n-1)(n-2)(n-3) MTTR^3) = 1e24 / (5*4*3*2*1000) = 8.3333e18
    expect(vdevMttdlHours(5, 3, 1e6, 10)).toBeCloseTo(1e24 / 120_000, 0);
  });

  it("degenerates to MTBF over n for a stripe", () => {
    expect(vdevMttdlHours(8, 0, 1e6, 10)).toBeCloseTo(125_000, 6);
    expect(vdevMttdlHours(8, 0, 1e6, 999)).toBeCloseTo(125_000, 6);
  });

  it("rises when the repair gets faster and falls as the vdev gets wider", () => {
    expect(vdevMttdlHours(6, 2, 1e6, 5)).toBeGreaterThan(vdevMttdlHours(6, 2, 1e6, 20));
    expect(vdevMttdlHours(12, 2, 1e6, 10)).toBeLessThan(vdevMttdlHours(6, 2, 1e6, 10));
  });

  it("refuses a vdev with no more drives than parity", () => {
    expect(() => vdevMttdlHours(2, 2, 1e6, 10)).toThrowError(/needs more than 2 drives/);
  });

  it("converts an MTTDL to an annual data loss probability", () => {
    expect(annualLossProbability(HOURS_PER_YEAR)).toBeCloseTo(1 - Math.exp(-1), 12);
    expect(annualLossProbability(1e12)).toBeLessThan(1e-7);
    expect(annualLossProbability(0)).toBe(1);
  });
});

describe("raidz-calculator/reliability pool aggregation", () => {
  const opts = { mtbfHours: 1e6, resilverHours: 10 };

  it("halves the pool MTTDL when a second identical vdev is striped in", () => {
    const one = mttdl(pool([vdev()]), opts);
    const two = mttdl(pool([vdev(), vdev()]), opts);
    expect(two.mttdlHours).toBeCloseTo(one.mttdlHours / 2, 0);
    expect(two.vdevs).toHaveLength(2);
    expect(two.vdevs[0]!.mttdlHours).toBeCloseTo(one.vdevs[0]!.mttdlHours, 0);
  });

  it("lets the weakest vdev dominate a mixed pool", () => {
    const mixed = mttdl(
      pool([vdev({ level: "raidz3" }), vdev({ level: "stripe", disks: 4 })]),
      opts,
    );
    const stripeOnly = mttdl(pool([vdev({ level: "stripe", disks: 4 })]), opts);
    expect(mixed.mttdlHours).toBeLessThan(stripeOnly.mttdlHours * 1.001);
    expect(mixed.mttdlHours).toBeGreaterThan(stripeOnly.mttdlHours * 0.9);
  });

  it("adds the human replacement delay to MTTR when no spare is racked", () => {
    const bare = mttdl(pool([vdev()], 0), opts);
    expect(bare.vdevs[0]!.mttrHours).toBe(10 + MANUAL_REPLACEMENT_DELAY_HOURS);
  });

  it("drops the human delay when a pool-wide hot spare is available", () => {
    const bare = mttdl(pool([vdev()], 0), opts);
    const spared = mttdl(pool([vdev()], 1), opts);
    expect(spared.vdevs[0]!.mttrHours).toBe(10);
    expect(spared.mttdlHours).toBeGreaterThan(bare.mttdlHours);
  });

  it("lets the hotSpares option override the pool spec", () => {
    const spec = pool([vdev()], 0);
    expect(mttdl(spec, { ...opts, hotSpares: 2 }).vdevs[0]!.mttrHours).toBe(10);
  });

  it("shortens a dRAID rebuild in proportion to the drives taking part", () => {
    const draid = vdev({ level: "draid2", disks: 11, spares: 1 });
    expect(draidRebuildSpeedup(draid)).toBe(10);
    expect(draidRebuildSpeedup(vdev({ level: "draid2", disks: 11, spares: 0 }))).toBe(1);
    expect(draidRebuildSpeedup(vdev({ level: "raidz2", disks: 11 }))).toBe(1);
    const r = mttdl(pool([draid]), opts);
    expect(r.vdevs[0]!.mttrHours).toBeCloseTo(1, 10);
    expect(r.vdevs[0]!.modelParity).toBe(2);
  });

  it("beats an equally wide raidz2 with the same parity thanks to the faster rebuild", () => {
    const draid = mttdl(pool([vdev({ level: "draid2", disks: 11, spares: 1 })]), opts);
    const raidz = mttdl(pool([vdev({ level: "raidz2", disks: 11 })], 1), opts);
    expect(draid.mttdlHours).toBeGreaterThan(raidz.mttdlHours);
  });

  it("scores a two way mirror with the single parity formula", () => {
    const mirror = mttdl(pool([vdev({ level: "mirror", disks: 2 })], 1), opts);
    expect(mirror.vdevs[0]!.modelParity).toBe(1);
    expect(mirror.vdevs[0]!.mttdlHours).toBeCloseTo(vdevMttdlHours(2, 1, 1e6, 10), 0);
  });

  it("scores an n-way mirror on the failures it tolerates, so a third copy helps", () => {
    const two = mttdl(pool([vdev({ level: "mirror", disks: 2 })], 1), opts);
    const three = mttdl(pool([vdev({ level: "mirror", disks: 3 })], 1), opts);
    expect(three.vdevs[0]!.modelParity).toBe(2);
    expect(three.vdevs[0]!.mttdlHours).toBeCloseTo(vdevMttdlHours(3, 2, 1e6, 10), 0);
    expect(three.mttdlHours).toBeGreaterThan(two.mttdlHours);
  });

  it("uses the parity count as the exponent on every level that is not a mirror", () => {
    const levels = ["stripe", "raidz1", "raidz2", "raidz3", "draid1", "draid2", "draid3"] as const;
    for (const level of levels) {
      const r = mttdl(pool([vdev({ level, disks: 8, spares: 1 })]), opts);
      expect(r.vdevs[0]!.modelParity).toBe(parityDisks(level));
    }
  });

  it("prefers an AFR over an MTBF when one is supplied", () => {
    const byAfr = mttdl(pool([vdev()]), { ...opts, afrPercent: 1 });
    expect(byAfr.mtbfHours).toBeCloseTo(afrToMtbfHours(1), 6);
    expect(byAfr.afrPercent).toBeCloseTo(1, 8);
  });

  it("reports the AFR implied by a bare MTBF", () => {
    const r = mttdl(pool([vdev()]), opts);
    expect(r.afrPercent).toBeCloseTo(mtbfToAfrPercent(1e6), 10);
    expect(r.mttdlYears).toBeCloseTo(r.mttdlHours / HOURS_PER_YEAR, 6);
    expect(r.annualDataLossProbability).toBeCloseTo(annualLossProbability(r.mttdlHours), 12);
  });

  it("rejects bad reliability inputs with actionable errors", () => {
    expect(() => mttdl(pool([]), opts)).toThrowError(/at least one vdev/);
    expect(() => mttdl(pool([vdev()]), { mtbfHours: 0, resilverHours: 10 })).toThrowError(
      /MTBF must be greater than 0/,
    );
    expect(() => mttdl(pool([vdev()]), { mtbfHours: 1e6, resilverHours: 0 })).toThrowError(
      /Resilver time must be greater than 0/,
    );
    expect(() => mttdl(pool([vdev()]), { ...opts, afrPercent: 150 })).toThrowError(
      /above 0 and below 100/,
    );
  });
});

describe("raidz-calculator/reliability reference table", () => {
  it("offers realistic worked examples across drive classes", () => {
    expect(MTBF_REFERENCE).toHaveLength(5);
    const ids = MTBF_REFERENCE.map((r) => r.id);
    expect(ids).toEqual([
      "consumer-hdd",
      "nas-hdd",
      "enterprise-hdd",
      "consumer-ssd",
      "enterprise-ssd",
    ]);
  });

  it("keeps every AFR in a plausible range with a derived MTBF and a source note", () => {
    for (const row of MTBF_REFERENCE) {
      expect(row.afrPercent).toBeGreaterThan(0);
      expect(row.afrPercent).toBeLessThan(5);
      expect(row.mtbfHours).toBeCloseTo(Math.round(afrToMtbfHours(row.afrPercent)), 6);
      expect(row.note.length).toBeGreaterThan(40);
      expect(row.vendorMtbfHours).toBeGreaterThan(row.mtbfHours * 0.5);
    }
  });

  it("ranks enterprise drives ahead of consumer drives", () => {
    const by = (id: string) => MTBF_REFERENCE.find((r) => r.id === id)!;
    expect(by("enterprise-hdd").afrPercent).toBeLessThan(by("consumer-hdd").afrPercent);
    expect(by("enterprise-ssd").afrPercent).toBeLessThan(by("consumer-ssd").afrPercent);
    expect(by("consumer-hdd").afrPercent).toBe(1.5);
    expect(by("enterprise-hdd").vendorMtbfHours).toBe(2_500_000);
  });
});

describe("raidz-calculator/reliability formatting", () => {
  it("scales an MTTDL into readable years", () => {
    expect(formatMttdl(HOURS_PER_YEAR * 2.5e9)).toBe("2.5 billion years");
    expect(formatMttdl(HOURS_PER_YEAR * 1.4e6)).toBe("1.4 million years");
    expect(formatMttdl(HOURS_PER_YEAR * 8300)).toBe("8,300 years");
    expect(formatMttdl(HOURS_PER_YEAR * 3.25)).toBe("3.3 years");
    expect(formatMttdl(500)).toBe("500 hours");
    expect(formatMttdl(0)).toBe("less than an hour");
  });

  it("keeps a small risk from rounding away to zero", () => {
    expect(formatProbability(0.0521)).toBe("5.21%");
    expect(formatProbability(0.00004)).toBe("0.0040%");
    expect(formatProbability(1e-9)).toBe("1.00e-7%");
    expect(formatProbability(0)).toBe("0%");
  });
});

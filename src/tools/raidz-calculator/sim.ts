/**
 * RAIDZ calculator v2: the pool model and the failure simulation.
 *
 * Pure arithmetic and string building. Nothing here touches the DOM, the
 * network, or a clock, so the same pool always produces the same numbers and
 * the bespoke panel can call these functions directly.
 *
 * The model is deliberately a layer above `run()`: a pool is a list of vdevs,
 * each with its own level, width, drive size, and (for dRAID) its own
 * distributed spares. That is what lets the panel draw mixed pools, where one
 * vdev is a 6 wide raidz2 and the next is a pair of mirrors.
 */
import { ToolError } from "../types";

/** Every redundancy layout the calculator models. */
export type VdevLevel =
  "stripe" | "mirror" | "raidz1" | "raidz2" | "raidz3" | "draid1" | "draid2" | "draid3";

/**
 * One vdev.
 *
 * `disks` is always the physical drive count of the vdev. For dRAID that
 * includes the distributed spares, because dRAID spare space lives inside the
 * vdev rather than beside it: a `draid2:4d:1s:7c` vdev has 7 children, of which
 * 1 child's worth of capacity is reserved as distributed spare.
 */
export interface VdevSpec {
  level: VdevLevel;
  /** Physical drives in this vdev. For dRAID: data + parity + distributed spares. */
  disks: number;
  /** Size of each drive in bytes. Every drive in a vdev is assumed identical. */
  diskBytes: number;
  /** dRAID distributed spares. Counted inside `disks`; ignored on other levels. */
  spares?: number;
}

/**
 * A pool: one or more vdevs striped together, plus any pool-wide hot spares.
 *
 * `hotSpares` are whole idle drives sitting in the chassis. They add no fault
 * tolerance to any single vdev (a raidz2 vdev still dies at the third failure
 * whether or not a spare is racked), but they remove the human replacement
 * delay from the mean time to repair, which is where they pay for themselves.
 * See `mttdl` in reliability.ts.
 */
export interface PoolSpec {
  vdevs: VdevSpec[];
  /** Pool-wide idle spare drives, sized at the largest member drive in the pool. */
  hotSpares?: number;
}

/**
 * Approximate ZFS slop-space and metadata reservation derate.
 *
 * ZFS holds back a slice of every pool (historically 1/32, capped, plus space
 * accounted to metadata and the space maps) so a full pool can still free
 * blocks. 2.4% is a workable middle estimate for a homelab-sized pool. It is
 * not exact: real usable space also depends on ashift, recordsize, and RAIDZ
 * padding, which this model cannot see without your actual pool.
 */
export const ZFS_OVERHEAD_RATIO = 0.976;

/**
 * Nominal parity per level. This answers "how many parity columns does this
 * layout write", which is a property of the level alone.
 *
 * It deliberately is NOT the same question as "how many drives can this vdev
 * lose". A mirror's nominal parity is 1 (one copy of redundancy per data
 * column) but an n-way mirror survives n-1 failures, and that depends on the
 * width, so it lives in `toleratedFailures(vdev)` instead.
 */
const PARITY: Record<VdevLevel, number> = {
  stripe: 0,
  mirror: 1,
  raidz1: 1,
  raidz2: 2,
  raidz3: 3,
  draid1: 1,
  draid2: 2,
  draid3: 3,
};

export function parityDisks(level: VdevLevel): number {
  return PARITY[level];
}

/** True for the three dRAID levels, which carry distributed spares. */
export function isDraid(level: VdevLevel): boolean {
  return level === "draid1" || level === "draid2" || level === "draid3";
}

/** Distributed spares actually in play: dRAID only, floored at zero. */
function draidSpares(v: VdevSpec): number {
  if (!isDraid(v.level)) return 0;
  return Math.max(0, Math.floor(v.spares ?? 0));
}

/** Smallest legal width for a level, given its distributed spare count. */
export function minDisks(level: VdevLevel, spares = 0): number {
  if (level === "stripe") return 1;
  if (level === "mirror") return 2;
  if (isDraid(level)) return parityDisks(level) + Math.max(0, Math.floor(spares)) + 1;
  return parityDisks(level) + 1;
}

/** How many whole drives this vdev can lose before it loses data. */
export function toleratedFailures(v: VdevSpec): number {
  if (v.level === "stripe") return 0;
  if (v.level === "mirror") return Math.max(0, Math.floor(v.disks) - 1);
  return parityDisks(v.level);
}

/** Drives whose capacity shows up as usable space. */
export function vdevDataDisks(v: VdevSpec): number {
  if (v.level === "mirror") return 1;
  if (v.level === "stripe") return Math.floor(v.disks);
  return Math.floor(v.disks) - draidSpares(v) - parityDisks(v.level);
}

/** Every drive in the vdev, spares included. */
export function vdevRawBytes(v: VdevSpec): number {
  return Math.floor(v.disks) * v.diskBytes;
}

/** Usable bytes before any ZFS or OS derate. dRAID excludes its spare space. */
export function vdevUsableBytes(v: VdevSpec): number {
  return vdevDataDisks(v) * v.diskBytes;
}

/** Capacity held back as dRAID distributed spare space. Zero on other levels. */
export function vdevSpareBytes(v: VdevSpec): number {
  return draidSpares(v) * v.diskBytes;
}

/** Capacity spent on redundancy: whatever is neither usable nor spare. */
export function vdevParityBytes(v: VdevSpec): number {
  return vdevRawBytes(v) - vdevUsableBytes(v) - vdevSpareBytes(v);
}

/** Throws a typed error when a vdev cannot exist as described. */
export function validateVdev(v: VdevSpec): void {
  if (!Number.isFinite(v.disks) || v.disks < 1)
    throw new ToolError("bad-disks", "Disks per vdev must be at least 1.");
  if (!Number.isFinite(v.diskBytes) || v.diskBytes <= 0)
    throw new ToolError("bad-disk-size", "Disk size must be greater than 0.");
  const spares = draidSpares(v);
  const need = minDisks(v.level, spares);
  if (Math.floor(v.disks) < need)
    throw new ToolError(
      "too-few-disks",
      `${v.level} needs at least ${need} disk${need === 1 ? "" : "s"} per vdev.`,
      v.level === "mirror" || v.level === "stripe"
        ? "Add more disks to this vdev."
        : "Add disks or choose a lower RAIDZ level.",
    );
}

export interface CapacityOptions {
  /** Subtract the ZFS slop-space and metadata estimate from usable capacity. */
  zfsOverhead: boolean;
  /** Extra headroom to hold back, as a percent of post-ZFS usable space. Default 0. */
  osReservePercent?: number;
}

/**
 * The capacity breakdown, in bytes.
 *
 * The five slices are exhaustive and disjoint:
 * `usableBytes + parityBytes + zfsOverheadBytes + osReserveBytes + spareBytes`
 * equals `rawBytes`, so a pie drawn from them sums to exactly 100% of the
 * drives you bought. That is why `rawBytes` counts spare drives too.
 */
export interface PoolCapacity {
  rawBytes: number;
  usableBytes: number;
  parityBytes: number;
  zfsOverheadBytes: number;
  osReserveBytes: number;
  spareBytes: number;
  /** usableBytes / rawBytes as a fraction from 0 to 1. */
  efficiency: number;
}

/** Largest member drive in the pool. Pool-wide hot spares are sized at this. */
export function largestDiskBytes(spec: PoolSpec): number {
  return spec.vdevs.reduce((max, v) => Math.max(max, v.diskBytes), 0);
}

/** Pool-wide hot spare drives, floored at zero and rounded down. */
export function poolHotSpares(spec: PoolSpec): number {
  return Math.max(0, Math.floor(spec.hotSpares ?? 0));
}

/**
 * Capacity for a whole pool.
 *
 * Order of derates matters: parity comes out first (it is physical), then the
 * ZFS reservation, then any OS or filesystem headroom you asked to hold back,
 * which is taken as a percent of what is left after ZFS rather than of raw.
 */
export function poolCapacity(spec: PoolSpec, options: CapacityOptions): PoolCapacity {
  if (!spec.vdevs || spec.vdevs.length === 0)
    throw new ToolError("no-vdevs", "A pool needs at least one vdev.", "Add a vdev to the pool.");
  for (const v of spec.vdevs) validateVdev(v);

  const reservePercent = Number.isFinite(options.osReservePercent)
    ? (options.osReservePercent as number)
    : 0;
  if (reservePercent < 0 || reservePercent >= 100)
    throw new ToolError(
      "bad-os-reserve",
      "The OS reserve must be at least 0 and below 100 percent.",
      "Use a value like 5 for a 5 percent reserve, or 0 for none.",
    );

  const hotSpareBytes = poolHotSpares(spec) * largestDiskBytes(spec);
  const rawBytes = spec.vdevs.reduce((sum, v) => sum + vdevRawBytes(v), 0) + hotSpareBytes;
  const parityBytes = spec.vdevs.reduce((sum, v) => sum + vdevParityBytes(v), 0);
  const spareBytes = spec.vdevs.reduce((sum, v) => sum + vdevSpareBytes(v), 0) + hotSpareBytes;

  const beforeDerates = spec.vdevs.reduce((sum, v) => sum + vdevUsableBytes(v), 0);
  const zfsOverheadBytes = options.zfsOverhead ? beforeDerates * (1 - ZFS_OVERHEAD_RATIO) : 0;
  const afterZfs = beforeDerates - zfsOverheadBytes;
  const osReserveBytes = afterZfs * (reservePercent / 100);
  const usableBytes = afterZfs - osReserveBytes;

  return {
    rawBytes,
    usableBytes,
    parityBytes,
    zfsOverheadBytes,
    osReserveBytes,
    spareBytes,
    efficiency: rawBytes > 0 ? usableBytes / rawBytes : 0,
  };
}

/* ---------------------------------------------------- failure simulation -- */

export type DriveState = "online" | "failed";
export type HealthState = "online" | "degraded" | "faulted";

export interface DriveStatus {
  id: string;
  state: DriveState;
}

export interface VdevStatus {
  id: string;
  level: VdevLevel;
  disks: DriveStatus[];
  failedCount: number;
  toleratedFailures: number;
  /** How many more drives this vdev can lose. Floors at 0, never negative. */
  failuresLeft: number;
  health: HealthState;
}

export interface PoolStatus {
  vdevs: VdevStatus[];
  health: HealthState;
  /** The weakest vdev's remaining headroom: the number that actually matters. */
  failuresLeftMin: number;
  dataLoss: boolean;
}

/** Stable, compact drive id: vdev index then drive index, "v0d3". */
export function driveId(vdevIndex: number, diskIndex: number): string {
  return `v${vdevIndex}d${diskIndex}`;
}

const DRIVE_ID = /^v(\d+)d(\d+)$/;

/**
 * Mark drives failed and propagate the result up: drive to vdev to pool.
 *
 * Rules, in one place because the panel colors depend on them:
 * - A vdev with no failures is online.
 * - A vdev with 1 to `toleratedFailures` failures is degraded, and degrades the pool.
 * - A vdev with strictly MORE failures than it tolerates is faulted, which is
 *   data loss, and faults the whole pool. A raidz2 vdev sitting at exactly two
 *   failures is still degraded with zero headroom left, not faulted.
 * - Pool-wide hot spares do not change any of this. A spare can only shorten
 *   the repair, so it moves the numbers in reliability.ts, never the tolerance.
 *
 * Ids that name a vdev or drive the pool does not have are ignored, so a stale
 * shared link degrades to the closest sensible pool instead of throwing.
 */
export function simulate(spec: PoolSpec, failed: Set<string>): PoolStatus {
  const vdevs: VdevStatus[] = spec.vdevs.map((v, vi) => {
    const width = Math.max(0, Math.floor(v.disks));
    const disks: DriveStatus[] = [];
    let failedCount = 0;
    for (let di = 0; di < width; di += 1) {
      const id = driveId(vi, di);
      const isFailed = failed.has(id);
      if (isFailed) failedCount += 1;
      disks.push({ id, state: isFailed ? "failed" : "online" });
    }
    const tolerated = toleratedFailures(v);
    const health: HealthState =
      failedCount === 0 ? "online" : failedCount <= tolerated ? "degraded" : "faulted";
    return {
      id: `v${vi}`,
      level: v.level,
      disks,
      failedCount,
      toleratedFailures: tolerated,
      failuresLeft: Math.max(0, tolerated - failedCount),
      health,
    };
  });

  const dataLoss = vdevs.some((v) => v.health === "faulted");
  const health: HealthState = dataLoss
    ? "faulted"
    : vdevs.some((v) => v.health === "degraded")
      ? "degraded"
      : "online";
  const failuresLeftMin = vdevs.length
    ? vdevs.reduce((min, v) => Math.min(min, v.failuresLeft), Infinity)
    : 0;

  return { vdevs, health, failuresLeftMin, dataLoss };
}

/**
 * Serialize a failure set for the URL fragment: "v0d3,v1d0".
 *
 * Sorted by vdev index then drive index so the same set of failed drives always
 * produces the same string no matter what order they were clicked in. A Set
 * keeps insertion order, so without the sort two identical pools would produce
 * two different shared links.
 */
export function encodeFailures(failed: Iterable<string>): string {
  const seen = new Set<string>();
  for (const raw of failed) {
    const id = String(raw).trim().toLowerCase();
    if (DRIVE_ID.test(id)) seen.add(id);
  }
  return [...seen]
    .sort((a, b) => {
      const ma = DRIVE_ID.exec(a)!;
      const mb = DRIVE_ID.exec(b)!;
      return Number(ma[1]) - Number(mb[1]) || Number(ma[2]) - Number(mb[2]);
    })
    .join(",");
}

/** Parse an encoded failure set. Unparseable entries are dropped, never thrown. */
export function decodeFailures(encoded: string): Set<string> {
  const out = new Set<string>();
  for (const part of String(encoded ?? "").split(/[,\s]+/)) {
    const id = part.trim().toLowerCase();
    if (DRIVE_ID.test(id)) out.add(id);
  }
  return out;
}

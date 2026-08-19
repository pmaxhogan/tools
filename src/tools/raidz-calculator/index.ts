import { formatBytes } from "../../lib/format";
import { ToolError, type ToolLogic } from "../types";

export interface RaidzOpts {
  disks: number;
  diskSizeUnit: string; // 'TB' | 'GB' | 'TiB' | 'GiB'
  diskSize: number;
  level: string; // 'raidz1' | 'raidz2' | 'raidz3' | 'mirror' | 'stripe'
  vdevs: number;
  zfsOverhead: boolean;
  [key: string]: unknown;
}

export type RaidzResult = Record<string, string>;

/** Approximate ZFS slop-space and metadata reservation derate. Not exact:
 * real usable space also depends on ashift, recordsize, and RAIDZ padding. */
const ZFS_OVERHEAD_RATIO = 0.976;

type Level = "raidz1" | "raidz2" | "raidz3" | "mirror" | "stripe";

const MIN_DISKS: Record<Level, number> = {
  raidz1: 2,
  raidz2: 3,
  raidz3: 4,
  mirror: 2,
  stripe: 1,
};

/** Decimal (10^n) or binary (2^n) bytes-per-unit, matched to how drive vendors
 * (decimal TB/GB) vs operating systems (binary TiB/GiB) label capacity. This
 * is a fixed unit-to-bytes table, not a display formatter. */
const UNIT_BYTES: Record<string, number> = {
  TB: 1e12,
  GB: 1e9,
  TiB: 2 ** 40,
  GiB: 2 ** 30,
};

function normalizeLevel(raw: string): Level {
  const s = (raw || "").trim().toLowerCase();
  if (s === "raidz1" || s === "z1" || s === "raid-z1" || s === "raid5") return "raidz1";
  if (s === "raidz2" || s === "z2" || s === "raid-z2" || s === "raid6") return "raidz2";
  if (s === "raidz3" || s === "z3" || s === "raid-z3") return "raidz3";
  if (s === "mirror" || s === "raid1" || s === "raid10") return "mirror";
  if (s === "stripe" || s === "raid0") return "stripe";
  throw new ToolError(
    "bad-level",
    `Unknown RAIDZ level "${raw}".`,
    "Use raidz1, raidz2, raidz3, mirror, or stripe.",
  );
}

function normalizeUnit(raw: string): string {
  const s = (raw || "").trim().toLowerCase();
  if (s === "tb") return "TB";
  if (s === "gb") return "GB";
  if (s === "tib") return "TiB";
  if (s === "gib") return "GiB";
  throw new ToolError("bad-unit", `Unknown disk size unit "${raw}".`, "Use TB, GB, TiB, or GiB.");
}

/** A plain decimal-TB string ("16.00 TB"), distinct from the binary-scaled
 * display of formatBytes, so drive-marketed TB and OS-reported TiB never get
 * conflated in the output. */
function decimalTB(bytes: number): string {
  return `${(bytes / 1e12).toFixed(2)} TB`;
}

/** Best-effort shorthand parser: "6x4TB raidz2" -> {disks, diskSize,
 * diskSizeUnit, level}. Returns null when the input does not match; callers
 * fall back to the option-driven values. */
export function parseShorthand(
  input: string,
): { disks: number; diskSize: number; diskSizeUnit: string; level: string } | null {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/^(\d+)\s*x\s*([\d.]+)\s*(tib|gib|tb|gb)\s*([a-z0-9-]+)?$/i);
  if (!m) return null;
  const disks = Number(m[1]);
  const diskSize = Number(m[2]);
  if (!Number.isFinite(disks) || !Number.isFinite(diskSize)) return null;
  const diskSizeUnit = normalizeUnit(m[3]!);
  const level = m[4] ? normalizeLevel(m[4]) : "raidz2";
  return { disks, diskSize, diskSizeUnit, level };
}

export function run(input: string, opts: RaidzOpts): RaidzResult {
  let disks = opts.disks;
  let diskSize = opts.diskSize;
  let diskSizeUnit = opts.diskSizeUnit;
  let levelRaw = opts.level;

  const shorthand = parseShorthand(input ?? "");
  if (shorthand) {
    disks = shorthand.disks;
    diskSize = shorthand.diskSize;
    diskSizeUnit = shorthand.diskSizeUnit;
    levelRaw = shorthand.level;
  }

  if (!Number.isFinite(disks) || disks < 1)
    throw new ToolError("bad-disks", "Disks per vdev must be at least 1.");
  if (!Number.isFinite(diskSize) || diskSize <= 0)
    throw new ToolError("bad-disk-size", "Disk size must be greater than 0.");
  const vdevs = opts.vdevs;
  if (!Number.isFinite(vdevs) || vdevs < 1)
    throw new ToolError("bad-vdevs", "Number of vdevs must be at least 1.");

  const level = normalizeLevel(levelRaw);
  const unit = normalizeUnit(diskSizeUnit);
  disks = Math.floor(disks);

  const minDisks = MIN_DISKS[level];
  if (disks < minDisks)
    throw new ToolError(
      "too-few-disks",
      `${level} needs at least ${minDisks} disk${minDisks === 1 ? "" : "s"} per vdev.`,
      level === "mirror" || level === "stripe"
        ? "Add more disks to this vdev."
        : "Add disks or choose a lower RAIDZ level.",
    );

  const diskBytes = diskSize * UNIT_BYTES[unit]!;
  const rawPerVdev = disks * diskBytes;

  let parity: number;
  let usablePerVdev: number;
  if (level === "mirror") {
    parity = disks - 1;
    usablePerVdev = diskBytes;
  } else if (level === "stripe") {
    parity = 0;
    usablePerVdev = rawPerVdev;
  } else {
    parity = { raidz1: 1, raidz2: 2, raidz3: 3 }[level]!;
    usablePerVdev = (disks - parity) * diskBytes;
  }

  const poolRaw = rawPerVdev * vdevs;
  let poolUsable = usablePerVdev * vdevs;
  if (opts.zfsOverhead) poolUsable *= ZFS_OVERHEAD_RATIO;

  const overheadBytes = poolRaw - poolUsable;
  const efficiencyPct = poolRaw > 0 ? (poolUsable / poolRaw) * 100 : 0;
  const overheadPct = poolRaw > 0 ? (overheadBytes / poolRaw) * 100 : 0;

  const toleranceLabel =
    level === "stripe"
      ? "0 disks per vdev (no redundancy)"
      : `${parity} disk${parity === 1 ? "" : "s"} per vdev`;

  const notes: string[] = [
    "This is an estimate: real usable space also depends on ashift, recordsize, and RAIDZ padding, which are not modeled here and vary by pool.",
  ];
  if (opts.zfsOverhead)
    notes.push(
      `Usable capacity above is derated by about ${(100 - ZFS_OVERHEAD_RATIO * 100).toFixed(1)}% to approximate ZFS slop space and metadata reservation.`,
    );
  if (level === "stripe")
    notes.push("Stripe (RAID 0) has no redundancy: any single disk failure loses the entire vdev.");

  return {
    Layout: `${vdevs}x (${disks}-disk ${level})`,
    "Raw capacity": `${formatBytes(poolRaw)} (${decimalTB(poolRaw)})`,
    "Usable capacity": `${formatBytes(poolUsable)} (${decimalTB(poolUsable)})`,
    "Parity overhead": `${formatBytes(overheadBytes)} (${decimalTB(overheadBytes)}), ${overheadPct.toFixed(1)}%`,
    "Storage efficiency": `${efficiencyPct.toFixed(1)}%`,
    "Fault tolerance": toleranceLabel,
    Notes: notes.join(" "),
  };
}

export default { run } satisfies ToolLogic<string, RaidzResult, RaidzOpts>;

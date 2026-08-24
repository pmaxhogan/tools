import { formatBytes } from "../../lib/format";
import { ToolError, type ToolLogic } from "../types";
import { formatMttdl, formatProbability, mttdl, type PoolReliability } from "./reliability";
import {
  isDraid,
  poolCapacity,
  toleratedFailures,
  ZFS_OVERHEAD_RATIO,
  type PoolSpec,
  type VdevLevel,
  type VdevSpec,
} from "./sim";

export interface RaidzOpts {
  disks: number;
  diskSizeUnit: string; // 'TB' | 'GB' | 'TiB' | 'GiB'
  diskSize: number;
  level: string; // raidz1-3, draid1-3, mirror, stripe
  vdevs: number;
  zfsOverhead: boolean;
  /** Headroom held back after the ZFS derate, as a percent. Default 0. */
  osReservePercent?: number;
  /**
   * Spare drives. On a dRAID level these are the distributed spares inside each
   * vdev, because that is where dRAID keeps spare space. On every other level
   * they are pool-wide hot spare drives sitting idle in the chassis. Default 0.
   */
  hotSpares?: number;
  /** Per drive MTBF in hours. Default 1200000. Ignored when afrPercent is above 0. */
  mtbfHours?: number;
  /** Per drive annualized failure rate, as a percent. Default 0, meaning use the MTBF. */
  afrPercent?: number;
  /** Hours to rebuild one drive, excluding the human replacement delay. Default 24. */
  resilverHours?: number;
  [key: string]: unknown;
}

export type RaidzResult = Record<string, string>;

/**
 * Read a numeric option that may arrive as a string from the query API or as
 * undefined from an older caller. Anything unparseable falls back rather than
 * throwing, so the v1 option set still runs unchanged.
 */
function num(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Decimal (10^n) or binary (2^n) bytes-per-unit, matched to how drive vendors
 * (decimal TB/GB) vs operating systems (binary TiB/GiB) label capacity. This
 * is a fixed unit-to-bytes table, not a display formatter. */
const UNIT_BYTES: Record<string, number> = {
  TB: 1e12,
  GB: 1e9,
  TiB: 2 ** 40,
  GiB: 2 ** 30,
};

function normalizeLevel(raw: string): VdevLevel {
  const s = (raw || "").trim().toLowerCase();
  if (s === "raidz1" || s === "z1" || s === "raid-z1" || s === "raid5") return "raidz1";
  if (s === "raidz2" || s === "z2" || s === "raid-z2" || s === "raid6") return "raidz2";
  if (s === "raidz3" || s === "z3" || s === "raid-z3") return "raidz3";
  if (s === "mirror" || s === "raid1" || s === "raid10") return "mirror";
  if (s === "stripe" || s === "raid0") return "stripe";
  if (s === "draid1" || s === "draid-1" || s === "draid") return "draid1";
  if (s === "draid2" || s === "draid-2") return "draid2";
  if (s === "draid3" || s === "draid-3") return "draid3";
  throw new ToolError(
    "bad-level",
    `Unknown RAIDZ level "${raw}".`,
    "Use raidz1, raidz2, raidz3, draid1, draid2, draid3, mirror, or stripe.",
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
  const vdevCount = Math.floor(vdevs);

  const diskBytes = diskSize * UNIT_BYTES[unit]!;
  const spares = Math.max(0, Math.floor(num(opts.hotSpares, 0)));
  const draid = isDraid(level);

  const vdev: VdevSpec = { level, disks, diskBytes, spares: draid ? spares : 0 };
  const spec: PoolSpec = {
    vdevs: Array.from({ length: vdevCount }, () => ({ ...vdev })),
    hotSpares: draid ? 0 : spares,
  };

  const osReservePercent = num(opts.osReservePercent, 0);
  const capacity = poolCapacity(spec, {
    zfsOverhead: Boolean(opts.zfsOverhead),
    osReservePercent,
  });

  // "Usable capacity" stays the post-ZFS figure it has always been, and the OS
  // reserve gets its own row, so a reserve of 0 leaves every v1 number intact.
  const usableBeforeReserve = capacity.usableBytes + capacity.osReserveBytes;
  const pct = (bytes: number) =>
    capacity.rawBytes > 0 ? ((bytes / capacity.rawBytes) * 100).toFixed(1) : "0.0";
  const size = (bytes: number) => `${formatBytes(bytes)} (${decimalTB(bytes)})`;

  const tolerated = toleratedFailures(vdev);
  const toleranceLabel =
    level === "stripe"
      ? "0 disks per vdev (no redundancy)"
      : `${tolerated} disk${tolerated === 1 ? "" : "s"} per vdev`;

  const afrPercent = num(opts.afrPercent, 0);
  const mtbfHours = num(opts.mtbfHours, 1_200_000);
  const resilverHours = num(opts.resilverHours, 24);
  let reliability: PoolReliability | null = null;
  if ((afrPercent > 0 || mtbfHours > 0) && resilverHours > 0)
    reliability = mttdl(spec, { mtbfHours, afrPercent, resilverHours });

  const notes: string[] = [
    "This is an estimate: real usable space also depends on ashift, recordsize, and RAIDZ padding, which are not modeled here and vary by pool.",
  ];
  if (opts.zfsOverhead)
    notes.push(
      `Usable capacity above is derated by about ${(100 - ZFS_OVERHEAD_RATIO * 100).toFixed(1)}% to approximate ZFS slop space and metadata reservation.`,
    );
  if (osReservePercent > 0)
    notes.push(
      `A further ${osReservePercent}% is held back as OS and filesystem reserve, shown as its own row.`,
    );
  if (level === "stripe")
    notes.push("Stripe (RAID 0) has no redundancy: any single disk failure loses the entire vdev.");
  if (spares > 0)
    notes.push(
      draid
        ? `${spares} distributed spare${spares === 1 ? "" : "s"} per vdev reserve capacity inside the vdev and let a rebuild start immediately, but they do not raise the number of drives a vdev can lose.`
        : `${spares} hot spare${spares === 1 ? " drive removes" : " drives remove"} the wait for a human to swap a disk, but a hot spare never raises the number of drives a vdev can lose.`,
    );
  notes.push(
    "Unrecoverable read errors (UREs) are ignored: only whole drive failures count, so a long resilver on large drives carries more real risk than these numbers show.",
  );
  if (reliability)
    notes.push(
      "MTTDL treats drive failures as independent and at a constant rate, so correlated failures from one bad batch or one hot shelf are not modeled.",
    );

  const layout = draid && spares > 0 ? `${level} with ${spares} distributed spare` : level;
  const out: RaidzResult = {
    Layout: `${vdevCount}x (${disks}-disk ${layout}${draid && spares > 1 ? "s" : ""})`,
    "Raw capacity": size(capacity.rawBytes),
    "Usable capacity": size(usableBeforeReserve),
  };
  if (capacity.osReserveBytes > 0)
    out["Usable after OS reserve"] =
      `${size(capacity.usableBytes)}, ${osReservePercent}% held back`;
  out["Parity overhead"] = `${size(capacity.parityBytes)}, ${pct(capacity.parityBytes)}%`;
  if (capacity.zfsOverheadBytes > 0)
    out["ZFS overhead"] = `${size(capacity.zfsOverheadBytes)}, ${pct(capacity.zfsOverheadBytes)}%`;
  if (capacity.spareBytes > 0)
    out["Spare capacity"] =
      `${size(capacity.spareBytes)}, ${pct(capacity.spareBytes)}% (${spares} ${draid ? "distributed spare" : "hot spare"}${spares === 1 ? "" : "s"}${draid ? " per vdev" : ""})`;
  out["Storage efficiency"] = `${(capacity.efficiency * 100).toFixed(1)}%`;
  out["Fault tolerance"] = toleranceLabel;
  if (reliability) {
    out["MTTDL (pool)"] =
      `${formatMttdl(reliability.mttdlHours)} (drive MTBF ${Math.round(reliability.mtbfHours).toLocaleString("en-US")} h, ${reliability.afrPercent.toFixed(2)}% AFR, ${resilverHours} h resilver)`;
    out["Annual data loss risk"] = formatProbability(reliability.annualDataLossProbability);
  }
  out["Notes"] = notes.join(" ");
  return out;
}

export default { run } satisfies ToolLogic<string, RaidzResult, RaidzOpts>;

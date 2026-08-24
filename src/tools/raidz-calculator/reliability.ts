/**
 * RAIDZ calculator v2: mean time to data loss.
 *
 * The standard Markov approximation for a redundancy group. Treat the numbers
 * as an order of magnitude comparison between layouts, not as a prediction: the
 * model assumes drives fail independently at a constant rate, which real
 * batches of drives do not do.
 *
 * What the model covers and what it leaves out is documented on `mttdl` below,
 * because those assumptions are shown to the user next to the result.
 */
import { ToolError } from "../types";
import {
  isDraid,
  poolHotSpares,
  toleratedFailures,
  type PoolSpec,
  type VdevLevel,
  type VdevSpec,
} from "./sim";

/** Hours in a Julian year (365.25 days), the convention AFR figures use. */
export const HOURS_PER_YEAR = 8766;

/**
 * Hours between a drive dying and a replacement starting to resilver, when a
 * human has to do it: notice the alert, find a drive, walk to the rack. One day
 * is a friendly homelab estimate. A pool with a hot spare or dRAID distributed
 * spare skips this entirely, which is the whole point of racking one.
 */
export const MANUAL_REPLACEMENT_DELAY_HOURS = 24;

/**
 * Convert an annualized failure rate to a mean time between failures.
 *
 * AFR is the probability a drive dies within a year. Under a constant hazard
 * rate that is `1 - exp(-8766 / MTBF)`, so `MTBF = 8766 / ln(1 / (1 - AFR))`.
 * The naive `MTBF = 8766 / AFR` is close for small rates and wrong for large
 * ones, so this does the exponential properly.
 */
export function afrToMtbfHours(afrPercent: number): number {
  if (!Number.isFinite(afrPercent) || afrPercent <= 0 || afrPercent >= 100)
    throw new ToolError(
      "bad-afr",
      "The annualized failure rate must be above 0 and below 100 percent.",
      "Typical drives sit between 0.3 and 2 percent. Use 0 to enter an MTBF instead.",
    );
  return HOURS_PER_YEAR / Math.log(1 / (1 - afrPercent / 100));
}

/** The inverse: the annualized failure rate a given MTBF implies, as a percent. */
export function mtbfToAfrPercent(mtbfHours: number): number {
  if (!Number.isFinite(mtbfHours) || mtbfHours <= 0)
    throw new ToolError(
      "bad-mtbf",
      "MTBF must be greater than 0 hours.",
      "A drive datasheet figure is usually between 1,000,000 and 2,500,000 hours.",
    );
  return (1 - Math.exp(-HOURS_PER_YEAR / mtbfHours)) * 100;
}

/** A worked example the panel can offer instead of making people guess an MTBF. */
export interface DriveReliabilityReference {
  id: string;
  label: string;
  /** Field observed annualized failure rate, as a percent. */
  afrPercent: number;
  /** The MTBF that AFR implies, in hours. Derived, not quoted. */
  mtbfHours: number;
  /** The lab MTBF the datasheet claims, where the vendors publish one. */
  vendorMtbfHours?: number;
  note: string;
}

function reference(
  id: string,
  label: string,
  afrPercent: number,
  note: string,
  vendorMtbfHours?: number,
): DriveReliabilityReference {
  return {
    id,
    label,
    afrPercent,
    mtbfHours: Math.round(afrToMtbfHours(afrPercent)),
    vendorMtbfHours,
    note,
  };
}

/**
 * Realistic starting points, so nobody has to invent a number.
 *
 * The AFR column is what large fleets actually measure. Backblaze publishes
 * quarterly and annual drive stats across a fleet in the hundreds of thousands
 * of drives, and those are the figures the HDD rows lean on. The vendor MTBF
 * column is the lab rating from the manufacturer datasheets (Seagate Exos and
 * IronWolf Pro, Western Digital Ultrastar and Red Pro, Micron and Samsung
 * enterprise SSD sheets). The two disagree by design: a lab MTBF describes a
 * new drive at rated workload and temperature, while AFR includes the whole
 * fleet, infant mortality and worn out drives together.
 */
export const MTBF_REFERENCE: DriveReliabilityReference[] = [
  reference(
    "consumer-hdd",
    "Consumer HDD",
    1.5,
    "Backblaze fleet data puts desktop class drives around 1 to 2 percent a year, well short of the 1,000,000 hour rating the datasheets print.",
    1_000_000,
  ),
  reference(
    "nas-hdd",
    "NAS HDD",
    1.0,
    "NAS rated drives (IronWolf Pro, Red Pro) are specified for 24/7 duty and land near 1 percent a year in Backblaze reporting.",
    1_200_000,
  ),
  reference(
    "enterprise-hdd",
    "Enterprise HDD",
    0.44,
    "Near-line enterprise drives (Exos, Ultrastar) quote 2,500,000 hours and the best performing models measure 0.35 to 0.5 percent a year.",
    2_500_000,
  ),
  reference(
    "consumer-ssd",
    "Consumer SSD",
    0.75,
    "Backblaze publishes a separate SSD report; consumer and boot SSDs settle near 0.5 to 1 percent a year once past their first year.",
    1_500_000,
  ),
  reference(
    "enterprise-ssd",
    "Enterprise SSD",
    0.3,
    "Enterprise SSD datasheets quote 2,000,000 hours at their rated drive writes per day, roughly 0.3 percent a year in service.",
    2_000_000,
  ),
];

export interface ReliabilityOptions {
  /** Mean time between failures per drive, in hours. Used when afrPercent is 0. */
  mtbfHours?: number;
  /** Annualized failure rate per drive, as a percent. Wins over mtbfHours when above 0. */
  afrPercent?: number;
  /** Hours to rebuild one drive's worth of data. Excludes the human delay. */
  resilverHours: number;
  /** Pool-wide hot spares. Falls back to `spec.hotSpares` when omitted. */
  hotSpares?: number;
}

export interface VdevReliability {
  id: string;
  level: VdevLevel;
  disks: number;
  /**
   * The exponent the Markov model uses: how many failures the vdev tolerates.
   * Equal to the parity count on every level except a mirror, where it is the
   * width minus one.
   */
  modelParity: number;
  /** Mean time to repair actually applied, in hours. */
  mttrHours: number;
  mttdlHours: number;
  mttdlYears: number;
  annualDataLossProbability: number;
}

export interface PoolReliability {
  /** Per-drive MTBF the run used, in hours (derived from AFR when one was given). */
  mtbfHours: number;
  /** The AFR that MTBF implies, as a percent. */
  afrPercent: number;
  vdevs: VdevReliability[];
  mttdlHours: number;
  mttdlYears: number;
  annualDataLossProbability: number;
}

/**
 * MTTDL for one redundancy group, in hours.
 *
 * One family of formulas covers every level:
 *
 *   MTTDL = MTBF^(p+1) / ( n (n-1) ... (n-p) * MTTR^p )
 *
 * with `n` drives and `p` tolerated failures. It expands to the textbook cases:
 * `MTBF/n` for a stripe, `MTBF^2 / (n(n-1) MTTR)` for single parity,
 * `MTBF^3 / (n(n-1)(n-2) MTTR^2)` for double, and
 * `MTBF^4 / (n(n-1)(n-2)(n-3) MTTR^3)` for triple.
 */
export function vdevMttdlHours(
  disks: number,
  parity: number,
  mtbfHours: number,
  mttrHours: number,
): number {
  const n = Math.floor(disks);
  const p = Math.max(0, Math.floor(parity));
  if (n <= p)
    throw new ToolError(
      "too-few-disks",
      `A vdev with ${p} parity needs more than ${p} drives.`,
      "Add drives or choose a lower parity level.",
    );
  let denominator = 1;
  for (let k = 0; k <= p; k += 1) denominator *= n - k;
  return Math.pow(mtbfHours, p + 1) / (denominator * Math.pow(mttrHours, p));
}

/**
 * How much faster a dRAID rebuild is than a classic RAIDZ resilver.
 *
 * A RAIDZ resilver writes everything onto one replacement drive, so that drive
 * is the ceiling. A dRAID vdev with distributed spares has nowhere single to
 * write: the rebuild reads from and writes across every surviving child, so the
 * time falls roughly in proportion to how many drives take part. This models
 * the best case, every surviving child participating, and real speedups are
 * lower because the rebuild shares the drives with client I/O.
 */
export function draidRebuildSpeedup(v: VdevSpec): number {
  if (!isDraid(v.level)) return 1;
  const spares = Math.max(0, Math.floor(v.spares ?? 0));
  if (spares < 1) return 1;
  return Math.max(1, Math.floor(v.disks) - 1);
}

/**
 * Mean time to data loss for a whole pool.
 *
 * The assumptions, all of them, because these are shown next to the result:
 *
 * 1. Drives fail independently at a constant rate. Correlated failures (one bad
 *    batch, one hot shelf, one power event) are not modeled and are real.
 * 2. Unrecoverable read errors are ignored. Only whole drive failures count, so
 *    a long resilver on large drives is riskier than these numbers say.
 * 3. MTTR is the human delay plus the resilver. `resilverHours` is the rebuild
 *    alone; a pool with a hot spare or a dRAID distributed spare drops the
 *    delay to zero, which is the only thing a spare changes. Spares never add
 *    fault tolerance to a vdev.
 * 4. The exponent is the failures a vdev tolerates, not its parity column count.
 *    They are the same number on every level except a mirror, where a three way
 *    mirror tolerates two failures and is scored with the double parity form.
 * 5. dRAID rebuilds are faster in proportion to the drives taking part.
 * 6. Vdevs are independent and striped, so losing any one loses the pool:
 *    `1 / MTTDL_pool = sum of 1 / MTTDL_vdev`.
 */
export function mttdl(spec: PoolSpec, options: ReliabilityOptions): PoolReliability {
  if (!spec.vdevs || spec.vdevs.length === 0)
    throw new ToolError("no-vdevs", "A pool needs at least one vdev.", "Add a vdev to the pool.");

  const afr = Number.isFinite(options.afrPercent) ? (options.afrPercent as number) : 0;
  const mtbfHours = afr > 0 ? afrToMtbfHours(afr) : (options.mtbfHours ?? 0);
  if (!Number.isFinite(mtbfHours) || mtbfHours <= 0)
    throw new ToolError(
      "bad-mtbf",
      "MTBF must be greater than 0 hours.",
      "Enter an MTBF in hours, or an annualized failure rate above 0 percent instead.",
    );

  const resilverHours = options.resilverHours;
  if (!Number.isFinite(resilverHours) || resilverHours <= 0)
    throw new ToolError(
      "bad-resilver",
      "Resilver time must be greater than 0 hours.",
      "A rough guide is one hour per terabyte of used space on spinning disks.",
    );

  const hotSpares = Number.isFinite(options.hotSpares)
    ? Math.max(0, Math.floor(options.hotSpares as number))
    : poolHotSpares(spec);

  const vdevs: VdevReliability[] = spec.vdevs.map((v, vi) => {
    const distributedSpares = isDraid(v.level) ? Math.max(0, Math.floor(v.spares ?? 0)) : 0;
    const automatic = hotSpares > 0 || distributedSpares > 0;
    const delay = automatic ? 0 : MANUAL_REPLACEMENT_DELAY_HOURS;
    const mttrHours = resilverHours / draidRebuildSpeedup(v) + delay;
    const modelParity = toleratedFailures(v);
    const hours = vdevMttdlHours(v.disks, modelParity, mtbfHours, mttrHours);
    return {
      id: `v${vi}`,
      level: v.level,
      disks: Math.floor(v.disks),
      modelParity,
      mttrHours,
      mttdlHours: hours,
      mttdlYears: hours / HOURS_PER_YEAR,
      annualDataLossProbability: annualLossProbability(hours),
    };
  });

  const rate = vdevs.reduce((sum, v) => sum + (v.mttdlHours > 0 ? 1 / v.mttdlHours : Infinity), 0);
  const poolHours = rate > 0 ? 1 / rate : Infinity;

  return {
    mtbfHours,
    afrPercent: mtbfToAfrPercent(mtbfHours),
    vdevs,
    mttdlHours: poolHours,
    mttdlYears: poolHours / HOURS_PER_YEAR,
    annualDataLossProbability: annualLossProbability(poolHours),
  };
}

/** Chance of losing data in one year given an MTTDL in hours, as a fraction. */
export function annualLossProbability(mttdlHours: number): number {
  if (!Number.isFinite(mttdlHours) || mttdlHours <= 0) return 1;
  return 1 - Math.exp(-HOURS_PER_YEAR / mttdlHours);
}

/** An MTTDL in hours as something a person can read: "1.4 million years". */
export function formatMttdl(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "less than an hour";
  const years = hours / HOURS_PER_YEAR;
  if (years >= 1e9) return `${(years / 1e9).toFixed(1)} billion years`;
  if (years >= 1e6) return `${(years / 1e6).toFixed(1)} million years`;
  if (years >= 1000) return `${Math.round(years).toLocaleString("en-US")} years`;
  if (years >= 1) return `${years.toFixed(1)} years`;
  return `${Math.round(hours).toLocaleString("en-US")} hours`;
}

/** A probability as a readable percent, keeping small risks from rounding to 0%. */
export function formatProbability(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "0%";
  const pct = p * 100;
  if (pct >= 1) return `${pct.toFixed(2)}%`;
  if (pct >= 0.001) return `${pct.toFixed(4)}%`;
  return `${pct.toExponential(2)}%`;
}

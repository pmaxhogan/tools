<script setup lang="ts">
/**
 * Bespoke panel for the RAIDZ calculator (v2).
 *
 * Options first, the way the approved mockup lays it out: a pool builder at the
 * top with a collapsed quick entry bar above it, then a hierarchical diagram
 * (pool > vdev cards > drive squares) where every drive is a toggle, a capacity
 * pie whose slices add up to every drive you bought, a reliability card, and
 * the key/value results.
 *
 * Every number comes from the pure logic layer (rule 27); this file owns DOM,
 * layout, and URL fragment state only.
 *   src/tools/raidz-calculator/index.ts        run, parseShorthand
 *   src/tools/raidz-calculator/sim.ts          poolCapacity, simulate,
 *                                              toleratedFailures, minDisks,
 *                                              isDraid, driveId,
 *                                              encodeFailures, decodeFailures,
 *                                              ZFS_OVERHEAD_RATIO
 *   src/tools/raidz-calculator/reliability.ts  mttdl, formatMttdl,
 *                                              formatProbability,
 *                                              afrToMtbfHours,
 *                                              mtbfToAfrPercent,
 *                                              MTBF_REFERENCE,
 *                                              MANUAL_REPLACEMENT_DELAY_HOURS
 *   src/tools/chart-maker/index.ts             slicePath (the pie geometry)
 *
 * TWO POOL MODES, ONE SET OF NUMBERS
 * ----------------------------------
 * Uniform mode is the meta option set, and its results grid comes straight from
 * `run()`, so the panel and the /api endpoint can never print different
 * capacities for the same pool. Advanced mixed mode builds a heterogeneous
 * PoolSpec that `run()` cannot express (it always stamps out identical vdevs),
 * so that mode drives every card from poolCapacity and mttdl directly and
 * labels its results as the mixed pool. Rendering run()'s uniform numbers next
 * to a mixed diagram would put two different capacities on one screen.
 *
 * The shorthand is a one shot: parsing it writes into the uniform controls and
 * is never replayed, so editing a control afterwards is not silently undone the
 * way it would be if the text were passed to `run()` as its input on every
 * keystroke.
 *
 * Nothing reads the DOM before mount: readFragment runs in onMounted and the
 * fragment writer stays quiet until then, so the server rendered markup is
 * always the default pool.
 */
import { computed, onMounted, ref, watch } from "vue";
import { ChevronRight, HardDrive, Plus, RotateCcw, Trash2, X } from "lucide-vue-next";
import { ToolError, type OptionSpec, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import { parseShorthand, run, type RaidzOpts } from "@/tools/raidz-calculator/index";
import {
  decodeFailures,
  driveId,
  encodeFailures,
  isDraid,
  largestDiskBytes,
  minDisks,
  poolCapacity,
  simulate,
  toleratedFailures,
  ZFS_OVERHEAD_RATIO,
  type DriveState,
  type HealthState,
  type PoolCapacity,
  type PoolSpec,
  type VdevLevel,
  type VdevSpec,
} from "@/tools/raidz-calculator/sim";
import {
  afrToMtbfHours,
  formatMttdl,
  formatProbability,
  MANUAL_REPLACEMENT_DELAY_HOURS,
  mtbfToAfrPercent,
  mttdl,
  MTBF_REFERENCE,
  type DriveReliabilityReference,
  type PoolReliability,
} from "@/tools/raidz-calculator/reliability";
import { slicePath } from "@/tools/chart-maker/index";
import { formatBytes } from "@/lib/format";
import { coerceOpts, readFragment, writeFragment } from "@/lib/fragment";
import { flattenSelectOptions } from "@/lib/select-options";
import { recordToRows, rowsToText } from "@/lib/key-value";
import OptionControl from "../OptionControl.vue";
import KeyValueGrid from "../KeyValueGrid.vue";
import CopyButton from "../CopyButton.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";

const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/**
 * Bytes per disk size unit: decimal for the TB and GB a drive is sold as,
 * binary for the TiB and GiB an operating system reports.
 *
 * LOGIC GAP: index.ts owns the same four constants but does not export them,
 * and the only way through them is `run()`, which returns formatted strings.
 * The panel needs real byte counts to build a PoolSpec for poolCapacity,
 * simulate, and mttdl, so the table is mirrored here. Exporting `UNIT_BYTES`
 * (or a `diskBytes(size, unit)` helper) from the logic layer would delete this
 * copy. Same story for `normalizeLevel` and `normalizeUnit`, which is why
 * `asLevel` and `asUnit` below only narrow known values instead of accepting
 * the aliases the logic layer understands.
 */
const UNIT_BYTES: Record<string, number> = {
  TB: 1e12,
  GB: 1e9,
  TiB: 2 ** 40,
  GiB: 2 ** 30,
};

const UNITS = ["TB", "GB", "TiB", "GiB"];

const LEVELS: VdevLevel[] = [
  "stripe",
  "mirror",
  "raidz1",
  "raidz2",
  "raidz3",
  "draid1",
  "draid2",
  "draid3",
];

/** Short display names for the badges and tables. The meta labels are longer. */
const LEVEL_LABEL: Record<VdevLevel, string> = {
  stripe: "Stripe",
  mirror: "Mirror",
  raidz1: "RAIDZ1",
  raidz2: "RAIDZ2",
  raidz3: "RAIDZ3",
  draid1: "dRAID1",
  draid2: "dRAID2",
  draid3: "dRAID3",
};

/** Compact unit buttons for the mixed vdev rows: the meta labels are too wide. */
const ROW_UNITS: SegmentedOption[] = UNITS.map((u) => ({ value: u, label: u }));

const RELIABILITY_MODES: SegmentedOption[] = [
  { value: "mtbf", label: "MTBF hours" },
  { value: "afr", label: "AFR percent" },
];

/** Donut geometry, in viewBox units. */
const PIE = { size: 220, cx: 110, cy: 110, outer: 96, inner: 58 };

/**
 * Smallest slice that gets its percentage drawn on the arc. The plan's floor is
 * one percent, but a one percent wedge is 3.6 degrees wide and cannot hold its
 * own label, so the on chart text needs a wider wedge than that. Every slice,
 * including the ones under one percent, still appears in the legend with its
 * size and its share, which is where the small ones are meant to be read.
 */
const ARC_LABEL_MIN_PERCENT = 4;

const SLICE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

/** Option ids that describe the pool shape. Hidden while mixed mode is on. */
const SHAPE_IDS = ["level", "disks", "diskSize", "diskSizeUnit", "vdevs"];
/** Option ids that derate capacity. They apply to both pool modes. */
const DERATE_IDS = ["zfsOverhead", "osReservePercent"];

/* ------------------------------------------------------------------ *
 * small pure helpers (presentation only)
 * ------------------------------------------------------------------ */

function numberOf(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function intOf(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function asLevel(raw: unknown, fallback: VdevLevel): VdevLevel {
  const s = String(raw ?? "").toLowerCase();
  return (LEVELS as string[]).includes(s) ? (s as VdevLevel) : fallback;
}

function asUnit(raw: unknown): string {
  const s = String(raw ?? "");
  return UNITS.includes(s) ? s : "TB";
}

function diskBytesOf(size: number, unit: string): number {
  return size * (UNIT_BYTES[asUnit(unit)] ?? UNIT_BYTES.TB);
}

/** "4.5" not "4.50", so a drive square reads as tightly as it can. */
function trimNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Number(value.toFixed(2)));
}

/** The label inside an online drive square: "4T", "500G". */
function shortSize(size: number, unit: string): string {
  return `${trimNumber(size)}${asUnit(unit).charAt(0).toUpperCase()}`;
}

/** A count of hours as something short: "1.2M h", "36 h". */
function hoursLabel(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "0 h";
  if (hours >= 1e6) return `${(hours / 1e6).toFixed(1)}M h`;
  if (hours >= 1000) return `${Math.round(hours).toLocaleString("en-US")} h`;
  return `${Math.round(hours)} h`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

interface CalcError {
  message: string;
  fix?: string;
}

function toCalcError(e: unknown): CalcError {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

/* ------------------------------------------------------------------ *
 * option state
 * ------------------------------------------------------------------ */

/**
 * The option bag, seeded from the meta defaults. Keeping the ids identical to
 * `meta.options` is what lets the fragment keys, the query API, and a link
 * pasted from the generic shell all mean the same thing.
 */
const opts = ref<Record<string, unknown>>(
  Object.fromEntries((props.meta.options ?? []).map((o) => [o.id, o.default])),
);

const defaults = computed<Record<string, string>>(() =>
  Object.fromEntries((props.meta.options ?? []).map((o) => [o.id, String(o.default)])),
);

const specById = computed<Record<string, OptionSpec>>(() =>
  Object.fromEntries((props.meta.options ?? []).map((o) => [o.id, o])),
);

function specList(ids: string[]): OptionSpec[] {
  return ids.map((id) => specById.value[id]).filter((s): s is OptionSpec => Boolean(s));
}

const shapeSpecs = computed(() => specList(SHAPE_IDS));
const derateSpecs = computed(() => specList(DERATE_IDS));
const resilverSpec = computed<OptionSpec | null>(() => specById.value.resilverHours ?? null);
const mtbfSpec = computed<OptionSpec | null>(() => specById.value.mtbfHours ?? null);
const afrSpec = computed<OptionSpec | null>(() => specById.value.afrPercent ?? null);

const level = computed(() => asLevel(opts.value.level, "raidz1"));
const disks = computed(() => intOf(opts.value.disks, 6));
const diskSize = computed(() => numberOf(opts.value.diskSize, 4));
const unit = computed(() => asUnit(opts.value.diskSizeUnit));
const vdevCount = computed(() => intOf(opts.value.vdevs, 1));
const zfsOverhead = computed(() => Boolean(opts.value.zfsOverhead));
const osReserve = computed(() => numberOf(opts.value.osReservePercent, 0));
const spares = computed(() => Math.max(0, intOf(opts.value.hotSpares, 0)));
const mtbfHours = computed(() => numberOf(opts.value.mtbfHours, 0));
const afrPercent = computed(() => numberOf(opts.value.afrPercent, 0));
const resilverHours = computed(() => numberOf(opts.value.resilverHours, 0));

/* ------------------------------------------------------------------ *
 * mixed vdev editor
 * ------------------------------------------------------------------ */

interface VdevRow {
  level: VdevLevel;
  disks: number;
  diskSize: number;
  unit: string;
  /** dRAID distributed spares. Counted inside `disks`; ignored elsewhere. */
  spares: number;
}

const mixed = ref(false);
const rows = ref<VdevRow[]>([]);

/**
 * The spare drives control. The logic layer reads the same number two different
 * ways, so the label has to say which one is in play: on a dRAID level it is
 * distributed spare space inside each vdev, everywhere else it is idle drives
 * beside the pool. Mixed mode always means the pool wide kind, because a mixed
 * pool keeps its dRAID spares per row.
 */
const spareSpec = computed<OptionSpec | null>(() => {
  const spec = specById.value.hotSpares;
  if (!spec) return null;
  if (mixed.value) return { ...spec, label: "Pool hot spares (idle drives)" };
  if (isDraid(level.value)) return { ...spec, label: "Distributed spares per vdev" };
  return { ...spec, label: "Hot spares (idle drives)" };
});

function uniformRow(): VdevRow {
  return {
    level: level.value,
    disks: disks.value,
    diskSize: diskSize.value,
    unit: unit.value,
    spares: isDraid(level.value) ? spares.value : 0,
  };
}

/**
 * Turning mixed mode on seeds the table from the uniform pool, so the diagram
 * does not jump: the first thing you see is the pool you already had, one row
 * per vdev, ready to be edited apart.
 */
function setMixed(on: boolean): void {
  if (on && rows.value.length === 0) {
    const count = Math.max(1, vdevCount.value);
    rows.value = Array.from({ length: count }, () => uniformRow());
  }
  mixed.value = on;
}

function addRow(): void {
  rows.value = [...rows.value, rows.value[rows.value.length - 1] ?? uniformRow()].map((r) => ({
    ...r,
  }));
}

function removeRow(index: number): void {
  if (rows.value.length <= 1) return;
  rows.value = rows.value.filter((_, i) => i !== index);
}

/** The flat level list, borrowed from the meta so labels and synonyms match. */
const rowLevelSpec = computed<SelectOptionSpec>(() => {
  const spec = specById.value.level;
  return {
    kind: "select",
    id: "raidz-vdev-level",
    label: "vdev level",
    default: "raidz2",
    ui: "select",
    options: spec && spec.kind === "select" ? flattenSelectOptions(spec) : [],
  };
});

/* ------------------------------------------------------------------ *
 * the pool
 * ------------------------------------------------------------------ */

/**
 * The pool the whole panel draws.
 *
 * The uniform branch mirrors `run()` exactly, including the split that decides
 * where the spare drives go: on a dRAID level they are distributed spares
 * inside every vdev, on every other level they are pool wide hot spares. Get
 * that backwards and the diagram and the pie stop agreeing.
 */
const poolSpec = computed<PoolSpec>(() => {
  if (mixed.value) {
    return {
      vdevs: rows.value.map((r) => ({
        level: r.level,
        disks: Math.floor(r.disks),
        diskBytes: diskBytesOf(r.diskSize, r.unit),
        spares: isDraid(r.level) ? Math.max(0, Math.floor(r.spares)) : 0,
      })),
      hotSpares: spares.value,
    };
  }
  const draid = isDraid(level.value);
  const vdev: VdevSpec = {
    level: level.value,
    disks: disks.value,
    diskBytes: diskBytesOf(diskSize.value, unit.value),
    spares: draid ? spares.value : 0,
  };
  const count = Number.isFinite(vdevCount.value) ? Math.max(0, vdevCount.value) : 0;
  return {
    vdevs: Array.from({ length: count }, () => ({ ...vdev })),
    hotSpares: draid ? 0 : spares.value,
  };
});

/** Pool wide idle spare drives. dRAID keeps its spares inside the vdev instead. */
const hotSpareCount = computed(() => Math.max(0, Math.floor(poolSpec.value.hotSpares ?? 0)));

const failed = ref<Set<string>>(new Set());

/** Every drive id the current pool actually has. */
const validDriveIds = computed<Set<string>>(() => {
  const ids = new Set<string>();
  poolSpec.value.vdevs.forEach((v, vi) => {
    const width = Math.max(0, Math.floor(v.disks));
    for (let di = 0; di < width; di += 1) ids.add(driveId(vi, di));
  });
  return ids;
});

/**
 * Shrink the pool and the failures that no longer exist go with it. `simulate`
 * ignores unknown ids, but `encodeFailures` would keep writing them to the URL,
 * and widening the pool again would resurrect a failed drive nobody clicked.
 */
watch(validDriveIds, (ids) => {
  const kept = [...failed.value].filter((id) => ids.has(id));
  if (kept.length !== failed.value.size) failed.value = new Set(kept);
});

/** `simulate` never throws, so the diagram stays interactive through any error. */
const poolStatus = computed(() => simulate(poolSpec.value, failed.value));

function toggleDrive(id: string): void {
  const next = new Set(failed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  failed.value = next;
}

function resetFailures(): void {
  failed.value = new Set();
}

/* ------------------------------------------------------------------ *
 * capacity, reliability, results
 * ------------------------------------------------------------------ */

const capacityReport = computed<{ capacity: PoolCapacity | null; error: CalcError | null }>(() => {
  try {
    return {
      capacity: poolCapacity(poolSpec.value, {
        zfsOverhead: zfsOverhead.value,
        osReservePercent: osReserve.value,
      }),
      error: null,
    };
  } catch (e) {
    return { capacity: null, error: toCalcError(e) };
  }
});

/** The same guard `run()` applies: no drive rate or no resilver time, no MTTDL. */
const reliabilityWanted = computed(
  () => (afrPercent.value > 0 || mtbfHours.value > 0) && resilverHours.value > 0,
);

/**
 * Reliability gets its own try, not the capacity one: an out of range AFR
 * should take out one card, not blank the pie and the diagram with it.
 */
const reliabilityReport = computed<{
  reliability: PoolReliability | null;
  error: CalcError | null;
}>(() => {
  if (!reliabilityWanted.value) return { reliability: null, error: null };
  try {
    return {
      reliability: mttdl(poolSpec.value, {
        mtbfHours: mtbfHours.value,
        afrPercent: afrPercent.value,
        resilverHours: resilverHours.value,
      }),
      error: null,
    };
  } catch (e) {
    return { reliability: null, error: toCalcError(e) };
  }
});

const runOpts = computed<RaidzOpts>(() => ({
  disks: disks.value,
  diskSizeUnit: unit.value,
  diskSize: diskSize.value,
  level: level.value,
  vdevs: vdevCount.value,
  zfsOverhead: zfsOverhead.value,
  osReservePercent: osReserve.value,
  hotSpares: spares.value,
  mtbfHours: mtbfHours.value,
  afrPercent: afrPercent.value,
  resilverHours: resilverHours.value,
}));

/** How the mixed pool's layout reads in one line. */
const mixedLayout = computed(() =>
  rows.value
    .map((r, i) => {
      const draidSpares = isDraid(r.level) ? Math.max(0, Math.floor(r.spares)) : 0;
      const extra =
        draidSpares > 0
          ? ` with ${draidSpares} distributed ${plural(draidSpares, "spare", "spares")}`
          : "";
      return `vdev ${i + 1}: ${Math.floor(r.disks)}-disk ${r.level}${extra} at ${trimNumber(r.diskSize)} ${r.unit}`;
    })
    .join("; "),
);

/**
 * The results record for the mixed pool, built from the same capacity and
 * reliability values every other card reads. `run()` cannot produce this: it
 * stamps out identical vdevs, so its answer would describe a pool that is not
 * on screen.
 */
function mixedRecord(cap: PoolCapacity, rel: PoolReliability | null): Record<string, string> {
  const share = (bytes: number) =>
    cap.rawBytes > 0 ? `${((bytes / cap.rawBytes) * 100).toFixed(1)}%` : "0.0%";
  const tolerated = poolSpec.value.vdevs.map((v) => toleratedFailures(v));
  const weakest = tolerated.length ? Math.min(...tolerated) : 0;

  const out: Record<string, string> = {
    Layout: mixedLayout.value,
    "Raw capacity": formatBytes(cap.rawBytes),
    "Usable capacity": formatBytes(cap.usableBytes + cap.osReserveBytes),
  };
  if (cap.osReserveBytes > 0)
    out["Usable after OS reserve"] =
      `${formatBytes(cap.usableBytes)}, ${trimNumber(osReserve.value)}% held back`;
  out["Parity overhead"] = `${formatBytes(cap.parityBytes)}, ${share(cap.parityBytes)}`;
  if (cap.zfsOverheadBytes > 0)
    out["ZFS overhead"] = `${formatBytes(cap.zfsOverheadBytes)}, ${share(cap.zfsOverheadBytes)}`;
  if (cap.spareBytes > 0)
    out["Spare capacity"] = `${formatBytes(cap.spareBytes)}, ${share(cap.spareBytes)}`;
  out["Storage efficiency"] = `${(cap.efficiency * 100).toFixed(1)}%`;
  out["Fault tolerance"] = `${weakest} ${plural(weakest, "disk", "disks")} in the weakest vdev`;
  if (rel) {
    out["MTTDL (pool)"] = formatMttdl(rel.mttdlHours);
    out["Annual data loss risk"] = formatProbability(rel.annualDataLossProbability);
  }

  const notes = [
    "This is an estimate: real usable space also depends on ashift, recordsize, and RAIDZ padding, which are not modeled here and vary by pool.",
  ];
  if (zfsOverhead.value)
    notes.push(
      `Usable capacity above is derated by about ${(100 - ZFS_OVERHEAD_RATIO * 100).toFixed(1)}% to approximate ZFS slop space and metadata reservation.`,
    );
  notes.push(
    "Unrecoverable read errors are ignored: only whole drive failures count, so a long resilver on large drives carries more real risk than these numbers show.",
  );
  out.Notes = notes.join(" ");
  return out;
}

const summary = computed<{ record: Record<string, string> | null; error: CalcError | null }>(() => {
  const cap = capacityReport.value;
  if (mixed.value) {
    if (!cap.capacity) return { record: null, error: cap.error };
    return {
      record: mixedRecord(cap.capacity, reliabilityReport.value.reliability),
      error: null,
    };
  }
  try {
    return { record: run("", runOpts.value), error: null };
  } catch (e) {
    return { record: null, error: toCalcError(e) };
  }
});

/** The error worth showing above everything: a pool that cannot exist. */
const blockingError = computed<CalcError | null>(
  () => capacityReport.value.error ?? summary.value.error,
);

const summaryText = computed(() =>
  summary.value.record ? rowsToText(recordToRows(summary.value.record)) : "",
);

/* ------------------------------------------------------------------ *
 * diagram labels
 * ------------------------------------------------------------------ */

/** Per vdev drive size text, taken from whichever mode built the vdev. */
const vdevSizeLabels = computed<string[]>(() =>
  poolSpec.value.vdevs.map((_, i) => {
    const row = mixed.value ? rows.value[i] : undefined;
    return row ? shortSize(row.diskSize, row.unit) : shortSize(diskSize.value, unit.value);
  }),
);

/**
 * The size printed on a hot spare square. `poolCapacity` sizes pool wide spares
 * at the largest member drive, so a mixed pool has to say that size, not the
 * first vdev's.
 */
const spareSizeLabel = computed(() => {
  const target = largestDiskBytes(poolSpec.value);
  const index = poolSpec.value.vdevs.findIndex((v) => v.diskBytes === target);
  return vdevSizeLabels.value[index] ?? shortSize(diskSize.value, unit.value);
});

/** dRAID distributed spares in one vdev, for the "includes N" line on the card. */
function draidSparesAt(index: number): number {
  const vdev = poolSpec.value.vdevs[index];
  if (!vdev || !isDraid(vdev.level)) return 0;
  return Math.max(0, Math.floor(vdev.spares ?? 0));
}

const totalDrives = computed(
  () =>
    poolSpec.value.vdevs.reduce((sum, v) => sum + Math.max(0, Math.floor(v.disks)), 0) +
    hotSpareCount.value,
);

const poolSummaryLine = computed(() => {
  const cap = capacityReport.value.capacity;
  const usable = cap ? `${formatBytes(cap.usableBytes)} usable, ` : "";
  const vdevs = poolSpec.value.vdevs.length;
  return `${usable}${vdevs} ${plural(vdevs, "vdev", "vdevs")}, ${totalDrives.value} ${plural(totalDrives.value, "drive", "drives")}`;
});

const HEALTH_LABEL: Record<HealthState, string> = {
  online: "Online",
  degraded: "Degraded",
  faulted: "Data loss",
};

function healthKey(health: HealthState): string {
  return health === "online" ? "ok" : health === "degraded" ? "warn" : "bad";
}

function chipStyle(health: HealthState): Record<string, string> {
  const key = healthKey(health);
  return { background: `var(--raidz-${key}-soft)`, color: `var(--raidz-${key})` };
}

/**
 * The faulted vdev fill. The stripe is decoration only: the "data loss" chip
 * next to it is what actually carries the state to a screen reader.
 */
const FAULT_STRIPE =
  "repeating-linear-gradient(135deg, color-mix(in srgb, var(--raidz-bad) 18%, var(--card)) 0 12px, color-mix(in srgb, var(--foreground) 10%, var(--card)) 12px 20px)";

function vdevCardStyle(health: HealthState): Record<string, string> {
  return health === "faulted" ? { background: FAULT_STRIPE } : {};
}

function driveStyle(state: DriveState): Record<string, string> {
  return state === "failed"
    ? { background: "var(--raidz-bad)", color: "var(--raidz-bad-ink)" }
    : { background: "var(--raidz-ok)", color: "var(--raidz-ok-soft)" };
}

function vdevChip(failuresLeft: number, health: HealthState): string {
  if (health === "faulted") return "Data loss";
  if (health === "online") return "Online";
  return `${failuresLeft} ${plural(failuresLeft, "failure", "failures")} left`;
}

function driveLabel(vdevIndex: number, diskIndex: number, state: DriveState): string {
  return `vdev ${vdevIndex + 1} drive ${diskIndex + 1}, ${state === "failed" ? "failed" : "online"}`;
}

/* ------------------------------------------------------------------ *
 * capacity pie
 * ------------------------------------------------------------------ */

interface PieSlice {
  key: string;
  label: string;
  bytes: number;
  color: string;
}

/**
 * The five slices are exhaustive and disjoint by construction in
 * `poolCapacity`, so they sum to exactly `rawBytes`. Empty slices drop out and
 * the colors are assigned after the filter, in lockstep, so a hidden slice can
 * never shift the palette under the legend.
 */
const pieSlices = computed<PieSlice[]>(() => {
  const cap = capacityReport.value.capacity;
  if (!cap) return [];
  return [
    { key: "usable", label: "Usable", bytes: cap.usableBytes },
    { key: "parity", label: "Parity", bytes: cap.parityBytes },
    { key: "zfs", label: "ZFS overhead", bytes: cap.zfsOverheadBytes },
    { key: "reserve", label: "OS reserve", bytes: cap.osReserveBytes },
    { key: "spare", label: "Spare capacity", bytes: cap.spareBytes },
  ]
    .filter((s) => s.bytes > 0)
    .map((s, i) => ({ ...s, color: SLICE_COLORS[i % SLICE_COLORS.length] }));
});

interface PieArc extends PieSlice {
  percent: number;
  d: string;
  labelX: number;
  labelY: number;
}

const pieArcs = computed<PieArc[]>(() => {
  const slices = pieSlices.value;
  const total = slices.reduce((sum, s) => sum + s.bytes, 0);
  if (total <= 0) return [];
  const midRadius = (PIE.outer + PIE.inner) / 2;
  let angle = -Math.PI / 2;
  return slices.map((s) => {
    const fraction = s.bytes / total;
    const start = angle;
    const end = angle + fraction * Math.PI * 2;
    angle = end;
    const mid = (start + end) / 2;
    return {
      ...s,
      percent: fraction * 100,
      d: slicePath(PIE.cx, PIE.cy, PIE.outer, PIE.inner, start, end),
      labelX: PIE.cx + midRadius * Math.cos(mid),
      labelY: PIE.cy + midRadius * Math.sin(mid),
    };
  });
});

/**
 * A pool with one slice (a stripe with every derate off) is a full circle, and
 * `slicePath` draws a zero length arc for that because its start and end points
 * land on the same coordinate. Draw a real circle instead.
 */
const pieIsWhole = computed(() => pieSlices.value.length === 1);

/**
 * Only the wedges wide enough to hold text get a label drawn on the chart. The
 * whole circle case has no arc to sit on, so its one label goes to the top of
 * the ring.
 */
const arcLabels = computed(() =>
  pieArcs.value
    .filter((arc) => arc.percent >= ARC_LABEL_MIN_PERCENT)
    .map((arc) => ({
      key: arc.key,
      text: `${arc.percent.toFixed(arc.percent >= 10 ? 0 : 1)}%`,
      x: pieIsWhole.value ? PIE.cx : arc.labelX,
      y: pieIsWhole.value ? PIE.cy - (PIE.outer + PIE.inner) / 2 : arc.labelY,
    })),
);

const pieLabel = computed(() => {
  if (pieArcs.value.length === 0) return "Capacity breakdown";
  const parts = pieArcs.value.map(
    (a) => `${a.label} ${a.percent.toFixed(1)} percent, ${formatBytes(a.bytes)}`,
  );
  return `Capacity breakdown of every drive in the pool: ${parts.join(", ")}.`;
});

/**
 * One denominator, used by both the arc labels and the legend. It equals
 * `rawBytes` because `poolCapacity` guarantees the five slices are exhaustive
 * and disjoint, but deriving the legend from `rawBytes` separately would leave
 * two numbers free to drift apart on the same wedge.
 */
function slicePercent(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

/* ------------------------------------------------------------------ *
 * reliability controls
 * ------------------------------------------------------------------ */

const reliabilityMode = ref("mtbf");

/**
 * The logic layer's rule is that an AFR above zero always wins over the MTBF,
 * so hiding a field is not enough: choosing "MTBF hours" has to actually zero
 * the AFR, or a leftover value would keep steering the result from behind a
 * control nobody can see. Switching seeds the other number from the one in
 * hand so the two never disagree by more than rounding.
 */
function setReliabilityMode(next: string): void {
  if (next === reliabilityMode.value) return;
  if (next === "afr") {
    if (afrPercent.value <= 0 && mtbfHours.value > 0) {
      try {
        opts.value.afrPercent = Number(mtbfToAfrPercent(mtbfHours.value).toFixed(2));
      } catch {
        /* An unusable MTBF leaves the AFR alone; the field is editable. */
      }
    }
    reliabilityMode.value = "afr";
    return;
  }
  if (afrPercent.value > 0) {
    try {
      opts.value.mtbfHours = Math.round(afrToMtbfHours(afrPercent.value));
    } catch {
      /* Out of range AFR: keep whatever MTBF is already in the field. */
    }
  }
  opts.value.afrPercent = 0;
  reliabilityMode.value = "mtbf";
}

/** A reference row fills both numbers and switches to the measured AFR. */
function applyReference(row: DriveReliabilityReference): void {
  opts.value.afrPercent = row.afrPercent;
  opts.value.mtbfHours = row.mtbfHours;
  reliabilityMode.value = "afr";
}

const referenceOpen = ref(false);

const spareNote = computed(() => {
  const draid = poolSpec.value.vdevs.some((v) => isDraid(v.level) && (v.spares ?? 0) > 0);
  if (draid)
    return `Distributed spares let the rebuild start with nobody in the room, so the ${MANUAL_REPLACEMENT_DELAY_HOURS} hour wait for a human drops out of the repair time, and the rebuild itself is spread across every surviving child.`;
  if (hotSpareCount.value > 0)
    return `${hotSpareCount.value} hot ${plural(hotSpareCount.value, "spare removes", "spares remove")} the ${MANUAL_REPLACEMENT_DELAY_HOURS} hour wait for a human to swap a disk. A spare never raises how many drives a vdev can lose.`;
  return `With no spare racked, the repair time includes a ${MANUAL_REPLACEMENT_DELAY_HOURS} hour estimate for somebody to notice the alert and fit a replacement.`;
});

const ASSUMPTIONS = [
  "Drives are treated as failing independently at a constant rate, so one bad batch, one hot shelf, or one power event is not modeled and is real.",
  "Unrecoverable read errors are ignored: only whole drive failures count, so a long resilver on large drives is riskier than these numbers say.",
  `Repair time is the resilver plus a ${MANUAL_REPLACEMENT_DELAY_HOURS} hour wait for a human, and a hot spare or a dRAID distributed spare drops that wait to zero. Spares never add fault tolerance.`,
  "Vdevs are striped, so losing any one vdev loses the pool. Read the result as an order of magnitude comparison between layouts, never as a prediction.",
];

/* ------------------------------------------------------------------ *
 * quick entry
 * ------------------------------------------------------------------ */

const quickOpen = ref(false);
const quickText = ref("");
const quickApplied = ref(false);

/**
 * One shot: a match writes the four values into the uniform controls and is
 * done. `parseShorthand` throws on a token like "6x4TB foo" (its level
 * normalizer is strict), so the throw is caught and treated as "not a layout".
 */
function applyShorthand(text: string): boolean {
  let parsed: ReturnType<typeof parseShorthand>;
  try {
    parsed = parseShorthand(text);
  } catch {
    /* Unparseable shorthand leaves the controls exactly as they were. */
    return false;
  }
  if (!parsed) return false;
  opts.value.disks = parsed.disks;
  opts.value.diskSize = parsed.diskSize;
  opts.value.diskSizeUnit = parsed.diskSizeUnit;
  opts.value.level = parsed.level;
  return true;
}

watch(quickText, (text) => {
  quickApplied.value = applyShorthand(text);
});

const quickStatus = computed(() => {
  const text = quickText.value.trim();
  if (!text)
    return (
      props.meta.inputOptional?.hint ??
      'Type a layout like "6x4TB raidz2" to fill the level, the width, and the disk size in one line.'
    );
  if (quickApplied.value)
    return `Applied: ${disks.value} ${plural(disks.value, "disk", "disks")} of ${trimNumber(diskSize.value)} ${unit.value}, ${LEVEL_LABEL[level.value]}. The vdev count and the derate switches still come from the controls.`;
  return 'That is not a layout this parser recognizes. Try something like "6x4TB raidz2".';
});

/* ------------------------------------------------------------------ *
 * URL fragment
 * ------------------------------------------------------------------ */

const mounted = ref(false);

function encodeVdevRows(list: VdevRow[]): string {
  return list
    .map(
      (r) =>
        `${r.level}:${Math.floor(r.disks)}:${trimNumber(r.diskSize)}:${r.unit}:${Math.max(0, Math.floor(r.spares))}`,
    )
    .join(",");
}

/** Anything unparseable is dropped, so a stale link degrades to uniform mode. */
function decodeVdevRows(raw: string): VdevRow[] {
  const out: VdevRow[] = [];
  for (const part of String(raw ?? "").split(",")) {
    const bits = part.split(":");
    if (bits.length < 4) continue;
    const width = Number(bits[1]);
    const size = Number(bits[2]);
    if (!Number.isFinite(width) || !Number.isFinite(size) || width < 1 || size <= 0) continue;
    const sparesRaw = Number(bits[4]);
    out.push({
      level: asLevel(bits[0], "raidz2"),
      disks: Math.floor(width),
      diskSize: size,
      unit: asUnit(bits[3]),
      spares: Number.isFinite(sparesRaw) ? Math.max(0, Math.floor(sparesRaw)) : 0,
    });
  }
  return out;
}

/**
 * One object, one write. `writeFragment` rebuilds the whole hash from what it
 * is given, so every key the panel owns has to be in the same call: the option
 * ids (shared with the query API), `vd` for the mixed vdev table, and `f` for
 * the failure set. Values equal to their meta default are left out so the plain
 * URL stays clean.
 */
const fragmentOpts = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts.value)) {
    const text = String(value);
    if (text !== defaults.value[key]) out[key] = text;
  }
  if (mixed.value) out.vd = encodeVdevRows(rows.value);
  const failures = encodeFailures(failed.value);
  if (failures) out.f = failures;
  return out;
});

watch(fragmentOpts, (state) => {
  if (!mounted.value) return;
  writeFragment({ opts: state });
});

onMounted(() => {
  const fragment = readFragment();
  const coerced = coerceOpts(props.meta.options, fragment.opts);
  for (const [key, value] of Object.entries(coerced)) opts.value[key] = value;

  const encodedRows = fragment.opts.vd;
  if (encodedRows) {
    const list = decodeVdevRows(encodedRows);
    if (list.length > 0) {
      rows.value = list;
      mixed.value = true;
    }
  }

  const encodedFailures = fragment.opts.f;
  if (encodedFailures) {
    const wanted = decodeFailures(encodedFailures);
    failed.value = new Set([...wanted].filter((id) => validDriveIds.value.has(id)));
  }

  // A shared link may still carry the generic shell's shorthand input. Apply it
  // once into the controls, then let the controls own the pool from here.
  if (!mixed.value && fragment.input) {
    // Applied here rather than left to the quickText watcher, which flushes
    // after this hook returns and would report last render's answer.
    quickApplied.value = applyShorthand(fragment.input);
    quickText.value = fragment.input;
    if (quickApplied.value) quickOpen.value = true;
  }

  reliabilityMode.value = afrPercent.value > 0 ? "afr" : "mtbf";
  mounted.value = true;
});
</script>

<template>
  <div class="raidz-panel flex flex-col gap-4">
    <!-- ---------------------------------------------------- pool builder -->
    <section class="rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="flex flex-col gap-4">
        <!-- Quick entry stays collapsed: the controls below are the main event. -->
        <div v-if="!mixed">
          <Button
            variant="ghost"
            size="sm"
            class="-ml-2.5 text-muted-foreground"
            :aria-expanded="quickOpen"
            aria-controls="raidz-quick-entry"
            @click="quickOpen = !quickOpen"
          >
            <ChevronRight
              class="size-4 transition-transform duration-150 motion-reduce:transition-none"
              :class="quickOpen ? 'rotate-90' : ''"
            />
            Quick entry
          </Button>
          <div
            v-show="quickOpen"
            id="raidz-quick-entry"
            class="mt-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
          >
            <Label for="raidz-shorthand" class="text-xs text-muted-foreground">
              Layout shorthand
            </Label>
            <Input
              id="raidz-shorthand"
              :model-value="quickText"
              placeholder="6x4TB raidz2"
              class="mt-1.5 h-8 font-mono"
              @update:model-value="quickText = String($event)"
            />
            <p class="mt-2 text-xs text-muted-foreground">{{ quickStatus }}</p>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <template v-if="!mixed">
            <OptionControl
              v-for="spec in shapeSpecs"
              :key="spec.id"
              :spec="spec"
              :model-value="opts[spec.id]"
              @update:model-value="opts[spec.id] = $event"
            />
          </template>
          <OptionControl
            v-for="spec in derateSpecs"
            :key="spec.id"
            :spec="spec"
            :model-value="opts[spec.id]"
            @update:model-value="opts[spec.id] = $event"
          />
          <OptionControl
            v-if="spareSpec"
            :spec="spareSpec"
            :model-value="opts.hotSpares"
            @update:model-value="opts.hotSpares = $event"
          />
          <OptionControl
            :spec="{
              kind: 'boolean',
              id: 'raidz-mixed',
              label: 'Advanced: mixed vdevs',
              default: false,
            }"
            :model-value="mixed"
            @update:model-value="setMixed(Boolean($event))"
          />
        </div>

        <!-- Mixed vdev editor: one row per vdev, each with its own shape. -->
        <div v-if="mixed" class="rounded-[12px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div class="overflow-x-auto">
            <table class="w-full min-w-[34rem] border-collapse text-sm">
              <caption class="sr-only">
                One row per vdev: level, width, drive size, and dRAID spares.
              </caption>
              <thead>
                <tr>
                  <th
                    scope="col"
                    class="border-b border-border px-2 py-1.5 text-left text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase"
                  >
                    vdev
                  </th>
                  <th
                    scope="col"
                    class="border-b border-border px-2 py-1.5 text-left text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase"
                  >
                    Level
                  </th>
                  <th
                    scope="col"
                    class="border-b border-border px-2 py-1.5 text-left text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase"
                  >
                    Disks
                  </th>
                  <th
                    scope="col"
                    class="border-b border-border px-2 py-1.5 text-left text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase"
                  >
                    Disk size
                  </th>
                  <th
                    scope="col"
                    class="border-b border-border px-2 py-1.5 text-left text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase"
                  >
                    Spares
                  </th>
                  <th scope="col" class="border-b border-border px-2 py-1.5">
                    <span class="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, index) in rows" :key="index">
                  <td class="border-b border-border/60 px-2 py-2 font-mono text-xs tabular-nums">
                    {{ index + 1 }}
                  </td>
                  <td class="border-b border-border/60 px-2 py-2">
                    <div class="w-[9.5rem]">
                      <SearchableSelect
                        :id="`raidz-vdev-${index}-level`"
                        :spec="rowLevelSpec"
                        :model-value="row.level"
                        @update:model-value="row.level = asLevel($event, 'raidz2')"
                      />
                    </div>
                  </td>
                  <td class="border-b border-border/60 px-2 py-2">
                    <Input
                      :id="`raidz-vdev-${index}-disks`"
                      type="number"
                      min="1"
                      max="60"
                      :model-value="row.disks"
                      :aria-label="`Disks in vdev ${index + 1}`"
                      class="h-8 w-20"
                      @update:model-value="row.disks = Number($event)"
                    />
                  </td>
                  <td class="border-b border-border/60 px-2 py-2">
                    <div class="flex items-center gap-2">
                      <Input
                        :id="`raidz-vdev-${index}-size`"
                        type="number"
                        min="0.1"
                        step="0.5"
                        :model-value="row.diskSize"
                        :aria-label="`Disk size in vdev ${index + 1}`"
                        class="h-8 w-20"
                        @update:model-value="row.diskSize = Number($event)"
                      />
                      <Segmented
                        :options="ROW_UNITS"
                        :model-value="row.unit"
                        :label="`Disk size unit for vdev ${index + 1}`"
                        size="sm"
                        :wrap="false"
                        @update:model-value="row.unit = asUnit($event)"
                      />
                    </div>
                  </td>
                  <td class="border-b border-border/60 px-2 py-2">
                    <Input
                      v-if="isDraid(row.level)"
                      :id="`raidz-vdev-${index}-spares`"
                      type="number"
                      min="0"
                      max="16"
                      :model-value="row.spares"
                      :aria-label="`Distributed spares in vdev ${index + 1}`"
                      class="h-8 w-20"
                      @update:model-value="row.spares = Number($event)"
                    />
                    <span v-else class="text-xs text-muted-foreground">n/a</span>
                  </td>
                  <td class="border-b border-border/60 px-2 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      :disabled="rows.length <= 1"
                      :aria-label="`Remove vdev ${index + 1}`"
                      @click="removeRow(index)"
                    >
                      <Trash2 class="size-4" />
                    </Button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="mt-2 flex flex-wrap items-center gap-3">
            <Button variant="secondary" size="sm" @click="addRow">
              <Plus class="size-4" />
              Add vdev
            </Button>
            <span class="text-xs text-muted-foreground">
              Levels: stripe, mirror, RAIDZ1 to RAIDZ3, dRAID1 to dRAID3. A dRAID vdev counts its
              distributed spares inside its own disk count.
            </span>
          </div>
        </div>

        <div
          v-if="blockingError"
          class="rounded-[10px] bg-secondary px-4 py-3 text-sm shadow-[var(--sh-inset)]"
          role="alert"
        >
          <p class="font-medium">{{ blockingError.message }}</p>
          <p v-if="blockingError.fix" class="mt-1 text-muted-foreground">
            {{ blockingError.fix }}
          </p>
          <p v-if="!mixed" class="mt-1 text-xs text-muted-foreground">
            {{ LEVEL_LABEL[level] }} needs at least {{ minDisks(level, spares) }} disks per vdev at
            this spare count.
          </p>
        </div>
      </div>
    </section>

    <!-- ------------------------------------------------------- diagram -->
    <section
      class="rounded-[14px] border border-dashed p-4"
      :style="{ background: 'var(--grad-brand-soft)' }"
      aria-label="Pool failure simulation"
    >
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <span
          class="grid size-8 shrink-0 place-items-center rounded-[10px]"
          :style="chipStyle(poolStatus.health)"
        >
          <HardDrive class="size-4" />
        </span>
        <span class="font-semibold">Pool</span>
        <span
          class="inline-flex h-6 items-center rounded-[8px] px-2 text-xs font-medium"
          :style="chipStyle(poolStatus.health)"
        >
          {{ HEALTH_LABEL[poolStatus.health] }}
        </span>
        <span class="text-xs text-muted-foreground">{{ poolSummaryLine }}</span>
        <Button
          variant="ghost"
          size="sm"
          class="ml-auto"
          :disabled="failed.size === 0"
          @click="resetFailures"
        >
          <RotateCcw class="size-4" />
          Reset
        </Button>
      </div>

      <p class="mb-3 text-xs text-muted-foreground">
        Click any drive to fail it or bring it back. Health propagates drive to vdev to pool: a vdev
        stays degraded until it loses more drives than it tolerates, and the first faulted vdev
        takes the whole pool with it.
      </p>

      <div class="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(15rem,1fr))]">
        <div
          v-for="(vdev, vi) in poolStatus.vdevs"
          :key="vdev.id"
          class="rounded-[12px] border bg-card p-3 shadow-[var(--sh-sm)]"
          :style="vdevCardStyle(vdev.health)"
        >
          <div class="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold">
            <span>vdev {{ vi + 1 }}</span>
            <span
              class="inline-flex h-5 items-center rounded-[6px] bg-secondary px-1.5 font-mono text-[11px] font-medium text-muted-foreground"
            >
              {{ LEVEL_LABEL[vdev.level] }}
            </span>
            <span
              class="ml-auto inline-flex h-6 items-center rounded-[8px] px-2 text-xs font-medium"
              :style="chipStyle(vdev.health)"
            >
              {{ vdevChip(vdev.failuresLeft, vdev.health) }}
            </span>
          </div>
          <div class="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(2.25rem,1fr))]">
            <button
              v-for="(drive, di) in vdev.disks"
              :key="drive.id"
              type="button"
              :aria-pressed="drive.state === 'failed'"
              :aria-label="driveLabel(vi, di, drive.state)"
              class="grid aspect-[1/1.35] place-items-center rounded-[8px] font-mono text-[11px] font-medium outline-none transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none"
              :style="driveStyle(drive.state)"
              @click="toggleDrive(drive.id)"
            >
              <X v-if="drive.state === 'failed'" class="size-4" />
              <span v-else>{{ vdevSizeLabels[vi] }}</span>
            </button>
          </div>
          <p v-if="draidSparesAt(vi) > 0" class="mt-2 text-[11px] text-muted-foreground">
            Includes {{ draidSparesAt(vi) }} distributed
            {{ plural(draidSparesAt(vi), "spare", "spares") }} inside the vdev.
          </p>
          <p v-if="vdev.health === 'faulted'" class="mt-2 text-[11px] font-medium">
            {{ vdev.failedCount }} of {{ vdev.toleratedFailures }} tolerated failures exceeded.
          </p>
        </div>

        <!-- Pool wide hot spares only. dRAID keeps its spares inside the vdev,
             where they are already drawn as drive squares. -->
        <div v-if="hotSpareCount > 0" class="rounded-[12px] border border-dashed p-3">
          <div class="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold">
            <span>Hot spares</span>
            <span
              class="inline-flex h-5 items-center rounded-[6px] bg-secondary px-1.5 font-mono text-[11px] font-medium text-muted-foreground"
            >
              {{ hotSpareCount }}
            </span>
            <span
              class="ml-auto inline-flex h-6 items-center rounded-[8px] px-2 text-xs font-medium"
              :style="chipStyle('online')"
            >
              Ready
            </span>
          </div>
          <div class="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(2.25rem,1fr))]">
            <span
              v-for="n in hotSpareCount"
              :key="n"
              class="grid aspect-[1/1.35] place-items-center rounded-[8px] border-2 border-dashed font-mono text-[11px] text-muted-foreground"
              :style="{ borderColor: 'var(--raidz-ok)' }"
            >
              {{ spareSizeLabel }}
            </span>
          </div>
          <p class="mt-2 text-[11px] text-muted-foreground">
            Idle drives. They shorten the repair, never the number of failures a vdev survives.
          </p>
        </div>
      </div>
    </section>

    <!-- ------------------------------------- capacity pie + reliability -->
    <div class="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(20rem,1fr))]">
      <section class="rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)]">
        <h3 class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Where the capacity goes
        </h3>
        <div v-if="pieArcs.length" class="mt-4 flex flex-wrap items-center gap-6">
          <svg
            :viewBox="`0 0 ${PIE.size} ${PIE.size}`"
            class="h-auto w-[13.75rem] max-w-full shrink-0"
            role="img"
            :aria-label="pieLabel"
          >
            <template v-if="pieIsWhole">
              <circle :cx="PIE.cx" :cy="PIE.cy" :r="PIE.outer" :fill="pieArcs[0].color" />
              <circle :cx="PIE.cx" :cy="PIE.cy" :r="PIE.inner" fill="var(--card)" />
            </template>
            <template v-else>
              <path v-for="arc in pieArcs" :key="arc.key" :d="arc.d" :fill="arc.color" />
            </template>
            <!-- White text with a dark halo reads on every chart token in both
                 themes, which a single token fill cannot promise. -->
            <text
              v-for="label in arcLabels"
              :key="`label-${label.key}`"
              :x="label.x"
              :y="label.y"
              text-anchor="middle"
              dominant-baseline="middle"
              font-size="11"
              font-weight="600"
              fill="#ffffff"
              stroke="rgba(0, 0, 0, 0.55)"
              stroke-width="3"
              paint-order="stroke"
            >
              {{ label.text }}
            </text>
            <text
              :x="PIE.cx"
              :y="PIE.cy - 6"
              text-anchor="middle"
              font-size="18"
              font-weight="600"
              fill="var(--foreground)"
            >
              {{ formatBytes(capacityReport.capacity?.rawBytes ?? 0) }}
            </text>
            <text
              :x="PIE.cx"
              :y="PIE.cy + 12"
              text-anchor="middle"
              font-size="10"
              fill="var(--muted-foreground)"
            >
              all drives
            </text>
          </svg>

          <dl class="grid min-w-[11rem] flex-1 gap-2 text-sm">
            <div v-for="arc in pieArcs" :key="`legend-${arc.key}`" class="flex items-center gap-2">
              <dt class="flex min-w-0 items-center gap-2">
                <span
                  class="size-3 shrink-0 rounded-[3px]"
                  :style="{ background: arc.color }"
                  aria-hidden="true"
                />
                <span class="truncate">{{ arc.label }}</span>
              </dt>
              <dd class="ml-auto shrink-0 font-mono text-xs tabular-nums">
                {{ formatBytes(arc.bytes) }}
                <span class="text-muted-foreground">{{ slicePercent(arc.percent) }}</span>
              </dd>
            </div>
          </dl>
        </div>
        <p v-else class="mt-4 text-sm text-muted-foreground">
          The capacity breakdown appears once the pool describes something that can exist.
        </p>
        <p class="mt-4 text-xs text-muted-foreground">
          One hundred percent is every drive you bought, spares included, so the slices add back up
          to the raw capacity.
        </p>
      </section>

      <section class="rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)]">
        <h3 class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Reliability
        </h3>

        <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div class="flex min-w-0 flex-col gap-1.5">
            <Label class="text-xs text-muted-foreground">Drive failure rate as</Label>
            <Segmented
              :options="RELIABILITY_MODES"
              :model-value="reliabilityMode"
              label="Drive failure rate as"
              @update:model-value="setReliabilityMode($event)"
            />
          </div>
          <OptionControl
            v-if="reliabilityMode === 'mtbf' && mtbfSpec"
            :spec="mtbfSpec"
            :model-value="opts.mtbfHours"
            @update:model-value="opts.mtbfHours = $event"
          />
          <OptionControl
            v-else-if="afrSpec"
            :spec="{ ...afrSpec, label: 'Drive AFR (percent)' }"
            :model-value="opts.afrPercent"
            @update:model-value="opts.afrPercent = $event"
          />
          <OptionControl
            v-if="resilverSpec"
            :spec="resilverSpec"
            :model-value="opts.resilverHours"
            @update:model-value="opts.resilverHours = $event"
          />
        </div>

        <p class="mt-3 text-xs text-muted-foreground">{{ spareNote }}</p>

        <div
          v-if="reliabilityReport.error"
          class="mt-4 rounded-[10px] bg-secondary px-4 py-3 text-sm shadow-[var(--sh-inset)]"
          role="alert"
        >
          <p class="font-medium">{{ reliabilityReport.error.message }}</p>
          <p v-if="reliabilityReport.error.fix" class="mt-1 text-muted-foreground">
            {{ reliabilityReport.error.fix }}
          </p>
        </div>

        <template v-else-if="reliabilityReport.reliability">
          <div class="mt-4 rounded-[12px] bg-secondary px-4 py-3 shadow-[var(--sh-inset)]">
            <span class="text-xs font-medium text-muted-foreground">MTTDL (pool)</span>
            <span class="block font-mono text-[22px] tabular-nums">
              {{ formatMttdl(reliabilityReport.reliability.mttdlHours) }}
            </span>
            <span class="block text-xs text-muted-foreground">
              Annual probability of data loss:
              {{ formatProbability(reliabilityReport.reliability.annualDataLossProbability) }}.
              Drive MTBF {{ hoursLabel(reliabilityReport.reliability.mtbfHours) }},
              {{ reliabilityReport.reliability.afrPercent.toFixed(2) }}% AFR.
            </span>
          </div>

          <div class="mt-4 overflow-x-auto">
            <table class="w-full border-collapse text-sm">
              <caption class="sr-only">
                Mean time to data loss for each vdev.
              </caption>
              <thead>
                <tr>
                  <th
                    scope="col"
                    class="border-b border-border px-2 py-1.5 text-left text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase"
                  >
                    vdev
                  </th>
                  <th
                    scope="col"
                    class="border-b border-border px-2 py-1.5 text-left text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase"
                  >
                    Tolerates
                  </th>
                  <th
                    scope="col"
                    class="border-b border-border px-2 py-1.5 text-left text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase"
                  >
                    Repair
                  </th>
                  <th
                    scope="col"
                    class="border-b border-border px-2 py-1.5 text-left text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase"
                  >
                    MTTDL
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(v, i) in reliabilityReport.reliability.vdevs" :key="v.id">
                  <td class="border-b border-border/60 px-2 py-2">
                    {{ i + 1 }}
                    <span class="text-xs text-muted-foreground">{{ LEVEL_LABEL[v.level] }}</span>
                  </td>
                  <td
                    class="border-b border-border/60 px-2 py-2 font-mono text-xs tabular-nums"
                    :title="`${v.disks} drives`"
                  >
                    {{ v.modelParity }}
                  </td>
                  <td class="border-b border-border/60 px-2 py-2 font-mono text-xs tabular-nums">
                    {{ hoursLabel(v.mttrHours) }}
                  </td>
                  <td class="border-b border-border/60 px-2 py-2 font-mono text-xs tabular-nums">
                    {{ formatMttdl(v.mttdlHours) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <p v-else class="mt-4 text-sm text-muted-foreground">
          Enter a drive MTBF or an annualized failure rate, plus a resilver time above zero, and the
          mean time to data loss appears here.
        </p>

        <!-- Reference figures, folded away until somebody needs a number. -->
        <div class="mt-4">
          <Button
            variant="ghost"
            size="sm"
            class="-ml-2.5 text-muted-foreground"
            :aria-expanded="referenceOpen"
            aria-controls="raidz-reference"
            @click="referenceOpen = !referenceOpen"
          >
            <ChevronRight
              class="size-4 transition-transform duration-150 motion-reduce:transition-none"
              :class="referenceOpen ? 'rotate-90' : ''"
            />
            Typical drive failure rates
          </Button>
          <div v-show="referenceOpen" id="raidz-reference" class="mt-2 overflow-x-auto">
            <table class="w-full border-collapse text-sm">
              <caption class="sr-only">
                Field measured failure rates and datasheet ratings by drive class.
              </caption>
              <thead>
                <tr>
                  <th
                    scope="col"
                    class="border-b border-border px-2 py-1.5 text-left text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase"
                  >
                    Drive class
                  </th>
                  <th
                    scope="col"
                    class="border-b border-border px-2 py-1.5 text-left text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase"
                  >
                    AFR
                  </th>
                  <th
                    scope="col"
                    class="border-b border-border px-2 py-1.5 text-left text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase"
                  >
                    Implied MTBF
                  </th>
                  <th
                    scope="col"
                    class="border-b border-border px-2 py-1.5 text-left text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase"
                  >
                    Datasheet
                  </th>
                  <th scope="col" class="border-b border-border px-2 py-1.5">
                    <span class="sr-only">Apply</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="reference in MTBF_REFERENCE" :key="reference.id">
                  <td class="border-b border-border/60 px-2 py-2">
                    <span class="font-medium">{{ reference.label }}</span>
                    <span class="mt-0.5 block text-xs text-muted-foreground">
                      {{ reference.note }}
                    </span>
                  </td>
                  <td class="border-b border-border/60 px-2 py-2 font-mono text-xs tabular-nums">
                    {{ reference.afrPercent.toFixed(2) }}%
                  </td>
                  <td class="border-b border-border/60 px-2 py-2 font-mono text-xs tabular-nums">
                    {{ hoursLabel(reference.mtbfHours) }}
                  </td>
                  <td class="border-b border-border/60 px-2 py-2 font-mono text-xs tabular-nums">
                    {{ reference.vendorMtbfHours ? hoursLabel(reference.vendorMtbfHours) : "n/a" }}
                  </td>
                  <td class="border-b border-border/60 px-2 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      :aria-label="`Use the ${reference.label} failure rate`"
                      @click="applyReference(reference)"
                    >
                      Use
                    </Button>
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="mt-2 text-xs text-muted-foreground">
              The AFR column is what large fleets measure and the datasheet column is the lab rating
              the vendor prints. They disagree by design.
            </p>
          </div>
        </div>

        <ul class="mt-4 flex list-disc flex-col gap-1 pl-4 text-xs text-muted-foreground">
          <li v-for="line in ASSUMPTIONS" :key="line">{{ line }}</li>
        </ul>
      </section>
    </div>

    <!-- --------------------------------------------------------- results -->
    <section
      class="rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
      aria-live="polite"
    >
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          {{ mixed ? "Result (mixed pool)" : "Result" }}
        </h3>
        <CopyButton v-if="summaryText" :text="summaryText" label="Copy all" />
      </div>
      <KeyValueGrid v-if="summary.record" :record="summary.record" columns="auto" />
      <p v-else class="text-sm text-muted-foreground">
        Fix the pool above and the full breakdown comes back.
      </p>
    </section>
  </div>
</template>

<style scoped>
/*
 * Health palette. The site tokens cover a positive and a destructive color but
 * have no caution color, so the three pool states are named once here, in both
 * themes, and every chip, drive square, and stripe reads them. The light and
 * dark values are the ones the approved mockup used.
 *
 * The "ink" and "soft" pairs exist so text placed on a solid state color stays
 * legible after the theme flips the state color from dark to light.
 */
.raidz-panel {
  --raidz-ok: var(--positive);
  --raidz-ok-soft: var(--positive-soft);
  --raidz-warn: #b8781a;
  --raidz-warn-soft: #fbefd9;
  --raidz-bad: #c9342b;
  --raidz-bad-soft: #fbe5e3;
  --raidz-bad-ink: #ffffff;
}

html.dark .raidz-panel {
  --raidz-warn: #e2a945;
  --raidz-warn-soft: #2d2415;
  --raidz-bad: #ef6b63;
  --raidz-bad-soft: #321b19;
  --raidz-bad-ink: #1b1917;
}
</style>

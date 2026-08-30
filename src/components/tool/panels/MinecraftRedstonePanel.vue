<script setup lang="ts">
/**
 * Bespoke panel for the Minecraft redstone timing calculator: a four mode
 * workbench.
 *
 * Every mode is the same split: a controls pane on the left, results on the
 * right as stat tiles plus a table or an SVG timing diagram. Mode one
 * converts ticks and builds delay lines and clocks, mode two compares item
 * transport throughput, mode three is the comparator container-fullness
 * table in both directions, and mode four is the per-version component
 * reference behind a searchable grouped picker. All arithmetic lives in the
 * pure logic layer (src/tools/minecraft-redstone-timing-calculator); this
 * file owns DOM, layout, and the URL fragment round trip only.
 */
import { computed, onMounted, ref, watch } from "vue";
import { ToolError, type SelectOptionSpec, type SelectGroup, type ToolMeta } from "@/tools/types";
import {
  buildClock,
  buildDelay,
  comparatorSignal,
  componentReference,
  containerFullnessTable,
  convertTime,
  fillTime,
  formatDuration,
  throughput,
  TIME_UNITS,
  type ClockKind,
  type TimeUnit,
} from "@/tools/minecraft-redstone-timing-calculator/index";
import {
  componentsForVersion,
  containersForVersion,
  REDSTONE_VERSIONS,
  TICKS_PER_SECOND,
  transportsForVersion,
  VERSION_CHANGES,
  type VersionId,
} from "@/tools/minecraft-redstone-timing-calculator/data";
import { readFragment, writeFragment } from "@/lib/fragment";
import { downloadText } from "@/lib/download";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Segmented } from "@/components/ui/segmented";
import type { SegmentedOption } from "@/components/ui/segmented";
import OutputView from "../OutputView.vue";
import ErrorBanner from "../ErrorBanner.vue";

defineProps<{ meta: ToolMeta }>();

type TabId = "timing" | "throughput" | "signal" | "reference";

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const version = ref<VersionId>("1.21.11");
const tps = ref(TICKS_PER_SECOND);
const tab = ref<TabId>("timing");

// timing tab
const convValue = ref(8);
const convUnit = ref<TimeUnit>("gameTicks");
const delayTarget = ref(10);
const clockKind = ref<ClockKind>("repeater-loop");
const clockTarget = ref(40);
/** False builds a delay line, true builds a clock. Same pane either way. */
const clockShown = ref(false);

const BUILDER_OPTIONS: SegmentedOption[] = [
  { value: "delay", label: "Delay line" },
  { value: "clock", label: "Clock" },
];

// throughput tab
const transport = ref("hopper");
const lines = ref(1);
const chainLength = ref(4);
const clockPeriod = ref(4);
const stackSize = ref(64);
const container = ref("double_chest");

// signal tab
const signalContainer = ref("double_chest");
const signalStackSize = ref(64);
const itemCount = ref(1482);
const targetSignal = ref(7);

// reference tab
const componentId = ref("repeater");

const mounted = ref(false);

/* ---------------------------------------------------------------- */
/* helpers                                                           */
/* ---------------------------------------------------------------- */

function fmt(n: number, digits = 0): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, lo), hi);
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  return Math.round(clampNum(v, lo, hi, fallback));
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

/* ---------------------------------------------------------------- */
/* select specs                                                      */
/* ---------------------------------------------------------------- */

const versionSpec: SelectOptionSpec = {
  kind: "select",
  id: "version",
  label: "Game version",
  default: "1.21.11",
  options: [...REDSTONE_VERSIONS].reverse().map((v) => ({
    value: v,
    label: v === REDSTONE_VERSIONS[REDSTONE_VERSIONS.length - 1] ? `${v} (latest)` : v,
    synonyms: [v.replace(/\./g, " ")],
  })),
};

const unitSpec: SelectOptionSpec = {
  kind: "select",
  id: "unit",
  label: "Unit",
  default: "gameTicks",
  options: [
    { value: "gameTicks", label: "Game ticks", synonyms: ["tick", "gt", "20 per second"] },
    { value: "redstoneTicks", label: "Redstone ticks", synonyms: ["rt", "2 game ticks"] },
    { value: "milliseconds", label: "Milliseconds", synonyms: ["ms", "50 per tick"] },
    { value: "seconds", label: "Seconds", synonyms: ["s", "sec"] },
    { value: "minutes", label: "Minutes", synonyms: ["min"] },
    { value: "hours", label: "Hours", synonyms: ["hr", "h"] },
  ],
};

const clockKindSpec: SelectOptionSpec = {
  kind: "select",
  id: "clockKind",
  label: "Clock type",
  default: "repeater-loop",
  options: [
    {
      value: "repeater-loop",
      label: "Repeater loop clock",
      synonyms: ["torch clock", "loop", "fast clock", "short period"],
    },
    {
      value: "item-clock",
      label: "Two hopper item clock",
      synonyms: ["hopper clock", "long period", "slow clock", "minutes"],
    },
  ],
};

const transportSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "transport",
  label: "Transport",
  default: "hopper",
  options: transportsForVersion(version.value).map((t) => ({
    value: t.id,
    label: t.label,
    synonyms: t.synonyms,
  })),
}));

function containerSpec(id: string): SelectOptionSpec {
  return {
    kind: "select",
    id,
    label: "Container",
    default: "double_chest",
    options: containersForVersion(version.value).map((c) => ({
      value: c.id,
      label: `${c.label} (${c.slots} slots)`,
      synonyms: c.synonyms,
    })),
  };
}

const fillContainerSpec = computed(() => containerSpec("container"));
const signalContainerSpec = computed(() => containerSpec("signalContainer"));

const stackSizeSpec: SelectOptionSpec = {
  kind: "select",
  id: "stackSize",
  label: "Item stack size",
  default: "64",
  options: [
    {
      value: "64",
      label: "Stacks to 64 (most items)",
      synonyms: ["64", "normal", "blocks", "ore"],
    },
    {
      value: "16",
      label: "Stacks to 16 (eggs, snowballs, signs)",
      synonyms: ["16", "egg", "snowball", "sign", "ender pearl"],
    },
    {
      value: "1",
      label: "Does not stack (tools, armor, potions)",
      synonyms: ["1", "unstackable", "tool", "armor", "potion", "bucket"],
    },
  ],
};

/** The component picker, grouped by category so search matches the group too. */
const componentSpec = computed<SelectOptionSpec>(() => {
  const list = componentsForVersion(version.value);
  const groupNames = [...new Set(list.map((c) => c.group))];
  const groups: SelectGroup[] = groupNames.map((g) => ({
    label: g,
    synonyms: [g.toLowerCase()],
    options: list
      .filter((c) => c.group === g)
      .map((c) => ({ value: c.id, label: c.label, synonyms: c.synonyms })),
  }));
  return { kind: "select", id: "component", label: "Component", default: "repeater", groups };
});

/* ---------------------------------------------------------------- */
/* timing tab                                                        */
/* ---------------------------------------------------------------- */

const conversion = computed(() => {
  try {
    return { value: convertTime(convValue.value, convUnit.value, tps.value), error: null };
  } catch (e) {
    return { value: null, error: toCalcError(e) };
  }
});

const conversionRows = computed<Record<string, string>>(() => {
  const c = conversion.value.value;
  if (!c) return {};
  const rows: Record<string, string> = {
    "Game ticks": fmt(c.gameTicks, 4),
    "Redstone ticks":
      c.wholeRedstoneTicks === null
        ? `${fmt(c.redstoneTicks, 4)} (not a whole redstone tick)`
        : fmt(c.wholeRedstoneTicks, 4),
    "Seconds at 20 ticks per second": c.formattedNominal,
  };
  if (c.tps !== TICKS_PER_SECOND) {
    rows[`Real time at ${fmt(c.tps, 2)} ticks per second`] =
      `${c.formattedReal} (${fmt(c.lagFactor, 3)} times longer)`;
  }
  return rows;
});

const delaySolution = computed(() => {
  try {
    return { value: buildDelay(delayTarget.value), error: null };
  } catch (e) {
    return { value: null, error: toCalcError(e) };
  }
});

const clockSolution = computed(() => {
  try {
    return { value: buildClock(clockTarget.value, clockKind.value, version.value), error: null };
  } catch (e) {
    return { value: null, error: toCalcError(e) };
  }
});

/** The clock actually drawn and described: the exact plan, else the closest. */
const shownClock = computed(() => {
  const s = clockSolution.value.value;
  if (!s) return null;
  return s.exact ?? s.above ?? s.below;
});

const shownDelay = computed(() => {
  const s = delaySolution.value.value;
  if (!s) return null;
  return s.exact ?? s.above ?? s.below;
});

/* ---------------------------------------------------------------- */
/* SVG timing diagram                                                */
/* ---------------------------------------------------------------- */

const DIAG_H = 132;
const DIAG_PAD = { left: 74, right: 16, top: 14, bottom: 26 };
const ROW_H = 34;

interface Trace {
  label: string;
  y: number;
  path: string;
}

interface Diagram {
  width: number;
  traces: Trace[];
  xTicks: { x: number; label: string }[];
  windowTicks: number;
  caption: string;
}

/** A square wave as an SVG path from a list of high/low runs. */
function wavePath(
  runs: { ticks: number; high: boolean }[],
  scale: number,
  yTop: number,
  yBottom: number,
): string {
  let x = DIAG_PAD.left;
  let y = runs[0]?.high ? yTop : yBottom;
  const parts = [`M ${x.toFixed(1)} ${y.toFixed(1)}`];
  for (const run of runs) {
    const nextY = run.high ? yTop : yBottom;
    if (nextY !== y) {
      parts.push(`L ${x.toFixed(1)} ${nextY.toFixed(1)}`);
      y = nextY;
    }
    x += run.ticks * scale;
    parts.push(`L ${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return parts.join(" ");
}

function xAxis(windowTicks: number, scale: number): { x: number; label: string }[] {
  const stepChoices = [1, 2, 4, 5, 10, 20, 40, 50, 100, 200, 400, 1000, 2000, 4000];
  const step = stepChoices.find((s) => windowTicks / s <= 10) ?? 8000;
  const ticks: { x: number; label: string }[] = [];
  for (let t = 0; t <= windowTicks; t += step) {
    ticks.push({ x: DIAG_PAD.left + t * scale, label: String(t) });
  }
  return ticks;
}

const diagram = computed<Diagram | null>(() => {
  const innerW = 460;
  if (tab.value !== "timing") return null;

  if (clockShown.value) {
    const plan = shownClock.value;
    if (!plan) return null;
    const windowTicks = plan.periodGameTicks * 2.5;
    const scale = innerW / windowTicks;
    const runs: { ticks: number; high: boolean }[] = [];
    for (let i = 0; i < 3; i += 1) {
      runs.push({ ticks: plan.onGameTicks, high: true });
      runs.push({ ticks: plan.offGameTicks, high: false });
    }
    const y = DIAG_PAD.top + ROW_H;
    return {
      width: innerW + DIAG_PAD.left + DIAG_PAD.right,
      traces: [{ label: "Clock", y, path: wavePath(runs, scale, DIAG_PAD.top + 6, y) }],
      xTicks: xAxis(windowTicks, scale),
      windowTicks,
      caption: `On for ${plan.onGameTicks} game ticks, off for ${plan.offGameTicks}, repeating every ${plan.periodGameTicks}.`,
    };
  }

  const line = shownDelay.value;
  if (!line) return null;
  const pulse = 4;
  const windowTicks = Math.max(12, line.gameTicks + pulse * 3);
  const scale = innerW / windowTicks;
  const yIn = DIAG_PAD.top + ROW_H;
  const yOut = DIAG_PAD.top + ROW_H * 2;
  const inRuns = [
    { ticks: 2, high: false },
    { ticks: pulse, high: true },
    { ticks: Math.max(0, windowTicks - 2 - pulse), high: false },
  ];
  const outRuns = [
    { ticks: 2 + line.gameTicks, high: false },
    { ticks: pulse, high: true },
    { ticks: Math.max(0, windowTicks - 2 - line.gameTicks - pulse), high: false },
  ];
  return {
    width: innerW + DIAG_PAD.left + DIAG_PAD.right,
    traces: [
      { label: "Input", y: yIn, path: wavePath(inRuns, scale, DIAG_PAD.top + 6, yIn) },
      { label: "Output", y: yOut, path: wavePath(outRuns, scale, yIn + 10, yOut) },
    ],
    xTicks: xAxis(windowTicks, scale),
    windowTicks,
    caption: `The output copies the input ${line.gameTicks} game ticks later. The pulse itself keeps its length; only its start moves.`,
  };
});

/* ---------------------------------------------------------------- */
/* throughput tab                                                    */
/* ---------------------------------------------------------------- */

const transportDef = computed(() =>
  transportsForVersion(version.value).find((t) => t.id === transport.value),
);

const throughputResult = computed(() => {
  try {
    const rate = throughput(transport.value, {
      version: version.value,
      lines: lines.value,
      chainLength: chainLength.value,
      stackSize: stackSize.value,
      clockPeriod: transportDef.value?.clockDriven ? clockPeriod.value : undefined,
      tps: tps.value,
    });
    const fill = fillTime(container.value, transport.value, {
      version: version.value,
      lines: lines.value,
      stackSize: stackSize.value,
      clockPeriod: transportDef.value?.clockDriven ? clockPeriod.value : undefined,
      tps: tps.value,
    });
    return { rate, fill, error: null };
  } catch (e) {
    return { rate: null, fill: null, error: toCalcError(e) };
  }
});

const transportComparison = computed(() =>
  transportsForVersion(version.value).map((t) => {
    const r = throughput(t.id, {
      version: version.value,
      stackSize: stackSize.value,
      clockPeriod: t.clockDriven ? Math.max(clockPeriod.value, t.minClockPeriod ?? 4) : undefined,
      tps: tps.value,
    });
    return {
      id: t.id,
      label: t.label,
      perSecond: fmt(r.itemsPerSecond, 2),
      perHour: fmt(r.itemsPerHour, 0),
      stacksPerHour: fmt(r.stacksPerHour, 1),
      selected: t.id === transport.value,
    };
  }),
);

/* ---------------------------------------------------------------- */
/* comparator signal tab                                             */
/* ---------------------------------------------------------------- */

const signalTable = computed(() => {
  try {
    return {
      value: containerFullnessTable(signalContainer.value, signalStackSize.value, version.value),
      error: null,
    };
  } catch (e) {
    return { value: null, error: toCalcError(e) };
  }
});

const currentSignal = computed(() => {
  const table = signalTable.value.value;
  if (!table) return null;
  try {
    return comparatorSignal(
      Math.min(itemCount.value, table.capacity),
      table.slots,
      table.stackSize,
    );
  } catch {
    return null;
  }
});

const targetBand = computed(() => {
  const table = signalTable.value.value;
  if (!table) return null;
  return table.bands[targetSignal.value] ?? null;
});

function useTargetItems() {
  const band = targetBand.value;
  if (band && band.minItems !== null) itemCount.value = band.minItems;
}

function downloadSignalTable() {
  const table = signalTable.value.value;
  if (!table) return;
  const header = "signal,min_items,max_items,slots,stack_size\n";
  const body = table.bands
    .filter((b) => b.minItems !== null)
    .map((b) => `${b.signal},${b.minItems},${b.maxItems},${table.slots},${table.stackSize}`)
    .join("\n");
  downloadText(
    `${header}${body}\n`,
    `comparator-signal-${table.slots}-slots-stack-${table.stackSize}.csv`,
    "text/csv",
  );
}

/* ---------------------------------------------------------------- */
/* reference tab                                                     */
/* ---------------------------------------------------------------- */

const referenceRows = computed(() => {
  try {
    return { value: componentReference(version.value), error: null };
  } catch (e) {
    return { value: null, error: toCalcError(e) };
  }
});

const selectedComponent = computed(
  () => referenceRows.value.value?.find((r) => r.id === componentId.value) ?? null,
);

/* ---------------------------------------------------------------- */
/* version guards                                                    */
/* ---------------------------------------------------------------- */

watch(version, (v) => {
  if (!transportsForVersion(v).some((t) => t.id === transport.value)) transport.value = "hopper";
  if (!containersForVersion(v).some((c) => c.id === container.value))
    container.value = "double_chest";
  if (!containersForVersion(v).some((c) => c.id === signalContainer.value)) {
    signalContainer.value = "double_chest";
  }
  if (!componentsForVersion(v).some((c) => c.id === componentId.value))
    componentId.value = "repeater";
});

/* ---------------------------------------------------------------- */
/* URL fragment: shareable state (rule 6, never localStorage)        */
/* ---------------------------------------------------------------- */

watch(
  [
    version,
    tps,
    tab,
    convValue,
    convUnit,
    delayTarget,
    clockKind,
    clockTarget,
    clockShown,
    transport,
    lines,
    chainLength,
    clockPeriod,
    stackSize,
    container,
    signalContainer,
    signalStackSize,
    itemCount,
    targetSignal,
    componentId,
  ],
  () => {
    if (!mounted.value) return;
    writeFragment({
      opts: {
        v: version.value,
        tps: String(tps.value),
        tab: tab.value,
        cv: String(convValue.value),
        cu: convUnit.value,
        dt: String(delayTarget.value),
        ck: clockKind.value,
        cp: String(clockTarget.value),
        cs: String(clockShown.value),
        tr: transport.value,
        ln: String(lines.value),
        cl: String(chainLength.value),
        clk: String(clockPeriod.value),
        ss: String(stackSize.value),
        ct: container.value,
        sc: signalContainer.value,
        sst: String(signalStackSize.value),
        it: String(itemCount.value),
        sg: String(targetSignal.value),
        cmp: componentId.value,
      },
    });
  },
);

onMounted(() => {
  const { opts } = readFragment();
  if (opts.v && (REDSTONE_VERSIONS as readonly string[]).includes(opts.v)) {
    version.value = opts.v as VersionId;
  }
  if (opts.tps) tps.value = clampNum(opts.tps, 0.1, 20, TICKS_PER_SECOND);
  if (opts.tab && ["timing", "throughput", "signal", "reference"].includes(opts.tab)) {
    tab.value = opts.tab as TabId;
  }
  if (opts.cv) convValue.value = clampNum(opts.cv, 0, 1e9, 8);
  if (opts.cu && (TIME_UNITS as readonly string[]).includes(opts.cu)) {
    convUnit.value = opts.cu as TimeUnit;
  }
  if (opts.dt) delayTarget.value = clampInt(opts.dt, 0, 12000, 10);
  if (opts.ck === "repeater-loop" || opts.ck === "item-clock") clockKind.value = opts.ck;
  if (opts.cp) clockTarget.value = clampInt(opts.cp, 1, 144000, 40);
  if (opts.cs) clockShown.value = opts.cs === "true";
  if (opts.tr && transportsForVersion(version.value).some((t) => t.id === opts.tr)) {
    transport.value = opts.tr;
  }
  if (opts.ln) lines.value = clampInt(opts.ln, 1, 1000, 1);
  if (opts.cl) chainLength.value = clampInt(opts.cl, 1, 200, 4);
  if (opts.clk) clockPeriod.value = clampInt(opts.clk, 4, 12000, 4);
  if (opts.ss) stackSize.value = clampInt(opts.ss, 1, 64, 64);
  if (opts.ct && containersForVersion(version.value).some((c) => c.id === opts.ct)) {
    container.value = opts.ct;
  }
  if (opts.sc && containersForVersion(version.value).some((c) => c.id === opts.sc)) {
    signalContainer.value = opts.sc;
  }
  if (opts.sst) signalStackSize.value = clampInt(opts.sst, 1, 64, 64);
  if (opts.it) itemCount.value = clampInt(opts.it, 0, 100000, 1482);
  if (opts.sg) targetSignal.value = clampInt(opts.sg, 0, 15, 7);
  if (opts.cmp && componentsForVersion(version.value).some((c) => c.id === opts.cmp)) {
    componentId.value = opts.cmp;
  }
  mounted.value = true;
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- header: version and server tick rate -->
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div class="flex min-w-0 flex-col gap-1">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Redstone workbench
        </span>
        <p class="max-w-[64ch] text-xs text-muted-foreground">
          Tick counts never change with server load. The tick rate below only changes how long those
          ticks take in real time.
        </p>
      </div>
      <div class="flex flex-wrap items-end gap-3">
        <div class="flex w-44 flex-col gap-1.5">
          <Label for="rs-version" class="text-xs text-muted-foreground">Game version</Label>
          <SearchableSelect
            id="rs-version"
            :spec="versionSpec"
            :model-value="version"
            @update:model-value="(v: string) => (version = v as VersionId)"
          />
        </div>
        <div class="flex w-36 flex-col gap-1.5">
          <Label for="rs-tps" class="text-xs text-muted-foreground">Server ticks per second</Label>
          <Input
            id="rs-tps"
            type="number"
            min="0.1"
            max="20"
            step="0.1"
            :model-value="tps"
            @update:model-value="(v) => (tps = clampNum(v, 0.1, 20, 20))"
          />
        </div>
      </div>
    </div>

    <Tabs v-model="tab" class="w-full">
      <TabsList class="flex w-full flex-wrap">
        <TabsTrigger value="timing">Ticks, delays and clocks</TabsTrigger>
        <TabsTrigger value="throughput">Item throughput</TabsTrigger>
        <TabsTrigger value="signal">Comparator signal</TabsTrigger>
        <TabsTrigger value="reference">Component reference</TabsTrigger>
      </TabsList>

      <!-- ====================== timing ====================== -->
      <TabsContent value="timing" class="pt-4">
        <div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <!-- controls -->
          <div class="flex flex-col gap-4 rounded-[14px] bg-secondary p-3 shadow-[var(--sh-inset)]">
            <div class="flex flex-col gap-2">
              <p class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                Convert a duration
              </p>
              <div class="flex flex-wrap items-end gap-2">
                <div class="flex w-28 flex-col gap-1.5">
                  <Label for="rs-conv-value" class="text-xs text-muted-foreground">Amount</Label>
                  <Input
                    id="rs-conv-value"
                    type="number"
                    min="0"
                    step="any"
                    :model-value="convValue"
                    @update:model-value="(v) => (convValue = clampNum(v, 0, 1e9, 8))"
                  />
                </div>
                <div class="flex min-w-40 flex-1 flex-col gap-1.5">
                  <Label for="rs-conv-unit" class="text-xs text-muted-foreground">Unit</Label>
                  <SearchableSelect
                    id="rs-conv-unit"
                    :spec="unitSpec"
                    :model-value="convUnit"
                    @update:model-value="(v: string) => (convUnit = v as TimeUnit)"
                  />
                </div>
              </div>
            </div>

            <div class="flex flex-col gap-2 border-t border-border pt-3">
              <div class="flex items-center justify-between gap-2">
                <p class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  Build a
                </p>
                <Segmented
                  :model-value="clockShown ? 'clock' : 'delay'"
                  :options="BUILDER_OPTIONS"
                  label="Builder mode"
                  size="sm"
                  @update:model-value="(v: string) => (clockShown = v === 'clock')"
                />
              </div>

              <template v-if="!clockShown">
                <div class="flex w-40 flex-col gap-1.5">
                  <Label for="rs-delay" class="text-xs text-muted-foreground">
                    Target delay (game ticks)
                  </Label>
                  <Input
                    id="rs-delay"
                    type="number"
                    min="0"
                    max="12000"
                    step="1"
                    :model-value="delayTarget"
                    @update:model-value="(v) => (delayTarget = clampInt(v, 0, 12000, 10))"
                  />
                </div>
              </template>
              <template v-else>
                <div class="flex flex-wrap items-end gap-2">
                  <div class="flex w-40 flex-col gap-1.5">
                    <Label for="rs-clock-period" class="text-xs text-muted-foreground">
                      Target period (game ticks)
                    </Label>
                    <Input
                      id="rs-clock-period"
                      type="number"
                      min="1"
                      max="144000"
                      step="1"
                      :model-value="clockTarget"
                      @update:model-value="(v) => (clockTarget = clampInt(v, 1, 144000, 40))"
                    />
                  </div>
                  <div class="flex min-w-44 flex-1 flex-col gap-1.5">
                    <Label for="rs-clock-kind" class="text-xs text-muted-foreground">
                      Clock type
                    </Label>
                    <SearchableSelect
                      id="rs-clock-kind"
                      :spec="clockKindSpec"
                      :model-value="clockKind"
                      @update:model-value="(v: string) => (clockKind = v as ClockKind)"
                    />
                  </div>
                </div>
              </template>
            </div>
          </div>

          <!-- results -->
          <div class="flex flex-col gap-3">
            <ErrorBanner
              v-if="conversion.error"
              :message="conversion.error.message"
              :hint="conversion.error.fix"
            />
            <div v-else aria-live="polite">
              <OutputView :output="conversionRows" />
            </div>

            <!-- stat tiles -->
            <div
              v-if="!clockShown && delaySolution.value"
              class="grid grid-cols-2 gap-3 sm:grid-cols-4"
            >
              <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                <div class="text-xs text-muted-foreground">Achievable delay</div>
                <div
                  class="font-mono text-lg tabular-nums"
                  :class="delaySolution.value.exact ? '' : 'text-destructive'"
                >
                  {{ shownDelay ? shownDelay.gameTicks : "n/a" }}
                </div>
              </div>
              <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                <div class="text-xs text-muted-foreground">Repeaters</div>
                <div class="font-mono text-lg tabular-nums">
                  {{ shownDelay ? shownDelay.componentCount : 0 }}
                </div>
              </div>
              <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                <div class="text-xs text-muted-foreground">Redstone ticks</div>
                <div class="font-mono text-lg tabular-nums">
                  {{ shownDelay ? shownDelay.redstoneTicks : 0 }}
                </div>
              </div>
              <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                <div class="text-xs text-muted-foreground">Real time</div>
                <div class="font-mono text-lg tabular-nums">
                  {{ shownDelay ? formatDuration(shownDelay.gameTicks / tps) : "0 s" }}
                </div>
              </div>
            </div>

            <div
              v-if="clockShown && clockSolution.value"
              class="grid grid-cols-2 gap-3 sm:grid-cols-4"
            >
              <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                <div class="text-xs text-muted-foreground">Period</div>
                <div
                  class="font-mono text-lg tabular-nums"
                  :class="clockSolution.value.exact ? '' : 'text-destructive'"
                >
                  {{ shownClock ? shownClock.periodGameTicks : "n/a" }}
                </div>
              </div>
              <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                <div class="text-xs text-muted-foreground">Pulses per minute</div>
                <div class="font-mono text-lg tabular-nums">
                  {{ shownClock ? fmt(shownClock.pulsesPerMinute, 2) : 0 }}
                </div>
              </div>
              <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                <div class="text-xs text-muted-foreground">
                  {{ clockKind === "item-clock" ? "Items in the loop" : "Loop repeaters" }}
                </div>
                <div class="font-mono text-lg tabular-nums">
                  {{
                    shownClock
                      ? clockKind === "item-clock"
                        ? shownClock.items
                        : (shownClock.line?.componentCount ?? 0)
                      : 0
                  }}
                </div>
              </div>
              <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                <div class="text-xs text-muted-foreground">Real period</div>
                <div class="font-mono text-lg tabular-nums">
                  {{ shownClock ? formatDuration(shownClock.periodGameTicks / tps) : "0 s" }}
                </div>
              </div>
            </div>

            <!-- timing diagram -->
            <div
              v-if="diagram"
              class="overflow-x-auto rounded-[10px] bg-secondary p-2 shadow-[var(--sh-inset)]"
            >
              <svg
                :width="diagram.width"
                :height="DIAG_H"
                :viewBox="`0 0 ${diagram.width} ${DIAG_H}`"
                role="img"
                :aria-label="diagram.caption"
                class="block text-primary"
              >
                <title>Timing diagram</title>
                <g class="text-border" stroke="currentColor" stroke-width="1">
                  <line
                    v-for="t in diagram.xTicks"
                    :key="`g${t.x}`"
                    :x1="t.x"
                    :x2="t.x"
                    :y1="DIAG_PAD.top"
                    :y2="DIAG_H - DIAG_PAD.bottom"
                    opacity="0.5"
                  />
                </g>
                <g class="text-muted-foreground" fill="currentColor" font-size="11">
                  <text
                    v-for="t in diagram.xTicks"
                    :key="`x${t.x}`"
                    :x="t.x"
                    :y="DIAG_H - 8"
                    text-anchor="middle"
                  >
                    {{ t.label }}
                  </text>
                  <text
                    v-for="tr in diagram.traces"
                    :key="`l${tr.label}`"
                    :x="DIAG_PAD.left - 8"
                    :y="tr.y - 4"
                    text-anchor="end"
                  >
                    {{ tr.label }}
                  </text>
                  <text :x="DIAG_PAD.left" :y="DIAG_H - 8" text-anchor="start" opacity="0">0</text>
                </g>
                <g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
                  <path v-for="tr in diagram.traces" :key="`p${tr.label}`" :d="tr.path" />
                </g>
              </svg>
              <p class="px-1 pt-1 text-xs text-muted-foreground">
                Game ticks along the bottom. {{ diagram.caption }}
              </p>
            </div>

            <!-- plan detail -->
            <ErrorBanner
              v-if="!clockShown && delaySolution.error"
              :message="delaySolution.error.message"
              :hint="delaySolution.error.fix"
            />
            <div
              v-else-if="!clockShown && delaySolution.value"
              class="flex flex-col gap-2 rounded-[14px] bg-secondary p-3 shadow-[var(--sh-inset)]"
              aria-live="polite"
            >
              <p class="text-sm">{{ delaySolution.value.note }}</p>
              <ul v-if="shownDelay && shownDelay.parts.length" class="flex flex-col gap-1 text-sm">
                <li v-for="p in shownDelay.parts" :key="p.setting" class="font-mono tabular-nums">
                  {{ p.count }} repeater{{ p.count === 1 ? "" : "s" }} on setting
                  {{ p.setting }} ({{ p.delayTicks }} game ticks each)
                </li>
              </ul>
              <p
                v-if="shownDelay && shownDelay.componentCount > 0"
                class="text-xs text-muted-foreground"
              >
                The same delay in comparators alone would take {{ shownDelay.comparatorOnlyCount }}
                of them, since a comparator is fixed at 1 redstone tick.
              </p>
              <p v-if="delaySolution.value.exact === null" class="text-xs text-muted-foreground">
                Closest achievable delays: {{ delaySolution.value.below?.gameTicks ?? "none" }} and
                {{ delaySolution.value.above?.gameTicks ?? "none" }} game ticks.
              </p>
            </div>

            <ErrorBanner
              v-if="clockShown && clockSolution.error"
              :message="clockSolution.error.message"
              :hint="clockSolution.error.fix"
            />
            <div
              v-else-if="clockShown && shownClock"
              class="flex flex-col gap-2 rounded-[14px] bg-secondary p-3 shadow-[var(--sh-inset)]"
              aria-live="polite"
            >
              <p class="text-sm font-semibold">{{ shownClock.label }}</p>
              <p class="text-sm">{{ shownClock.recipe }}</p>
              <p class="text-xs text-muted-foreground">{{ shownClock.note }}</p>
              <p class="text-xs text-muted-foreground">{{ clockSolution.value?.note }}</p>
            </div>
          </div>
        </div>
      </TabsContent>

      <!-- ====================== throughput ====================== -->
      <TabsContent value="throughput" class="pt-4">
        <div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div class="flex flex-col gap-3 rounded-[14px] bg-secondary p-3 shadow-[var(--sh-inset)]">
            <div class="flex flex-col gap-1.5">
              <Label for="rs-transport" class="text-xs text-muted-foreground">Transport</Label>
              <SearchableSelect
                id="rs-transport"
                :spec="transportSpec"
                :model-value="transport"
                @update:model-value="(v: string) => (transport = v)"
              />
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div class="flex flex-col gap-1.5">
                <Label for="rs-lines" class="text-xs text-muted-foreground">Parallel lines</Label>
                <Input
                  id="rs-lines"
                  type="number"
                  min="1"
                  max="1000"
                  step="1"
                  :model-value="lines"
                  @update:model-value="(v) => (lines = clampInt(v, 1, 1000, 1))"
                />
              </div>
              <div v-if="transportDef?.chainable" class="flex flex-col gap-1.5">
                <Label for="rs-chain" class="text-xs text-muted-foreground">Units in series</Label>
                <Input
                  id="rs-chain"
                  type="number"
                  min="1"
                  max="200"
                  step="1"
                  :model-value="chainLength"
                  @update:model-value="(v) => (chainLength = clampInt(v, 1, 200, 4))"
                />
              </div>
              <div v-if="transportDef?.clockDriven" class="flex flex-col gap-1.5">
                <Label for="rs-clockp" class="text-xs text-muted-foreground">
                  Clock period (game ticks)
                </Label>
                <Input
                  id="rs-clockp"
                  type="number"
                  :min="transportDef?.minClockPeriod ?? 4"
                  max="12000"
                  step="1"
                  :model-value="clockPeriod"
                  @update:model-value="
                    (v) => (clockPeriod = clampInt(v, transportDef?.minClockPeriod ?? 4, 12000, 4))
                  "
                />
              </div>
            </div>
            <div class="flex flex-col gap-1.5">
              <Label for="rs-stack" class="text-xs text-muted-foreground">Item stack size</Label>
              <SearchableSelect
                id="rs-stack"
                :spec="stackSizeSpec"
                :model-value="String(stackSize)"
                @update:model-value="(v: string) => (stackSize = Number(v))"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label for="rs-container" class="text-xs text-muted-foreground">
                Container to fill or empty
              </Label>
              <SearchableSelect
                id="rs-container"
                :spec="fillContainerSpec"
                :model-value="container"
                @update:model-value="(v: string) => (container = v)"
              />
            </div>
            <p v-if="transportDef" class="text-xs text-muted-foreground">
              {{ transportDef.note }}
            </p>
          </div>

          <div class="flex flex-col gap-3">
            <ErrorBanner
              v-if="throughputResult.error"
              :message="throughputResult.error.message"
              :hint="throughputResult.error.fix"
            />
            <template v-else-if="throughputResult.rate && throughputResult.fill">
              <div class="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-live="polite">
                <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  <div class="text-xs text-muted-foreground">Items per second</div>
                  <div class="font-mono text-lg tabular-nums">
                    {{ fmt(throughputResult.rate.itemsPerSecond, 2) }}
                  </div>
                </div>
                <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  <div class="text-xs text-muted-foreground">Items per hour</div>
                  <div class="font-mono text-lg tabular-nums">
                    {{ fmt(throughputResult.rate.itemsPerHour, 0) }}
                  </div>
                </div>
                <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  <div class="text-xs text-muted-foreground">Stacks per hour</div>
                  <div class="font-mono text-lg tabular-nums">
                    {{ fmt(throughputResult.rate.stacksPerHour, 1) }}
                  </div>
                </div>
                <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  <div class="text-xs text-muted-foreground">Startup latency</div>
                  <div class="font-mono text-lg tabular-nums">
                    {{ throughputResult.rate.startupTicks }} gt
                  </div>
                </div>
              </div>

              <div class="rounded-[14px] bg-secondary p-3 shadow-[var(--sh-inset)]">
                <p class="text-sm">
                  Filling or emptying a
                  <span class="font-semibold">{{ throughputResult.fill.containerLabel }}</span>
                  ({{ fmt(throughputResult.fill.capacity) }} items across
                  {{ throughputResult.fill.slots }} slots) takes
                  <span class="font-mono tabular-nums">{{ throughputResult.fill.formatted }}</span>
                  , which is
                  <span class="font-mono tabular-nums">
                    {{ fmt(throughputResult.fill.gameTicks, 0) }}
                  </span>
                  game ticks.
                </p>
              </div>

              <div class="overflow-auto rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]">
                <table class="w-full min-w-[520px] text-sm">
                  <caption class="sr-only">
                    Every item transport compared at the current stack size and tick rate
                  </caption>
                  <thead>
                    <tr class="text-left text-xs font-semibold text-muted-foreground">
                      <th scope="col" class="px-3 py-1.5">Transport</th>
                      <th scope="col" class="px-3 py-1.5">Items per second</th>
                      <th scope="col" class="px-3 py-1.5">Items per hour</th>
                      <th scope="col" class="px-3 py-1.5">Stacks per hour</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="row in transportComparison"
                      :key="row.id"
                      :class="row.selected ? 'font-semibold text-primary' : ''"
                    >
                      <td class="px-3 py-1.5">{{ row.label }}</td>
                      <td class="px-3 py-1.5 font-mono tabular-nums">{{ row.perSecond }}</td>
                      <td class="px-3 py-1.5 font-mono tabular-nums">{{ row.perHour }}</td>
                      <td class="px-3 py-1.5 font-mono tabular-nums">{{ row.stacksPerHour }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </template>
          </div>
        </div>
      </TabsContent>

      <!-- ====================== comparator signal ====================== -->
      <TabsContent value="signal" class="pt-4">
        <div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div class="flex flex-col gap-3 rounded-[14px] bg-secondary p-3 shadow-[var(--sh-inset)]">
            <div class="flex flex-col gap-1.5">
              <Label for="rs-sig-container" class="text-xs text-muted-foreground">Container</Label>
              <SearchableSelect
                id="rs-sig-container"
                :spec="signalContainerSpec"
                :model-value="signalContainer"
                @update:model-value="(v: string) => (signalContainer = v)"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label for="rs-sig-stack" class="text-xs text-muted-foreground"
                >Item stack size</Label
              >
              <SearchableSelect
                id="rs-sig-stack"
                :spec="stackSizeSpec"
                :model-value="String(signalStackSize)"
                @update:model-value="(v: string) => (signalStackSize = Number(v))"
              />
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div class="flex flex-col gap-1.5">
                <Label for="rs-items" class="text-xs text-muted-foreground">Items inside</Label>
                <Input
                  id="rs-items"
                  type="number"
                  min="0"
                  :max="signalTable.value?.capacity ?? 3456"
                  step="1"
                  :model-value="itemCount"
                  @update:model-value="
                    (v) => (itemCount = clampInt(v, 0, signalTable.value?.capacity ?? 3456, 0))
                  "
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <Label for="rs-target-signal" class="text-xs text-muted-foreground">
                  Wanted signal (0 to 15)
                </Label>
                <Input
                  id="rs-target-signal"
                  type="number"
                  min="0"
                  max="15"
                  step="1"
                  :model-value="targetSignal"
                  @update:model-value="(v) => (targetSignal = clampInt(v, 0, 15, 7))"
                />
              </div>
            </div>
            <button
              type="button"
              class="rounded-[10px] border bg-card px-3 py-1.5 text-sm transition-colors hover:bg-accent"
              :disabled="!targetBand || targetBand.minItems === null"
              @click="useTargetItems"
            >
              Fill in the fewest items for signal {{ targetSignal }}
            </button>
            <button
              type="button"
              class="rounded-[10px] border bg-card px-3 py-1.5 text-sm transition-colors hover:bg-accent"
              :disabled="!signalTable.value"
              @click="downloadSignalTable"
            >
              Download this table as CSV
            </button>
          </div>

          <div class="flex flex-col gap-3">
            <ErrorBanner
              v-if="signalTable.error"
              :message="signalTable.error.message"
              :hint="signalTable.error.fix"
            />
            <template v-else-if="signalTable.value">
              <div class="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-live="polite">
                <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  <div class="text-xs text-muted-foreground">
                    Signal for {{ fmt(itemCount) }} items
                  </div>
                  <div class="font-mono text-lg tabular-nums">{{ currentSignal ?? "n/a" }}</div>
                </div>
                <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  <div class="text-xs text-muted-foreground">
                    Fewest for signal {{ targetSignal }}
                  </div>
                  <div class="font-mono text-lg tabular-nums">
                    {{
                      targetBand && targetBand.minItems !== null
                        ? fmt(targetBand.minItems)
                        : "unreachable"
                    }}
                  </div>
                </div>
                <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  <div class="text-xs text-muted-foreground">Container capacity</div>
                  <div class="font-mono text-lg tabular-nums">
                    {{ fmt(signalTable.value.capacity) }}
                  </div>
                </div>
                <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  <div class="text-xs text-muted-foreground">Slots</div>
                  <div class="font-mono text-lg tabular-nums">{{ signalTable.value.slots }}</div>
                </div>
              </div>

              <div
                class="max-h-[26rem] overflow-auto rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]"
              >
                <table class="w-full min-w-[480px] text-sm">
                  <caption class="sr-only">
                    Comparator signal strength for every item count in this container
                  </caption>
                  <thead>
                    <tr class="text-left text-xs font-semibold text-muted-foreground">
                      <th scope="col" class="px-3 py-1.5">Signal</th>
                      <th scope="col" class="px-3 py-1.5">Fewest items</th>
                      <th scope="col" class="px-3 py-1.5">Most items</th>
                      <th scope="col" class="px-3 py-1.5">In stacks</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="band in signalTable.value.bands"
                      :key="band.signal"
                      :class="band.signal === currentSignal ? 'font-semibold text-primary' : ''"
                    >
                      <td class="px-3 py-1.5 font-mono tabular-nums">{{ band.signal }}</td>
                      <td class="px-3 py-1.5 font-mono tabular-nums">
                        {{ band.minItems === null ? "unreachable" : fmt(band.minItems) }}
                      </td>
                      <td class="px-3 py-1.5 font-mono tabular-nums">
                        {{ band.maxItems === null ? "unreachable" : fmt(band.maxItems) }}
                      </td>
                      <td class="px-3 py-1.5">{{ band.minItemsAsStacks || "n/a" }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <p class="text-xs text-muted-foreground">
                {{ signalTable.value.container?.note }} How you spread the items between slots makes
                no difference: the game divides every slot by the same per-slot stack size, so only
                the total matters.
                <template v-if="signalTable.value.unreachable.length">
                  This container cannot produce signal
                  {{ signalTable.value.unreachable.join(", ") }} at this stack size.
                </template>
              </p>
            </template>
          </div>
        </div>
      </TabsContent>

      <!-- ====================== component reference ====================== -->
      <TabsContent value="reference" class="pt-4">
        <div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div class="flex flex-col gap-3 rounded-[14px] bg-secondary p-3 shadow-[var(--sh-inset)]">
            <div class="flex flex-col gap-1.5">
              <Label for="rs-component" class="text-xs text-muted-foreground">Component</Label>
              <SearchableSelect
                id="rs-component"
                :spec="componentSpec"
                :model-value="componentId"
                @update:model-value="(v: string) => (componentId = v)"
              />
            </div>
            <div v-if="selectedComponent" class="flex flex-col gap-2">
              <div class="grid grid-cols-2 gap-2">
                <div class="rounded-[10px] bg-card px-3 py-2">
                  <div class="text-xs text-muted-foreground">{{ selectedComponent.kindLabel }}</div>
                  <div class="font-mono text-lg tabular-nums">
                    {{ selectedComponent.delayLabel }}
                  </div>
                </div>
                <div class="rounded-[10px] bg-card px-3 py-2">
                  <div class="text-xs text-muted-foreground">In seconds at 20 TPS</div>
                  <div class="font-mono text-lg tabular-nums">{{ selectedComponent.seconds }}</div>
                </div>
              </div>
              <p class="text-sm">{{ selectedComponent.note }}</p>
              <p class="text-xs text-muted-foreground">Read from {{ selectedComponent.source }}.</p>
            </div>
          </div>

          <div class="flex flex-col gap-3">
            <ErrorBanner v-if="referenceRows.error" :message="referenceRows.error.message" />
            <div
              v-else
              class="max-h-[26rem] overflow-auto rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]"
            >
              <table class="w-full min-w-[560px] text-sm">
                <caption class="sr-only">
                  Every timed redstone component in
                  {{
                    version
                  }}, sorted by timing
                </caption>
                <thead>
                  <tr class="text-left text-xs font-semibold text-muted-foreground">
                    <th scope="col" class="px-3 py-1.5">Component</th>
                    <th scope="col" class="px-3 py-1.5">Game ticks</th>
                    <th scope="col" class="px-3 py-1.5">Seconds</th>
                    <th scope="col" class="px-3 py-1.5">What that measures</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in referenceRows.value ?? []"
                    :key="row.id"
                    :class="row.id === componentId ? 'font-semibold text-primary' : ''"
                  >
                    <td class="px-3 py-1.5">{{ row.label }}</td>
                    <td class="px-3 py-1.5 font-mono tabular-nums">{{ row.delayLabel }}</td>
                    <td class="px-3 py-1.5 font-mono tabular-nums">{{ row.seconds }}</td>
                    <td class="px-3 py-1.5 text-muted-foreground">{{ row.kindLabel }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div
              class="flex flex-col gap-2 rounded-[14px] bg-secondary p-3 shadow-[var(--sh-inset)]"
            >
              <p class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                Version boundaries
              </p>
              <div v-for="change in VERSION_CHANGES" :key="change.version" class="text-sm">
                <span
                  class="font-mono font-semibold"
                  :class="change.version === version ? 'text-primary' : ''"
                >
                  {{ change.version }}
                </span>
                <span class="text-muted-foreground"> {{ change.summary }}</span>
              </div>
            </div>
          </div>
        </div>
      </TabsContent>
    </Tabs>

    <p class="text-xs text-muted-foreground">
      Every constant here was read from the decompiled or unobfuscated server source of 1.16.5,
      1.18.2, 1.20.6, 1.21.1, 1.21.11 and 26.2, and the hopper cadence was checked against a live
      dedicated server. Not an official Minecraft product. Not approved by or associated with Mojang
      or Microsoft.
    </p>
  </div>
</template>

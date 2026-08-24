<script setup lang="ts">
/**
 * Bespoke panel for the Minecraft projectile trajectory calculator.
 *
 * Composes the pure logic layer (src/tools/minecraft-projectile-calculator):
 * the per tick simulator, the search based aim solver, maximum range, drop
 * over distance, and the ender pearl landing spot. All physics lives in the
 * logic layer; the panel owns only DOM, fragment state, and layout.
 */
import { computed, onMounted, ref, watch } from "vue";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  bowPowerForTime,
  crossbowChargeTicks,
  dropOverDistance,
  impactDamage,
  launcherLabel,
  launchSpeed,
  maxRange,
  minimumBowDrawTicks,
  pearlLanding,
  simulate,
  solveAim,
  type AimSolution,
  type SimTick,
} from "@/tools/minecraft-projectile-calculator/index";
import {
  BOW_FULL_DRAW_TICKS,
  DEFAULT_LAUNCH_HEIGHT,
  ENCHANTMENTS,
  ENCHANT_BY_ID,
  LAUNCH_MODES,
  PROJECTILES,
  PROJECTILE_BY_ID,
  TPS,
  VERSIONS,
  VERSION_INFO,
  enchantsForLauncher,
  type EnchantId,
  type LaunchModeId,
  type ProjectileId,
  type VersionId,
} from "@/tools/minecraft-projectile-calculator/data";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Segmented } from "@/components/ui/segmented";
import type { SegmentedOption } from "@/components/ui/segmented";
import OutputView from "../OutputView.vue";

defineProps<{ meta: ToolMeta }>();

type Mode = "aim" | "range" | "drop" | "pearl";
type Medium = "air" | "water";

const MODES: { id: Mode; label: string }[] = [
  { id: "aim", label: "Aim at a target" },
  { id: "range", label: "Maximum range" },
  { id: "drop", label: "Drop over distance" },
  { id: "pearl", label: "Ender pearl landing" },
];

const MODE_OPTIONS: SegmentedOption[] = MODES.map((m) => ({ value: m.id, label: m.label }));

const MEDIUM_OPTIONS: SegmentedOption[] = [
  { value: "air", label: "Air" },
  { value: "water", label: "Water" },
];

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const version = ref<VersionId>("1.21.11");
const mode = ref<Mode>("aim");
const projectile = ref<ProjectileId>("arrow");
const launcher = ref<LaunchModeId>("bow");
const medium = ref<Medium>("air");
const drawTicks = ref(BOW_FULL_DRAW_TICKS);
const distance = ref(30);
const deltaY = ref(0);
const throwPitch = ref(-30);
const levels = ref<Record<string, number>>({});

const mounted = ref(false);

/* ---------------------------------------------------------------- */
/* helpers                                                           */
/* ---------------------------------------------------------------- */

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
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
/* pickers                                                           */
/* ---------------------------------------------------------------- */

const versionSpec: SelectOptionSpec = {
  kind: "select",
  id: "version",
  label: "Version",
  default: "1.21.11",
  options: VERSIONS.map((v) => ({
    value: v,
    label: VERSION_INFO[v].label,
    synonyms: [v.replace(/\./g, " ")],
  })),
};

const projectileSpec: SelectOptionSpec = {
  kind: "select",
  id: "projectile",
  label: "Projectile",
  default: "arrow",
  groups: [
    {
      label: "Arrows and tridents",
      synonyms: ["bow", "crossbow", "spear"],
      options: PROJECTILES.filter((p) => p.family === "arrow").map((p) => ({
        value: p.id,
        label: p.label,
        synonyms: p.synonyms,
      })),
    },
    {
      label: "Thrown items",
      synonyms: ["hand", "throw", "consumable"],
      options: PROJECTILES.filter((p) => p.family === "throwable").map((p) => ({
        value: p.id,
        label: p.label,
        synonyms: p.synonyms,
      })),
    },
    {
      label: "Rockets",
      synonyms: ["firework", "crossbow", "elytra"],
      options: PROJECTILES.filter((p) => p.family === "firework").map((p) => ({
        value: p.id,
        label: p.label,
        synonyms: p.synonyms,
      })),
    },
    {
      label: "Mob fireballs",
      synonyms: ["ghast", "blaze", "deflect"],
      options: PROJECTILES.filter((p) => p.family === "hurting").map((p) => ({
        value: p.id,
        label: p.label,
        synonyms: p.synonyms,
      })),
    },
  ],
};

/** Only the launchers this projectile can actually come out of. */
const launcherSpec = computed<SelectOptionSpec>(() => {
  const def = PROJECTILE_BY_ID[projectile.value];
  return {
    kind: "select",
    id: "launcher",
    label: "Launcher",
    default: def.launchers[0],
    options: def.launchers.map((id) => ({
      value: id,
      label: def.launcherLabels?.[id] ?? LAUNCH_MODES[id].label,
      synonyms: [id],
    })),
  };
});

const def = computed(() => PROJECTILE_BY_ID[projectile.value]);
const info = computed(() => VERSION_INFO[version.value]);
const isBow = computed(() => launcher.value === "bow");
const minDraw = minimumBowDrawTicks();

/** Only the enchantments that can legally sit on this weapon. */
const availableEnchants = computed(() => enchantsForLauncher(launcher.value));

function levelOf(id: EnchantId): number {
  return levels.value[id] ?? 0;
}

/** True when another active enchantment is in this one's exclusive set. */
function blockedBy(id: EnchantId): string | null {
  for (const other of ENCHANT_BY_ID[id].excludes) {
    if (levelOf(other) > 0) return ENCHANT_BY_ID[other].label;
  }
  return null;
}

function setLevel(id: EnchantId, value: unknown): void {
  const next = clampInt(value, 0, ENCHANT_BY_ID[id].maxLevel, 0);
  const copy = { ...levels.value, [id]: next };
  if (next > 0) {
    for (const other of ENCHANT_BY_ID[id].excludes) copy[other] = 0;
  }
  levels.value = copy;
}

/* ---------------------------------------------------------------- */
/* keep the picker combinations legal                                */
/* ---------------------------------------------------------------- */

watch(projectile, (id) => {
  const allowed = PROJECTILE_BY_ID[id].launchers;
  if (!allowed.includes(launcher.value)) launcher.value = allowed[0];
  if (id === "ender_pearl" && mode.value === "pearl") return;
  if (mode.value === "pearl" && id !== "ender_pearl") mode.value = "aim";
});

watch(mode, (m) => {
  if (m === "pearl") {
    projectile.value = "ender_pearl";
    launcher.value = "hand";
  }
});

watch(launcher, () => {
  // Drop any enchantment that does not belong on the new weapon.
  const allowed = new Set(availableEnchants.value.map((e) => e.id));
  const next: Record<string, number> = {};
  for (const [id, level] of Object.entries(levels.value)) {
    if (allowed.has(id as EnchantId)) next[id] = level;
  }
  levels.value = next;
});

/* ---------------------------------------------------------------- */
/* the calculation                                                   */
/* ---------------------------------------------------------------- */

const speed = computed(() => launchSpeed(projectile.value, launcher.value, drawTicks.value));

interface Curve {
  kind: "primary" | "secondary";
  label: string;
  ticks: SimTick[];
}

interface Calc {
  error: CalcError | null;
  curves: Curve[];
  tiles: { label: string; value: string; sub?: string }[];
  detail: Record<string, string>;
  target: { distance: number; y: number } | null;
}

const GROUND_Y = -DEFAULT_LAUNCH_HEIGHT;
const DROP_DISTANCES = [5, 10, 15, 20, 30, 40, 50, 60];

function toCurve(ticks: SimTick[], kind: "primary" | "secondary", label: string): Curve {
  return { kind, label, ticks };
}

/**
 * Runs one flight for the plot. Without a ground plane a projectile keeps
 * falling for the whole tick budget, which would blow the chart's vertical
 * scale out to hundreds of blocks, so an open ended run always carries a
 * horizontal cutoff just past whatever the reader is looking at.
 */
function shootAt(pitch: number, ground: boolean, stopAfter?: number): SimTick[] {
  return simulate({
    version: version.value,
    projectile: projectile.value,
    launcher: launcher.value,
    drawTicks: drawTicks.value,
    medium: medium.value,
    origin: { x: 0, y: 0, z: 0 },
    groundY: ground ? GROUND_Y : undefined,
    stopAfterDistance: stopAfter,
    pitch,
    maxTicks: ground ? 2000 : 400,
  }).ticks;
}

function damageTile(atSpeed: number): { label: string; value: string; sub?: string } {
  const d = impactDamage(projectile.value, atSpeed, {
    power: levelOf("power"),
    punch: levelOf("punch"),
    impaling: levelOf("impaling"),
    critical: isBow.value && drawTicks.value >= BOW_FULL_DRAW_TICKS,
  });
  if (d.base === 0) return { label: "Damage on hit", value: "none", sub: "no impact damage" };
  const value = d.critMax > d.base ? `${d.base} to ${d.critMax}` : `${d.base}`;
  return {
    label: "Damage on hit",
    value,
    sub: `${round(d.base / 2)} to ${round(d.critMax / 2)} hearts`,
  };
}

const calc = computed<Calc>(() => {
  try {
    if (mode.value === "aim") {
      const solutions = solveAim({
        version: version.value,
        projectile: projectile.value,
        launcher: launcher.value,
        drawTicks: drawTicks.value,
        medium: medium.value,
        distance: distance.value,
        deltaY: deltaY.value,
      });
      if (!solutions.low) {
        const r = maxRange(
          version.value,
          projectile.value,
          launcher.value,
          drawTicks.value,
          medium.value,
        );
        return {
          error: {
            message: `A ${def.value.label.toLowerCase()} cannot reach a target ${round(distance.value)} blocks away at ${round(deltaY.value)} blocks of height.`,
            fix: `Its maximum range is about ${round(r.maxRange)} blocks. Move closer, aim at a lower target, or pick a faster launcher.`,
          },
          curves: [],
          tiles: [],
          detail: {},
          target: null,
        };
      }
      const low: AimSolution = solutions.low;
      // Stop each plotted arc just past the target so the chart scales to the
      // shot the reader asked about, not to a 400 tick free fall.
      const plotTo = distance.value * 1.1;
      const curves: Curve[] = [toCurve(shootAt(low.pitch, false, plotTo), "primary", "Flat shot")];
      if (solutions.high) {
        curves.push(
          toCurve(shootAt(solutions.high.pitch, false, plotTo), "secondary", "Lobbed shot"),
        );
      }
      const detail: Record<string, string> = {
        "Launch speed": `${round(speed.value, 4)} blocks per tick`,
        "Aim angle (flat shot)": `${round(low.angle, 2)} degrees above the horizon`,
        "Game pitch (flat shot)": `${round(low.pitch, 2)} (what F3 shows)`,
        "Flight time (flat shot)": `${round(low.seconds)} s (${round(low.flightTicks)} ticks)`,
        "Impact speed": `${round(low.impactSpeed, 3)} blocks per tick`,
        "Closest achievable miss": `${round(Math.abs(low.missY), 4)} blocks (the game's sine table limits how finely you can aim)`,
      };
      if (solutions.high) {
        detail["Aim angle (lobbed shot)"] =
          `${round(solutions.high.angle, 2)} degrees above the horizon`;
        detail["Flight time (lobbed shot)"] =
          `${round(solutions.high.seconds)} s (${round(solutions.high.flightTicks)} ticks)`;
      }
      if (levelOf("multishot") > 0) {
        detail["Multishot spread"] =
          `the two side arrows land about ${round(distance.value * Math.sin((10 * Math.PI) / 180))} blocks either side at this distance`;
      }
      if (launcher.value === "crossbow") {
        const ticks = crossbowChargeTicks(levelOf("quick_charge"));
        detail["Reload time"] = `${round(ticks / TPS)} s (${ticks} ticks)`;
      }
      if (levelOf("riptide") > 0) {
        detail["Riptide launch"] =
          `${round((3 * (1 + levelOf("riptide"))) / 4, 3)} blocks per tick, and it launches you instead of the trident`;
      }
      return {
        error: null,
        curves,
        tiles: [
          { label: "Aim angle", value: `${round(low.angle, 2)}`, sub: "degrees above horizon" },
          { label: "Flight time", value: `${round(low.seconds)}`, sub: "seconds" },
          {
            label: "Impact speed",
            value: `${round(low.impactSpeed, 2)}`,
            sub: "blocks per tick",
          },
          damageTile(low.impactSpeed),
        ],
        detail,
        target: { distance: distance.value, y: deltaY.value },
      };
    }

    if (mode.value === "range") {
      const r = maxRange(
        version.value,
        projectile.value,
        launcher.value,
        drawTicks.value,
        medium.value,
      );
      if (r.unlimited) {
        return {
          error: null,
          curves: [toCurve(shootAt(0, false).slice(0, 101), "primary", "Level shot")],
          tiles: [
            { label: "Range", value: "unlimited", sub: "gravity never pulls it down" },
            {
              label: `After ${r.overTicks} ticks`,
              value: `${round(r.maxRange)}`,
              sub: "blocks traveled",
            },
            { label: "Launch speed", value: `${round(speed.value, 3)}`, sub: "blocks per tick" },
            {
              label: "Elapsed",
              value: `${round(r.overTicks / TPS)}`,
              sub: "seconds simulated",
            },
          ],
          detail: {
            "Launch speed": `${round(speed.value, 4)} blocks per tick`,
            Range: `not limited by gravity. It covers ${round(r.maxRange)} blocks in ${r.overTicks} ticks and only stops when its fuse, its despawn timer, or a block stops it.`,
            Medium: medium.value === "water" ? "underwater" : "air",
          },
          target: null,
        };
      }
      const curves: Curve[] = [
        toCurve(shootAt(-r.bestAngle, true), "primary", "Best angle"),
        toCurve(shootAt(0, true), "secondary", "Level shot"),
      ];
      return {
        error: null,
        curves,
        tiles: [
          { label: "Maximum range", value: `${round(r.maxRange)}`, sub: "blocks" },
          { label: "Best angle", value: `${r.bestAngle}`, sub: "degrees above horizon" },
          { label: "Flight time", value: `${round(r.seconds)}`, sub: "seconds" },
          { label: "Level shot", value: `${round(r.levelRange)}`, sub: "blocks" },
        ],
        detail: {
          "Launch speed": `${round(speed.value, 4)} blocks per tick`,
          "Maximum range": `${round(r.maxRange)} blocks, launched from ${DEFAULT_LAUNCH_HEIGHT} blocks up and landing on flat ground`,
          "Best angle": `${r.bestAngle} degrees above the horizon, which drag pulls under the vacuum answer of 45`,
          "Flight time at that angle": `${round(r.seconds)} s (${round(r.flightTicks)} ticks)`,
          "Range firing dead level": `${round(r.levelRange)} blocks after ${round(r.levelFlightTicks / TPS)} s`,
          Medium: medium.value === "water" ? "underwater" : "air",
        },
        target: null,
      };
    }

    if (mode.value === "pearl") {
      const p = pearlLanding(version.value, throwPitch.value, medium.value);
      const curves: Curve[] = [toCurve(shootAt(throwPitch.value, true), "primary", "Pearl")];
      return {
        error: null,
        curves,
        tiles: [
          { label: "Lands at", value: `${round(p.distance)}`, sub: "blocks away" },
          { label: "Flight time", value: `${round(p.seconds)}`, sub: "seconds" },
          { label: "You take", value: `${p.damage}`, sub: "damage (2.5 hearts)" },
          {
            label: "Short of impact",
            value: `${round(p.offsetFromImpact)}`,
            sub: "blocks",
          },
        ],
        detail: {
          "Throw pitch": `${round(throwPitch.value, 1)} degrees (negative aims up)`,
          "Lands at": `${round(p.distance)} blocks away, ${round(p.landingY)} blocks above your feet`,
          "Flight time": `${round(p.seconds)} s (${round(p.flightTicks)} ticks)`,
          "Fall damage on arrival": `${p.damage} (2.5 hearts), and it ignores Feather Falling because it is dealt directly`,
          "Teleport point": p.landsAt,
          "Short of the impact point by": `${round(p.offsetFromImpact)} blocks`,
        },
        target: null,
      };
    }

    const rows = dropOverDistance(
      version.value,
      projectile.value,
      DROP_DISTANCES,
      launcher.value,
      drawTicks.value,
      medium.value,
    );
    const curves: Curve[] = [
      toCurve(
        shootAt(0, false, DROP_DISTANCES[DROP_DISTANCES.length - 1]),
        "primary",
        "Level shot",
      ),
    ];
    const detail: Record<string, string> = {
      "Launch speed": `${round(speed.value, 4)} blocks per tick`,
    };
    for (const row of rows) {
      detail[`Drop at ${row.distance} blocks`] =
        `${round(row.drop)} blocks after ${round(row.seconds)} s, still moving ${round(row.speed, 2)} blocks per tick`;
    }
    if (rows.length === 0) detail["Drop"] = "This projectile never reaches those distances.";
    const at20 = rows.find((r) => r.distance === 20);
    const at40 = rows.find((r) => r.distance === 40);
    return {
      error: null,
      curves,
      tiles: [
        { label: "Drop at 20", value: at20 ? `${round(at20.drop)}` : "n/a", sub: "blocks" },
        { label: "Drop at 40", value: at40 ? `${round(at40.drop)}` : "n/a", sub: "blocks" },
        {
          label: "Speed at 40",
          value: at40 ? `${round(at40.speed, 2)}` : "n/a",
          sub: "blocks per tick",
        },
        {
          label: "Time to 40",
          value: at40 ? `${round(at40.seconds)}` : "n/a",
          sub: "seconds",
        },
      ],
      detail,
      target: null,
    };
  } catch (e) {
    return { error: toCalcError(e), curves: [], tiles: [], detail: {}, target: null };
  }
});

/* ---------------------------------------------------------------- */
/* the trajectory plot                                               */
/* ---------------------------------------------------------------- */

const CHART_W = 760;
const CHART_H = 260;
const PAD = { left: 52, right: 18, top: 16, bottom: 30 };

const chart = computed(() => {
  const curves = calc.value.curves;
  const inner = { w: CHART_W - PAD.left - PAD.right, h: CHART_H - PAD.top - PAD.bottom };
  let maxX = 1;
  let maxY = 1;
  let minY = 0;
  for (const c of curves) {
    for (const t of c.ticks) {
      if (t.distance > maxX) maxX = t.distance;
      if (t.y > maxY) maxY = t.y;
      if (t.y < minY) minY = t.y;
    }
  }
  const target = calc.value.target;
  if (target) {
    if (target.distance > maxX) maxX = target.distance;
    if (target.y > maxY) maxY = target.y;
    if (target.y < minY) minY = target.y;
  }
  if (minY > GROUND_Y) minY = GROUND_Y;
  maxY = Math.max(maxY, minY + 1);
  const spanY = maxY - minY;

  const px = (d: number): number => PAD.left + (d / maxX) * inner.w;
  const py = (y: number): number => PAD.top + inner.h - ((y - minY) / spanY) * inner.h;

  const paths = curves.map((c) => ({
    kind: c.kind,
    label: c.label,
    points: c.ticks.map((t) => `${px(t.distance).toFixed(1)},${py(t.y).toFixed(1)}`).join(" "),
    dots: c.ticks
      .filter((t, i) => i % Math.max(1, Math.ceil(c.ticks.length / 40)) === 0)
      .map((t) => ({ cx: px(t.distance), cy: py(t.y), tick: t.tick })),
  }));

  const xTicks: { x: number; label: string }[] = [];
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    const d = (maxX * i) / steps;
    xTicks.push({ x: px(d), label: `${Math.round(d)}` });
  }
  const yTicks: { y: number; label: string }[] = [0, 0.5, 1].map((f) => {
    const value = minY + f * spanY;
    return { y: py(value), label: `${Math.round(value)}` };
  });

  return {
    paths,
    xTicks,
    yTicks,
    groundY: py(GROUND_Y),
    eyeY: py(0),
    target: target ? { x: px(target.distance), y: py(target.y) } : null,
    maxX: Math.round(maxX),
    minY: Math.round(minY),
    maxY: Math.round(maxY),
  };
});

const chartLabel = computed(() => {
  const c = calc.value.curves[0];
  if (!c) return "Trajectory plot, no flight to show";
  return `Side view of the ${def.value.label.toLowerCase()} trajectory, reaching ${chart.value.maxX} blocks horizontally between ${chart.value.minY} and ${chart.value.maxY} blocks of height`;
});

/* ---------------------------------------------------------------- */
/* fragment state                                                    */
/* ---------------------------------------------------------------- */

watch(
  [version, mode, projectile, launcher, medium, drawTicks, distance, deltaY, throwPitch, levels],
  () => {
    if (!mounted.value) return;
    const enchants = Object.entries(levels.value)
      .filter(([, level]) => level > 0)
      .map(([id, level]) => `${id}:${level}`)
      .join(",");
    writeFragment({
      opts: {
        v: version.value,
        mode: mode.value,
        p: projectile.value,
        l: launcher.value,
        med: medium.value,
        dt: String(drawTicks.value),
        d: String(distance.value),
        dy: String(deltaY.value),
        pit: String(throwPitch.value),
        ench: enchants,
      },
    });
  },
  { deep: true },
);

/** Every fragment value is untrusted: validate, clamp, and gate all of it. */
onMounted(() => {
  const { opts } = readFragment() as { opts: Partial<Record<string, string>> };
  const pick = <T extends string>(
    value: string | undefined,
    allowed: readonly T[],
  ): T | undefined => (allowed.includes(value as T) ? (value as T) : undefined);

  version.value = pick(opts.v, VERSIONS) ?? "1.21.11";
  mode.value = pick(opts.mode, ["aim", "range", "drop", "pearl"] as const) ?? "aim";
  const p = PROJECTILES.find((x) => x.id === opts.p);
  if (p) projectile.value = p.id;
  const allowed = PROJECTILE_BY_ID[projectile.value].launchers;
  launcher.value = allowed.includes(opts.l as LaunchModeId) ? (opts.l as LaunchModeId) : allowed[0];
  medium.value = pick(opts.med, ["air", "water"] as const) ?? "air";
  drawTicks.value = clampInt(opts.dt, 0, 60, BOW_FULL_DRAW_TICKS);
  distance.value = clampNum(opts.d, 0.5, 500, 30);
  deltaY.value = clampNum(opts.dy, -320, 320, 0);
  throwPitch.value = clampNum(opts.pit, -90, 90, -30);

  const restored: Record<string, number> = {};
  const legal = new Set(enchantsForLauncher(launcher.value).map((e) => e.id));
  for (const part of (opts.ench ?? "").split(",")) {
    const [id, level] = part.split(":");
    if (!legal.has(id as EnchantId)) continue;
    const enchant = ENCHANT_BY_ID[id as EnchantId];
    const value = clampInt(level, 0, enchant.maxLevel, 0);
    if (value <= 0) continue;
    if (enchant.excludes.some((other) => (restored[other] ?? 0) > 0)) continue;
    restored[id] = value;
  }
  levels.value = restored;
  mounted.value = true;
});

const bowPowerLabel = computed(
  () => `${Math.round(bowPowerForTime(drawTicks.value) * 100)}% power`,
);

const enchantNotes = computed(() =>
  ENCHANTMENTS.filter((e) => e.weapon === launcher.value && levelOf(e.id) > 0).map((e) => ({
    id: e.id,
    text: `${e.label} ${levelOf(e.id)}: ${e.effect}`,
  })),
);
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- mode, version, medium -->
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div class="flex flex-col gap-1.5">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >Mode</span
        >
        <Segmented
          :model-value="mode"
          :options="MODE_OPTIONS"
          label="Calculator mode"
          @update:model-value="(v: string) => (mode = v as Mode)"
        />
      </div>
      <div class="flex flex-wrap gap-3">
        <div class="flex w-40 flex-col gap-1.5">
          <Label for="mcp-version" class="text-xs text-muted-foreground">Version</Label>
          <SearchableSelect
            id="mcp-version"
            :spec="versionSpec"
            :model-value="version"
            @update:model-value="(v: string) => (version = v as VersionId)"
          />
        </div>
        <div class="flex flex-col gap-1.5">
          <span class="text-xs text-muted-foreground">Medium</span>
          <Segmented
            :model-value="medium"
            :options="MEDIUM_OPTIONS"
            label="Medium"
            size="sm"
            @update:model-value="(v: string) => (medium = v === 'water' ? 'water' : 'air')"
          />
        </div>
      </div>
    </div>

    <!-- workbench: the shot on the left, the shot's target on the right -->
    <div class="grid grid-cols-1 items-stretch gap-3 lg:grid-cols-2">
      <section class="flex flex-col gap-3 rounded-[14px] border p-4" aria-label="The shot">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          The shot
        </span>

        <div class="flex flex-col gap-1.5">
          <Label for="mcp-projectile" class="text-xs text-muted-foreground">Projectile</Label>
          <SearchableSelect
            id="mcp-projectile"
            :spec="projectileSpec"
            :model-value="projectile"
            @update:model-value="(v: string) => (projectile = v as ProjectileId)"
          />
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="mcp-launcher" class="text-xs text-muted-foreground">Launcher</Label>
          <SearchableSelect
            id="mcp-launcher"
            :spec="launcherSpec"
            :model-value="launcher"
            @update:model-value="(v: string) => (launcher = v as LaunchModeId)"
          />
        </div>

        <div v-if="isBow" class="flex flex-col gap-1.5">
          <Label for="mcp-draw" class="text-xs text-muted-foreground">
            Bow draw in ticks ({{ bowPowerLabel }})
          </Label>
          <Input
            id="mcp-draw"
            type="number"
            :min="minDraw"
            max="60"
            step="1"
            :model-value="drawTicks"
            @update:model-value="(v) => (drawTicks = clampInt(v, minDraw, 60, BOW_FULL_DRAW_TICKS))"
          />
          <p class="text-xs text-muted-foreground">
            A full draw is 20 ticks, one second. The game refuses to fire under 0.1 power, which is
            {{ minDraw }} ticks.
          </p>
        </div>

        <div class="rounded-[10px] bg-secondary p-2.5 shadow-[var(--sh-inset)]">
          <p class="font-mono text-xs tabular-nums">
            {{ round(speed, 4) }} blocks per tick at launch,
            {{ launcherLabel(projectile, launcher) }}
          </p>
          <p class="mt-1 text-xs text-muted-foreground">{{ def.note }}</p>
        </div>

        <!-- only the enchantments this weapon can actually carry -->
        <div v-if="availableEnchants.length > 0" class="flex flex-col gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            {{ LAUNCH_MODES[launcher].label }} enchantments
          </span>
          <div class="grid grid-cols-2 gap-2">
            <div
              v-for="e in availableEnchants"
              :key="e.id"
              class="flex flex-col gap-1"
              :title="e.effect"
            >
              <Label :for="`mcp-ench-${e.id}`" class="text-xs text-muted-foreground">
                {{ e.label }}
                <span v-if="blockedBy(e.id)" class="opacity-70">
                  (excluded by {{ blockedBy(e.id) }})
                </span>
              </Label>
              <Input
                :id="`mcp-ench-${e.id}`"
                type="number"
                min="0"
                :max="e.maxLevel"
                step="1"
                :disabled="blockedBy(e.id) !== null"
                :model-value="levelOf(e.id)"
                @update:model-value="(v) => setLevel(e.id, v)"
              />
            </div>
          </div>
          <ul v-if="enchantNotes.length > 0" class="flex flex-col gap-1">
            <li v-for="n in enchantNotes" :key="n.id" class="text-xs text-muted-foreground">
              {{ n.text }}
            </li>
          </ul>
        </div>
      </section>

      <section class="flex flex-col gap-3 rounded-[14px] border p-4" aria-label="The target">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          {{
            mode === "aim"
              ? "The target"
              : mode === "pearl"
                ? "The throw"
                : mode === "range"
                  ? "The range test"
                  : "The drop test"
          }}
        </span>

        <template v-if="mode === 'aim'">
          <div class="grid grid-cols-2 gap-3">
            <div class="flex flex-col gap-1.5">
              <Label for="mcp-distance" class="text-xs text-muted-foreground">
                Distance (blocks)
              </Label>
              <Input
                id="mcp-distance"
                type="number"
                min="0.5"
                max="500"
                step="0.5"
                :model-value="distance"
                @update:model-value="(v) => (distance = clampNum(v, 0.5, 500, 30))"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label for="mcp-dy" class="text-xs text-muted-foreground">
                Height above you (blocks)
              </Label>
              <Input
                id="mcp-dy"
                type="number"
                min="-320"
                max="320"
                step="0.5"
                :model-value="deltaY"
                @update:model-value="(v) => (deltaY = clampNum(v, -320, 320, 0))"
              />
            </div>
          </div>
          <p class="text-xs text-muted-foreground">
            Distance is measured flat along the ground and height is measured from the launch point,
            which sits {{ DEFAULT_LAUNCH_HEIGHT }} blocks above your feet. The solver runs a full
            simulation at every candidate angle rather than using the vacuum formula, so drag is
            included.
          </p>
        </template>

        <template v-else-if="mode === 'pearl'">
          <div class="flex flex-col gap-1.5">
            <Label for="mcp-pitch" class="text-xs text-muted-foreground">
              Throw pitch (degrees, negative aims up)
            </Label>
            <Input
              id="mcp-pitch"
              type="number"
              min="-90"
              max="90"
              step="1"
              :model-value="throwPitch"
              @update:model-value="(v) => (throwPitch = clampNum(v, -90, 90, -30))"
            />
          </div>
          <p class="text-xs text-muted-foreground">
            The pitch is the number the F3 screen shows, so -45 is aimed halfway up. A pearl always
            costs 5 damage on arrival, and armor does not reduce it.
          </p>
        </template>

        <template v-else-if="mode === 'range'">
          <p class="text-xs text-muted-foreground">
            The maximum range search simulates every launch angle from level to 80 degrees and keeps
            the one that lands furthest, then refines it in hundredths of a degree. The shot starts
            {{ DEFAULT_LAUNCH_HEIGHT }} blocks above your feet and lands on flat ground at your own
            level.
          </p>
        </template>

        <template v-else>
          <p class="text-xs text-muted-foreground">
            Drop is measured from a dead level shot: how far below your crosshair line the
            projectile has fallen by each distance, and how much speed it has left, which is what
            arrow damage scales with.
          </p>
        </template>

        <!-- stat tiles -->
        <div
          v-if="!calc.error"
          class="mt-auto grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2"
        >
          <div
            v-for="t in calc.tiles"
            :key="t.label"
            class="rounded-[10px] border bg-card p-2.5 text-center shadow-[var(--sh-sm)]"
          >
            <p class="text-xs text-muted-foreground">{{ t.label }}</p>
            <p class="font-mono text-xl font-semibold tabular-nums">{{ t.value }}</p>
            <p v-if="t.sub" class="font-mono text-xs text-muted-foreground tabular-nums">
              {{ t.sub }}
            </p>
          </div>
        </div>
      </section>
    </div>

    <!-- error -->
    <div
      v-if="calc.error"
      class="rounded-[14px] border border-destructive/40 bg-destructive/5 p-4 text-sm"
      role="alert"
    >
      <p class="font-medium text-destructive">{{ calc.error.message }}</p>
      <p v-if="calc.error.fix" class="text-muted-foreground">{{ calc.error.fix }}</p>
    </div>

    <!-- trajectory plot -->
    <div v-if="!calc.error" class="flex flex-col gap-2">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Trajectory (side view, blocks)
      </span>
      <div class="overflow-x-auto rounded-[10px] bg-secondary p-2 shadow-[var(--sh-inset)]">
        <svg
          :width="CHART_W"
          :height="CHART_H"
          :viewBox="`0 0 ${CHART_W} ${CHART_H}`"
          role="img"
          :aria-label="chartLabel"
          class="text-primary"
        >
          <g class="text-border" stroke="currentColor" stroke-width="1">
            <line
              v-for="t in chart.yTicks"
              :key="`y${t.y}`"
              :x1="PAD.left"
              :x2="CHART_W - PAD.right"
              :y1="t.y"
              :y2="t.y"
              opacity="0.6"
            />
          </g>
          <!-- the ground, and the height the shot leaves at -->
          <line
            :x1="PAD.left"
            :x2="CHART_W - PAD.right"
            :y1="chart.groundY"
            :y2="chart.groundY"
            class="text-muted-foreground"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-dasharray="2 3"
            opacity="0.8"
          />
          <line
            :x1="PAD.left"
            :x2="CHART_W - PAD.right"
            :y1="chart.eyeY"
            :y2="chart.eyeY"
            class="text-muted-foreground"
            stroke="currentColor"
            stroke-width="1"
            stroke-dasharray="1 5"
            opacity="0.6"
          />
          <g class="text-muted-foreground" fill="currentColor" font-size="11">
            <text
              v-for="t in chart.yTicks"
              :key="`yl${t.y}`"
              :x="PAD.left - 8"
              :y="t.y + 4"
              text-anchor="end"
            >
              {{ t.label }}
            </text>
            <text
              v-for="t in chart.xTicks"
              :key="`xl${t.x}`"
              :x="t.x"
              :y="CHART_H - 10"
              text-anchor="middle"
            >
              {{ t.label }}
            </text>
          </g>
          <template v-for="(p, i) in chart.paths" :key="`p${i}`">
            <polyline
              :points="p.points"
              fill="none"
              stroke="currentColor"
              :stroke-width="p.kind === 'primary' ? 2 : 1.5"
              :stroke-dasharray="p.kind === 'primary' ? undefined : '5 4'"
              :opacity="p.kind === 'primary' ? 1 : 0.55"
              stroke-linejoin="round"
            />
            <circle
              v-for="(d, j) in p.dots"
              :key="`d${i}-${j}`"
              :cx="d.cx"
              :cy="d.cy"
              :r="p.kind === 'primary' ? 1.8 : 1.2"
              fill="currentColor"
              :opacity="p.kind === 'primary' ? 0.8 : 0.4"
            />
          </template>
          <g v-if="chart.target">
            <circle
              :cx="chart.target.x"
              :cy="chart.target.y"
              r="5"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              class="text-destructive"
            />
            <circle
              :cx="chart.target.x"
              :cy="chart.target.y"
              r="1.5"
              class="text-destructive"
              fill="currentColor"
            />
          </g>
        </svg>
      </div>
      <p class="text-xs text-muted-foreground">
        One dot per sampled game tick, so the spacing shows how fast the projectile is still moving.
        The dashed line is your feet; the dotted line is the height the shot leaves at.
        <span v-if="calc.curves.length > 1">
          The dashed curve is the {{ calc.curves[1].label.toLowerCase() }}.
        </span>
      </p>
    </div>

    <!-- full breakdown -->
    <div v-if="!calc.error" aria-live="polite">
      <OutputView :output="calc.detail" />
    </div>

    <p class="text-xs text-muted-foreground">
      Physics reimplemented from decompiled or unobfuscated server source for six versions and
      checked against per tick positions measured on a real dedicated server.
      <span v-if="info.throwableAcceleratesFirst">
        On {{ info.label }}, thrown items take gravity and drag before they move, arrows in water
        take their drag before the move, and an ender pearl lands you at its position at the start
        of the impact tick.
      </span>
      <span v-else-if="info.floatGravity">
        On {{ info.label }}, gravity is a Java float, so a falling projectile loses
        0.05000000074505806 per tick rather than exactly 0.05.
      </span>
      <span v-else>
        On {{ info.label }}, gravity is a true double and every projectile still moves before it
        takes drag and gravity.
      </span>
      <span>Not an official Minecraft product.</span>
      <span>Not approved by or associated with Mojang or Microsoft.</span>
    </p>
  </div>
</template>

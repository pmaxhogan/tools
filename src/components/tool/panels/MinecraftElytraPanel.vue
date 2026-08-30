<script setup lang="ts">
/**
 * Bespoke panel for the Minecraft elytra flight calculator.
 *
 * A workbench split: the flight setup on the left, headline stat tiles and
 * two SVG charts (the flight path, and speed over time with the rocket
 * boost shaded) on the right, then per-mode detail underneath. Every number
 * comes out of the pure logic layer in
 * src/tools/minecraft-elytra-calculator; the panel owns only DOM, layout,
 * and URL-fragment state.
 */
import { computed, onMounted, ref, watch } from "vue";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  CUSTOM_PROFILE_ID,
  bestGlidePitch,
  cruisePlan,
  durabilityPlan,
  fireworkSelfDamage,
  flightProfileSelectGroups,
  flightProfiles,
  matchFlightProfile,
  MAX_FIREWORK_STARS,
  MAX_UNBREAKING,
  simulateFlight,
  setupMatchesProfile,
  steadyState,
  travelPlan,
  type FlightSetup,
  type SimResult,
} from "@/tools/minecraft-elytra-calculator/index";
import {
  DEFAULT_GRAVITY,
  ELYTRA_ENCHANTS,
  ELYTRA_VERSION_DATA,
  ELYTRA_VERSIONS,
  GLIDER_COMPONENT_FROM,
  NETHER_RATIO,
  SLOW_FALLING_GRAVITY,
  TICKS_PER_SECOND,
  type ElytraVersionId,
} from "@/tools/minecraft-elytra-calculator/data";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import ErrorBanner from "../ErrorBanner.vue";
import OutputView from "../OutputView.vue";

defineProps<{ meta: ToolMeta }>();

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

type Mode = "glide" | "cruise" | "travel" | "durability" | "damage";

const MODES: { id: Mode; label: string }[] = [
  { id: "glide", label: "Glide" },
  { id: "cruise", label: "Rocket cruise" },
  { id: "travel", label: "Trip planner" },
  { id: "durability", label: "Durability" },
  { id: "damage", label: "Firework damage" },
];

const version = ref<ElytraVersionId>("1.21.11");
const mode = ref<Mode>("glide");
const pitch = ref(0);
const height = ref(100);
const flightDuration = ref(1);
const rocketInterval = ref(60);
const useRockets = ref(false);
const chainRockets = ref(true);
const divePreamble = ref(false);
const divePitch = ref(45);
const diveTicks = ref(100);
const targetX = ref(10000);
const targetZ = ref(0);
const damage = ref(0);
const unbreaking = ref(0);
const mending = ref(false);
const stars = ref(1);
const slowFalling = ref(false);
/**
 * The preset the user last picked explicitly. It is honored only while the
 * setup still matches it, so it can never disagree with the controls; the
 * displayed selection is always `activeProfile` below, which falls back to a
 * match against the live setup and then to "Custom". That is what keeps the
 * trigger from rendering an empty box on a clean load, where the default
 * setup is exactly the level glide preset.
 */
const explicitProfile = ref<string | null>(null);

const mounted = ref(false);

/* ---------------------------------------------------------------- */
/* helpers                                                           */
/* ---------------------------------------------------------------- */

function fmt(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return "no limit";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, lo), hi);
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  return Math.round(clampNum(v, lo, hi, fallback));
}

function ticksToWords(ticks: number): string {
  const seconds = ticks / TICKS_PER_SECOND;
  if (seconds < 90) return `${fmt(seconds, 1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${fmt(seconds - minutes * 60, 0)} s`;
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

const gravity = computed(() => (slowFalling.value ? SLOW_FALLING_GRAVITY : DEFAULT_GRAVITY));
const versionData = computed(() => ELYTRA_VERSION_DATA[version.value]);

/* ---------------------------------------------------------------- */
/* select specs                                                      */
/* ---------------------------------------------------------------- */

const versionSpec: SelectOptionSpec = {
  kind: "select",
  id: "version",
  label: "Version",
  default: "1.21.11",
  options: ELYTRA_VERSIONS.map((v) => ({
    value: v,
    label: v === "26.2" ? "26.2 (latest)" : v,
    synonyms: [v.replace(/\./g, " ")],
  })),
};

const durationSpec: SelectOptionSpec = {
  kind: "select",
  id: "flightDuration",
  label: "Firework flight duration",
  default: "1",
  options: [
    { value: "1", label: "1 gunpowder", synonyms: ["duration 1", "cheap", "plain rocket"] },
    { value: "2", label: "2 gunpowder", synonyms: ["duration 2", "medium"] },
    { value: "3", label: "3 gunpowder", synonyms: ["duration 3", "long", "best range"] },
  ],
};

/**
 * Rocket cruise and the trip planner are about flying on rockets, so their
 * chart always shows a powered flight and the toggle only decides whether
 * rockets are chained or fired on an interval. Glide mode is the one place
 * where flying unpowered is the point.
 */
const powered = computed(
  () => mode.value === "cruise" || mode.value === "travel" || useRockets.value,
);

/** The live setup, in the shape the logic layer matches profiles against. */
const setup = computed<FlightSetup>(() => ({
  pitchDeg: pitch.value,
  rockets: powered.value,
  chain: chainRockets.value,
  intervalTicks: rocketInterval.value,
  dive: divePreamble.value ? { pitchDeg: divePitch.value, ticks: diveTicks.value } : null,
}));

const profiles = computed(() => flightProfiles(gravity.value));

/**
 * The selection the picker shows. An explicit pick wins while it still
 * describes the setup (so "Best glide ratio" stays selected even though it
 * resolves to the same pitch as level glide), otherwise the setup is matched
 * against the presets, and anything unmatched reads "Custom". This is always
 * a non-empty id, which is the property the trigger needs to render a label.
 */
const activeProfile = computed(() => {
  const picked = explicitProfile.value
    ? profiles.value.find((p) => p.id === explicitProfile.value)
    : undefined;
  if (picked && setupMatchesProfile(setup.value, picked)) return picked.id;
  return matchFlightProfile(setup.value, gravity.value);
});

/**
 * The flight profile picker: long enough to earn the shared searchable
 * select's search field, grouped by what the profile is for. "Custom" is a
 * real option so the trigger always has something to display, the same way
 * the XP panel offers "Custom weights".
 */
const profileSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "profile",
  label: "Flight profile",
  default: CUSTOM_PROFILE_ID,
  groups: flightProfileSelectGroups(gravity.value),
}));

function applyProfile(id: string) {
  explicitProfile.value = id;
  const def = profiles.value.find((p) => p.id === id);
  // "Custom" describes the setup rather than changing it.
  if (!def) return;
  pitch.value = def.pitchDeg;
  useRockets.value = def.rockets;
  chainRockets.value = def.chain;
  rocketInterval.value = def.intervalTicks;
  divePreamble.value = def.dive !== null;
  if (def.dive) {
    divePitch.value = def.dive.pitchDeg;
    diveTicks.value = def.dive.ticks;
  }
}

/* ---------------------------------------------------------------- */
/* the simulation                                                    */
/* ---------------------------------------------------------------- */

const simulation = computed<{ result: SimResult | null; error: CalcError | null }>(() => {
  try {
    const rocketMode = powered.value ? (chainRockets.value ? "chained" : "interval") : "none";
    const result = simulateFlight({
      pitchDeg: pitch.value,
      pitchSegments: divePreamble.value
        ? [{ throughTick: diveTicks.value, pitchDeg: divePitch.value }]
        : undefined,
      gravity: gravity.value,
      rocketMode,
      flightDuration: flightDuration.value,
      rocketIntervalTicks: rocketInterval.value,
      stopAfterDrop: mode.value === "glide" ? height.value : undefined,
      stopAfterDistance: mode.value === "glide" ? undefined : 4000,
      maxTicks: 40000,
    });
    return { result, error: null };
  } catch (e) {
    return { result: null, error: toCalcError(e) };
  }
});

const glideSteady = computed(() => steadyState(pitch.value, { gravity: gravity.value }));
const cruiseSteady = computed(() =>
  steadyState(pitch.value, { boosting: true, gravity: gravity.value }),
);
/**
 * Durability mode turns flight time into distance, so it needs a speed with a
 * fixed meaning rather than whatever pitch was last used elsewhere: level
 * flight with rockets chained.
 */
const levelCruiseSpeed = computed(
  () => steadyState(0, { boosting: true, gravity: gravity.value }).horizontalSpeed,
);
const bestGlide = computed(() => bestGlidePitch(0.5, gravity.value));

const cruise = computed<{ plan: ReturnType<typeof cruisePlan> | null; error: CalcError | null }>(
  () => {
    try {
      return { plan: cruisePlan(pitch.value, flightDuration.value, gravity.value), error: null };
    } catch (e) {
      return { plan: null, error: toCalcError(e) };
    }
  },
);

const trip = computed<{ plan: ReturnType<typeof travelPlan> | null; error: CalcError | null }>(
  () => {
    try {
      return {
        plan: travelPlan(targetX.value, targetZ.value, {
          pitchDeg: pitch.value,
          flightDuration: flightDuration.value,
          gravity: gravity.value,
        }),
        error: null,
      };
    } catch (e) {
      return { plan: null, error: toCalcError(e) };
    }
  },
);

const wear = computed<{ plan: ReturnType<typeof durabilityPlan> | null; error: CalcError | null }>(
  () => {
    try {
      return {
        plan: durabilityPlan({
          version: version.value,
          currentDamage: damage.value,
          unbreaking: unbreaking.value,
          cruiseSpeed: levelCruiseSpeed.value,
        }),
        error: null,
      };
    } catch (e) {
      return { plan: null, error: toCalcError(e) };
    }
  },
);

const selfDamage = computed(() => {
  try {
    return { value: fireworkSelfDamage(stars.value), error: null };
  } catch (e) {
    return { value: null, error: toCalcError(e) };
  }
});

/* ---------------------------------------------------------------- */
/* stat tiles                                                        */
/* ---------------------------------------------------------------- */

interface Tile {
  label: string;
  value: string;
  hint?: string;
}

const tiles = computed<Tile[]>(() => {
  const sim = simulation.value.result;
  switch (mode.value) {
    case "glide": {
      if (!sim) return [];
      const landed = sim.stoppedBy === "drop";
      const ratio = height.value > 0 ? sim.distance / height.value : 0;
      return [
        {
          label: "Distance",
          value: `${fmt(sim.distance)} blocks`,
          hint: landed
            ? `from ${fmt(height.value)} blocks up`
            : `still airborne after ${fmt(sim.ticks)} ticks`,
        },
        {
          label: "Time in the air",
          value: ticksToWords(sim.ticks),
          hint: landed ? `${fmt(sim.ticks)} ticks` : "never loses the height at this setup",
        },
        {
          label: "Glide ratio",
          value: landed ? `${fmt(ratio, 2)} to 1` : "climbing",
          hint: landed ? "blocks forward per block down" : "the rockets outpace the descent",
        },
        {
          label: "Top speed",
          value: `${fmt(sim.peakHorizontalSpeed * TICKS_PER_SECOND, 1)} blocks/s`,
          hint: `${fmt(sim.peakHorizontalSpeed, 3)} per tick`,
        },
      ];
    }
    case "cruise": {
      const plan = cruise.value.plan;
      if (!plan) return [];
      return [
        {
          label: "Cruise speed",
          value: `${fmt(plan.speedPerSecond, 1)} blocks/s`,
          hint: `${fmt(plan.speedPerTick, 3)} per tick, rockets chained`,
        },
        {
          label: "Blocks per rocket",
          value: fmt(plan.blocksPerRocket, 1),
          hint: `${fmt(plan.minBlocksPerRocket)} to ${fmt(plan.maxBlocksPerRocket)} on the lifetime roll`,
        },
        {
          label: "Rockets per 1000 blocks",
          value: fmt(plan.rocketsPerThousandBlocks, 1),
          hint: `${fmt(plan.gunpowderPerThousandBlocks, 1)} gunpowder, ${fmt(plan.paperPerThousandBlocks, 1)} paper`,
        },
        {
          label: "Height change",
          value: `${fmt(plan.verticalSpeedPerTick * TICKS_PER_SECOND, 2)} blocks/s`,
          hint: plan.verticalSpeedPerTick >= 0 ? "climbing" : "sinking slowly",
        },
      ];
    }
    case "travel": {
      const plan = trip.value.plan;
      if (!plan) return [];
      return [
        {
          label: "Distance",
          value: `${fmt(plan.overworld.distance)} blocks`,
          hint: "straight line from the origin",
        },
        {
          label: "Rockets",
          value: fmt(plan.overworld.rockets),
          hint: `${fmt(plan.overworld.gunpowder)} gunpowder, ${fmt(plan.overworld.paper)} paper`,
        },
        {
          label: "Flight time",
          value: ticksToWords(plan.overworld.ticks),
          hint: "at chained rocket cruise",
        },
        {
          label: "Nether instead",
          value: `${fmt(plan.nether.rockets)} rockets`,
          hint: `${fmt(plan.nether.distance)} blocks, ${ticksToWords(plan.nether.ticks)}`,
        },
      ];
    }
    case "durability": {
      const plan = wear.value.plan;
      if (!plan) return [];
      return [
        {
          label: "Flight time left",
          value: ticksToWords(plan.flightTicks),
          hint: `${fmt(plan.usableDurability)} usable durability`,
        },
        {
          label: "Distance left",
          value: `${fmt(plan.flightDistance)} blocks`,
          hint: "at chained rocket cruise",
        },
        {
          label: "Mending upkeep",
          value: `${fmt(plan.mendingXpPerSecond, 2)} XP/s`,
          hint: mending.value ? "orbs needed to break even" : "turn Mending on to apply it",
        },
        {
          label: "Phantom membranes",
          value: fmt(plan.membranesToFull),
          hint: `${fmt(plan.repairPerMembrane)} durability each`,
        },
      ];
    }
    case "damage": {
      const d = selfDamage.value.value;
      if (!d) return [];
      return [
        {
          label: "Damage to you",
          value: d.harmless ? "none" : fmt(d.damage),
          hint: "before armor",
        },
        {
          label: "Hearts",
          value: d.harmless ? "0" : fmt(d.hearts, 1),
          hint: "half a heart per point",
        },
        { label: "Firework stars", value: fmt(d.stars), hint: "5 damage plus 2 per star" },
        { label: "Armor", value: "applies", hint: "the fireworks type does not bypass armor" },
      ];
    }
    default:
      return [];
  }
});

/* ---------------------------------------------------------------- */
/* charts                                                            */
/* ---------------------------------------------------------------- */

const CHART_W = 720;
const CHART_H = 220;
const PAD = { left: 56, right: 14, top: 14, bottom: 28 };

interface ChartTick {
  pos: number;
  label: string;
}

interface ChartData {
  path: string;
  speedPath: string;
  boostBands: { x: number; width: number }[];
  xTicks: ChartTick[];
  yTicks: ChartTick[];
  speedTicks: ChartTick[];
  speedXTicks: ChartTick[];
  summary: string;
}

/** Downsample the tick trace so the SVG stays small on long flights. */
function thin<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const stride = Math.ceil(items.length / max);
  const out = items.filter((_, i) => i % stride === 0);
  const last = items[items.length - 1];
  if (last !== undefined && out[out.length - 1] !== last) out.push(last);
  return out;
}

const chart = computed<ChartData | null>(() => {
  const sim = simulation.value.result;
  if (!sim || sim.samples.length < 2) return null;
  const samples = thin(sim.samples, 600);
  const innerW = CHART_W - PAD.left - PAD.right;
  const innerH = CHART_H - PAD.top - PAD.bottom;

  const maxDistance = Math.max(1, sim.distance);
  const lo = Math.min(0, sim.lowestAltitude);
  const hi = Math.max(0, sim.highestAltitude);
  const span = Math.max(1, hi - lo);

  const px = (d: number) => PAD.left + (d / maxDistance) * innerW;
  const py = (a: number) => PAD.top + innerH - ((a - lo) / span) * innerH;

  const path = samples
    .map((s) => `${px(s.distance).toFixed(1)},${py(s.altitude).toFixed(1)}`)
    .join(" ");

  const maxSpeed = Math.max(0.001, sim.peakHorizontalSpeed);
  const totalTicks = Math.max(1, sim.ticks);
  const sx = (t: number) => PAD.left + (t / totalTicks) * innerW;
  const sy = (v: number) => PAD.top + innerH - (v / maxSpeed) * innerH;
  const speedPath = samples
    .map((s) => `${sx(s.tick).toFixed(1)},${sy(s.horizontalSpeed).toFixed(1)}`)
    .join(" ");

  // Contiguous runs of boosted ticks, shaded behind the speed line.
  const bands: { x: number; width: number }[] = [];
  let runStart: number | null = null;
  for (const s of sim.samples) {
    if (s.boosting && runStart === null) runStart = s.tick;
    if (!s.boosting && runStart !== null) {
      bands.push({ x: sx(runStart), width: Math.max(1, sx(s.tick) - sx(runStart)) });
      runStart = null;
    }
  }
  if (runStart !== null) {
    bands.push({ x: sx(runStart), width: Math.max(1, sx(sim.ticks) - sx(runStart)) });
  }

  const xTicks: ChartTick[] = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    pos: PAD.left + f * innerW,
    label: fmt(maxDistance * f),
  }));
  const yTicks: ChartTick[] = [0, 0.5, 1].map((f) => ({
    pos: PAD.top + innerH - f * innerH,
    label: fmt(lo + f * span),
  }));
  const speedTicks: ChartTick[] = [0, 0.5, 1].map((f) => ({
    pos: PAD.top + innerH - f * innerH,
    label: fmt(maxSpeed * f * TICKS_PER_SECOND, 1),
  }));
  const speedXTicks: ChartTick[] = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    pos: PAD.left + f * innerW,
    label: fmt((totalTicks * f) / TICKS_PER_SECOND, 1),
  }));

  return {
    path,
    speedPath,
    boostBands: bands.slice(0, 400),
    xTicks,
    yTicks,
    speedTicks,
    speedXTicks,
    summary: `Flight path over ${fmt(sim.distance)} blocks, ending ${fmt(-sim.altitudeChange)} blocks below the start, peaking at ${fmt(sim.peakHorizontalSpeed * TICKS_PER_SECOND, 1)} blocks per second`,
  };
});

const showChart = computed(
  () => mode.value === "glide" || mode.value === "cruise" || mode.value === "travel",
);

/* ---------------------------------------------------------------- */
/* detail rows                                                       */
/* ---------------------------------------------------------------- */

const glideRows = computed<Record<string, string>>(() => {
  const s = glideSteady.value;
  const best = bestGlide.value;
  const rows: Record<string, string> = {
    "Terminal glide speed": `${fmt(s.horizontalSpeed, 3)} forward and ${fmt(-s.verticalSpeed, 3)} down per tick`,
    "Terminal glide ratio": `${fmt(s.glideRatio, 2)} blocks forward per block down`,
    "Best pitch for range": `${fmt(best.pitchDeg, 1)} degrees, ${fmt(best.state.glideRatio, 2)} to 1`,
    "Speed with rockets at this pitch": `${fmt(cruiseSteady.value.horizontalSpeed * TICKS_PER_SECOND, 1)} blocks per second`,
  };
  return rows;
});

const tripRows = computed<Record<string, string>>(() => {
  const plan = trip.value.plan;
  if (!plan) return {};
  const rows: Record<string, string> = {
    "Overworld flight": `${fmt(plan.overworld.distance)} blocks, ${fmt(plan.overworld.rockets)} rockets, ${ticksToWords(plan.overworld.ticks)}`,
    "Overworld materials": `${fmt(plan.overworld.crafts)} crafts: ${fmt(plan.overworld.gunpowder)} gunpowder and ${fmt(plan.overworld.paper)} paper`,
    "Nether flight": `${fmt(plan.nether.distance)} blocks, ${fmt(plan.nether.rockets)} rockets, ${ticksToWords(plan.nether.ticks)}`,
    "Nether materials": `${fmt(plan.nether.crafts)} crafts: ${fmt(plan.nether.gunpowder)} gunpowder and ${fmt(plan.nether.paper)} paper`,
    "Rockets saved by the portal": fmt(Math.max(0, plan.overworld.rockets - plan.nether.rockets)),
  };
  return rows;
});

const wearRows = computed<Record<string, string>>(() => {
  const plan = wear.value.plan;
  if (!plan) return {};
  const rows: Record<string, string> = {
    Durability: `${fmt(plan.usableDurability)} usable of ${fmt(plan.maxDamage)}, flight cuts out with 1 point left`,
    "Flight per durability point": `${fmt(plan.expectedTicksPerDurability)} ticks (${fmt(plan.expectedTicksPerDurability / TICKS_PER_SECOND, 1)} s) at Unbreaking ${unbreaking.value}`,
    "Continuous flight": `${ticksToWords(plan.flightTicks)}, about ${fmt(plan.flightDistance)} blocks at level cruise`,
  };
  if (mending.value) {
    rows["Mending upkeep"] =
      `${fmt(plan.mendingXpPerSecond, 2)} experience per second of flight keeps it even, and ${fmt(plan.mendingXpToFullRepair)} points repair the damage it already has`;
  }
  rows["Anvil repair"] =
    `${fmt(plan.membranesToFull)} phantom membranes at ${fmt(plan.repairPerMembrane)} durability each, ${fmt(plan.anvilUses)} anvil uses, ${fmt(plan.levelsIgnoringPriorWork)} levels before the prior work penalty`;
  return rows;
});

const damageRows = computed<Record<string, string>>(() => {
  const d = selfDamage.value.value;
  if (!d) return {};
  const rows: Record<string, string> = {
    "When it fires": "the rocket reaches the end of its lifetime while attached to you",
    Damage: d.harmless
      ? "none, a rocket with no stars never explodes on the flier"
      : `${fmt(d.damage)} points, or ${fmt(d.hearts, 1)} hearts, before armor`,
    Falloff: "none for the flier: the attached glider always takes the full amount",
    "Damage type":
      "minecraft:fireworks, inside the explosion tag, so armor and Blast Protection both apply",
  };
  return rows;
});

/** The detail block for the active mode, rendered through the shared output view. */
const detailRows = computed<Record<string, string>>(() => {
  switch (mode.value) {
    case "travel":
      return tripRows.value;
    case "durability":
      return wearRows.value;
    case "damage":
      return damageRows.value;
    default:
      return glideRows.value;
  }
});

/* ---------------------------------------------------------------- */
/* URL fragment: shareable state (rule 6, never localStorage)        */
/* ---------------------------------------------------------------- */

watch(
  [
    version,
    mode,
    pitch,
    height,
    flightDuration,
    rocketInterval,
    useRockets,
    chainRockets,
    divePreamble,
    divePitch,
    diveTicks,
    targetX,
    targetZ,
    damage,
    unbreaking,
    mending,
    stars,
    slowFalling,
    activeProfile,
  ],
  () => {
    if (!mounted.value) return;
    writeFragment({
      opts: {
        v: version.value,
        m: mode.value,
        p: String(pitch.value),
        h: String(height.value),
        fd: String(flightDuration.value),
        ri: String(rocketInterval.value),
        rk: String(useRockets.value),
        ch: String(chainRockets.value),
        dv: String(divePreamble.value),
        dp: String(divePitch.value),
        dt: String(diveTicks.value),
        tx: String(targetX.value),
        tz: String(targetZ.value),
        dmg: String(damage.value),
        unb: String(unbreaking.value),
        mnd: String(mending.value),
        st: String(stars.value),
        sf: String(slowFalling.value),
        pr: activeProfile.value,
      },
    });
  },
);

onMounted(() => {
  const { opts } = readFragment();
  if (opts.v && (ELYTRA_VERSIONS as readonly string[]).includes(opts.v)) {
    version.value = opts.v as ElytraVersionId;
  }
  if (opts.m && MODES.some((m) => m.id === opts.m)) mode.value = opts.m as Mode;
  if (opts.p) pitch.value = clampNum(opts.p, -90, 90, 0);
  if (opts.h) height.value = clampInt(opts.h, 1, 10000, 100);
  if (opts.fd) flightDuration.value = clampInt(opts.fd, 1, 3, 1);
  if (opts.ri) rocketInterval.value = clampInt(opts.ri, 1, 600, 60);
  if (opts.rk !== undefined) useRockets.value = opts.rk === "true";
  if (opts.ch !== undefined) chainRockets.value = opts.ch !== "false";
  if (opts.dv !== undefined) divePreamble.value = opts.dv === "true";
  if (opts.dp) divePitch.value = clampNum(opts.dp, -90, 90, 45);
  if (opts.dt) diveTicks.value = clampInt(opts.dt, 1, 2000, 100);
  if (opts.tx) targetX.value = clampInt(opts.tx, -30000000, 30000000, 10000);
  if (opts.tz) targetZ.value = clampInt(opts.tz, -30000000, 30000000, 0);
  const maxDamage = ELYTRA_VERSION_DATA[version.value].maxDamage - 1;
  if (opts.dmg) damage.value = clampInt(opts.dmg, 0, maxDamage, 0);
  if (opts.unb) unbreaking.value = clampInt(opts.unb, 0, MAX_UNBREAKING, 0);
  if (opts.mnd !== undefined) mending.value = opts.mnd === "true";
  if (opts.st) stars.value = clampInt(opts.st, 0, MAX_FIREWORK_STARS, 1);
  if (opts.sf !== undefined) slowFalling.value = opts.sf === "true";
  // Restored as a hint only: activeProfile re-derives it if the rest of
  // the fragment does not actually describe that preset.
  if (opts.pr) explicitProfile.value = opts.pr;
  mounted.value = true;
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- header: mode and version -->
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div class="flex flex-col gap-1.5">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Mode
        </span>
        <div class="flex flex-wrap gap-2" role="group" aria-label="Calculator mode">
          <button
            v-for="m in MODES"
            :key="m.id"
            type="button"
            class="rounded-[10px] border px-3 py-1.5 text-sm transition-colors"
            :class="
              mode === m.id ? 'border-ring bg-accent font-semibold' : 'bg-secondary hover:bg-accent'
            "
            :aria-pressed="mode === m.id"
            @click="mode = m.id"
          >
            {{ m.label }}
          </button>
        </div>
      </div>
      <div class="flex w-44 flex-col gap-1.5">
        <Label for="mce-version" class="text-xs text-muted-foreground">Version</Label>
        <SearchableSelect
          id="mce-version"
          :spec="versionSpec"
          :model-value="version"
          @update:model-value="(v: string) => (version = v as ElytraVersionId)"
        />
      </div>
    </div>

    <!-- workbench: setup on the left, results on the right -->
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
      <!-- setup -->
      <section class="flex flex-col gap-3 rounded-[14px] border p-4" aria-label="Flight setup">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Flight setup
        </span>

        <template v-if="mode !== 'durability' && mode !== 'damage'">
          <div class="flex flex-col gap-1.5">
            <Label for="mce-profile" class="text-xs text-muted-foreground">Flight profile</Label>
            <SearchableSelect
              id="mce-profile"
              :spec="profileSpec"
              :model-value="activeProfile"
              @update:model-value="applyProfile"
            />
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div class="flex flex-col gap-1.5">
              <Label for="mce-pitch" class="text-xs text-muted-foreground">
                Pitch (down is positive)
              </Label>
              <Input
                id="mce-pitch"
                type="number"
                min="-90"
                max="90"
                step="0.5"
                :model-value="pitch"
                @update:model-value="
                  (v) => {
                    pitch = clampNum(v, -90, 90, 0);
                  }
                "
              />
            </div>
            <div v-if="mode === 'glide'" class="flex flex-col gap-1.5">
              <Label for="mce-height" class="text-xs text-muted-foreground">Height (blocks)</Label>
              <Input
                id="mce-height"
                type="number"
                min="1"
                max="10000"
                step="1"
                :model-value="height"
                @update:model-value="(v) => (height = clampInt(v, 1, 10000, 100))"
              />
            </div>
          </div>

          <div v-if="mode === 'travel'" class="grid grid-cols-2 gap-3">
            <div class="flex flex-col gap-1.5">
              <Label for="mce-x" class="text-xs text-muted-foreground">Target X</Label>
              <Input
                id="mce-x"
                type="number"
                step="1"
                :model-value="targetX"
                @update:model-value="(v) => (targetX = clampInt(v, -30000000, 30000000, 10000))"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label for="mce-z" class="text-xs text-muted-foreground">Target Z</Label>
              <Input
                id="mce-z"
                type="number"
                step="1"
                :model-value="targetZ"
                @update:model-value="(v) => (targetZ = clampInt(v, -30000000, 30000000, 0))"
              />
            </div>
          </div>

          <div v-if="mode === 'glide'" class="flex items-center justify-between gap-2">
            <Label for="mce-rockets" class="cursor-pointer text-xs text-muted-foreground">
              Fire rockets while gliding
            </Label>
            <Switch
              id="mce-rockets"
              :model-value="useRockets"
              @update:model-value="
                (v) => {
                  useRockets = Boolean(v);
                }
              "
            />
          </div>

          <template v-if="powered">
            <div class="flex flex-col gap-1.5">
              <Label for="mce-duration" class="text-xs text-muted-foreground">
                Firework flight duration
              </Label>
              <SearchableSelect
                id="mce-duration"
                :spec="durationSpec"
                :model-value="String(flightDuration)"
                @update:model-value="(v: string) => (flightDuration = Number(v))"
              />
            </div>
          </template>

          <template v-if="powered">
            <div class="flex items-center justify-between gap-2">
              <Label for="mce-chain" class="cursor-pointer text-xs text-muted-foreground">
                Chain them back to back
              </Label>
              <Switch
                id="mce-chain"
                :model-value="chainRockets"
                @update:model-value="
                  (v) => {
                    chainRockets = Boolean(v);
                  }
                "
              />
            </div>
            <div v-if="!chainRockets" class="flex flex-col gap-1.5">
              <Label for="mce-interval" class="text-xs text-muted-foreground">
                Ticks between rockets
              </Label>
              <Input
                id="mce-interval"
                type="number"
                min="1"
                max="600"
                step="1"
                :model-value="rocketInterval"
                @update:model-value="(v) => (rocketInterval = clampInt(v, 1, 600, 60))"
              />
            </div>
          </template>

          <div class="flex items-center justify-between gap-2">
            <Label for="mce-dive" class="cursor-pointer text-xs text-muted-foreground">
              Dive first, then hold the pitch above
            </Label>
            <Switch
              id="mce-dive"
              :model-value="divePreamble"
              @update:model-value="
                (v) => {
                  divePreamble = Boolean(v);
                }
              "
            />
          </div>
          <div v-if="divePreamble" class="grid grid-cols-2 gap-3">
            <div class="flex flex-col gap-1.5">
              <Label for="mce-dive-pitch" class="text-xs text-muted-foreground">Dive pitch</Label>
              <Input
                id="mce-dive-pitch"
                type="number"
                min="-90"
                max="90"
                step="0.5"
                :model-value="divePitch"
                @update:model-value="(v) => (divePitch = clampNum(v, -90, 90, 45))"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label for="mce-dive-ticks" class="text-xs text-muted-foreground">Dive ticks</Label>
              <Input
                id="mce-dive-ticks"
                type="number"
                min="1"
                max="2000"
                step="1"
                :model-value="diveTicks"
                @update:model-value="(v) => (diveTicks = clampInt(v, 1, 2000, 100))"
              />
            </div>
          </div>
        </template>

        <template v-if="mode === 'durability'">
          <div class="grid grid-cols-2 gap-3">
            <div class="flex flex-col gap-1.5">
              <Label for="mce-damage" class="text-xs text-muted-foreground">
                Damage so far (0 to {{ versionData.maxDamage - 1 }})
              </Label>
              <Input
                id="mce-damage"
                type="number"
                min="0"
                :max="versionData.maxDamage - 1"
                step="1"
                :model-value="damage"
                @update:model-value="(v) => (damage = clampInt(v, 0, versionData.maxDamage - 1, 0))"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label for="mce-unb" class="text-xs text-muted-foreground">Unbreaking (0 to 3)</Label>
              <Input
                id="mce-unb"
                type="number"
                min="0"
                :max="MAX_UNBREAKING"
                step="1"
                :model-value="unbreaking"
                @update:model-value="(v) => (unbreaking = clampInt(v, 0, MAX_UNBREAKING, 0))"
              />
            </div>
          </div>
          <div class="flex items-center justify-between gap-2">
            <Label for="mce-mending" class="cursor-pointer text-xs text-muted-foreground">
              Elytra has Mending
            </Label>
            <Switch
              id="mce-mending"
              :model-value="mending"
              @update:model-value="(v) => (mending = Boolean(v))"
            />
          </div>
          <p class="text-xs text-muted-foreground">
            Only {{ ELYTRA_ENCHANTS.map((e) => e.label).join(", ") }} can go on an elytra. It is not
            armor, so Protection and its family are not offered here, and Unbreaking works at the
            full rate instead of the reduced armor rate.
          </p>
        </template>

        <template v-if="mode === 'damage'">
          <div class="flex flex-col gap-1.5">
            <Label for="mce-stars" class="text-xs text-muted-foreground">
              Firework stars in the rocket (0 to {{ MAX_FIREWORK_STARS }})
            </Label>
            <Input
              id="mce-stars"
              type="number"
              min="0"
              :max="MAX_FIREWORK_STARS"
              step="1"
              :model-value="stars"
              @update:model-value="(v) => (stars = clampInt(v, 0, MAX_FIREWORK_STARS, 1))"
            />
          </div>
          <p class="text-xs text-muted-foreground">
            One paper and one gunpowder leave 7 crafting slots, so a rocket holds at most 7 stars. A
            plain rocket with no stars is completely safe to fly with.
          </p>
        </template>

        <div class="flex items-center justify-between gap-2 border-t pt-3">
          <Label for="mce-slow" class="cursor-pointer text-xs text-muted-foreground">
            Slow Falling effect
          </Label>
          <Switch
            id="mce-slow"
            :model-value="slowFalling"
            @update:model-value="(v) => (slowFalling = Boolean(v))"
          />
        </div>
      </section>

      <!-- results -->
      <section class="flex min-w-0 flex-col gap-3" aria-label="Results" aria-live="polite">
        <ErrorBanner
          v-if="simulation.error"
          :message="simulation.error.message"
          :hint="simulation.error.fix"
        />
        <ErrorBanner
          v-else-if="wear.error && mode === 'durability'"
          :message="wear.error.message"
          :hint="wear.error.fix"
        />

        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div
            v-for="tile in tiles"
            :key="tile.label"
            class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]"
          >
            <div class="text-xs text-muted-foreground">{{ tile.label }}</div>
            <div class="font-mono text-lg tabular-nums">{{ tile.value }}</div>
            <div v-if="tile.hint" class="text-xs text-muted-foreground">{{ tile.hint }}</div>
          </div>
        </div>

        <!-- flight path -->
        <template v-if="showChart && chart">
          <div class="flex flex-col gap-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Flight path
            </span>
            <div class="overflow-x-auto rounded-[10px] bg-secondary p-2 shadow-[var(--sh-inset)]">
              <svg
                :width="CHART_W"
                :height="CHART_H"
                :viewBox="`0 0 ${CHART_W} ${CHART_H}`"
                role="img"
                :aria-label="chart.summary"
                class="text-primary"
              >
                <g class="text-border" stroke="currentColor" stroke-width="1">
                  <line
                    v-for="t in chart.yTicks"
                    :key="`fy${t.pos}`"
                    :x1="PAD.left"
                    :x2="CHART_W - PAD.right"
                    :y1="t.pos"
                    :y2="t.pos"
                    opacity="0.6"
                  />
                </g>
                <g class="text-muted-foreground" fill="currentColor" font-size="11">
                  <text
                    v-for="t in chart.yTicks"
                    :key="`fyl${t.pos}`"
                    :x="PAD.left - 6"
                    :y="t.pos + 4"
                    text-anchor="end"
                  >
                    {{ t.label }}
                  </text>
                  <text
                    v-for="t in chart.xTicks"
                    :key="`fxl${t.pos}`"
                    :x="t.pos"
                    :y="CHART_H - 8"
                    text-anchor="middle"
                  >
                    {{ t.label }}
                  </text>
                </g>
                <polyline
                  :points="chart.path"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linejoin="round"
                />
              </svg>
            </div>
            <p class="text-xs text-muted-foreground">
              Altitude relative to the launch point (vertical) against horizontal distance
              (horizontal), one point per simulated tick.
            </p>
          </div>

          <!-- speed -->
          <div class="flex flex-col gap-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Speed over time
            </span>
            <div class="overflow-x-auto rounded-[10px] bg-secondary p-2 shadow-[var(--sh-inset)]">
              <svg
                :width="CHART_W"
                :height="CHART_H"
                :viewBox="`0 0 ${CHART_W} ${CHART_H}`"
                role="img"
                aria-label="Horizontal speed in blocks per second against time in seconds, with shaded bands where a firework rocket is boosting"
                class="text-primary"
              >
                <g class="text-primary">
                  <rect
                    v-for="(b, i) in chart.boostBands"
                    :key="`bb${i}`"
                    :x="b.x"
                    :width="b.width"
                    :y="PAD.top"
                    :height="CHART_H - PAD.top - PAD.bottom"
                    fill="currentColor"
                    opacity="0.12"
                  />
                </g>
                <g class="text-border" stroke="currentColor" stroke-width="1">
                  <line
                    v-for="t in chart.speedTicks"
                    :key="`sy${t.pos}`"
                    :x1="PAD.left"
                    :x2="CHART_W - PAD.right"
                    :y1="t.pos"
                    :y2="t.pos"
                    opacity="0.6"
                  />
                </g>
                <g class="text-muted-foreground" fill="currentColor" font-size="11">
                  <text
                    v-for="t in chart.speedTicks"
                    :key="`syl${t.pos}`"
                    :x="PAD.left - 6"
                    :y="t.pos + 4"
                    text-anchor="end"
                  >
                    {{ t.label }}
                  </text>
                  <text
                    v-for="t in chart.speedXTicks"
                    :key="`sxl${t.pos}`"
                    :x="t.pos"
                    :y="CHART_H - 8"
                    text-anchor="middle"
                  >
                    {{ t.label }}
                  </text>
                </g>
                <polyline
                  :points="chart.speedPath"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linejoin="round"
                />
              </svg>
            </div>
            <p class="text-xs text-muted-foreground">
              Blocks per second against seconds. Shaded bands are ticks where a rocket is boosting
              you. Dive first and then level off to see the speed spike: the game keeps converting
              your remaining descent into forward speed for a moment after you flatten out.
            </p>
          </div>
        </template>
      </section>
    </div>

    <!-- detail -->
    <div class="flex flex-col gap-2 rounded-[14px] border p-4">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        {{
          mode === "travel"
            ? "Overworld against the Nether"
            : mode === "durability"
              ? "Wear and repair"
              : mode === "damage"
                ? "The firework gotcha"
                : "Steady state at this pitch"
        }}
      </span>
      <div aria-live="polite">
        <OutputView :output="detailRows" />
      </div>
      <p v-if="mode === 'travel'" class="text-xs text-muted-foreground">
        One block in the Nether covers {{ NETHER_RATIO }} in the Overworld, so a linked portal pair
        turns a long flight into a short one. The comparison assumes you have portals at both ends
        and a clear path; the Nether roof is at y 128, so plan the route around it.
      </p>
      <p v-if="mode !== 'travel' && mode !== 'damage'" class="text-xs text-muted-foreground">
        The simulation flies a straight heading with no blocks, water, or collisions, starting from
        rest, and evaluates each rocket at the mean of its lifetime roll. Real flights differ where
        you steer, where terrain gets in the way, and where a rocket rolls short or long.
      </p>
    </div>

    <p class="text-xs text-muted-foreground">
      Physics reimplemented from decompiled and unobfuscated game code for 1.16.5, 1.18.2, 1.20.6,
      1.21.1, 1.21.11, and 26.2, where the flight equations are identical. The elytra became a data
      driven glider component between 1.21.1 and
      {{ GLIDER_COMPONENT_FROM ?? "a later release" }}. Not an official Minecraft product. Not
      approved by or associated with Mojang or Microsoft.
    </p>
  </div>
</template>

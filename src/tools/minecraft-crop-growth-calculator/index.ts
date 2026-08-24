import { ToolError, type ToolLogic } from "../types";
import {
  ANIMAL_BY_ID,
  CONSTANTS,
  GROWTH_VERSIONS,
  PLANT_BY_ID,
  plantModel,
  type AnimalInfo,
  type BonemealModel,
  type GrowthConstants,
  type PlantInfo,
  type PlantModel,
} from "./data";

/**
 * Minecraft crop growth, farm layout, bone meal, and animal breeding timings.
 *
 * Every number is derived from the real per-version mechanics, which were read
 * out of decompiled server source under mc-pipeline/work/<version>/src/ by
 * mc-pipeline/12-emit-growth-data.mjs (see data.ts). The mechanics, in the
 * order this file applies them:
 *
 * - ServerLevel#tickChunk picks `randomTickSpeed` positions per chunk SECTION
 *   per game tick, uniformly at random with replacement out of 16x16x16 = 4096
 *   blocks. So one block gets `randomTickSpeed` independent 1/4096 draws per
 *   game tick, not one 3/4096 draw. That distinction is what makes the exact
 *   distribution below a negative binomial over draws.
 * - CropBlock#getGrowthSpeed sums 1 for the block itself, 1 for dry farmland or
 *   3 for moist farmland directly below, and a QUARTER of that weight for each
 *   of the eight blocks around the one below. Anything that is not farmland
 *   contributes nothing, which is why water channels are not free. The result
 *   is halved when the same plant sits on both horizontal axes, and halved when
 *   it sits diagonally but not on both axes.
 * - CropBlock#randomTick grows the crop when nextInt(floor(25 / speed) + 1) is
 *   0, so the per random tick chance is exactly 1 / (floor(25 / speed) + 1).
 * - BeetrootBlock and TorchflowerCropBlock override randomTick with an extra
 *   nextInt(3) != 0 gate, so they only attempt that roll on two random ticks
 *   out of three. Beetroot is measurably slower than wheat per stage because
 *   of it, and no other crop has the gate.
 * - Plants that ignore farmland use their own flat roll instead: nether wart
 *   1/10, cocoa 1/5, sweet berry bush 1/5, sapling 1/7, bamboo 1/3, kelp 0.14,
 *   cave vines and nether vines 0.1. Sugar cane and cactus advance on EVERY
 *   random tick and need 16 of them per new block.
 * - BoneMealItem#growCrop consumes the item whenever the block is a valid
 *   target, even when the block's own success roll fails (saplings), which is
 *   why a sapling costs more bone meal than its stage count suggests.
 * - Animal#setInLove sets 600 ticks of love mode, breeding sets both parents to
 *   age 6000 (the cooldown), and AgeableMob starts babies at age -24000.
 *   AgeableMob#getSpeedUpSecondsWhenFeeding is (int)(ticks / 20 * 0.1f), an
 *   integer division that rounds to zero once under 200 ticks remain.
 */

// ------------------------------------------------------------- helpers ----

/** Float32 rounding, matching the game's `float` growth speed arithmetic. */
const f32 = Math.fround;

function constants(version: string): GrowthConstants {
  const c = CONSTANTS[version];
  if (!c) {
    throw new ToolError(
      "unknown-version",
      `No growth data for Minecraft ${version}.`,
      `Pick one of ${GROWTH_VERSIONS.join(", ")}.`,
    );
  }
  return c;
}

function plantFor(id: string, version: string): PlantInfo {
  const plant = PLANT_BY_ID.get(id);
  if (!plant) {
    throw new ToolError("unknown-plant", `No plant called "${id}".`, "Pick a plant from the list.");
  }
  if (!plant.versions.includes(version)) {
    throw new ToolError(
      "plant-not-in-version",
      `${plant.label} does not exist in Minecraft ${version}.`,
      `It is available in ${plant.versions.join(", ")}.`,
    );
  }
  return plant;
}

// ---------------------------------------------------------- farm layout ----

/** How much same-plant crowding the growth speed check sees. */
export type Crowding =
  /** No neighboring plant of the same kind, orthogonally or diagonally. */
  | "none"
  /** Same plant on one horizontal axis only, with the diagonals clear. */
  | "row"
  /** Same plant on both horizontal axes. */
  | "grid"
  /** Same plant only on a diagonal. */
  | "diagonal";

export interface FarmLayout {
  /** The farmland directly below has moisture above 0. */
  centerHydrated: boolean;
  /** How many of the eight blocks around the one below are farmland (0 to 8). */
  neighbourFarmland: number;
  /** Those farmland blocks are hydrated. */
  neighbourHydrated: boolean;
  crowding: Crowding;
}

export interface LayoutPreset {
  id: string;
  label: string;
  /** Share of the farm footprint that actually holds a plant. */
  density: number;
  layout: FarmLayout;
  note: string;
}

/**
 * The layouts people actually argue about, so the tool can answer "which one
 * is faster" with throughput rather than with per-plant speed.
 *
 * `density` is the fraction of the footprint that is planted: a row layout is
 * twice as fast per plant but only half of it grows anything, which is the
 * whole point of the comparison.
 */
export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: "rows",
    label: "Hydrated rows, one bare farmland row between",
    density: 0.5,
    layout: {
      centerHydrated: true,
      neighbourFarmland: 8,
      neighbourHydrated: true,
      crowding: "row",
    },
    note: "Every block is still farmland and still hydrated, but the plant only has neighbors on one axis, so the crowding halving never applies.",
  },
  {
    id: "full",
    label: "Fully planted hydrated field",
    density: 1,
    layout: {
      centerHydrated: true,
      neighbourFarmland: 8,
      neighbourHydrated: true,
      crowding: "grid",
    },
    note: "The classic 9x9 with water in the middle behaves like this: every farmland block is inside the hydration range, and every plant is crowded on both axes.",
  },
  {
    id: "water-rows",
    label: "Crop rows alternating with water channels",
    density: 0.5,
    layout: {
      centerHydrated: true,
      neighbourFarmland: 2,
      neighbourHydrated: true,
      crowding: "row",
    },
    note: "Water is not farmland, so the six blocks that became water contribute nothing to growth speed. This layout is slower per plant than a plain hydrated field.",
  },
  {
    id: "dry-full",
    label: "Fully planted field, no water in range",
    density: 1,
    layout: {
      centerHydrated: false,
      neighbourFarmland: 8,
      neighbourHydrated: false,
      crowding: "grid",
    },
    note: "Dry farmland is worth 1 instead of 3, so the whole field runs at a fraction of the hydrated speed.",
  },
  {
    id: "dry-rows",
    label: "Rows on dry farmland",
    density: 0.5,
    layout: {
      centerHydrated: false,
      neighbourFarmland: 8,
      neighbourHydrated: false,
      crowding: "row",
    },
    note: "Uncrowded but unhydrated: still far behind any layout with water inside the hydration range.",
  },
  {
    id: "single",
    label: "One plant on a lone hydrated farmland block",
    density: 1,
    layout: {
      centerHydrated: true,
      neighbourFarmland: 0,
      neighbourHydrated: true,
      crowding: "none",
    },
    note: "Nothing around it is farmland, so only the block below contributes. This is the speed a single tilled block in a grass field gets.",
  },
];

export const LAYOUT_PRESET_BY_ID: Map<string, LayoutPreset> = new Map(
  LAYOUT_PRESETS.map((l) => [l.id, l]),
);

/**
 * CropBlock#getGrowthSpeed, reimplemented over a described layout instead of a
 * real world. Neighboring blocks that are not farmland simply add nothing.
 */
export function growthSpeed(layout: FarmLayout, version: string): number {
  const c = constants(version);
  const neighbors = Math.min(8, Math.max(0, Math.floor(layout.neighbourFarmland)));
  const centerWeight = layout.centerHydrated ? c.speedMoistFarmland : c.speedFarmland;
  const neighbourWeight = layout.neighbourHydrated ? c.speedMoistFarmland : c.speedFarmland;
  let speed = f32(c.speedBase + centerWeight);
  const per = f32(neighbourWeight / c.speedNeighbourDivisor);
  for (let i = 0; i < neighbors; i++) speed = f32(speed + per);
  if (layout.crowding === "grid" || layout.crowding === "diagonal") {
    speed = f32(speed / c.speedCrowdDivisor);
  }
  return speed;
}

/** 1 / (floor(25 / speed) + 1), the exact per random tick growth chance. */
export function cropGrowthChance(speed: number, version: string): number {
  const c = constants(version);
  if (speed <= 0) return 0;
  return 1 / (Math.floor(f32(c.growthDivisor / speed)) + 1);
}

/** The chance one random tick advances this plant by one stage. */
export function stageChance(model: PlantModel, speed: number, version: string): number {
  switch (model.model.kind) {
    case "crop":
      return cropGrowthChance(speed, version) * (model.model.gate ?? 1);
    case "fixed":
      return model.model.chance;
    case "always":
      return 1;
  }
}

// ---------------------------------------------- negative binomial timing ----

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** Log gamma (Lanczos, g = 7). Accurate to well past the precision we need. */
function lgamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i++) a += LANCZOS[i] / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function lchoose(n: number, k: number): number {
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
}

/** P(at least `k` successes in `n` independent Bernoulli(`s`) trials). */
function atLeast(n: number, k: number, s: number): number {
  if (k <= 0) return 1;
  if (n < k) return 0;
  const logS = Math.log(s);
  const logQ = Math.log1p(-s);
  let below = 0;
  for (let i = 0; i < k; i++) {
    below += Math.exp(lchoose(n, i) + i * logS + (n - i) * logQ);
  }
  return Math.min(1, Math.max(0, 1 - below));
}

export interface TimingStats {
  /** Successful growth steps required. */
  steps: number;
  /** Chance one random tick produces a step. */
  chancePerRandomTick: number;
  /** Chance one game tick produces a step (all draws combined). */
  chancePerGameTick: number;
  /** Expected game ticks. Exact expectation of the underlying draw count. */
  meanTicks: number;
  /** Half of all plants are done by this tick. */
  medianTicks: number;
  /** The fastest 5 percent are done by this tick. */
  p5Ticks: number;
  /** The slowest 5 percent are still growing at this tick. */
  p95Ticks: number;
  /** Standard deviation of the finish time, in game ticks. */
  stdDevTicks: number;
}

/**
 * Exact finish-time statistics for a plant needing `steps` successful growth
 * rolls, given `chance` per random tick and `randomTickSpeed` draws per game
 * tick. Each draw is an independent Bernoulli trial with probability
 * chance / blocksPerSection, so the number of draws is negative binomial and
 * the tick count is that divided by the draws per tick.
 */
export function timing(
  steps: number,
  chance: number,
  randomTickSpeed: number,
  version: string,
): TimingStats {
  const c = constants(version);
  const rts = Math.max(0, Math.floor(randomTickSpeed));
  const perDraw = chance / c.blocksPerSection;
  const perGameTick = 1 - (1 - perDraw) ** rts;
  if (rts === 0 || chance <= 0 || steps <= 0) {
    return {
      steps,
      chancePerRandomTick: chance,
      chancePerGameTick: perGameTick,
      meanTicks: rts === 0 || chance <= 0 ? Infinity : 0,
      medianTicks: rts === 0 || chance <= 0 ? Infinity : 0,
      p5Ticks: rts === 0 || chance <= 0 ? Infinity : 0,
      p95Ticks: rts === 0 || chance <= 0 ? Infinity : 0,
      stdDevTicks: rts === 0 || chance <= 0 ? Infinity : 0,
    };
  }
  const meanDraws = steps / perDraw;
  const varDraws = (steps * (1 - perDraw)) / perDraw ** 2;
  const mean = meanDraws / rts;

  const cdf = (ticks: number): number => atLeast(rts * ticks, steps, perDraw);
  const quantile = (q: number): number => {
    let hi = Math.max(1, Math.ceil(mean));
    while (cdf(hi) < q) hi *= 2;
    let lo = 0;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (cdf(mid) >= q) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };

  return {
    steps,
    chancePerRandomTick: chance,
    chancePerGameTick: perGameTick,
    meanTicks: mean,
    medianTicks: quantile(0.5),
    p5Ticks: quantile(0.05),
    p95Ticks: quantile(0.95),
    stdDevTicks: Math.sqrt(varDraws) / rts,
  };
}

/** Sampled cumulative finish probability, for the distribution chart. */
export function finishCurve(
  steps: number,
  chance: number,
  randomTickSpeed: number,
  version: string,
  points = 60,
): { ticks: number; cdf: number }[] {
  const stats = timing(steps, chance, randomTickSpeed, version);
  if (!Number.isFinite(stats.p95Ticks) || stats.p95Ticks <= 0) return [];
  const c = constants(version);
  const perDraw = chance / c.blocksPerSection;
  const rts = Math.max(1, Math.floor(randomTickSpeed));
  const end = Math.ceil(stats.p95Ticks * 1.35);
  const out: { ticks: number; cdf: number }[] = [];
  for (let i = 0; i <= points; i++) {
    const ticks = Math.round((i / points) * end);
    out.push({ ticks, cdf: atLeast(rts * ticks, steps, perDraw) });
  }
  return out;
}

// --------------------------------------------------------- bone meal ------

export interface BonemealResult {
  /** Expected bone meal items consumed to finish from freshly planted. */
  expectedUses: number;
  /** True when the plant cannot be bone mealed at all. */
  unsupported: boolean;
  /** Plain-language description of what one bone meal does. */
  effect: string;
}

/**
 * Expected bone meal items to take a plant from freshly planted to harvestable.
 *
 * Every branch is an exact expectation, not a simulation. The "divided" branch
 * (beetroot) can advance nothing at all, which turns the recurrence into a
 * fixed point rather than a plain sum, and is exactly why beetroot costs almost
 * twice the bone meal of wheat despite needing fewer than half the stages.
 */
export function bonemealUses(model: PlantModel): BonemealResult {
  const bm: BonemealModel | null = model.bonemeal;
  if (!bm) {
    return {
      expectedUses: 0,
      unsupported: true,
      effect: "Bone meal does nothing to this plant.",
    };
  }
  const steps = model.stages;
  if (bm.kind === "fixed") {
    return {
      expectedUses: Math.ceil(steps / bm.amount),
      unsupported: false,
      effect: `Each bone meal advances exactly ${bm.amount} stage${bm.amount === 1 ? "" : "s"}.`,
    };
  }
  if (bm.kind === "chance") {
    return {
      expectedUses: Math.ceil(steps / bm.amount) / bm.success,
      unsupported: false,
      effect: `Each bone meal has a ${(bm.success * 100).toFixed(0)} percent chance to advance a stage, and the item is consumed either way.`,
    };
  }
  if (bm.kind === "blocks") {
    const avg = (bm.min + bm.max) / 2;
    return {
      expectedUses: 1 / avg,
      unsupported: false,
      effect:
        bm.min === bm.max
          ? `Each bone meal adds ${bm.min} block.`
          : `Each bone meal adds ${bm.min} to ${bm.max} blocks, ${avg} on average.`,
    };
  }

  // uniform and divided: dynamic programming over stages remaining.
  const divisor = bm.kind === "divided" ? bm.divisor : 1;
  const increments: number[] = [];
  for (let d = bm.min; d <= bm.max; d++) increments.push(Math.floor(d / divisor));
  const n = increments.length;
  const expected = new Array<number>(steps + 1).fill(0);
  for (let r = 1; r <= steps; r++) {
    let sum = 1;
    let stall = 0;
    for (const inc of increments) {
      if (inc <= 0) stall += 1;
      else sum += expected[Math.max(0, r - inc)] / n;
    }
    // r appears on both sides when a roll can advance nothing: solve for it.
    expected[r] = sum / (1 - stall / n);
  }
  const effect =
    bm.kind === "divided"
      ? `Each bone meal rolls ${bm.min} to ${bm.max} and divides by ${divisor}, so ${((increments.filter((i) => i === 0).length / n) * 100).toFixed(0)} percent of uses advance nothing at all.`
      : `Each bone meal advances ${bm.min} to ${bm.max} stages, chosen uniformly.`;
  return { expectedUses: expected[steps], unsupported: false, effect };
}

// --------------------------------------------------------- calculation ----

export interface GrowthOptions {
  version: string;
  plant: string;
  /** A LAYOUT_PRESETS id, or "custom" to use the explicit layout fields. */
  layout?: string;
  custom?: Partial<FarmLayout>;
  randomTickSpeed?: number;
  /** Stems: how many of the four sides can actually take a fruit (1 to 4). */
  fruitSides?: number;
  /** Chunk loaded and ticking. False means growth is paused entirely. */
  chunkTicking?: boolean;
}

export interface LayoutRow {
  id: string;
  label: string;
  speed: number;
  chancePerRandomTick: number;
  meanTicks: number;
  density: number;
  /** Harvests per real hour per block of farm footprint. */
  yieldPerHourPerBlock: number;
  note: string;
}

export interface TickSpeedRow {
  randomTickSpeed: number;
  meanTicks: number;
  meanMinutes: number;
  /** Speed relative to the default random tick speed. */
  relative: number;
}

export interface GrowthResult {
  version: string;
  plant: PlantInfo;
  model: PlantModel;
  layoutId: string;
  layout: FarmLayout;
  speed: number | null;
  randomTickSpeed: number;
  timing: TimingStats;
  /** Stems only: extra time for the fruit to appear after the stem matures. */
  fruit: { sides: number; expectedRolls: number; meanTicks: number } | null;
  layouts: LayoutRow[];
  tickSpeeds: TickSpeedRow[];
  bonemeal: BonemealResult;
  curve: { ticks: number; cdf: number }[];
  notes: string[];
}

const TICK_SPEED_ROWS = [1, 2, 3, 4, 6, 10, 20, 50, 100];

export function calculate(opts: GrowthOptions): GrowthResult {
  const version = opts.version || GROWTH_VERSIONS[GROWTH_VERSIONS.length - 1];
  const c = constants(version);
  const plant = plantFor(opts.plant, version);
  const model = plantModel(plant, version);
  const rts = Math.max(
    0,
    Math.min(4096, Math.floor(opts.randomTickSpeed ?? c.randomTickSpeedDefault)),
  );
  const ticking = opts.chunkTicking !== false;
  const notes: string[] = [];

  const presetId = opts.layout && LAYOUT_PRESET_BY_ID.has(opts.layout) ? opts.layout : "custom";
  const preset = LAYOUT_PRESET_BY_ID.get(presetId);
  const layout: FarmLayout = model.farmland
    ? {
        centerHydrated: opts.custom?.centerHydrated ?? preset?.layout.centerHydrated ?? true,
        neighbourFarmland: opts.custom?.neighbourFarmland ?? preset?.layout.neighbourFarmland ?? 8,
        neighbourHydrated:
          opts.custom?.neighbourHydrated ?? preset?.layout.neighbourHydrated ?? true,
        crowding: opts.custom?.crowding ?? preset?.layout.crowding ?? "row",
      }
    : { centerHydrated: false, neighbourFarmland: 0, neighbourHydrated: false, crowding: "none" };

  const speed = model.farmland ? growthSpeed(layout, version) : null;
  const chance = stageChance(model, speed ?? 0, version);
  const effectiveRts = ticking ? rts : 0;
  const stats = timing(model.stages, chance, effectiveRts, version);

  if (!ticking) {
    notes.push(
      c.randomTickGate === "player-near-for-spawning"
        ? `Chunk ticking is off in this calculation, which in ${version} is stricter than it sounds: ServerChunkCache.tickChunks only reaches the random tick loop inside the natural spawning branch, gated on ${c.randomTickGateMethod}, so a chunk with no player close enough for spawning grows nothing at all.`
        : `Chunk ticking is off in this calculation. From ${version} random ticking runs over the block ticking chunks (${c.randomTickGateMethod}), so a farm outside the server's simulation distance does not grow at all.`,
    );
  }
  if (rts === 0 && ticking) {
    notes.push(
      `A random tick speed of 0 stops all growth: the ${c.randomTickGameRule} game rule controls how many block positions each chunk section rolls per tick.`,
    );
  }
  if (model.light !== null) {
    notes.push(
      `This plant only grows when the light level where it is checked is at least ${model.light}, so an unlit farm never advances no matter how long you wait.`,
    );
  }
  if (model.perBlock) {
    notes.push(
      `Times are for ONE new block. ${model.maxHeight ? `The column stops at ${model.maxHeight} blocks.` : ""}`.trim(),
    );
  }
  if (!model.farmland) {
    notes.push(
      "This plant ignores farmland entirely, so hydration and field layout change nothing about its speed.",
    );
  }
  if (model.berryChance !== undefined) {
    notes.push(
      `A newly grown vine block carries glow berries with probability ${model.berryChance}.`,
    );
  }

  // Stems keep rolling after the stem matures: each success picks one of the
  // four horizontal sides and only produces a fruit if that side is valid.
  let fruit: GrowthResult["fruit"] = null;
  if (model.fruitSides) {
    const sides = Math.max(
      1,
      Math.min(model.fruitSides, Math.floor(opts.fruitSides ?? model.fruitSides)),
    );
    const expectedRolls = model.fruitSides / sides;
    const perRoll = timing(1, chance, effectiveRts, version);
    fruit = { sides, expectedRolls, meanTicks: perRoll.meanTicks * expectedRolls };
    notes.push(
      `After the stem reaches its last stage it keeps rolling: each success picks one of the ${model.fruitSides} horizontal sides at random, and a fruit only appears if that side is free. With ${sides} usable side${sides === 1 ? "" : "s"} that is ${expectedRolls.toFixed(2)} successful rolls per fruit.`,
    );
  }

  const layouts: LayoutRow[] = model.farmland
    ? LAYOUT_PRESETS.map((p) => {
        const s = growthSpeed(p.layout, version);
        const ch = stageChance(model, s, version);
        const t = timing(model.stages, ch, effectiveRts, version);
        const cycleTicks = t.meanTicks + (fruit ? fruit.meanTicks : 0);
        const perHour =
          Number.isFinite(cycleTicks) && cycleTicks > 0
            ? (3600 * c.ticksPerSecond * p.density) / cycleTicks
            : 0;
        return {
          id: p.id,
          label: p.label,
          speed: s,
          chancePerRandomTick: ch,
          meanTicks: t.meanTicks,
          density: p.density,
          yieldPerHourPerBlock: perHour,
          note: p.note,
        };
      })
    : [];

  const tickSpeeds: TickSpeedRow[] = TICK_SPEED_ROWS.map((n) => {
    const t = timing(model.stages, chance, n, version);
    const base = timing(model.stages, chance, c.randomTickSpeedDefault, version);
    return {
      randomTickSpeed: n,
      meanTicks: t.meanTicks,
      meanMinutes: t.meanTicks / (c.ticksPerSecond * 60),
      relative: base.meanTicks / t.meanTicks,
    };
  });

  return {
    version,
    plant,
    model,
    layoutId: presetId,
    layout,
    speed,
    randomTickSpeed: rts,
    timing: stats,
    fruit,
    layouts,
    tickSpeeds,
    bonemeal: bonemealUses(model),
    curve: finishCurve(model.stages, chance, effectiveRts, version),
    notes,
  };
}

// ----------------------------------------------------------- breeding -----

export interface BreedingOptions {
  version: string;
  animal: string;
  /** Feed the baby to speed it up instead of waiting it out. */
  feedBaby?: boolean;
  /** How many breeding pairs the farm runs. */
  pairs?: number;
}

export interface BreedingResult {
  version: string;
  animal: AnimalInfo;
  /** Ticks of love mode after one feed. */
  loveTicks: number;
  /** Ticks before a parent can breed again. */
  cooldownTicks: number;
  /** Ticks for an unfed baby to become an adult. */
  babyTicks: number;
  /** Feeds needed before the speed up rounds to zero. */
  feedsToAdult: number;
  /** Ticks the baby still has to wait after the last useful feed. */
  ticksAfterFeeding: number;
  /** Ticks of growth removed by the first feed, the biggest single saving. */
  firstFeedSavesTicks: number;
  /** Food items per baby produced, counting both parents. */
  foodPerBaby: number;
  /** Food items per baby when the baby is also fed to adulthood. */
  foodPerAdult: number;
  /** Babies per real hour across all pairs. */
  babiesPerHour: number;
  notes: string[];
}

export function breeding(opts: BreedingOptions): BreedingResult {
  const version = opts.version || GROWTH_VERSIONS[GROWTH_VERSIONS.length - 1];
  const c = constants(version);
  const animal = ANIMAL_BY_ID.get(opts.animal);
  if (!animal) {
    throw new ToolError(
      "unknown-animal",
      `No animal called "${opts.animal}".`,
      "Pick an animal from the list.",
    );
  }
  if (!animal.versions.includes(version)) {
    throw new ToolError(
      "animal-not-in-version",
      `${animal.label} does not exist in Minecraft ${version}.`,
      `It is available in ${animal.versions.join(", ")}.`,
    );
  }
  const pairs = Math.max(1, Math.floor(opts.pairs ?? 1));

  // AgeableMob#getSpeedUpSecondsWhenFeeding: (int)(remaining / 20 * 0.1f).
  // Both the seconds conversion and the tenth are integer truncations, so the
  // saving falls to zero once fewer than 200 ticks remain.
  let remaining = c.babyGrowTicks;
  let feeds = 0;
  let firstSaving = 0;
  for (;;) {
    const seconds = Math.floor(remaining / c.ticksPerSecond);
    const speedUpSeconds = Math.floor(seconds * c.feedFraction);
    if (speedUpSeconds <= 0) break;
    const saved = speedUpSeconds * c.ticksPerSecond;
    if (feeds === 0) firstSaving = saved;
    remaining -= saved;
    feeds += 1;
  }

  const notes = [
    `Feeding a baby removes ${(c.feedFraction * 100).toFixed(0)} percent of its REMAINING growth time, not a fixed amount, so each feed is worth less than the one before it. The first feed saves ${firstSaving} ticks and the last useful one saves ${c.ticksPerSecond} ticks.`,
    `Once fewer than ${c.ticksPerSecond * 10} ticks remain the speed up truncates to zero, so the final ${(remaining / c.ticksPerSecond).toFixed(1)} seconds cannot be fed away.`,
    `Breeding sets both parents to age ${c.breedCooldownTicks}, which counts down one per tick, so a pair produces at most one baby every ${(c.breedCooldownTicks / c.ticksPerSecond / 60).toFixed(0)} minutes.`,
  ];
  if (animal.special === "eggs") {
    notes.push(
      `${animal.label} do not spawn a baby directly: breeding produces eggs that hatch on their own timer, so the food cost per animal is the same but the arrival time is not.`,
    );
  }
  if (animal.special === "tadpole") {
    notes.push(
      `${animal.label} lay eggs that hatch into tadpoles, which grow on their own timer rather than the standard baby age counter.`,
    );
  }

  return {
    version,
    animal,
    loveTicks: c.loveTicks,
    cooldownTicks: c.breedCooldownTicks,
    babyTicks: c.babyGrowTicks,
    feedsToAdult: feeds,
    ticksAfterFeeding: remaining,
    firstFeedSavesTicks: firstSaving,
    foodPerBaby: 2,
    foodPerAdult: 2 + feeds,
    babiesPerHour: (3600 * c.ticksPerSecond * pairs) / c.breedCooldownTicks,
    notes,
  };
}

// ------------------------------------------------------------ formatting --

/** Game ticks as a short human duration, using the game's own tick rate. */
export function formatTicks(ticks: number, version: string): string {
  if (!Number.isFinite(ticks)) return "never";
  const c = constants(version);
  const seconds = ticks / c.ticksPerSecond;
  if (seconds < 90) return `${seconds.toFixed(1)} s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${minutes.toFixed(1)} min`;
  return `${(minutes / 60).toFixed(2)} h`;
}

/** Game ticks as Minecraft days, where one day is 24000 ticks. */
export function inGameDays(ticks: number): number {
  return ticks / 24000;
}

// ------------------------------------------------------------- run() API --

export interface GrowthRunOpts {
  version?: string;
  plant?: string;
  layout?: string;
  randomTickSpeed?: number;
  fruitSides?: number;
  animal?: string;
  [key: string]: unknown;
}

export function run(input: string, opts: GrowthRunOpts): Record<string, string> {
  const version = opts.version ?? GROWTH_VERSIONS[GROWTH_VERSIONS.length - 1];
  const plantId = (input || "").trim() || opts.plant || "wheat";
  const result = calculate({
    version,
    plant: plantId,
    layout: opts.layout ?? "full",
    randomTickSpeed: opts.randomTickSpeed,
    fruitSides: opts.fruitSides,
  });
  const t = result.timing;
  const out: Record<string, string> = {
    Plant: `${result.plant.label} in Minecraft ${result.version}`,
    "Growth stages": `${result.model.stages} successful growth rolls`,
  };
  if (result.speed !== null) {
    out["Growth speed"] =
      `${result.speed} (${LAYOUT_PRESET_BY_ID.get(result.layoutId)?.label ?? "custom layout"})`;
  }
  out["Chance per random tick"] = `1 in ${(1 / t.chancePerRandomTick).toFixed(2)}`;
  out["Average time"] =
    `${formatTicks(t.meanTicks, version)} (${Math.round(t.meanTicks).toLocaleString("en-US")} ticks, ${inGameDays(t.meanTicks).toFixed(2)} in game days)`;
  out["Median time"] = formatTicks(t.medianTicks, version);
  out["Slowest 5 percent"] = `still growing after ${formatTicks(t.p95Ticks, version)}`;
  out["Bone meal"] = result.bonemeal.unsupported
    ? "Bone meal does nothing to this plant."
    : `${result.bonemeal.expectedUses.toFixed(2)} on average. ${result.bonemeal.effect}`;
  if (opts.animal) {
    const b = breeding({ version, animal: String(opts.animal) });
    out["Breeding cooldown"] = `${formatTicks(b.cooldownTicks, version)} per parent`;
    out["Baby growth"] =
      `${formatTicks(b.babyTicks, version)} unfed, or ${b.feedsToAdult} feeds plus ${formatTicks(b.ticksAfterFeeding, version)}`;
    out["Food per animal"] = `${b.foodPerBaby} to breed, ${b.foodPerAdult} to breed and raise`;
  }
  if (result.notes.length) out["Notes"] = result.notes.join(" ");
  return out;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, GrowthRunOpts>;

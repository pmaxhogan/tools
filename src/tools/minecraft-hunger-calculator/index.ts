import { ToolError, type ToolLogic } from "../types";
import {
  ACTIVITY_BY_ID,
  DIFFICULTIES,
  HUNGER_VERSIONS,
  MECHANICS,
  PEACEFUL_REGEN,
  TICKS_PER_SECOND,
  foodById,
  foodsFor,
  type DifficultyId,
  type FoodItem,
  type VersionId,
} from "./data";

/**
 * Minecraft hunger, saturation, and natural regeneration, reimplemented from
 * decompiled server source (see ./data.ts for the per-constant citations).
 *
 * The whole system is three numbers on the player. Every action adds
 * exhaustion; once exhaustion passes 4 it resets by 4 and burns one point of
 * saturation, or, when saturation is already empty, one point of the hunger
 * bar. Regeneration spends the same currency: healing one health point costs
 * 6 exhaustion on both regeneration paths, which is 1.5 hunger or saturation
 * points, which is 3 points per heart.
 *
 * `stepTick` is a faithful port of net.minecraft.world.food.FoodData#tick
 * plus the Peaceful refill in ServerPlayer#tickRegeneration. Everything else
 * in this file is a closed form on top of it, and the test suite proves the
 * closed forms agree with the simulation.
 */

/** Hard cap on any simulation: 24 real hours of ticks. */
const MAX_SIM_TICKS = 20 * 60 * 60 * 24;

/* ------------------------------------------------------------------ */
/* the tick simulation                                                 */
/* ------------------------------------------------------------------ */

export interface HungerState {
  /** Hunger bar, 0 to 20 points. Two points fill one drumstick icon. */
  food: number;
  /** Saturation, 0 to 20 points. Hidden from the HUD in vanilla. */
  saturation: number;
  /** Exhaustion, 0 to 40. Reaching 4 burns a saturation or hunger point. */
  exhaustion: number;
  /** Health points, 0 to maxHealth. Two points make one heart. */
  health: number;
  /** FoodData's own timer, shared by both regeneration paths and starving. */
  tickTimer: number;
  /** The player tick counter, which drives the Peaceful refill timers. */
  tickCount: number;
}

export interface SimEnv {
  version: VersionId;
  difficulty: DifficultyId;
  /** The naturalRegeneration game rule. */
  naturalRegen: boolean;
  maxHealth: number;
  /** Exhaustion the player's activity adds every tick. */
  exhaustionPerTick: number;
}

export interface TickOutcome {
  state: HungerState;
  /** Health gained this tick by natural regeneration. */
  healed: number;
  /** Health lost this tick to starvation. */
  starved: number;
}

/** Which regeneration path ran on a tick. */
export type RegenPath = "saturated" | "normal" | "none";

/**
 * One server tick. Order within the tick: the player's activity exhaustion
 * lands first, then the Peaceful refill, then FoodData#tick. Sub-tick order
 * does not change any aggregate this tool reports.
 */
export function stepTick(state: HungerState, env: SimEnv): TickOutcome {
  const { maxFood, maxSaturation, exhaustionDrop, maxExhaustion } = MECHANICS;
  const { tickCount } = state;
  let { food, saturation, exhaustion, health, tickTimer } = state;
  let healed = 0;
  let starved = 0;

  // Player#causeFoodExhaustion clamps the running total at 40.
  exhaustion = Math.min(exhaustion + env.exhaustionPerTick, maxExhaustion);

  const peaceful = env.difficulty === "peaceful";
  if (peaceful && env.naturalRegen) {
    const regen = PEACEFUL_REGEN[env.version];
    if (regen) {
      if (tickCount % regen.healEvery === 0 && health < env.maxHealth) {
        healed += Math.min(1, env.maxHealth - health);
        health = Math.min(env.maxHealth, health + 1);
      }
      if (
        regen.saturationEvery > 0 &&
        tickCount % regen.saturationEvery === 0 &&
        saturation < maxSaturation
      ) {
        saturation = Math.min(maxSaturation, saturation + 1);
      }
      if (tickCount % regen.foodEvery === 0 && food < maxFood) food += 1;
    }
  }

  // FoodData#tick: the exhaustion cascade.
  if (exhaustion > exhaustionDrop) {
    exhaustion -= exhaustionDrop;
    if (saturation > 0) saturation = Math.max(saturation - 1, 0);
    else if (!peaceful) food = Math.max(food - 1, 0);
  }

  // Player#isHurt: alive and below maximum health.
  const hurt = health > 0 && health < env.maxHealth;
  if (env.naturalRegen && saturation > 0 && hurt && food >= maxFood) {
    tickTimer++;
    if (tickTimer >= MECHANICS.healthTickCountSaturated) {
      const spent = Math.min(saturation, MECHANICS.saturatedHealCap);
      const gain = Math.min(spent / MECHANICS.saturatedHealCap, env.maxHealth - health);
      health += gain;
      healed += gain;
      exhaustion = Math.min(exhaustion + spent, maxExhaustion);
      tickTimer = 0;
    }
  } else if (env.naturalRegen && food >= MECHANICS.healLevel && hurt) {
    tickTimer++;
    if (tickTimer >= MECHANICS.healthTickCount) {
      const gain = Math.min(1, env.maxHealth - health);
      health += gain;
      healed += gain;
      exhaustion = Math.min(exhaustion + MECHANICS.exhaustionHeal, maxExhaustion);
      tickTimer = 0;
    }
  } else if (food <= MECHANICS.starveLevel) {
    tickTimer++;
    if (tickTimer >= MECHANICS.healthTickCount) {
      // The difficulty floor: Easy stops at 10 health, Normal at 1, Hard kills.
      if (health > 10 || env.difficulty === "hard" || (health > 1 && env.difficulty === "normal")) {
        starved = Math.min(1, health);
        health = Math.max(0, health - 1);
      }
      tickTimer = 0;
    }
  } else {
    tickTimer = 0;
  }

  return {
    state: { food, saturation, exhaustion, health, tickTimer, tickCount: tickCount + 1 },
    healed,
    starved,
  };
}

/** Eat one food item. Source: FoodData#eat, which calls the private add(). */
export function eatFood(state: HungerState, food: FoodItem): HungerState {
  const nextFood = Math.min(state.food + food.nutrition, MECHANICS.maxFood);
  // Saturation is clamped to the food level AFTER the hunger bar fills, so a
  // rich food eaten on a nearly full bar throws most of its saturation away.
  const nextSaturation = Math.min(state.saturation + food.saturation, nextFood);
  return { ...state, food: nextFood, saturation: nextSaturation };
}

/** True when the food can be eaten at this hunger level. */
export function canEat(state: HungerState, food: FoodItem): boolean {
  return food.alwaysEdible || state.food < MECHANICS.maxFood;
}

/** A fresh player: full hunger, the starting saturation, full health. */
export function freshState(maxHealth = 20): HungerState {
  return {
    food: MECHANICS.maxFood,
    saturation: MECHANICS.startSaturation,
    exhaustion: 0,
    health: maxHealth,
    tickTimer: 0,
    tickCount: 0,
  };
}

/* ------------------------------------------------------------------ */
/* the activity mix                                                    */
/* ------------------------------------------------------------------ */

export interface ActivityRate {
  activityId: string;
  /** Units of this activity per minute (blocks, jumps, hits, or seconds). */
  perMinute: number;
}

/** Exhaustion per second from a described activity mix. */
export function exhaustionPerSecond(mix: readonly ActivityRate[]): number {
  let total = 0;
  for (const entry of mix) {
    const activity = ACTIVITY_BY_ID.get(String(entry.activityId));
    if (!activity) {
      throw new ToolError(
        "unknown-activity",
        `Unknown activity "${String(entry.activityId)}".`,
        "Pick an activity such as Sprinting, Breaking blocks, or Attacking.",
      );
    }
    const rate = typeof entry.perMinute === "number" ? entry.perMinute : Number(entry.perMinute);
    if (!Number.isFinite(rate) || rate < 0) {
      throw new ToolError(
        "bad-rate",
        `The rate for ${activity.label} must be a number of ${activity.unitPlural} per minute that is zero or more, got "${String(entry.perMinute)}".`,
        "Use plain numbers like 0, 60, or 336.",
      );
    }
    total += activity.exhaustion * rate;
  }
  return total / 60;
}

/* ------------------------------------------------------------------ */
/* drain planning (closed forms)                                       */
/* ------------------------------------------------------------------ */

export interface DrainPlan {
  exhaustionPerSecond: number;
  /** Hunger or saturation points burned per hour. */
  pointsPerHour: number;
  /** Seconds until saturation reaches zero, so the hunger bar starts moving. */
  secondsToSaturationGone: number | null;
  /** Seconds until the hunger bar reaches 6, the level below which sprinting stops. */
  secondsToSprintLost: number | null;
  /** Seconds until the hunger bar is empty and starvation starts. */
  secondsToEmpty: number | null;
}

/**
 * How long a starting food and saturation last at a given exhaustion rate.
 *
 * Each 4 exhaustion burns exactly one point, saturation first. Saturation is
 * a float but the tick subtracts a whole point and clamps at zero, so a
 * partial point still absorbs a full 4 exhaustion: the count of burns is
 * ceil(saturation) plus the food level.
 */
export function drainPlan(food: number, saturation: number, exhPerSecond: number): DrainPlan {
  const perHour = (exhPerSecond * 3600) / MECHANICS.exhaustionDrop;
  const seconds = (burns: number): number | null =>
    exhPerSecond <= 0 ? null : (burns * MECHANICS.exhaustionDrop) / exhPerSecond;
  const satBurns = Math.ceil(saturation);
  return {
    exhaustionPerSecond: exhPerSecond,
    pointsPerHour: perHour,
    secondsToSaturationGone: seconds(satBurns),
    secondsToSprintLost: seconds(satBurns + Math.max(0, food - MECHANICS.sprintLevel)),
    secondsToEmpty: seconds(satBurns + food),
  };
}

/* ------------------------------------------------------------------ */
/* food value and rankings                                             */
/* ------------------------------------------------------------------ */

/**
 * Hunger or saturation points one item is worth, net of the exhaustion its
 * own Hunger effect will later cost. Junk foods such as rotten flesh are the
 * only items where the two differ.
 */
export function effectivePoints(food: FoodItem): number {
  return food.nutrition + food.saturation - food.hungerExhaustion / MECHANICS.exhaustionDrop;
}

/** Exhaustion an item covers: 4 exhaustion per point restored. */
export function exhaustionCovered(food: FoodItem): number {
  return effectivePoints(food) * MECHANICS.exhaustionDrop;
}

/**
 * Health points one item is worth when the whole item is spent on natural
 * regeneration. Healing costs 6 exhaustion per health point on both paths,
 * and 4 exhaustion is one point, so one point of food or saturation is
 * 4/6 health, and one heart costs 3 points.
 */
export function healthPerItem(food: FoodItem): number {
  return (effectivePoints(food) * MECHANICS.exhaustionDrop) / MECHANICS.exhaustionHeal;
}

export interface FoodRanking {
  food: FoodItem;
  /** Raw nutrition plus saturation. */
  points: number;
  /** Points net of the item's own Hunger effect. */
  netPoints: number;
  heartsPerItem: number;
  /**
   * Hearts from one full stack. A stack fills exactly one inventory slot, so
   * this is also the hearts per inventory slot.
   */
  heartsPerStack: number;
  heartsPerSlot: number;
  /** Hearts from a full 36 slot inventory of this food. */
  heartsPerInventory: number;
  /** Seconds the eating animation takes. Cake is instant per slice. */
  eatSeconds: number;
}

/** Inventory slots a player can fill with one item: 27 main plus 9 hotbar. */
export const INVENTORY_SLOTS = 36;

export type RankBy = "item" | "slot" | "saturation" | "nutrition";

/** Every food in a version, ranked. Ties break on name so output is stable. */
export function rankFoods(version: VersionId, by: RankBy = "item"): FoodRanking[] {
  const rows = foodsFor(version).map((food): FoodRanking => {
    const hearts = healthPerItem(food) / 2;
    return {
      food,
      points: food.nutrition + food.saturation,
      netPoints: effectivePoints(food),
      heartsPerItem: hearts,
      heartsPerStack: hearts * food.stack,
      heartsPerSlot: hearts * food.stack,
      heartsPerInventory: hearts * food.stack * INVENTORY_SLOTS,
      eatSeconds: food.eatTicks / TICKS_PER_SECOND,
    };
  });
  const key = (r: FoodRanking): number => {
    switch (by) {
      case "slot":
        return r.heartsPerSlot;
      case "saturation":
        return r.food.saturation;
      case "nutrition":
        return r.food.nutrition;
      default:
        return r.heartsPerItem;
    }
  };
  return rows.sort((a, b) => key(b) - key(a) || a.food.name.localeCompare(b.food.name));
}

export interface SustainPlan {
  food: FoodItem;
  /** Items eaten per hour to hold the hunger bar steady. */
  itemsPerHour: number;
  /** Items per in-game day, which is 20 real minutes. */
  itemsPerDay: number;
  /** Full stacks per hour. */
  stacksPerHour: number;
  /** Seconds of the hour spent in the eating animation. */
  eatingSecondsPerHour: number;
}

/** In-game day length in real seconds: 24000 ticks at 20 ticks per second. */
export const DAY_SECONDS = 24000 / TICKS_PER_SECOND;

/**
 * How much of one food it takes to stay fed at a given exhaustion rate.
 * Assumes the player eats at a deficit large enough that nothing is wasted
 * to the saturation clamp.
 */
export function sustainPlan(food: FoodItem, exhPerSecond: number): SustainPlan {
  const covered = exhaustionCovered(food);
  if (covered <= 0) {
    throw new ToolError(
      "worthless-food",
      `${food.name} costs more exhaustion through its Hunger effect than it restores, so it can never sustain a player.`,
      "Pick a food with a positive net value, for example Cooked porkchop or Golden carrot.",
    );
  }
  const perHour = (exhPerSecond * 3600) / covered;
  return {
    food,
    itemsPerHour: perHour,
    itemsPerDay: (exhPerSecond * DAY_SECONDS) / covered,
    stacksPerHour: perHour / food.stack,
    eatingSecondsPerHour: (perHour * food.eatTicks) / TICKS_PER_SECOND,
  };
}

/* ------------------------------------------------------------------ */
/* regeneration planning (simulated)                                   */
/* ------------------------------------------------------------------ */

export interface RegenPlan {
  ticks: number;
  seconds: number;
  healed: number;
  /** True when the target was reached before the simulation cap. */
  reached: boolean;
  /** Which path did the healing, or "both" when the run switched paths. */
  path: RegenPath | "both";
  end: HungerState;
  /** Hunger points spent. */
  foodSpent: number;
  /** Saturation points spent. */
  saturationSpent: number;
}

/**
 * Time to regenerate a number of hearts from a starting state, simulated tick
 * by tick so the path switch is exact: at food 20 with saturation left the
 * player heals every 10 ticks, otherwise every 80 ticks while food is at
 * least 18, and neither path runs once food drops below 18.
 */
export function regenPlan(
  start: HungerState,
  env: SimEnv,
  hearts: number,
  maxTicks = MAX_SIM_TICKS,
): RegenPlan {
  const target = hearts * 2;
  let state = start;
  let healed = 0;
  let ticks = 0;
  let sawSaturated = false;
  let sawNormal = false;
  while (healed < target - 1e-9 && ticks < maxTicks) {
    const before = state;
    const out = stepTick(state, env);
    state = out.state;
    ticks++;
    if (out.healed > 0) {
      healed += out.healed;
      if (before.food >= MECHANICS.maxFood && before.saturation > 0) sawSaturated = true;
      else sawNormal = true;
    }
    if (state.health <= 0) break;
    // Neither regeneration path runs at full health (Player#isHurt), so a
    // player who is already topped up can never reach a larger target.
    if (state.health >= env.maxHealth) break;
    // Outside Peaceful the hunger bar only ever falls, so once it drops
    // below the heal level nothing can restart regeneration: stop early
    // instead of spinning to the tick cap.
    if (!env.naturalRegen) break;
    if (env.difficulty !== "peaceful" && state.food < MECHANICS.healLevel) break;
  }
  const path: RegenPath | "both" =
    sawSaturated && sawNormal ? "both" : sawSaturated ? "saturated" : sawNormal ? "normal" : "none";
  return {
    ticks,
    seconds: ticks / TICKS_PER_SECOND,
    healed,
    reached: healed >= target - 1e-9,
    path,
    end: state,
    foodSpent: start.food - state.food,
    saturationSpent: start.saturation - state.saturation,
  };
}

export interface SurvivalRun {
  ticks: number;
  seconds: number;
  end: HungerState;
  /** Health lost to starvation over the run. */
  starvationDamage: number;
  /** Health gained by natural regeneration over the run. */
  healed: number;
  /** Tick the hunger bar first hit zero, or null when it never did. */
  emptyAtTick: number | null;
  /** Tick sprinting became impossible (food at or below 6), or null. */
  sprintLostAtTick: number | null;
  /** True when the player died. */
  died: boolean;
}

/** Run the tick simulation forward and report what happened. */
export function simulate(start: HungerState, env: SimEnv, ticks: number): SurvivalRun {
  const limit = Math.min(Math.max(0, Math.floor(ticks)), MAX_SIM_TICKS);
  let state = start;
  let starvationDamage = 0;
  let healed = 0;
  let emptyAtTick: number | null = null;
  let sprintLostAtTick: number | null = null;
  let i = 0;
  for (; i < limit; i++) {
    const out = stepTick(state, env);
    state = out.state;
    starvationDamage += out.starved;
    healed += out.healed;
    if (sprintLostAtTick === null && state.food <= MECHANICS.sprintLevel) sprintLostAtTick = i + 1;
    if (emptyAtTick === null && state.food <= 0) emptyAtTick = i + 1;
    if (state.health <= 0) {
      i++;
      break;
    }
  }
  return {
    ticks: i,
    seconds: i / TICKS_PER_SECOND,
    end: state,
    starvationDamage,
    healed,
    emptyAtTick,
    sprintLostAtTick,
    died: state.health <= 0,
  };
}

/* ------------------------------------------------------------------ */
/* the generic run() surface                                           */
/* ------------------------------------------------------------------ */

export interface McHungerOpts {
  mode: string; // 'drain' | 'sustain' | 'regen' | 'compare'
  version: string;
  difficulty: string;
  food: string;
  startFood: number;
  startSaturation: number;
  startHealth: number;
  hearts: number;
  sprintBlocksPerMinute: number;
  swimBlocksPerMinute: number;
  jumpsPerMinute: number;
  blocksMinedPerMinute: number;
  hitsPerMinute: number;
  hitsTakenPerMinute: number;
  [key: string]: unknown;
}

export type McHungerResult = Record<string, string>;

function num(opts: McHungerOpts, id: string, label: string, min: number, max: number): number {
  const raw = opts[id];
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    throw new ToolError(
      "not-a-number",
      `${label} must be a number, got "${String(raw)}".`,
      "Enter a plain number with no units.",
    );
  }
  if (n < min || n > max) {
    throw new ToolError(
      "out-of-range",
      `${label} must be between ${min} and ${max}, got ${n}.`,
      `Pick a value from ${min} to ${max}.`,
    );
  }
  return n;
}

function getVersion(opts: McHungerOpts): VersionId {
  const v = String(opts.version ?? "");
  if (!(HUNGER_VERSIONS as readonly string[]).includes(v)) {
    throw new ToolError(
      "unknown-version",
      `Unknown Minecraft version "${v}".`,
      `Pick one of ${HUNGER_VERSIONS.join(", ")}.`,
    );
  }
  return v as VersionId;
}

function getDifficulty(opts: McHungerOpts): DifficultyId {
  const d = String(opts.difficulty ?? "normal");
  if (!DIFFICULTIES.some((x) => x.id === d)) {
    throw new ToolError(
      "unknown-difficulty",
      `Unknown difficulty "${d}".`,
      "Pick Peaceful, Easy, Normal, or Hard.",
    );
  }
  return d as DifficultyId;
}

function getFood(opts: McHungerOpts, version: VersionId): FoodItem {
  const id = String(opts.food ?? "");
  const item = foodById(version, id);
  if (!item) {
    throw new ToolError(
      "unknown-food",
      `"${id}" is not an edible item in Minecraft ${version}.`,
      `Pick a food available in ${version}, for example cooked_porkchop or golden_carrot.`,
    );
  }
  return item;
}

function mixFrom(opts: McHungerOpts): ActivityRate[] {
  return [
    {
      activityId: "sprint",
      perMinute: num(opts, "sprintBlocksPerMinute", "Blocks sprinted per minute", 0, 100000),
    },
    {
      activityId: "swim",
      perMinute: num(opts, "swimBlocksPerMinute", "Blocks swum per minute", 0, 100000),
    },
    { activityId: "jump", perMinute: num(opts, "jumpsPerMinute", "Jumps per minute", 0, 100000) },
    {
      activityId: "mine",
      perMinute: num(opts, "blocksMinedPerMinute", "Blocks broken per minute", 0, 100000),
    },
    {
      activityId: "attack",
      perMinute: num(opts, "hitsPerMinute", "Hits landed per minute", 0, 100000),
    },
    {
      activityId: "damage",
      perMinute: num(opts, "hitsTakenPerMinute", "Hits taken per minute", 0, 100000),
    },
  ];
}

function dec(n: number, places = 2): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: places });
}

/** Seconds as a readable duration, for example "3 min 20 s". */
export function duration(seconds: number | null): string {
  if (seconds === null) return "never at this rate";
  if (seconds < 60) return `${dec(seconds, 1)} s`;
  const mins = Math.floor(seconds / 60);
  const rest = seconds - mins * 60;
  if (mins < 60) return `${mins} min ${dec(rest, 0)} s`;
  const hours = Math.floor(mins / 60);
  return `${hours} h ${mins - hours * 60} min`;
}

function runDrain(opts: McHungerOpts): McHungerResult {
  const food = num(opts, "startFood", "Starting hunger", 0, MECHANICS.maxFood);
  const saturation = num(
    opts,
    "startSaturation",
    "Starting saturation",
    0,
    MECHANICS.maxSaturation,
  );
  const difficulty = getDifficulty(opts);
  const exh = exhaustionPerSecond(mixFrom(opts));
  const plan = drainPlan(food, saturation, exh);
  const rows: McHungerResult = {
    "Exhaustion per second": `${dec(exh, 4)}`,
    "Points burned per hour": `${dec(plan.pointsPerHour)} hunger or saturation points`,
    "Saturation gone after": duration(plan.secondsToSaturationGone),
    "Sprinting stops after": duration(plan.secondsToSprintLost),
    "Hunger bar empty after": duration(plan.secondsToEmpty),
  };
  if (difficulty === "peaceful") {
    // On Peaceful the exhaustion cascade still burns saturation, but the food
    // drop is guarded by difficulty != PEACEFUL, so the bar never moves and
    // sprinting is never lost.
    rows["Sprinting stops after"] = "never: Peaceful never drains the hunger bar";
    rows["Hunger bar empty after"] = "never: Peaceful never drains the hunger bar";
  }
  const floor = DIFFICULTIES.find((d) => d.id === difficulty)?.starveFloor ?? null;
  rows["Starvation floor"] =
    difficulty === "peaceful"
      ? "none: Peaceful refills hunger and health instead"
      : floor === null
        ? "starvation can kill you on Hard"
        : `starvation stops at ${floor} health (${floor / 2} hearts)`;
  return rows;
}

function runSustain(opts: McHungerOpts): McHungerResult {
  const version = getVersion(opts);
  const item = getFood(opts, version);
  const exh = exhaustionPerSecond(mixFrom(opts));
  if (exh <= 0) {
    return {
      Food: item.name,
      "Items per hour": "0: nothing you selected costs exhaustion",
      "Restores per item": `${item.nutrition} hunger, ${dec(item.saturation)} saturation`,
    };
  }
  const plan = sustainPlan(item, exh);
  return {
    Food: `${item.name} in Minecraft ${version}`,
    "Restores per item": `${item.nutrition} hunger points, ${dec(item.saturation)} saturation`,
    "Exhaustion covered per item": dec(exhaustionCovered(item)),
    "Items per hour": dec(plan.itemsPerHour, 1),
    "Items per in-game day": `${dec(plan.itemsPerDay, 1)} (a day is 20 real minutes)`,
    "Stacks per hour": `${dec(plan.stacksPerHour, 2)} (a stack is ${item.stack})`,
    "Hearts of healing per item": dec(healthPerItem(item) / 2),
  };
}

function runRegen(opts: McHungerOpts): McHungerResult {
  const version = getVersion(opts);
  const difficulty = getDifficulty(opts);
  const hearts = num(opts, "hearts", "Hearts to regenerate", 0.5, 10);
  const start: HungerState = {
    food: num(opts, "startFood", "Starting hunger", 0, MECHANICS.maxFood),
    saturation: num(opts, "startSaturation", "Starting saturation", 0, MECHANICS.maxSaturation),
    exhaustion: 0,
    health: num(opts, "startHealth", "Starting health", 0, 20),
    tickTimer: 0,
    tickCount: 0,
  };
  const env: SimEnv = {
    version,
    difficulty,
    naturalRegen: true,
    maxHealth: 20,
    exhaustionPerTick: exhaustionPerSecond(mixFrom(opts)) / TICKS_PER_SECOND,
  };
  const plan = regenPlan(start, env, hearts);
  const pathLabel: Record<RegenPath | "both", string> = {
    saturated: "saturated fast heal, every 10 ticks",
    normal: "normal heal, every 80 ticks",
    both: "started saturated, finished on the normal path",
    none: "no healing happened",
  };
  return {
    "Hearts requested": dec(hearts, 1),
    "Hearts regenerated": plan.reached
      ? dec(plan.healed / 2, 2)
      : `${dec(plan.healed / 2, 2)} (stalled)`,
    "Time taken": plan.reached ? duration(plan.seconds) : "never at this hunger level",
    "Regeneration path": pathLabel[plan.path],
    "Hunger spent": `${dec(plan.foodSpent, 1)} points`,
    "Saturation spent": `${dec(plan.saturationSpent, 2)} points`,
    "Ending hunger and saturation": `${dec(plan.end.food, 0)} hunger, ${dec(plan.end.saturation, 2)} saturation`,
  };
}

function runCompare(opts: McHungerOpts): McHungerResult {
  const version = getVersion(opts);
  const ranked = rankFoods(version, "item");
  const rows: McHungerResult = {};
  for (const [i, r] of ranked.slice(0, 10).entries()) {
    rows[`${i + 1}. ${r.food.name}`] =
      `${dec(r.heartsPerItem)} hearts per item, ${dec(r.heartsPerSlot, 1)} per slot (${r.food.nutrition} hunger + ${dec(r.food.saturation)} saturation)`;
  }
  const bySlot = rankFoods(version, "slot")[0];
  const bySaturation = rankFoods(version, "saturation")[0];
  if (bySlot)
    rows["Best per inventory slot"] =
      `${bySlot.food.name} (${dec(bySlot.heartsPerSlot, 1)} hearts)`;
  if (bySaturation) {
    rows["Highest saturation"] =
      `${bySaturation.food.name} (${dec(bySaturation.food.saturation)} saturation)`;
  }
  return rows;
}

export function run(_input: undefined, opts: McHungerOpts): McHungerResult {
  switch (opts.mode) {
    case "drain":
      return runDrain(opts);
    case "sustain":
      return runSustain(opts);
    case "regen":
      return runRegen(opts);
    case "compare":
      return runCompare(opts);
    default:
      throw new ToolError(
        "unknown-mode",
        `Unknown mode "${String(opts.mode)}".`,
        "Pick a mode: Hunger drain, Food needed, Regeneration, or Compare foods.",
      );
  }
}

export default { run } satisfies ToolLogic<undefined, McHungerResult, McHungerOpts>;

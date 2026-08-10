import { ToolError, type ToolLogic } from "../types";
import {
  BOOST_ADD,
  BOOST_PULL,
  BOOST_TARGET,
  CLIMB_TRADE,
  CLIMB_VERTICAL_GAIN,
  DEFAULT_GRAVITY,
  DIVE_CONVERSION,
  DRAG_HORIZONTAL,
  DRAG_VERTICAL,
  ELYTRA_VERSION_DATA,
  LIFETIME_JITTER_MAX,
  LIFETIME_JITTER_MEAN,
  LIFETIME_JITTER_MIN,
  LIFETIME_PER_LEVEL,
  LIFT_FACTOR,
  MAX_REPAIR_MATERIALS,
  MENDING_DURABILITY_PER_XP,
  NETHER_RATIO,
  REPAIR_FRACTION,
  ROCKETS_PER_CRAFT,
  SELF_DAMAGE_BASE,
  SELF_DAMAGE_PER_STAR,
  SLOW_FALLING_GRAVITY,
  STEER_RATE,
  TICKS_PER_DURABILITY,
  TICKS_PER_SECOND,
  type ElytraVersionId,
} from "./data";

/**
 * Elytra flight, reimplemented from the decompiled server source.
 *
 * The centrepiece is a real per-tick simulator of the elytra branch of
 * LivingEntity#travel (LivingEntity#updateFallFlyingMovement from 1.21.11
 * on), plus the firework rocket boost from FireworkRocketEntity#tick. Every
 * distance, time, and rocket count this module reports comes out of that
 * simulator, never a fitted curve. See ./data.ts for the constant citations.
 *
 * Conventions that match the game:
 * - Pitch is the player's xRot in degrees. POSITIVE pitch looks DOWN.
 * - Speed is in blocks per tick; there are 20 ticks in a second.
 * - Yaw is held constant, so the flight is a vertical plane and "distance"
 *   means horizontal distance along the heading.
 *
 * Within one tick the rocket boost is applied before the glide step. The
 * game ticks the player and the rocket entity separately, so the two orders
 * differ by a one tick phase shift only; the displacement per tick at steady
 * state is identical either way.
 */

// ---------------------------------------------------------------------------
// Float fidelity helpers
// ---------------------------------------------------------------------------

/** (float)(Math.PI / 180.0), the constant the game multiplies degrees by. */
const DEG_TO_RAD_F = Math.fround(Math.PI / 180);
/** Vec3#multiply takes float literals that widen to double. */
const DRAG_H = Math.fround(DRAG_HORIZONTAL);
const DRAG_V = Math.fround(DRAG_VERTICAL);

const SIN_SCALE = 10430.378350470453;
const SIN_MASK = 65535;
const COS_OFFSET = 16384;

let sinTable: Float32Array | null = null;

/**
 * Mth#sin, the game's 65536 entry float sine table. Reimplemented rather
 * than replaced by Math.sin because the quantization is visible at the
 * fractional pitches the tool exposes: Mth.sin drives the pitch-up trade
 * term and the look vector in every verified version.
 */
function mthTable(): Float32Array {
  if (!sinTable) {
    const table = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) table[i] = Math.fround(Math.sin(i / SIN_SCALE));
    sinTable = table;
  }
  return sinTable;
}

export function mthSin(radians: number): number {
  return mthTable()[Math.trunc(radians * SIN_SCALE) & SIN_MASK]!;
}

export function mthCos(radians: number): number {
  return mthTable()[Math.trunc(radians * SIN_SCALE + COS_OFFSET) & SIN_MASK]!;
}

// ---------------------------------------------------------------------------
// Vectors and the look direction
// ---------------------------------------------------------------------------

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Entity#calculateViewVector. Float math throughout, exactly as in the game:
 * every intermediate is a float and only the Vec3 fields are doubles.
 */
export function lookVector(pitchDeg: number, yawDeg = 0): Vec3 {
  const rx = Math.fround(Math.fround(pitchDeg) * DEG_TO_RAD_F);
  const ry = Math.fround(Math.fround(-yawDeg) * DEG_TO_RAD_F);
  const yc = mthCos(ry);
  const ys = mthSin(ry);
  const xc = mthCos(rx);
  const xs = mthSin(rx);
  return { x: Math.fround(ys * xc), y: Math.fround(-xs), z: Math.fround(yc * xc) };
}

function horizontal(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.z * v.z);
}

// ---------------------------------------------------------------------------
// One tick of physics
// ---------------------------------------------------------------------------

export interface StepInput {
  pitchDeg: number;
  yawDeg?: number;
  /** Effective gravity: 0.08 normally, 0.01 under Slow Falling. */
  gravity?: number;
  /** True when an attached firework rocket is boosting this tick. */
  boosting?: boolean;
}

/**
 * The firework rocket boost from FireworkRocketEntity#tick, attached branch:
 * per axis, v += look * 0.1 + (look * 1.5 - v) * 0.5. The fixed point is
 * look * 1.7, which is why chained rockets converge on a ceiling instead of
 * accelerating without bound.
 */
export function applyRocketBoost(v: Vec3, look: Vec3): Vec3 {
  return {
    x: v.x + look.x * BOOST_ADD + (look.x * BOOST_TARGET - v.x) * BOOST_PULL,
    y: v.y + look.y * BOOST_ADD + (look.y * BOOST_TARGET - v.y) * BOOST_PULL,
    z: v.z + look.z * BOOST_ADD + (look.z * BOOST_TARGET - v.z) * BOOST_PULL,
  };
}

/**
 * One tick of elytra glide physics. Returns the new velocity, which is also
 * exactly the displacement applied by move() that tick.
 */
export function stepGlide(velocity: Vec3, input: StepInput): Vec3 {
  const pitch = input.pitchDeg;
  const gravity = input.gravity ?? DEFAULT_GRAVITY;
  const look = lookVector(pitch, input.yawDeg ?? 0);
  let v = input.boosting ? applyRocketBoost(velocity, look) : velocity;

  const lean = Math.fround(Math.fround(pitch) * DEG_TO_RAD_F);
  const lookHor = Math.sqrt(look.x * look.x + look.z * look.z);
  const moveHor = horizontal(v);
  // Mth.square(Math.cos(lean)) from 1.18.2 on; 1.16.5 read the same cosine
  // out of the float sine table, which differs only in the last bits.
  const lift = Math.cos(lean) * Math.cos(lean);

  v = { x: v.x, y: v.y + gravity * (-1 + lift * LIFT_FACTOR), z: v.z };

  if (v.y < 0 && lookHor > 0) {
    // Falling converts into forward speed along the look direction.
    const convert = v.y * -DIVE_CONVERSION * lift;
    v = {
      x: v.x + (look.x * convert) / lookHor,
      y: v.y + convert,
      z: v.z + (look.z * convert) / lookHor,
    };
  }

  if (lean < 0 && lookHor > 0) {
    // Pitching up trades horizontal speed for altitude at 3.2 to 1.
    const convert = moveHor * -mthSin(lean) * CLIMB_TRADE;
    v = {
      x: v.x - (look.x * convert) / lookHor,
      y: v.y + convert * CLIMB_VERTICAL_GAIN,
      z: v.z - (look.z * convert) / lookHor,
    };
  }

  if (lookHor > 0) {
    // Steering: horizontal velocity is pulled toward the look direction.
    v = {
      x: v.x + ((look.x / lookHor) * moveHor - v.x) * STEER_RATE,
      y: v.y,
      z: v.z + ((look.z / lookHor) * moveHor - v.z) * STEER_RATE,
    };
  }

  return { x: v.x * DRAG_H, y: v.y * DRAG_V, z: v.z * DRAG_H };
}

// ---------------------------------------------------------------------------
// Rocket schedules
// ---------------------------------------------------------------------------

export type RocketMode = "none" | "chained" | "interval";

export interface RocketLifetime {
  /** Ticks the rocket exists for, from the lifetime roll. */
  minLifetime: number;
  maxLifetime: number;
  meanLifetime: number;
  /** Ticks the boost is actually applied: lifetime + 1. */
  minBoostTicks: number;
  maxBoostTicks: number;
  meanBoostTicks: number;
}

/**
 * FireworkRocketEntity's constructor rolls
 * lifetime = 10 * (1 + flightDuration) + nextInt(6) + nextInt(7),
 * and #tick explodes once life exceeds it, so the boost lands on
 * lifetime + 1 ticks. The jitter is a fixed 0 to 11 tick spread with a mean
 * of 5.5, which the planner reports as a tolerance rather than simulating.
 */
export function rocketLifetime(flightDuration: number): RocketLifetime {
  const base = LIFETIME_PER_LEVEL * (1 + flightDuration);
  return {
    minLifetime: base + LIFETIME_JITTER_MIN,
    maxLifetime: base + LIFETIME_JITTER_MAX,
    meanLifetime: base + LIFETIME_JITTER_MEAN,
    minBoostTicks: base + LIFETIME_JITTER_MIN + 1,
    maxBoostTicks: base + LIFETIME_JITTER_MAX + 1,
    meanBoostTicks: base + LIFETIME_JITTER_MEAN + 1,
  };
}

// ---------------------------------------------------------------------------
// The simulator
// ---------------------------------------------------------------------------

/**
 * A pitch change partway through a flight. `throughTick` is the last tick
 * the segment's pitch applies to; after the final segment the flight falls
 * back to `SimOptions.pitchDeg`. This is what makes the dive-then-level
 * maneuver expressible without handing the simulator a callback.
 */
export interface PitchSegment {
  throughTick: number;
  pitchDeg: number;
}

export interface SimOptions {
  pitchDeg: number;
  pitchSegments?: PitchSegment[];
  yawDeg?: number;
  gravity?: number;
  rocketMode?: RocketMode;
  /** 1, 2, or 3 gunpowder. */
  flightDuration?: number;
  /** Ticks between rocket firings in "interval" mode. */
  rocketIntervalTicks?: number;
  /** Starting horizontal speed in blocks per tick (0 for a standing jump). */
  initialSpeed?: number;
  /** Starting vertical speed in blocks per tick (negative is falling). */
  initialVerticalSpeed?: number;
  /** Hard tick budget. */
  maxTicks?: number;
  /** Stop once the flier has descended this many blocks below the start. */
  stopAfterDrop?: number;
  /** Stop once this much horizontal distance is covered. */
  stopAfterDistance?: number;
}

export interface SimSample {
  tick: number;
  /** Horizontal distance covered so far, in blocks. */
  distance: number;
  /** Altitude relative to the start, in blocks. */
  altitude: number;
  horizontalSpeed: number;
  verticalSpeed: number;
  boosting: boolean;
  pitchDeg: number;
}

export interface SimResult {
  ticks: number;
  seconds: number;
  distance: number;
  /** Net altitude change: negative means the flier lost height. */
  altitudeChange: number;
  lowestAltitude: number;
  highestAltitude: number;
  peakHorizontalSpeed: number;
  finalHorizontalSpeed: number;
  finalVerticalSpeed: number;
  rocketsUsed: number;
  boostTicks: number;
  /** Full per tick trace, starting with the state before the first tick. */
  samples: SimSample[];
  /** Why the run ended. */
  stoppedBy: "drop" | "distance" | "ticks";
}

export const MAX_SIM_TICKS = 200000;

function clampGravity(gravity: number | undefined): number {
  return gravity ?? DEFAULT_GRAVITY;
}

function checkPitch(pitch: unknown): number {
  if (typeof pitch !== "number" || !Number.isFinite(pitch) || pitch < -90 || pitch > 90) {
    throw new ToolError(
      "bad-pitch",
      `Pitch must be between -90 and 90 degrees, got "${String(pitch)}".`,
      "Use a negative pitch to look up and a positive pitch to look down, the same as the F3 screen.",
    );
  }
  return pitch;
}

/** Run the per-tick simulator. Pure: same options in, same trace out. */
export function simulateFlight(options: SimOptions): SimResult {
  const pitch = checkPitch(options.pitchDeg);
  const segments = (options.pitchSegments ?? []).map((s) => ({
    throughTick: s.throughTick,
    pitchDeg: checkPitch(s.pitchDeg),
  }));
  const pitchAtTick = (t: number): number => {
    for (const s of segments) if (t <= s.throughTick) return s.pitchDeg;
    return pitch;
  };
  const maxTicks = Math.min(options.maxTicks ?? 20000, MAX_SIM_TICKS);
  if (!Number.isInteger(maxTicks) || maxTicks < 1) {
    throw new ToolError(
      "bad-tick-budget",
      `The tick budget must be a whole number of at least 1, got "${String(options.maxTicks)}".`,
      `Pick a budget from 1 to ${MAX_SIM_TICKS} ticks.`,
    );
  }
  const mode: RocketMode = options.rocketMode ?? "none";
  const flightDuration = options.flightDuration ?? 1;
  if (mode !== "none" && ![1, 2, 3].includes(flightDuration)) {
    throw new ToolError(
      "bad-flight-duration",
      `Firework flight duration must be 1, 2, or 3, got "${String(options.flightDuration)}".`,
      "Flight duration equals the gunpowder count in the crafting recipe, so it can only be 1, 2, or 3.",
    );
  }
  const boostTicks = rocketLifetime(flightDuration).meanBoostTicks;
  const interval =
    mode === "chained" ? boostTicks : Math.max(1, Math.round(options.rocketIntervalTicks ?? 60));
  if (mode === "interval" && interval < 1) {
    throw new ToolError(
      "bad-rocket-interval",
      `The rocket interval must be at least 1 tick, got "${String(options.rocketIntervalTicks)}".`,
      "Enter how many ticks pass between rocket firings, for example 60 for one every three seconds.",
    );
  }

  const gravity = clampGravity(options.gravity);
  const look = lookVector(pitchAtTick(1), options.yawDeg ?? 0);
  const lookHor = Math.sqrt(look.x * look.x + look.z * look.z);
  const heading = lookHor > 0 ? { x: look.x / lookHor, z: look.z / lookHor } : { x: 0, z: 1 };
  const speed0 = options.initialSpeed ?? 0;

  let v: Vec3 = {
    x: heading.x * speed0,
    y: options.initialVerticalSpeed ?? 0,
    z: heading.z * speed0,
  };

  let distance = 0;
  let altitude = 0;
  let lowest = 0;
  let highest = 0;
  let peak = horizontal(v);
  let rocketsUsed = 0;
  let boosted = 0;
  const samples: SimSample[] = [
    {
      tick: 0,
      distance: 0,
      altitude: 0,
      horizontalSpeed: horizontal(v),
      verticalSpeed: v.y,
      boosting: false,
      pitchDeg: pitchAtTick(1),
    },
  ];

  let stoppedBy: SimResult["stoppedBy"] = "ticks";
  let tick = 0;
  // Boost ticks remaining on the currently attached rocket.
  let remainingBoost = 0;
  let ticksSinceLaunch = Number.POSITIVE_INFINITY;

  while (tick < maxTicks) {
    if (mode !== "none" && remainingBoost <= 0 && ticksSinceLaunch >= interval) {
      remainingBoost = boostTicks;
      ticksSinceLaunch = 0;
      rocketsUsed++;
    }
    const boosting = remainingBoost > 0;
    if (boosting) {
      remainingBoost--;
      boosted++;
    }
    ticksSinceLaunch++;

    const tickPitch = pitchAtTick(tick + 1);
    v = stepGlide(v, { pitchDeg: tickPitch, yawDeg: options.yawDeg, gravity, boosting });
    tick++;
    const hor = horizontal(v);
    distance += hor;
    altitude += v.y;
    if (altitude < lowest) lowest = altitude;
    if (altitude > highest) highest = altitude;
    if (hor > peak) peak = hor;
    samples.push({
      tick,
      distance,
      altitude,
      horizontalSpeed: hor,
      verticalSpeed: v.y,
      boosting,
      pitchDeg: tickPitch,
    });

    if (options.stopAfterDrop !== undefined && -altitude >= options.stopAfterDrop) {
      stoppedBy = "drop";
      break;
    }
    if (options.stopAfterDistance !== undefined && distance >= options.stopAfterDistance) {
      stoppedBy = "distance";
      break;
    }
  }

  return {
    ticks: tick,
    seconds: tick / TICKS_PER_SECOND,
    distance,
    altitudeChange: altitude,
    lowestAltitude: lowest,
    highestAltitude: highest,
    peakHorizontalSpeed: peak,
    finalHorizontalSpeed: horizontal(v),
    finalVerticalSpeed: v.y,
    rocketsUsed,
    boostTicks: boosted,
    samples,
    stoppedBy,
  };
}

// ---------------------------------------------------------------------------
// Steady states
// ---------------------------------------------------------------------------

export interface SteadyState {
  horizontalSpeed: number;
  verticalSpeed: number;
  /** Blocks forward per block lost. Infinity when the flier is not sinking. */
  glideRatio: number;
  /** Ticks it took to settle within the tolerance. */
  settleTicks: number;
}

/**
 * Iterate one pitch to its fixed point. Both the glide and the chained-rocket
 * cases are contractions, so this converges quickly and exactly reproduces
 * what the tick loop above would report after a long flight.
 */
export function steadyState(
  pitchDeg: number,
  opts: { boosting?: boolean; gravity?: number; tolerance?: number; maxTicks?: number } = {},
): SteadyState {
  const tolerance = opts.tolerance ?? 1e-12;
  const maxTicks = opts.maxTicks ?? 20000;
  const gravity = clampGravity(opts.gravity);
  let v: Vec3 = { x: 0, y: 0, z: 0 };
  let settleTicks = maxTicks;
  for (let i = 0; i < maxTicks; i++) {
    const next = stepGlide(v, {
      pitchDeg,
      gravity,
      boosting: opts.boosting ?? false,
    });
    const delta = Math.abs(horizontal(next) - horizontal(v)) + Math.abs(next.y - v.y);
    v = next;
    if (delta < tolerance) {
      settleTicks = i + 1;
      break;
    }
  }
  const hor = horizontal(v);
  return {
    horizontalSpeed: hor,
    verticalSpeed: v.y,
    glideRatio: v.y < 0 ? hor / -v.y : Number.POSITIVE_INFINITY,
    settleTicks,
  };
}

/** The pitch, to the given step, with the best glide ratio. */
export function bestGlidePitch(
  step = 0.5,
  gravity?: number,
): { pitchDeg: number; state: SteadyState } {
  let best = { pitchDeg: 0, state: steadyState(0, { gravity }) };
  for (let p = -20; p <= 20 + 1e-9; p += step) {
    const pitch = Math.round(p / step) * step;
    const state = steadyState(pitch, { gravity });
    if (state.glideRatio > best.state.glideRatio) best = { pitchDeg: pitch, state };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Rocket economics
// ---------------------------------------------------------------------------

export interface CruisePlan {
  pitchDeg: number;
  flightDuration: number;
  /** Steady horizontal speed with rockets chained back to back. */
  speedPerTick: number;
  speedPerSecond: number;
  verticalSpeedPerTick: number;
  /** Boost ticks one rocket supplies, at the mean lifetime roll. */
  boostTicks: number;
  minBoostTicks: number;
  maxBoostTicks: number;
  blocksPerRocket: number;
  minBlocksPerRocket: number;
  maxBlocksPerRocket: number;
  rocketsPerThousandBlocks: number;
  /** Resource cost per 1000 blocks. */
  gunpowderPerThousandBlocks: number;
  paperPerThousandBlocks: number;
}

/**
 * Cruising with rockets chained back to back: fire the next rocket the tick
 * the last one expires. The speed is the fixed point of boost plus glide, so
 * it is the real ceiling rather than an average over a burst.
 */
export function cruisePlan(pitchDeg: number, flightDuration: number, gravity?: number): CruisePlan {
  if (![1, 2, 3].includes(flightDuration)) {
    throw new ToolError(
      "bad-flight-duration",
      `Firework flight duration must be 1, 2, or 3, got "${String(flightDuration)}".`,
      "Flight duration equals the gunpowder count in the crafting recipe, so it can only be 1, 2, or 3.",
    );
  }
  const state = steadyState(pitchDeg, { boosting: true, gravity });
  const life = rocketLifetime(flightDuration);
  const perRocket = state.horizontalSpeed * life.meanBoostTicks;
  const rocketsPerK = perRocket > 0 ? 1000 / perRocket : Number.POSITIVE_INFINITY;
  return {
    pitchDeg,
    flightDuration,
    speedPerTick: state.horizontalSpeed,
    speedPerSecond: state.horizontalSpeed * TICKS_PER_SECOND,
    verticalSpeedPerTick: state.verticalSpeed,
    boostTicks: life.meanBoostTicks,
    minBoostTicks: life.minBoostTicks,
    maxBoostTicks: life.maxBoostTicks,
    blocksPerRocket: perRocket,
    minBlocksPerRocket: state.horizontalSpeed * life.minBoostTicks,
    maxBlocksPerRocket: state.horizontalSpeed * life.maxBoostTicks,
    rocketsPerThousandBlocks: rocketsPerK,
    // One craft is 1 paper plus `flightDuration` gunpowder and yields 3 rockets.
    gunpowderPerThousandBlocks: (rocketsPerK * flightDuration) / ROCKETS_PER_CRAFT,
    paperPerThousandBlocks: rocketsPerK / ROCKETS_PER_CRAFT,
  };
}

export interface TravelLeg {
  distance: number;
  rockets: number;
  ticks: number;
  seconds: number;
  gunpowder: number;
  paper: number;
  crafts: number;
}

export interface TravelPlan {
  overworld: TravelLeg;
  nether: TravelLeg;
  /** Blocks saved by taking the Nether, as a fraction of the overworld trip. */
  netherSavingFraction: number;
  cruise: CruisePlan;
}

function leg(distance: number, cruise: CruisePlan): TravelLeg {
  const rockets = distance <= 0 ? 0 : Math.ceil(distance / cruise.blocksPerRocket);
  const ticks = cruise.speedPerTick > 0 ? distance / cruise.speedPerTick : 0;
  const crafts = Math.ceil(rockets / ROCKETS_PER_CRAFT);
  return {
    distance,
    rockets,
    ticks,
    seconds: ticks / TICKS_PER_SECOND,
    gunpowder: crafts * cruise.flightDuration,
    paper: crafts,
    crafts,
  };
}

/**
 * The trip planner: fly dx, dz in the Overworld, or fly one eighth of it in
 * the Nether. The 8 to 1 ratio is the real decision, so both legs are costed
 * with the same cruise model.
 */
export function travelPlan(
  dx: number,
  dz: number,
  opts: { pitchDeg?: number; flightDuration?: number; gravity?: number } = {},
): TravelPlan {
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) {
    throw new ToolError(
      "bad-coordinates",
      `Coordinates must be finite numbers, got X "${String(dx)}" and Z "${String(dz)}".`,
      "Enter the X and Z you want to reach, in blocks, as plain numbers.",
    );
  }
  const cruise = cruisePlan(opts.pitchDeg ?? 0, opts.flightDuration ?? 1, opts.gravity);
  const distance = Math.hypot(dx, dz);
  const overworld = leg(distance, cruise);
  const nether = leg(distance / NETHER_RATIO, cruise);
  return {
    overworld,
    nether,
    netherSavingFraction: distance > 0 ? 1 - 1 / NETHER_RATIO : 0,
    cruise,
  };
}

// ---------------------------------------------------------------------------
// Durability
// ---------------------------------------------------------------------------

export const MAX_UNBREAKING = 3;

export interface DurabilityPlan {
  maxDamage: number;
  currentDamage: number;
  /** Durability points left before flight cuts out. */
  usableDurability: number;
  /** Raw ticks of flight per durability point (before Unbreaking). */
  ticksPerDurability: number;
  /** Expected ticks of flight per durability point with Unbreaking. */
  expectedTicksPerDurability: number;
  flightTicks: number;
  flightSeconds: number;
  /** Distance at the given cruise speed, in blocks. */
  flightDistance: number;
  /** Mending experience per second of flight to break even. */
  mendingXpPerSecond: number;
  mendingXpToFullRepair: number;
  /** Anvil repair: durability restored per phantom membrane. */
  repairPerMembrane: number;
  membranesToFull: number;
  /** Membranes that fit in one anvil use, and the level cost of that use. */
  membranesPerAnvilUse: number;
  anvilUses: number;
  levelsIgnoringPriorWork: number;
}

/**
 * Durability planning. LivingEntity#updateFallFlying takes 1 point every 20
 * ticks of flight, Unbreaking skips that hit with probability
 * level / (level + 1) (the elytra takes the full non-armor rate, it is not
 * an ArmorItem and is not in #minecraft:enchantable/armor), and flight cuts
 * out one point before the item would break.
 */
export function durabilityPlan(opts: {
  version?: ElytraVersionId;
  currentDamage?: number;
  unbreaking?: number;
  /** Blocks per tick used to turn flight time into distance. */
  cruiseSpeed?: number;
}): DurabilityPlan {
  const version = opts.version ?? "1.21.11";
  const versionData = ELYTRA_VERSION_DATA[version];
  if (!versionData) {
    throw new ToolError(
      "unknown-version",
      `Unknown Minecraft version "${String(opts.version)}".`,
      "Pick a version from the dropdown, for example 1.21.11.",
    );
  }
  const maxDamage = versionData.maxDamage;
  const currentDamage = opts.currentDamage ?? 0;
  if (!Number.isInteger(currentDamage) || currentDamage < 0 || currentDamage > maxDamage - 1) {
    throw new ToolError(
      "bad-damage",
      `Damage must be a whole number from 0 to ${maxDamage - 1}, got "${String(opts.currentDamage)}".`,
      `An elytra with ${maxDamage - 1} damage has 1 durability left and refuses to glide, so that is the top of the range.`,
    );
  }
  const unbreaking = opts.unbreaking ?? 0;
  if (!Number.isInteger(unbreaking) || unbreaking < 0 || unbreaking > MAX_UNBREAKING) {
    throw new ToolError(
      "bad-unbreaking",
      `Unbreaking must be a whole number from 0 to ${MAX_UNBREAKING}, got "${String(opts.unbreaking)}".`,
      "Use 0 for an unenchanted elytra, or a level from 1 to 3.",
    );
  }
  // isFlyEnabled needs damage < maxDamage - 1, so the last usable damage
  // value is maxDamage - 2 and the flier can still absorb one more point.
  const usable = maxDamage - 1 - currentDamage;
  const expectedTicks = TICKS_PER_DURABILITY * (unbreaking + 1);
  const flightTicks = usable * expectedTicks;
  const cruiseSpeed = opts.cruiseSpeed ?? 0;
  const repairPerMembrane = Math.floor(maxDamage / REPAIR_FRACTION);
  const membranes = currentDamage === 0 ? 0 : Math.ceil(currentDamage / repairPerMembrane);
  const anvilUses = Math.ceil(membranes / MAX_REPAIR_MATERIALS);
  return {
    maxDamage,
    currentDamage,
    usableDurability: usable,
    ticksPerDurability: TICKS_PER_DURABILITY,
    expectedTicksPerDurability: expectedTicks,
    flightTicks,
    flightSeconds: flightTicks / TICKS_PER_SECOND,
    flightDistance: flightTicks * cruiseSpeed,
    mendingXpPerSecond: TICKS_PER_SECOND / (expectedTicks * MENDING_DURABILITY_PER_XP),
    mendingXpToFullRepair: Math.ceil(currentDamage / MENDING_DURABILITY_PER_XP),
    repairPerMembrane,
    membranesToFull: membranes,
    membranesPerAnvilUse: MAX_REPAIR_MATERIALS,
    anvilUses,
    levelsIgnoringPriorWork: membranes,
  };
}

// ---------------------------------------------------------------------------
// Firework self damage
// ---------------------------------------------------------------------------

export const MAX_FIREWORK_STARS = 7;

export interface SelfDamage {
  stars: number;
  damage: number;
  hearts: number;
  /** Explodes on the flier only when the rocket carries stars. */
  harmless: boolean;
}

/**
 * FireworkRocketEntity#dealExplosionDamage: 5 + 2 per firework star, dealt
 * to the attached glider with no distance falloff. A plain rocket carries no
 * stars and cannot hurt you.
 */
export function fireworkSelfDamage(stars: number): SelfDamage {
  if (!Number.isInteger(stars) || stars < 0 || stars > MAX_FIREWORK_STARS) {
    throw new ToolError(
      "bad-star-count",
      `Firework star count must be a whole number from 0 to ${MAX_FIREWORK_STARS}, got "${String(stars)}".`,
      "One paper and one gunpowder leave 7 free crafting slots, so a rocket holds at most 7 stars.",
    );
  }
  const damage = stars === 0 ? 0 : SELF_DAMAGE_BASE + SELF_DAMAGE_PER_STAR * stars;
  return { stars, damage, hearts: damage / 2, harmless: stars === 0 };
}

// ---------------------------------------------------------------------------
// The generic run() surface
// ---------------------------------------------------------------------------

export interface McElytraOpts {
  mode: string;
  version: string;
  pitch: number;
  height: number;
  flightDuration: number;
  targetX: number;
  targetZ: number;
  damage: number;
  unbreaking: number;
  stars: number;
  slowFalling: boolean;
  [key: string]: unknown;
}

export type McElytraResult = Record<string, string>;

function num(opts: McElytraOpts, id: string, label: string, fallback: number): number {
  const raw = opts[id];
  if (raw === undefined || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    throw new ToolError(
      "not-a-number",
      `${label} must be a number, got "${String(raw)}".`,
      "Enter a plain number, with no units or thousands separators.",
    );
  }
  return n;
}

function fmt(n: number, digits = 0): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function duration(ticks: number): string {
  const seconds = ticks / TICKS_PER_SECOND;
  if (seconds < 90) return `${fmt(seconds, 1)} seconds`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes} min ${rest} s`;
}

function gravityFor(opts: McElytraOpts): number {
  return opts.slowFalling ? SLOW_FALLING_GRAVITY : DEFAULT_GRAVITY;
}

function runGlide(opts: McElytraOpts): McElytraResult {
  const pitch = num(opts, "pitch", "Pitch", 0);
  const height = num(opts, "height", "Height", 100);
  if (height <= 0 || height > 10000) {
    throw new ToolError(
      "bad-height",
      `Height must be between 1 and 10000 blocks, got "${String(opts.height)}".`,
      "Enter how far above the landing spot you start, in blocks.",
    );
  }
  const gravity = gravityFor(opts);
  const sim = simulateFlight({
    pitchDeg: pitch,
    gravity,
    stopAfterDrop: height,
    maxTicks: 40000,
  });
  const steady = steadyState(pitch, { gravity });
  const best = bestGlidePitch(0.5, gravity);
  return {
    "Launch height": `${fmt(height)} blocks`,
    Pitch: `${fmt(pitch, 1)} degrees (${pitch >= 0 ? "looking down" : "looking up"})`,
    "Distance covered": `${fmt(sim.distance)} blocks`,
    "Time in the air": duration(sim.ticks),
    "Glide ratio": `${fmt(sim.distance / height, 2)} blocks forward per block down`,
    "Top speed": `${fmt(sim.peakHorizontalSpeed, 3)} blocks per tick (${fmt(sim.peakHorizontalSpeed * TICKS_PER_SECOND, 1)} blocks per second)`,
    "Terminal glide speed": `${fmt(steady.horizontalSpeed, 3)} forward, ${fmt(-steady.verticalSpeed, 3)} down, per tick`,
    "Best glide pitch": `${fmt(best.pitchDeg, 1)} degrees, ${fmt(best.state.glideRatio, 2)} to 1`,
  };
}

function runCruise(opts: McElytraOpts): McElytraResult {
  const pitch = num(opts, "pitch", "Pitch", 0);
  const flightDuration = Math.round(num(opts, "flightDuration", "Firework flight duration", 1));
  const plan = cruisePlan(pitch, flightDuration, gravityFor(opts));
  return {
    "Cruise speed": `${fmt(plan.speedPerTick, 3)} blocks per tick (${fmt(plan.speedPerSecond, 1)} blocks per second)`,
    "Rocket flight duration": `${flightDuration} (${flightDuration} gunpowder per craft)`,
    "Boost per rocket": `${fmt(plan.boostTicks, 1)} ticks on average (${plan.minBoostTicks} to ${plan.maxBoostTicks})`,
    "Blocks per rocket": `${fmt(plan.blocksPerRocket, 1)} blocks (${fmt(plan.minBlocksPerRocket)} to ${fmt(plan.maxBlocksPerRocket)})`,
    "Rockets per 1000 blocks": fmt(plan.rocketsPerThousandBlocks, 1),
    "Gunpowder per 1000 blocks": fmt(plan.gunpowderPerThousandBlocks, 1),
    "Paper per 1000 blocks": fmt(plan.paperPerThousandBlocks, 1),
    "Height change while cruising": `${fmt(plan.verticalSpeedPerTick * TICKS_PER_SECOND, 2)} blocks per second`,
  };
}

function runTravel(opts: McElytraOpts): McElytraResult {
  const x = num(opts, "targetX", "Target X", 10000);
  const z = num(opts, "targetZ", "Target Z", 0);
  const flightDuration = Math.round(num(opts, "flightDuration", "Firework flight duration", 1));
  const plan = travelPlan(x, z, {
    pitchDeg: num(opts, "pitch", "Pitch", 0),
    flightDuration,
    gravity: gravityFor(opts),
  });
  return {
    Distance: `${fmt(plan.overworld.distance)} blocks from the origin`,
    "Overworld rockets": `${fmt(plan.overworld.rockets)} (${fmt(plan.overworld.crafts)} crafts: ${fmt(plan.overworld.gunpowder)} gunpowder, ${fmt(plan.overworld.paper)} paper)`,
    "Overworld time": duration(plan.overworld.ticks),
    "Nether distance": `${fmt(plan.nether.distance)} blocks (8 to 1)`,
    "Nether rockets": `${fmt(plan.nether.rockets)} (${fmt(plan.nether.crafts)} crafts: ${fmt(plan.nether.gunpowder)} gunpowder, ${fmt(plan.nether.paper)} paper)`,
    "Nether time": duration(plan.nether.ticks),
    "Saved by the Nether": `${fmt(plan.netherSavingFraction * 100)}% of the distance`,
  };
}

function runDurability(opts: McElytraOpts): McElytraResult {
  const version = String(opts.version ?? "1.21.11") as ElytraVersionId;
  const damage = Math.round(num(opts, "damage", "Current damage", 0));
  const unbreaking = Math.round(num(opts, "unbreaking", "Unbreaking level", 0));
  const cruise = cruisePlan(
    0,
    Math.round(num(opts, "flightDuration", "Firework flight duration", 1)),
    gravityFor(opts),
  );
  const plan = durabilityPlan({
    version,
    currentDamage: damage,
    unbreaking,
    cruiseSpeed: cruise.speedPerTick,
  });
  return {
    "Durability left": `${fmt(plan.usableDurability)} of ${fmt(plan.maxDamage)} (flight stops with 1 point left)`,
    "Flight per durability point": `${fmt(plan.expectedTicksPerDurability)} ticks (${fmt(plan.expectedTicksPerDurability / TICKS_PER_SECOND, 1)} seconds) with Unbreaking ${unbreaking}`,
    "Total flight time": duration(plan.flightTicks),
    "Distance at cruise": `${fmt(plan.flightDistance)} blocks with rockets chained`,
    "Mending upkeep": `${fmt(plan.mendingXpPerSecond, 2)} experience per second of flight`,
    "Experience for a full repair": `${fmt(plan.mendingXpToFullRepair)} points`,
    "Phantom membranes": `${fmt(plan.membranesToFull)} to repair fully (${fmt(plan.repairPerMembrane)} durability each, up to ${plan.membranesPerAnvilUse} per anvil use)`,
    "Anvil uses": `${fmt(plan.anvilUses)} (${fmt(plan.levelsIgnoringPriorWork)} levels before the prior work penalty)`,
  };
}

function runDamage(opts: McElytraOpts): McElytraResult {
  const stars = Math.round(num(opts, "stars", "Firework stars", 0));
  const self = fireworkSelfDamage(stars);
  return {
    "Firework stars": fmt(stars),
    "Damage to you": self.harmless
      ? "None: a rocket with no stars never explodes on the flier"
      : `${fmt(self.damage)} damage (${fmt(self.hearts, 1)} hearts) before armor`,
    "Damage type": "minecraft:fireworks, which is in the explosion tag and does not bypass armor",
    "Applies when": "the rocket reaches the end of its lifetime while boosting you",
  };
}

export function run(_input: undefined, opts: McElytraOpts): McElytraResult {
  switch (opts.mode) {
    case "glide":
      return runGlide(opts);
    case "cruise":
      return runCruise(opts);
    case "travel":
      return runTravel(opts);
    case "durability":
      return runDurability(opts);
    case "damage":
      return runDamage(opts);
    default:
      throw new ToolError(
        "unknown-mode",
        `Unknown mode "${String(opts.mode)}".`,
        "Pick a mode: Glide from height, Rocket cruise, Trip planner, Durability, or Firework damage.",
      );
  }
}

export default { run } satisfies ToolLogic<undefined, McElytraResult, McElytraOpts>;

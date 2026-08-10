import { ToolError, type ToolLogic } from "../types";
import {
  ARROW_DESPAWN_TICKS,
  BOW_FULL_DRAW_TICKS,
  CROSSBOW_BASE_CHARGE_SECONDS,
  DEFAULT_LAUNCH_HEIGHT,
  ENCHANT_BY_ID,
  ENDER_PEARL_DAMAGE,
  LAUNCH_MODES,
  PROJECTILE_BY_ID,
  PUNCH_KNOCKBACK_PER_LEVEL,
  PUNCH_VERTICAL_PUSH,
  TPS,
  VERSIONS,
  VERSION_INFO,
  type EnchantId,
  type LaunchModeId,
  type ProjectileId,
  type TrigEra,
  type VersionId,
} from "./data";

/**
 * Minecraft projectile trajectory calculator.
 *
 * Every projectile is stepped one game tick at a time with the real per type
 * gravity and drag constants and the real per version order of operations,
 * reimplemented from decompiled or unobfuscated server source (never copied):
 *
 *   AbstractArrow.tick          move, then drag, then gravity
 *   ThrowableProjectile.tick    same until 1.21.2, then gravity, drag, move
 *   FireworkRocketEntity.tick   no gravity and no drag when shot at an angle
 *   Projectile.getMovementToShoot   normalize the aim vector, then scale by speed
 *   Projectile.shootFromRotation    yaw and pitch to a direction through Mth.sin
 *   BowItem.getPowerForTime     the float draw curve
 *   CrossbowItem.getChargeDuration  1.25s base, minus 0.25s per Quick Charge
 *
 * Positions and motion are Java doubles, so the arithmetic here is plain
 * double arithmetic. Math.fround appears only where the game genuinely uses a
 * Java float: the 0.99F drag constant, the pre 1.20 float gravity constants,
 * the bow power curve, and the Mth trig lookup.
 *
 * Aim angles are solved by search over simulations, never by the vacuum
 * ballistic formula, because 1 percent drag per tick makes the closed form
 * wrong by whole blocks at range.
 */

const f32 = Math.fround;

/** (float)(Math.PI / 180.0), the game's Mth.DEG_TO_RAD. */
const DEG_TO_RAD_F = f32(Math.PI / 180);

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type Medium = "air" | "water";

/* ------------------------------------------------------------------ */
/* Mth trig: a 65536 entry float lookup table, not Math.sin            */
/* ------------------------------------------------------------------ */

/**
 * Reproduces Mth.sin. The game samples a 65536 entry float table rather than
 * calling Math.sin, and the quantisation is large enough to move a long shot
 * by a fraction of a block, so an aim angle that ignores it is not exact.
 *
 * Values are computed on demand instead of materialising the table, which is
 * the same arithmetic without a quarter megabyte of memory per page.
 */
function mthSin(radians: number, era: TrigEra): number {
  if (era === "double") {
    const index = Math.trunc(radians * 10430.378350470453) & 65535;
    return f32(Math.sin(index / 10430.378350470453));
  }
  const index = Math.trunc(f32(radians * f32(10430.378))) & 65535;
  return f32(Math.sin((index * Math.PI * 2) / 65536));
}

/** Reproduces Mth.cos, which is the same table offset by a quarter turn. */
function mthCos(radians: number, era: TrigEra): number {
  if (era === "double") {
    const index = Math.trunc(radians * 10430.378350470453 + 16384) & 65535;
    return f32(Math.sin(index / 10430.378350470453));
  }
  const index = Math.trunc(f32(f32(radians * f32(10430.378)) + 16384)) & 65535;
  return f32(Math.sin((index * Math.PI * 2) / 65536));
}

/* ------------------------------------------------------------------ */
/* launch velocity                                                     */
/* ------------------------------------------------------------------ */

/**
 * BowItem.getPowerForTime. Pure float arithmetic: a 20 tick full draw gives
 * exactly 1.0, and a release under 0.1 power is refused by the game.
 */
export function bowPowerForTime(drawTicks: number): number {
  const t = f32(drawTicks / 20);
  let power = f32(f32(f32(t * t) + f32(t * 2)) / 3);
  if (power > 1) power = 1;
  return power;
}

/** Blocks per tick an arrow leaves a bow at, for a given draw in ticks. */
export function bowVelocity(drawTicks: number): number {
  return f32(bowPowerForTime(drawTicks) * 3);
}

/** The shortest draw the game will fire at all, in ticks. */
export function minimumBowDrawTicks(): number {
  for (let t = 0; t <= BOW_FULL_DRAW_TICKS; t++) {
    if (bowPowerForTime(t) >= 0.1) return t;
  }
  return BOW_FULL_DRAW_TICKS;
}

/**
 * CrossbowItem.getChargeDuration: floor(20 * (1.25 - 0.25 * quickCharge)).
 * Quick Charge III lands on 10 ticks, half a second.
 */
export function crossbowChargeTicks(quickCharge: number): number {
  const seconds = f32(CROSSBOW_BASE_CHARGE_SECONDS - 0.25 * quickCharge);
  return Math.max(0, Math.floor(f32(seconds * 20)));
}

/** Launch speed in blocks per tick for a projectile and launcher. */
export function launchSpeed(
  projectile: ProjectileId,
  launcher: LaunchModeId,
  drawTicks = BOW_FULL_DRAW_TICKS,
): number {
  const def = PROJECTILE_BY_ID[projectile];
  const mode = LAUNCH_MODES[launcher];
  const override = def.powerByLauncher?.[launcher];
  if (override !== undefined) return override;
  if (mode.chargeable) return bowVelocity(drawTicks);
  return mode.power;
}

/** Degrees added to the pitch for the y component only, before normalising. */
export function launchPitchOffset(projectile: ProjectileId, launcher: LaunchModeId): number {
  const def = PROJECTILE_BY_ID[projectile];
  return def.pitchOffsetByLauncher?.[launcher] ?? LAUNCH_MODES[launcher].pitchOffset;
}

/**
 * Projectile.shootFromRotation followed by Projectile.getMovementToShoot with
 * the inaccuracy term at its mean of zero: build the aim vector in floats,
 * normalise it in doubles, then scale by the launch speed.
 *
 * `pitch` is the game's xRot, so negative is upward.
 */
export function motionFromRotation(
  version: VersionId,
  pitch: number,
  yaw: number,
  pitchOffset: number,
  speed: number,
): Vec3 {
  const era = VERSION_INFO[version].trigEra;
  const yawRad = f32(yaw * DEG_TO_RAD_F);
  const pitchRad = f32(pitch * DEG_TO_RAD_F);
  const offsetRad = f32(f32(pitch + pitchOffset) * DEG_TO_RAD_F);
  const dx = f32(-mthSin(yawRad, era) * mthCos(pitchRad, era));
  const dy = f32(-mthSin(offsetRad, era));
  const dz = f32(mthCos(yawRad, era) * mthCos(pitchRad, era));
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (length < f32(1e-5)) return { x: 0, y: 0, z: 0 };
  const scale = f32(speed);
  return { x: (dx / length) * scale, y: (dy / length) * scale, z: (dz / length) * scale };
}

/* ------------------------------------------------------------------ */
/* the per tick simulator                                              */
/* ------------------------------------------------------------------ */

export interface SimTick {
  /** Ticks since the projectile spawned. Tick 0 is the spawn position. */
  tick: number;
  x: number;
  y: number;
  z: number;
  /** Motion at the START of this tick, in blocks per tick. */
  vx: number;
  vy: number;
  vz: number;
  /** Horizontal distance from the spawn point. */
  distance: number;
  /** Speed in blocks per tick, which is what arrow damage scales with. */
  speed: number;
}

export interface SimulateOptions {
  version: VersionId;
  projectile: ProjectileId;
  medium?: Medium;
  /** Spawn position. Defaults to the origin at the standing launch height. */
  origin?: Vec3;
  /** Explicit motion in blocks per tick. Wins over pitch, yaw and speed. */
  motion?: Vec3;
  /** Game pitch (xRot) in degrees: negative aims upward. */
  pitch?: number;
  yaw?: number;
  launcher?: LaunchModeId;
  drawTicks?: number;
  /** Overrides the launcher's speed. */
  speed?: number;
  /**
   * "hurting" family only: overrides AbstractHurtingProjectile's acceleration
   * per tick. A ghast or blaze sets it to 0.1 when it shoots; an entity
   * summoned by command before 1.21.1 has no stored Power vector at all, so it
   * coasts on drag alone.
   */
  accelerationPower?: number;
  /** Absolute y of the surface the projectile lands on. Omit for no ground. */
  groundY?: number;
  /**
   * Stop as soon as the flight has covered this much horizontal distance.
   * Horizontal speed only ever shrinks, so the distance is monotonic and
   * cutting the run short cannot change any earlier tick. Purely a speed lever
   * for the aim search, which runs hundreds of simulations per answer.
   */
  stopAfterDistance?: number;
  maxTicks?: number;
}

export interface SimResult {
  ticks: SimTick[];
  motion0: Vec3;
  origin: Vec3;
  landed: boolean;
  /** Where the flight ended, interpolated onto the ground plane when it landed. */
  landing: SimTick | null;
  /** Fractional ticks of flight, so a landing part way through a tick is honest. */
  flightTicks: number;
  peak: SimTick;
  /** True when the run hit the tick budget instead of the ground. */
  truncated: boolean;
}

const DEFAULT_MAX_TICKS = 600;

function speedOf(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function sample(tick: number, p: Vec3, v: Vec3, origin: Vec3): SimTick {
  const dx = p.x - origin.x;
  const dz = p.z - origin.z;
  return {
    tick,
    x: p.x,
    y: p.y,
    z: p.z,
    vx: v.x,
    vy: v.y,
    vz: v.z,
    distance: Math.sqrt(dx * dx + dz * dz),
    speed: speedOf(v),
  };
}

/**
 * Steps one game tick of motion. The order of operations is the whole point:
 *
 *   arrows (AbstractArrow.tick)        position += motion, drag, gravity
 *   arrows in water on 1.21.2+         drag, position += motion, gravity
 *   throwables before 1.21.2           position += motion, drag, gravity
 *   throwables on 1.21.2+              gravity, drag, position += motion
 *   fireworks shot at an angle         position += motion, nothing else
 */
function stepTick(
  version: VersionId,
  projectile: ProjectileId,
  medium: Medium,
  p: Vec3,
  v: Vec3,
  /** Unit heading captured at launch, used by the versions that store xPower. */
  launchHeading: Vec3,
  accelerationPower: number,
): { p: Vec3; v: Vec3 } {
  const info = VERSION_INFO[version];
  const def = PROJECTILE_BY_ID[projectile];
  const inWater = medium === "water";
  const gravity = info.floatGravity ? f32(def.gravity) : def.gravity;
  const airDrag = f32(def.airDrag);
  const waterDrag = f32(def.waterDrag);

  if (def.family === "firework") {
    // FireworkRocketEntity.tick. A crossbow rocket is flagged shot at angle and
    // gets nothing; any other rocket gains 15 percent horizontal speed and 0.04
    // upward first, then moves.
    if (def.shotAtAngle) {
      return { p: { x: p.x + v.x, y: p.y + v.y, z: p.z + v.z }, v: { ...v } };
    }
    const boosted = { x: v.x * 1.15, y: v.y + 0.04, z: v.z * 1.15 };
    return {
      p: { x: p.x + boosted.x, y: p.y + boosted.y, z: p.z + boosted.z },
      v: boosted,
    };
  }

  if (def.family === "hurting") {
    // AbstractHurtingProjectile.tick: motion += heading * accelerationPower,
    // then motion *= inertia. No gravity ever.
    const inertia = inWater ? waterDrag : airDrag;
    const accel = accelerationPower;
    const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    const fromMotion =
      len < f32(1e-5) ? { x: 0, y: 0, z: 0 } : { x: v.x / len, y: v.y / len, z: v.z / len };
    const unit = info.hurtingAccelFromMotion ? fromMotion : launchHeading;
    const pushed = {
      x: (v.x + unit.x * accel) * inertia,
      y: (v.y + unit.y * accel) * inertia,
      z: (v.z + unit.z * accel) * inertia,
    };
    if (info.hurtingAcceleratesFirst) {
      return { p: { x: p.x + pushed.x, y: p.y + pushed.y, z: p.z + pushed.z }, v: pushed };
    }
    return { p: { x: p.x + v.x, y: p.y + v.y, z: p.z + v.z }, v: pushed };
  }

  let nv = { ...v };

  if (def.family === "throwable" && info.throwableAcceleratesFirst) {
    nv = { x: nv.x, y: nv.y - gravity, z: nv.z };
    const drag = inWater ? waterDrag : airDrag;
    nv = { x: nv.x * drag, y: nv.y * drag, z: nv.z * drag };
    return { p: { x: p.x + nv.x, y: p.y + nv.y, z: p.z + nv.z }, v: nv };
  }

  if (def.family === "arrow" && inWater && info.arrowWaterDragBeforeMove) {
    nv = { x: nv.x * waterDrag, y: nv.y * waterDrag, z: nv.z * waterDrag };
    const np = { x: p.x + nv.x, y: p.y + nv.y, z: p.z + nv.z };
    nv = { x: nv.x, y: nv.y - gravity, z: nv.z };
    return { p: np, v: nv };
  }

  const np = { x: p.x + nv.x, y: p.y + nv.y, z: p.z + nv.z };
  const drag = inWater ? waterDrag : airDrag;
  nv = { x: nv.x * drag, y: nv.y * drag, z: nv.z * drag };
  nv = { x: nv.x, y: nv.y - gravity, z: nv.z };
  return { p: np, v: nv };
}

/** Runs the flight tick by tick and returns every sampled position. */
export function simulate(options: SimulateOptions): SimResult {
  const version = requireVersion(options.version);
  const projectile = requireProjectile(options.projectile);
  const def = PROJECTILE_BY_ID[projectile];
  const medium: Medium = options.medium === "water" ? "water" : "air";
  const origin: Vec3 = options.origin ?? { x: 0, y: DEFAULT_LAUNCH_HEIGHT, z: 0 };
  const maxTicks = Math.max(1, Math.min(20000, Math.floor(options.maxTicks ?? DEFAULT_MAX_TICKS)));

  let motion: Vec3;
  if (options.motion) {
    motion = { ...options.motion };
  } else {
    const launcher = options.launcher ?? def.launchers[0];
    const speed = options.speed ?? launchSpeed(projectile, launcher, options.drawTicks);
    motion = motionFromRotation(
      version,
      options.pitch ?? 0,
      options.yaw ?? 0,
      launchPitchOffset(projectile, launcher),
      speed,
    );
  }

  const accelerationPower = options.accelerationPower ?? def.accelerationPower ?? 0;
  const launchLength = speedOf(motion);
  const launchHeading: Vec3 =
    launchLength < f32(1e-5)
      ? { x: 0, y: 0, z: 0 }
      : { x: motion.x / launchLength, y: motion.y / launchLength, z: motion.z / launchLength };

  const ticks: SimTick[] = [];
  let p: Vec3 = { ...origin };
  let v: Vec3 = { ...motion };
  let peak = sample(0, p, v, origin);
  ticks.push(peak);

  let landed = false;
  let landing: SimTick | null = null;
  let flightTicks = 0;
  let truncated = false;

  for (let t = 1; t <= maxTicks; t++) {
    const next = stepTick(version, projectile, medium, p, v, launchHeading, accelerationPower);
    if (options.groundY !== undefined && next.p.y <= options.groundY) {
      const dy = p.y - next.p.y;
      const frac = dy === 0 ? 0 : (p.y - options.groundY) / dy;
      const hit: Vec3 = {
        x: p.x + (next.p.x - p.x) * frac,
        y: options.groundY,
        z: p.z + (next.p.z - p.z) * frac,
      };
      landing = sample(t, hit, v, origin);
      ticks.push(landing);
      landed = true;
      flightTicks = t - 1 + frac;
      break;
    }
    p = next.p;
    v = next.v;
    const s = sample(t, p, v, origin);
    ticks.push(s);
    if (s.y > peak.y) peak = s;
    flightTicks = t;
    if (t === maxTicks) truncated = true;
    if (options.stopAfterDistance !== undefined && s.distance >= options.stopAfterDistance) break;
  }

  if (!landed && options.groundY === undefined) truncated = ticks.length - 1 >= maxTicks;

  return { ticks, motion0: motion, origin, landed, landing, flightTicks, peak, truncated };
}

/* ------------------------------------------------------------------ */
/* aiming: solved by search, never by the vacuum formula               */
/* ------------------------------------------------------------------ */

/**
 * The height a shot reaches at a given horizontal distance, interpolated
 * between the two ticks that straddle it. Returns null when the projectile
 * never gets that far, which is what makes a target genuinely out of range.
 */
function heightAtDistance(result: SimResult, distance: number): number | null {
  const ticks = result.ticks;
  for (let i = 1; i < ticks.length; i++) {
    const a = ticks[i - 1];
    const b = ticks[i];
    if (b.distance >= distance && a.distance <= distance) {
      const span = b.distance - a.distance;
      const frac = span === 0 ? 0 : (distance - a.distance) / span;
      return a.y + (b.y - a.y) * frac;
    }
  }
  return null;
}

/** Fractional ticks of flight to reach a horizontal distance. */
function ticksToDistance(result: SimResult, distance: number): number | null {
  const ticks = result.ticks;
  for (let i = 1; i < ticks.length; i++) {
    const a = ticks[i - 1];
    const b = ticks[i];
    if (b.distance >= distance && a.distance <= distance) {
      const span = b.distance - a.distance;
      const frac = span === 0 ? 0 : (distance - a.distance) / span;
      return a.tick + (b.tick - a.tick) * frac;
    }
  }
  return null;
}

/** Speed in blocks per tick at a horizontal distance, interpolated. */
function speedAtDistance(result: SimResult, distance: number): number | null {
  const ticks = result.ticks;
  for (let i = 1; i < ticks.length; i++) {
    const a = ticks[i - 1];
    const b = ticks[i];
    if (b.distance >= distance && a.distance <= distance) {
      const span = b.distance - a.distance;
      const frac = span === 0 ? 0 : (distance - a.distance) / span;
      return a.speed + (b.speed - a.speed) * frac;
    }
  }
  return null;
}

export interface AimOptions {
  version: VersionId;
  projectile: ProjectileId;
  launcher?: LaunchModeId;
  drawTicks?: number;
  speed?: number;
  medium?: Medium;
  /** Horizontal distance to the target, in blocks. */
  distance: number;
  /** Target height relative to the launch point, in blocks. Up is positive. */
  deltaY: number;
  maxTicks?: number;
}

export interface AimSolution {
  /** Degrees above the horizon. This is what a player reads off the F3 screen negated. */
  angle: number;
  /** The game's xRot for the same shot, where negative is upward. */
  pitch: number;
  /** Fractional ticks in flight. */
  flightTicks: number;
  seconds: number;
  /** Blocks per tick at the moment it reaches the target. */
  impactSpeed: number;
  /**
   * How far above (positive) or below (negative) the target the shot actually
   * passes. It is rarely exactly zero: the game's sine table only has 65536
   * directions, so there is a smallest possible aim step and at long range it
   * is worth a fraction of a block.
   */
  missY: number;
  arc: "low" | "high";
}

const SCAN_STEP_DEGREES = 0.25;
const SCAN_MIN = -89;
const SCAN_MAX = 89;

function solutionAt(o: AimOptions, angle: number): AimSolution | null {
  const result = simulate({
    version: o.version,
    projectile: o.projectile,
    launcher: o.launcher,
    drawTicks: o.drawTicks,
    speed: o.speed,
    medium: o.medium,
    origin: { x: 0, y: 0, z: 0 },
    pitch: -angle,
    stopAfterDistance: o.distance,
    maxTicks: o.maxTicks ?? DEFAULT_MAX_TICKS,
  });
  const t = ticksToDistance(result, o.distance);
  const s = speedAtDistance(result, o.distance);
  const y = heightAtDistance(result, o.distance);
  if (t === null || s === null || y === null) return null;
  return {
    angle,
    pitch: -angle,
    flightTicks: t,
    seconds: t / TPS,
    impactSpeed: s,
    missY: y - o.deltaY,
    arc: "low",
  };
}

/**
 * Solves the aim angle for a target by simulating the whole flight at many
 * angles and bisecting where the miss changes sign. Drag makes the textbook
 * 45 degree ballistic answer wrong, so there is no closed form to fall back on.
 *
 * Most reachable targets have two answers: a flat fast shot and a lobbed one.
 */
export function solveAim(o: AimOptions): { low: AimSolution | null; high: AimSolution | null } {
  if (!(o.distance > 0)) {
    throw new ToolError(
      "invalid-distance",
      "The target distance must be greater than zero.",
      "Enter how many blocks away the target is, measured flat on the ground.",
    );
  }
  const target = o.deltaY;
  const errors: { angle: number; err: number }[] = [];
  for (let a = SCAN_MIN; a <= SCAN_MAX + 1e-9; a += SCAN_STEP_DEGREES) {
    const e = aimErrorAt(o, a, target);
    if (e !== null) errors.push({ angle: a, err: e });
  }

  const roots: number[] = [];
  for (let i = 1; i < errors.length; i++) {
    const a = errors[i - 1];
    const b = errors[i];
    if (a.err === 0) roots.push(a.angle);
    if ((a.err < 0 && b.err > 0) || (a.err > 0 && b.err < 0)) {
      roots.push(bisect(o, target, a.angle, a.err, b.angle));
    }
  }
  if (errors.length > 0 && errors[errors.length - 1].err === 0) {
    roots.push(errors[errors.length - 1].angle);
  }

  const unique = roots.filter((r, i) => roots.findIndex((x) => Math.abs(x - r) < 1e-4) === i);
  unique.sort((a, b) => a - b);
  const low = unique.length > 0 ? solutionAt(o, unique[0]) : null;
  const high = unique.length > 1 ? solutionAt(o, unique[unique.length - 1]) : null;
  if (low) low.arc = "low";
  if (high) high.arc = "high";
  return { low, high: high && Math.abs(high.angle - (low?.angle ?? 0)) > 1e-3 ? high : null };
}

function aimErrorAt(o: AimOptions, angle: number, target: number): number | null {
  const result = simulate({
    version: o.version,
    projectile: o.projectile,
    launcher: o.launcher,
    drawTicks: o.drawTicks,
    speed: o.speed,
    medium: o.medium,
    origin: { x: 0, y: 0, z: 0 },
    pitch: -angle,
    stopAfterDistance: o.distance,
    maxTicks: o.maxTicks ?? DEFAULT_MAX_TICKS,
  });
  const y = heightAtDistance(result, o.distance);
  if (y === null) return null;
  return y - target;
}

/**
 * Bisects the miss between two bracketing angles.
 *
 * The miss is a step function of the angle, not a smooth one, because
 * Mth.sin only has 65536 entries. So the loop narrows the bracket and then
 * keeps whichever end of it actually misses by less, which is the best a
 * player can do in game.
 */
function bisect(o: AimOptions, target: number, lo: number, loErr: number, hi: number): number {
  let a = lo;
  let b = hi;
  let fa = loErr;
  let fb = aimErrorAt(o, hi, target) ?? -loErr;
  for (let i = 0; i < 60; i++) {
    const mid = (a + b) / 2;
    if (mid === a || mid === b) break;
    const fm = aimErrorAt(o, mid, target);
    if (fm === null) break;
    if (fm === 0) return mid;
    if ((fa < 0 && fm < 0) || (fa > 0 && fm > 0)) {
      a = mid;
      fa = fm;
    } else {
      b = mid;
      fb = fm;
    }
  }
  return Math.abs(fa) <= Math.abs(fb) ? a : b;
}

/* ------------------------------------------------------------------ */
/* range, drop, and the pearl                                          */
/* ------------------------------------------------------------------ */

export interface RangeResult {
  /** Best horizontal distance, in blocks, landing back at the launch height. */
  maxRange: number;
  /** The angle above the horizon that achieves it. Drag pulls it under 45. */
  bestAngle: number;
  flightTicks: number;
  seconds: number;
  /** Distance reached firing dead level from the standing launch height. */
  levelRange: number;
  levelFlightTicks: number;
  /**
   * True for the projectiles that take no gravity at all, where "range" is set
   * by the fuse or the despawn timer rather than by the arc. The distances
   * above are then simply how far it got inside the simulated tick budget.
   */
  unlimited: boolean;
  /** How many ticks the numbers above were measured over. */
  overTicks: number;
}

/**
 * Maximum range, found by simulating every angle rather than by the vacuum
 * formula. With 1 percent drag per tick the best angle is not 45 degrees.
 *
 * `dropTo` is how far below the launch point the ground sits: 0 is a shot that
 * has to come back to the height it left at, and the default is the standing
 * launch height so the arrow lands on the shooter's own floor.
 */
export function maxRange(
  version: VersionId,
  projectile: ProjectileId,
  launcher?: LaunchModeId,
  drawTicks?: number,
  medium: Medium = "air",
  dropTo: number = DEFAULT_LAUNCH_HEIGHT,
): RangeResult {
  const weightless = PROJECTILE_BY_ID[projectile].gravity === 0;
  // A projectile with no gravity never comes down, so measuring it against the
  // ground is meaningless. Measure it over its own useful lifetime instead: a
  // crossbow rocket's fuse, or the arrow despawn window for the rest.
  const budget = weightless ? 100 : 2000;

  const shoot = (angle: number): SimResult =>
    simulate({
      version,
      projectile,
      launcher,
      drawTicks,
      medium,
      origin: { x: 0, y: dropTo, z: 0 },
      groundY: weightless ? undefined : 0,
      pitch: -angle,
      maxTicks: budget,
    });

  if (weightless) {
    const level = shoot(0);
    const last = level.ticks[level.ticks.length - 1];
    return {
      maxRange: last.distance,
      bestAngle: 0,
      flightTicks: last.tick,
      seconds: last.tick / TPS,
      levelRange: last.distance,
      levelFlightTicks: last.tick,
      unlimited: true,
      overTicks: budget,
    };
  }

  let bestAngle = 0;
  let best = -1;
  for (let a = 0; a <= 80; a += 0.5) {
    const r = shoot(a);
    const d = r.landing?.distance ?? r.ticks[r.ticks.length - 1].distance;
    if (d > best) {
      best = d;
      bestAngle = a;
    }
  }
  for (let a = bestAngle - 0.5; a <= bestAngle + 0.5; a += 0.01) {
    if (a < 0 || a > 89) continue;
    const r = shoot(a);
    const d = r.landing?.distance ?? r.ticks[r.ticks.length - 1].distance;
    if (d > best) {
      best = d;
      bestAngle = a;
    }
  }

  const bestRun = shoot(bestAngle);
  const level = shoot(0);
  return {
    maxRange: best,
    bestAngle: Math.round(bestAngle * 100) / 100,
    flightTicks: bestRun.flightTicks,
    seconds: bestRun.flightTicks / TPS,
    levelRange: level.landing?.distance ?? 0,
    levelFlightTicks: level.flightTicks,
    unlimited: false,
    overTicks: budget,
  };
}

export interface DropRow {
  distance: number;
  /** Blocks below the crosshair line the projectile is by then. */
  drop: number;
  ticks: number;
  seconds: number;
  speed: number;
}

/** How far a dead level shot has fallen by each of the given distances. */
export function dropOverDistance(
  version: VersionId,
  projectile: ProjectileId,
  distances: number[],
  launcher?: LaunchModeId,
  drawTicks?: number,
  medium: Medium = "air",
): DropRow[] {
  const result = simulate({
    version,
    projectile,
    launcher,
    drawTicks,
    medium,
    origin: { x: 0, y: 0, z: 0 },
    pitch: 0,
    stopAfterDistance: Math.max(...distances, 0),
    maxTicks: 2000,
  });
  const rows: DropRow[] = [];
  for (const d of distances) {
    const y = heightAtDistance(result, d);
    const t = ticksToDistance(result, d);
    const s = speedAtDistance(result, d);
    if (y === null || t === null || s === null) continue;
    rows.push({ distance: d, drop: -y, ticks: t, seconds: t / TPS, speed: s });
  }
  return rows;
}

export interface PearlResult {
  distance: number;
  landingY: number;
  flightTicks: number;
  seconds: number;
  damage: number;
  /** Where the game puts you: the impact point, or the pearl's position at the start of that tick. */
  landsAt: "impact point" | "position at the start of the impact tick";
  /** Distance between those two definitions on this version, in blocks. */
  offsetFromImpact: number;
}

/**
 * Where an ender pearl puts you, and the 5 fall damage it always deals.
 *
 * From 1.21.2 ThrownEnderpearl.onHit teleports to oldPosition(), the pearl's
 * position at the start of the tick it hit on, instead of the clipped impact
 * point. On a fast pearl that is most of a block short of the wall.
 */
export function pearlLanding(
  version: VersionId,
  pitch: number,
  medium: Medium = "air",
  groundDrop: number = DEFAULT_LAUNCH_HEIGHT,
): PearlResult {
  const result = simulate({
    version,
    projectile: "ender_pearl",
    launcher: "hand",
    medium,
    origin: { x: 0, y: groundDrop, z: 0 },
    groundY: 0,
    pitch,
    maxTicks: 2000,
  });
  const info = VERSION_INFO[version];
  const impact = result.landing ?? result.ticks[result.ticks.length - 1];
  const startOfTick = result.ticks[Math.max(0, result.ticks.length - 2)];
  const chosen = info.pearlLandsAtOldPosition ? startOfTick : impact;
  const dx = impact.x - startOfTick.x;
  const dy = impact.y - startOfTick.y;
  const dz = impact.z - startOfTick.z;
  return {
    distance: chosen.distance,
    landingY: chosen.y,
    flightTicks: result.flightTicks,
    seconds: result.flightTicks / TPS,
    damage: ENDER_PEARL_DAMAGE,
    landsAt: info.pearlLandsAtOldPosition
      ? "position at the start of the impact tick"
      : "impact point",
    offsetFromImpact: info.pearlLandsAtOldPosition ? Math.sqrt(dx * dx + dy * dy + dz * dz) : 0,
  };
}

/* ------------------------------------------------------------------ */
/* damage and knockback                                                */
/* ------------------------------------------------------------------ */

export interface ImpactDamage {
  /** Damage before a critical roll. */
  base: number;
  /** Lowest and highest a fully drawn critical shot can roll. */
  critMin: number;
  critMax: number;
  hearts: number;
  /** Horizontal knockback impulse in blocks per tick. */
  knockback: number;
  verticalKnockback: number;
}

/**
 * AbstractArrow.onHitEntity: ceil((float)speed * baseDamage). The speed is cast
 * to a float before the multiply, and a fully drawn bow marks the arrow
 * critical, which adds a random 0 to floor(damage / 2) + 1 on top.
 *
 * A trident is not speed scaled: ThrownTrident.onHitEntity uses a flat 8.
 */
export function impactDamage(
  projectile: ProjectileId,
  speed: number,
  opts: { power?: number; punch?: number; impaling?: number; critical?: boolean } = {},
): ImpactDamage {
  const def = PROJECTILE_BY_ID[projectile];
  const punch = clampInt(opts.punch ?? 0, 0, ENCHANT_BY_ID.punch.maxLevel);
  const knockback = punch * PUNCH_KNOCKBACK_PER_LEVEL;

  if (def.damage.kind === "none") {
    return {
      base: 0,
      critMin: 0,
      critMax: 0,
      hearts: 0,
      knockback,
      verticalKnockback: punch > 0 ? PUNCH_VERTICAL_PUSH : 0,
    };
  }

  if (def.damage.kind === "flat") {
    // Impaling only exists on a trident, so it never touches a blaze fireball.
    const impaling = def.launchers.includes("throw")
      ? clampInt(opts.impaling ?? 0, 0, ENCHANT_BY_ID.impaling.maxLevel)
      : 0;
    const base = def.damage.amount + impaling * 2.5;
    return {
      base,
      critMin: base,
      critMax: base,
      hearts: base / 2,
      knockback,
      verticalKnockback: punch > 0 ? PUNCH_VERTICAL_PUSH : 0,
    };
  }

  const power = clampInt(opts.power ?? 0, 0, ENCHANT_BY_ID.power.maxLevel);
  const bonus = power > 0 ? 1 + 0.5 * (power - 1) : 0;
  const baseDamage = def.damage.base + bonus;
  const base = Math.ceil(Math.max(0, f32(speed) * baseDamage));
  const critExtra = Math.floor(base / 2) + 1;
  return {
    base,
    critMin: opts.critical ? base : base,
    critMax: opts.critical ? base + critExtra : base,
    hearts: base / 2,
    knockback,
    verticalKnockback: punch > 0 ? PUNCH_VERTICAL_PUSH : 0,
  };
}

/* ------------------------------------------------------------------ */
/* validation helpers                                                  */
/* ------------------------------------------------------------------ */

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(Math.max(Math.floor(n), lo), hi);
}

export function requireVersion(value: unknown): VersionId {
  const v = String(value ?? "");
  if ((VERSIONS as string[]).includes(v)) return v as VersionId;
  throw new ToolError(
    "unknown-version",
    `"${v}" is not a covered Minecraft version.`,
    `Pick one of ${VERSIONS.join(", ")}.`,
  );
}

export function requireProjectile(value: unknown): ProjectileId {
  const v = String(value ?? "");
  if (v in PROJECTILE_BY_ID) return v as ProjectileId;
  throw new ToolError(
    "unknown-projectile",
    `"${v}" is not a projectile this calculator models.`,
    `Pick one of ${Object.keys(PROJECTILE_BY_ID).join(", ")}.`,
  );
}

function requireLauncher(projectile: ProjectileId, value: unknown): LaunchModeId {
  const def = PROJECTILE_BY_ID[projectile];
  if (value === undefined || value === null || value === "") return def.launchers[0];
  const v = String(value);
  if ((def.launchers as string[]).includes(v)) return v as LaunchModeId;
  throw new ToolError(
    "impossible-launcher",
    `A ${def.label.toLowerCase()} cannot be fired from a ${v}.`,
    `Choose one of: ${def.launchers.map((l) => LAUNCH_MODES[l].label).join(", ")}.`,
  );
}

/** Rejects enchantments that cannot exist on the weapon, or on each other. */
export function validateEnchants(
  launcher: LaunchModeId,
  levels: Partial<Record<EnchantId, number>>,
): void {
  const active = (Object.keys(levels) as EnchantId[]).filter((id) => (levels[id] ?? 0) > 0);
  for (const id of active) {
    const def = ENCHANT_BY_ID[id];
    if (!def) {
      throw new ToolError("unknown-enchant", `"${id}" is not an enchantment.`);
    }
    if (def.weapon !== launcher) {
      throw new ToolError(
        "impossible-enchant",
        `${def.label} cannot go on a ${LAUNCH_MODES[launcher].label.toLowerCase()}.`,
        `${def.label} only exists on a ${LAUNCH_MODES[def.weapon].label.toLowerCase()}.`,
      );
    }
    const clash = def.excludes.find((other) => active.includes(other));
    if (clash) {
      throw new ToolError(
        "exclusive-enchants",
        `${def.label} and ${ENCHANT_BY_ID[clash].label} cannot be on the same item.`,
        `Drop one of them: the game puts them in the same exclusive set.`,
      );
    }
  }
}

function num(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function blocks(n: number): string {
  return `${round(n)} blocks`;
}

/* ------------------------------------------------------------------ */
/* run()                                                               */
/* ------------------------------------------------------------------ */

export interface ProjectileCalcOpts {
  mode?: string;
  version?: string;
  projectile?: string;
  launcher?: string;
  drawTicks?: number;
  medium?: string;
  pitch?: number;
  distance?: number;
  deltaY?: number;
  power?: number;
  punch?: number;
  quickCharge?: number;
  impaling?: number;
  [key: string]: unknown;
}

export type ProjectileCalcResult = Record<string, string>;

const DROP_DISTANCES = [5, 10, 20, 30, 40, 50, 60];

export function run(_input: string, opts: ProjectileCalcOpts = {}): ProjectileCalcResult {
  const version = requireVersion(opts.version ?? "1.21.11");
  const projectile = requireProjectile(opts.projectile ?? "arrow");
  const launcher = requireLauncher(projectile, opts.launcher);
  const def = PROJECTILE_BY_ID[projectile];
  const medium: Medium = opts.medium === "water" ? "water" : "air";
  const drawTicks = clampInt(num(opts.drawTicks, BOW_FULL_DRAW_TICKS), 0, 72000);
  const mode = String(opts.mode ?? "aim");

  const power = clampInt(num(opts.power, 0), 0, ENCHANT_BY_ID.power.maxLevel);
  const punch = clampInt(num(opts.punch, 0), 0, ENCHANT_BY_ID.punch.maxLevel);
  const impaling = clampInt(num(opts.impaling, 0), 0, ENCHANT_BY_ID.impaling.maxLevel);
  validateEnchants(launcher, { power, punch, impaling });

  const speed = launchSpeed(projectile, launcher, drawTicks);

  if (mode === "range") {
    const r = maxRange(version, projectile, launcher, drawTicks, medium);
    const damage = impactDamage(projectile, speed, { power, punch, impaling, critical: true });
    if (r.unlimited) {
      return {
        Projectile: `${def.label}, ${launcherLabel(projectile, launcher)}`,
        "Launch speed": `${round(speed, 4)} blocks per tick`,
        Range: `not limited by gravity; it covers ${blocks(r.maxRange)} in ${r.overTicks} ticks and only stops when its fuse, its despawn timer, or a block stops it`,
        "Damage on a point blank hit": damageLine(damage),
      };
    }
    return {
      Projectile: `${def.label}, ${launcherLabel(projectile, launcher)}`,
      "Launch speed": `${round(speed, 4)} blocks per tick`,
      "Maximum range": blocks(r.maxRange),
      "Best angle": `${r.bestAngle} degrees above the horizon`,
      "Flight time at that angle": `${round(r.seconds)} s (${round(r.flightTicks)} ticks)`,
      "Range firing level": blocks(r.levelRange),
      "Damage on a point blank hit": damageLine(damage),
    };
  }

  if (mode === "drop") {
    const rows = dropOverDistance(
      version,
      projectile,
      DROP_DISTANCES,
      launcher,
      drawTicks,
      medium,
    );
    const out: ProjectileCalcResult = {
      Projectile: `${def.label}, ${launcherLabel(projectile, launcher)}`,
      "Launch speed": `${round(speed, 4)} blocks per tick`,
    };
    for (const row of rows) {
      out[`Drop at ${row.distance} blocks`] =
        `${round(row.drop)} blocks after ${round(row.seconds)} s`;
    }
    if (rows.length === 0) out["Drop"] = "This projectile never reaches those distances.";
    return out;
  }

  if (mode === "pearl") {
    const r = pearlLanding(version, num(opts.pitch, 0), medium);
    return {
      "Ender pearl throw": `pitch ${round(num(opts.pitch, 0), 1)} degrees in ${medium}`,
      "Lands at": blocks(r.distance),
      "Flight time": `${round(r.seconds)} s (${round(r.flightTicks)} ticks)`,
      "You take": `${r.damage} damage (2.5 hearts)`,
      "Teleport point": r.landsAt,
      "Short of the impact point by": blocks(r.offsetFromImpact),
    };
  }

  const distance = num(opts.distance, 30);
  const deltaY = num(opts.deltaY, 0);
  const aim = solveAim({
    version,
    projectile,
    launcher,
    drawTicks,
    medium,
    distance,
    deltaY,
  });
  if (!aim.low) {
    const r = maxRange(version, projectile, launcher, drawTicks, medium);
    throw new ToolError(
      "out-of-range",
      `A ${def.label.toLowerCase()} launched at ${round(speed, 3)} blocks per tick cannot reach a target ${round(distance)} blocks away at ${round(deltaY)} blocks of height.`,
      `Its maximum range is about ${round(r.maxRange)} blocks. Move closer or pick a faster launcher.`,
    );
  }

  const damage = impactDamage(projectile, aim.low.impactSpeed, {
    power,
    punch,
    impaling,
    critical: launcher === "bow" ? drawTicks >= BOW_FULL_DRAW_TICKS : false,
  });

  const out: ProjectileCalcResult = {
    Projectile: `${def.label}, ${launcherLabel(projectile, launcher)}`,
    "Launch speed": `${round(speed, 4)} blocks per tick`,
    Target: `${round(distance)} blocks away, ${round(deltaY)} blocks up`,
    "Aim angle (flat shot)": `${round(aim.low.angle, 2)} degrees above the horizon`,
    "Flight time (flat shot)": `${round(aim.low.seconds)} s (${round(aim.low.flightTicks)} ticks)`,
    "Impact speed": `${round(aim.low.impactSpeed, 3)} blocks per tick`,
    "Best possible miss": `${round(Math.abs(aim.low.missY), 4)} blocks (the sine table limits how finely you can aim)`,
    "Damage on hit": damageLine(damage),
  };
  if (aim.high) {
    out["Aim angle (lobbed shot)"] = `${round(aim.high.angle, 2)} degrees above the horizon`;
    out["Flight time (lobbed shot)"] =
      `${round(aim.high.seconds)} s (${round(aim.high.flightTicks)} ticks)`;
  }
  if (punch > 0) {
    out["Knockback"] =
      `${round(damage.knockback, 2)} blocks per tick horizontal plus ${damage.verticalKnockback} vertical`;
  }
  if (launcher === "crossbow") {
    const qc = clampInt(num(opts.quickCharge, 0), 0, ENCHANT_BY_ID.quick_charge.maxLevel);
    out["Reload time"] =
      `${round(crossbowChargeTicks(qc) / TPS)} s (${crossbowChargeTicks(qc)} ticks)`;
  }
  return out;
}

/** Human label for how a projectile got launched, honouring per type overrides. */
export function launcherLabel(projectile: ProjectileId, launcher: LaunchModeId): string {
  const def = PROJECTILE_BY_ID[projectile];
  return (def.launcherLabels?.[launcher] ?? LAUNCH_MODES[launcher].label).toLowerCase();
}

function damageLine(d: ImpactDamage): string {
  if (d.base === 0) return "none (this projectile does not deal impact damage)";
  if (d.critMax > d.base) {
    return `${d.base} to ${d.critMax} (${round(d.base / 2)} to ${round(d.critMax / 2)} hearts, critical roll included)`;
  }
  return `${d.base} (${round(d.hearts)} hearts)`;
}

export { ARROW_DESPAWN_TICKS, DEFAULT_LAUNCH_HEIGHT, TPS };

export default { run } satisfies ToolLogic<string, ProjectileCalcResult, ProjectileCalcOpts>;

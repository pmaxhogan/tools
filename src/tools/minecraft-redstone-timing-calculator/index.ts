/**
 * Minecraft redstone timing and throughput calculator.
 *
 * Five independent engines, all pure:
 *
 * 1. Unit conversion between game ticks, redstone ticks, seconds and real
 *    wall-clock time at a configurable server tick rate.
 * 2. A delay-line builder: the cheapest repeater and comparator arrangement
 *    that hits a target delay exactly, plus the achievable delays that
 *    bracket a target that cannot be hit.
 * 3. A clock builder: repeater loop clocks and item (hopper) clocks.
 * 4. Item throughput for hoppers, hopper chains, hopper minecarts, dropper
 *    chains and water streams, plus double chest fill and empty times.
 * 5. The comparator container-fullness table, forward and inverted.
 *
 * Every constant lives in ./data.ts with the class and method it was read
 * from in the decompiled or unobfuscated server source of each supported
 * version. Nothing here reads the DOM, the network, or the clock.
 */
import { ToolError, type ToolLogic } from "../types";
import {
  COMPONENTS,
  CONTAINERS,
  MS_PER_TICK,
  REDSTONE_TICK_GAME_TICKS,
  REDSTONE_VERSIONS,
  TICKS_PER_SECOND,
  TRANSPORTS,
  VERSION_CHANGES,
  containerById,
  containersForVersion,
  componentsForVersion,
  transportById,
  transportsForVersion,
  type ComponentTiming,
  type ContainerSpec,
  type TimingKind,
  type TransportSpec,
  type VersionId,
} from "./data";

export {
  COMPONENTS,
  CONTAINERS,
  MS_PER_TICK,
  REDSTONE_TICK_GAME_TICKS,
  REDSTONE_VERSIONS,
  TICKS_PER_SECOND,
  TRANSPORTS,
  VERSION_CHANGES,
  componentsForVersion,
  containersForVersion,
  transportsForVersion,
};
export type { ComponentTiming, ContainerSpec, TimingKind, TransportSpec, VersionId };

/* ------------------------------------------------------------------ */
/* shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Largest delay line the builder will plan, in game ticks (10 minutes). */
export const MAX_DELAY_GAME_TICKS = 12_000;

/** Largest clock period the builder will plan, in game ticks (2 hours). */
export const MAX_PERIOD_GAME_TICKS = 144_000;

function requireVersion(version: string): VersionId {
  if ((REDSTONE_VERSIONS as readonly string[]).includes(version)) return version as VersionId;
  throw new ToolError(
    "unknown-version",
    `Version "${version}" is not in the verified redstone data set.`,
    `Use one of: ${REDSTONE_VERSIONS.join(", ")}.`,
  );
}

function requireFiniteInt(value: number, what: string, fix: string): number {
  if (!Number.isFinite(value)) {
    throw new ToolError("not-a-number", `${what} must be a number.`, fix);
  }
  return Math.round(value);
}

function requireTps(tps: number): number {
  if (!Number.isFinite(tps) || tps <= 0) {
    throw new ToolError(
      "bad-tick-rate",
      "The server tick rate must be a positive number of ticks per second.",
      "A healthy server runs at 20. Enter the measured rate from /tick query or a profiler.",
    );
  }
  if (tps > 1000) {
    throw new ToolError(
      "bad-tick-rate",
      "The server tick rate must be 1000 ticks per second or less.",
      "Enter the real measured rate. Vanilla caps normal play at 20.",
    );
  }
  return tps;
}

/* ------------------------------------------------------------------ */
/* 1. unit conversion                                                  */
/* ------------------------------------------------------------------ */

export type TimeUnit =
  | "gameTicks"
  | "redstoneTicks"
  | "milliseconds"
  | "seconds"
  | "minutes"
  | "hours";

export const TIME_UNITS: readonly TimeUnit[] = [
  "gameTicks",
  "redstoneTicks",
  "milliseconds",
  "seconds",
  "minutes",
  "hours",
];

export interface TimeConversion {
  /** Whole game ticks. Everything the game schedules is an integer count. */
  gameTicks: number;
  /** Game ticks divided by 2. Fractional when the tick count is odd. */
  redstoneTicks: number;
  /** Whole redstone ticks, or null when the game tick count is odd. */
  wholeRedstoneTicks: number | null;
  /** Duration at the nominal 20 ticks per second. */
  nominalSeconds: number;
  nominalMilliseconds: number;
  /** Duration at the tick rate supplied by the caller. */
  tps: number;
  realSeconds: number;
  realMilliseconds: number;
  /** realSeconds / nominalSeconds. Above 1 means the server is behind. */
  lagFactor: number;
  /** "1 min 4.05 s" style, using the real (tick rate adjusted) duration. */
  formattedReal: string;
  formattedNominal: string;
}

/** Convert one duration into every unit the calculator speaks. */
export function convertTime(value: number, unit: TimeUnit, tps = TICKS_PER_SECOND): TimeConversion {
  if (!Number.isFinite(value)) {
    throw new ToolError(
      "not-a-number",
      "The duration must be a number.",
      "Enter a value like 8 (game ticks) or 0.4 (seconds).",
    );
  }
  if (value < 0) {
    throw new ToolError(
      "negative-duration",
      "A duration cannot be negative.",
      "Enter zero or more.",
    );
  }
  const rate = requireTps(tps);

  let gameTicks: number;
  switch (unit) {
    case "gameTicks":
      gameTicks = value;
      break;
    case "redstoneTicks":
      gameTicks = value * REDSTONE_TICK_GAME_TICKS;
      break;
    case "milliseconds":
      gameTicks = (value / 1000) * TICKS_PER_SECOND;
      break;
    case "seconds":
      gameTicks = value * TICKS_PER_SECOND;
      break;
    case "minutes":
      gameTicks = value * 60 * TICKS_PER_SECOND;
      break;
    case "hours":
      gameTicks = value * 3600 * TICKS_PER_SECOND;
      break;
    default:
      throw new ToolError(
        "unknown-unit",
        `"${String(unit)}" is not a time unit this tool knows.`,
        `Use one of: ${TIME_UNITS.join(", ")}.`,
      );
  }
  // Everything the game schedules is a whole tick, so the canonical answer is
  // rounded. Sub-tick input is a request the game cannot honour.
  gameTicks = Math.round(gameTicks * 1e6) / 1e6;
  const wholeTicks = Math.round(gameTicks);
  const nominalSeconds = gameTicks / TICKS_PER_SECOND;
  const realSeconds = gameTicks / rate;
  return {
    gameTicks,
    redstoneTicks: gameTicks / REDSTONE_TICK_GAME_TICKS,
    wholeRedstoneTicks:
      Number.isInteger(gameTicks) && wholeTicks % REDSTONE_TICK_GAME_TICKS === 0
        ? wholeTicks / REDSTONE_TICK_GAME_TICKS
        : null,
    nominalSeconds,
    nominalMilliseconds: gameTicks * MS_PER_TICK,
    tps: rate,
    realSeconds,
    realMilliseconds: realSeconds * 1000,
    lagFactor: TICKS_PER_SECOND / rate,
    formattedReal: formatDuration(realSeconds),
    formattedNominal: formatDuration(nominalSeconds),
  };
}

/** "0.4 s", "1 min 4.05 s", "2 h 13 min 20 s". Never uses a dash. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "unknown";
  if (seconds === 0) return "0 s";
  if (seconds < 1) return `${round(seconds, 3)} s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds - h * 3600) / 60);
  const s = seconds - h * 3600 - m * 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} h`);
  if (m > 0) parts.push(`${m} min`);
  if (s > 0 || parts.length === 0) parts.push(`${round(s, s < 10 ? 2 : 1)} s`);
  return parts.join(" ");
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/* ------------------------------------------------------------------ */
/* 2. delay line builder                                               */
/* ------------------------------------------------------------------ */

/** Repeater delay settings, in game ticks: 1 to 4 redstone ticks. */
export const REPEATER_DELAYS: readonly number[] = [2, 4, 6, 8];

/** A comparator always delays by exactly 1 redstone tick. */
export const COMPARATOR_DELAY = 2;

export interface DelayPart {
  component: "repeater" | "comparator";
  /** Repeater delay setting, 1 to 4 (right clicks from the default). Absent for comparators. */
  setting?: number;
  /** Delay contributed by one of these, in game ticks. */
  delayTicks: number;
  count: number;
}

export interface DelayLine {
  /** Total delay in game ticks. */
  gameTicks: number;
  redstoneTicks: number;
  parts: DelayPart[];
  /** Total number of components placed. */
  componentCount: number;
  /** Repeater settings in placement order, e.g. [4, 4, 3]. */
  repeaterSettings: number[];
  /** How many comparators alone would be needed for the same delay. */
  comparatorOnlyCount: number;
}

export interface DelaySolution {
  targetGameTicks: number;
  /** Exact hit, or null when the target is not achievable. */
  exact: DelayLine | null;
  /** Largest achievable delay at or below the target. Null below 2 ticks. */
  below: DelayLine | null;
  /** Smallest achievable delay at or above the target. */
  above: DelayLine | null;
  /** Why the target is or is not achievable, in one sentence. */
  note: string;
}

/**
 * Achievable delays are 0 (a straight wire) and every EVEN tick count from 2
 * upward: the shortest delay component is 1 redstone tick, which is 2 game
 * ticks, and repeaters and comparators only add whole redstone ticks. An odd
 * game-tick delay cannot be built out of repeaters and comparators at all.
 */
export function isAchievableDelay(gameTicks: number): boolean {
  return Number.isInteger(gameTicks) && gameTicks >= 0 && gameTicks % REDSTONE_TICK_GAME_TICKS === 0;
}

/**
 * Fewest components for an achievable delay: fill with repeaters on setting 4
 * (8 game ticks) and spend the remainder on one more repeater. Greedy is
 * optimal here because every repeater contributes at most 8 ticks, so
 * ceil(ticks / 8) is a hard lower bound and the greedy plan always meets it.
 */
export function delayLineFor(gameTicks: number): DelayLine {
  if (!isAchievableDelay(gameTicks)) {
    throw new ToolError(
      "unachievable-delay",
      `${gameTicks} game ticks cannot be built from repeaters and comparators.`,
      "Only even tick counts are achievable: the smallest step is 1 redstone tick, which is 2 game ticks.",
    );
  }
  if (gameTicks > MAX_DELAY_GAME_TICKS) {
    throw new ToolError(
      "delay-too-long",
      `A delay line of ${gameTicks} game ticks would need hundreds of repeaters.`,
      `Keep the target at or under ${MAX_DELAY_GAME_TICKS} game ticks, or use an item clock for longer periods.`,
    );
  }
  const settings: number[] = [];
  let left = gameTicks;
  while (left >= 8) {
    settings.push(4);
    left -= 8;
  }
  if (left > 0) settings.push(left / 2);

  const parts: DelayPart[] = [];
  for (const s of [4, 3, 2, 1]) {
    const count = settings.filter((x) => x === s).length;
    if (count > 0) {
      parts.push({ component: "repeater", setting: s, delayTicks: s * 2, count });
    }
  }
  return {
    gameTicks,
    redstoneTicks: gameTicks / REDSTONE_TICK_GAME_TICKS,
    parts,
    componentCount: settings.length,
    repeaterSettings: settings,
    comparatorOnlyCount: gameTicks / COMPARATOR_DELAY,
  };
}

/** Plan a delay line for a target, with the bracketing delays when it misses. */
export function buildDelay(targetGameTicks: number): DelaySolution {
  const target = requireFiniteInt(
    targetGameTicks,
    "The target delay",
    "Enter a whole number of game ticks, for example 10.",
  );
  if (target < 0) {
    throw new ToolError("negative-delay", "A delay cannot be negative.", "Enter zero or more.");
  }
  if (target > MAX_DELAY_GAME_TICKS) {
    throw new ToolError(
      "delay-too-long",
      `A delay line of ${target} game ticks would need hundreds of repeaters.`,
      `Keep the target at or under ${MAX_DELAY_GAME_TICKS} game ticks, or use an item clock for longer periods.`,
    );
  }
  if (isAchievableDelay(target)) {
    const line = target === 0 ? zeroDelayLine() : delayLineFor(target);
    return {
      targetGameTicks: target,
      exact: line,
      below: line,
      above: line,
      note:
        target === 0
          ? "Zero delay: run the signal straight through wire, with no repeater or comparator in the line."
          : `Exact. ${target} game ticks is ${target / 2} redstone ticks, so it lands on a whole component step.`,
    };
  }
  const lower = target - 1;
  const upper = target + 1;
  return {
    targetGameTicks: target,
    exact: null,
    below: lower >= 2 ? delayLineFor(lower) : lower === 0 ? zeroDelayLine() : null,
    above: upper <= MAX_DELAY_GAME_TICKS ? delayLineFor(upper) : null,
    note: `${target} game ticks is an odd tick count. Repeaters and comparators only add whole redstone ticks (2 game ticks each), so the closest achievable delays are ${lower} and ${upper}.`,
  };
}

function zeroDelayLine(): DelayLine {
  return {
    gameTicks: 0,
    redstoneTicks: 0,
    parts: [],
    componentCount: 0,
    repeaterSettings: [],
    comparatorOnlyCount: 0,
  };
}

/* ------------------------------------------------------------------ */
/* 3. clock builder                                                    */
/* ------------------------------------------------------------------ */

export type ClockKind = "repeater-loop" | "item-clock";

export interface ClockPlan {
  kind: ClockKind;
  label: string;
  /** Full on plus off period, in game ticks. */
  periodGameTicks: number;
  /** Ticks the output is high, then low. */
  onGameTicks: number;
  offGameTicks: number;
  /** Pulses per real minute at 20 ticks per second. */
  pulsesPerMinute: number;
  /** How to build it. */
  recipe: string;
  /** Loop delay line, for repeater loops. */
  line?: DelayLine;
  /** Items shuttling in the loop, for item clocks. */
  items?: number;
  note: string;
}

export interface ClockSolution {
  targetGameTicks: number;
  exact: ClockPlan | null;
  below: ClockPlan | null;
  above: ClockPlan | null;
  note: string;
}

/**
 * Repeater loop clock: an odd number of inverting stages (a redstone torch)
 * around a loop of repeaters. The signal flips every time it goes round, so
 * the full period is twice the loop delay and the duty cycle is even. The
 * loop delay is a normal delay line, so achievable periods are multiples of
 * 4 game ticks (2 game ticks of loop delay, doubled), and the shortest
 * stable torch loop is one torch plus one repeater.
 */
export function repeaterClockFor(periodGameTicks: number): ClockPlan {
  const half = periodGameTicks / 2;
  const line = delayLineFor(half);
  return {
    kind: "repeater-loop",
    label: "Repeater loop clock",
    periodGameTicks,
    onGameTicks: half,
    offGameTicks: half,
    pulsesPerMinute: (60 * TICKS_PER_SECOND) / periodGameTicks,
    recipe:
      line.componentCount === 0
        ? "A bare torch loop with no repeaters burns out. Add at least one repeater."
        : `A redstone torch feeding a loop of ${line.componentCount} repeater${line.componentCount === 1 ? "" : "s"} (settings ${line.repeaterSettings.join(", ")}) back into the block the torch is on.`,
    line,
    note: "The output is high for half the period and low for the other half. Add or remove a repeater tick to change the period by 4 game ticks.",
  };
}

/**
 * Item clock: items shuttling between two hoppers that face each other, read
 * by a comparator. Every item transfer costs one hopper cooldown, so one
 * direction takes items * cooldown ticks and the full cycle is twice that.
 * The cooldown is the hopper transfer constant in ./data.ts, verified on a
 * live server at 8 game ticks per item.
 */
export function itemClockFor(periodGameTicks: number, cooldownTicks: number): ClockPlan {
  const items = periodGameTicks / (2 * cooldownTicks);
  const half = periodGameTicks / 2;
  return {
    kind: "item-clock",
    label: "Two hopper item clock",
    periodGameTicks,
    onGameTicks: half,
    offGameTicks: half,
    pulsesPerMinute: (60 * TICKS_PER_SECOND) / periodGameTicks,
    recipe: `Two hoppers facing each other with ${items} item${items === 1 ? "" : "s"} shuttling between them, and a comparator reading one of them.`,
    items,
    note: `Each item transfer costs one hopper cooldown of ${cooldownTicks} game ticks, and the items have to travel both ways, so the period is 2 x items x ${cooldownTicks}.`,
  };
}

/**
 * Plan a clock for a target period, exact where possible and bracketed where
 * not. Repeater loops step in 4 game ticks; item clocks step in twice the
 * hopper cooldown, which is much coarser but scales to hours.
 */
export function buildClock(
  targetGameTicks: number,
  kind: ClockKind = "repeater-loop",
  version: string = REDSTONE_VERSIONS[REDSTONE_VERSIONS.length - 1]!,
): ClockSolution {
  const target = requireFiniteInt(
    targetGameTicks,
    "The target period",
    "Enter a whole number of game ticks, for example 40.",
  );
  const v = requireVersion(version);
  if (target < 1) {
    throw new ToolError(
      "period-too-short",
      "A clock period must be at least 1 game tick.",
      "Enter a period of 1 or more game ticks.",
    );
  }
  if (target > MAX_PERIOD_GAME_TICKS) {
    throw new ToolError(
      "period-too-long",
      `A period of ${target} game ticks is longer than this planner covers.`,
      `Keep the target at or under ${MAX_PERIOD_GAME_TICKS} game ticks (2 hours).`,
    );
  }

  if (kind === "repeater-loop") {
    const step = 4; // 2 game ticks of loop delay, doubled by the inversion
    const exactly = target % step === 0 && target >= step;
    const lowN = Math.floor(target / step);
    const highN = Math.ceil(target / step);
    return {
      targetGameTicks: target,
      exact: exactly ? repeaterClockFor(target) : null,
      below: lowN >= 1 ? repeaterClockFor(lowN * step) : null,
      above: highN * step <= MAX_DELAY_GAME_TICKS * 2 ? repeaterClockFor(highN * step) : null,
      note: exactly
        ? `Exact. The loop carries ${target / 2} game ticks of repeater delay and the inversion doubles it.`
        : `A repeater loop period is always a multiple of 4 game ticks, because the loop delay is a whole number of redstone ticks and the inversion doubles it. ${target} is not, so the closest periods are ${lowN * step} and ${highN * step}.`,
    };
  }

  const hopper = transportById(v, "hopper");
  const cooldown = hopper.ticksPerItem;
  const step = 2 * cooldown;
  const exactly = target % step === 0 && target >= step;
  const lowN = Math.floor(target / step);
  const highN = Math.ceil(target / step);
  const maxItems = Math.floor(MAX_PERIOD_GAME_TICKS / step);
  return {
    targetGameTicks: target,
    exact: exactly ? itemClockFor(target, cooldown) : null,
    below: lowN >= 1 ? itemClockFor(lowN * step, cooldown) : null,
    above: highN <= maxItems ? itemClockFor(highN * step, cooldown) : null,
    note: exactly
      ? `Exact with ${target / step} item${target / step === 1 ? "" : "s"} in the loop.`
      : `An item clock period is always a multiple of ${step} game ticks (one item, both ways). ${target} is not, so the closest periods are ${lowN * step} and ${highN * step}.`,
  };
}

/* ------------------------------------------------------------------ */
/* 4. item throughput                                                  */
/* ------------------------------------------------------------------ */

export interface ThroughputResult {
  transport: TransportSpec;
  /** Number of parallel lines or hoppers feeding the same destination. */
  lines: number;
  /** Game ticks between two consecutive items on ONE line. */
  ticksPerItem: number;
  /** Items moved by the whole setup, per unit of time, at the given tick rate. */
  itemsPerSecond: number;
  itemsPerMinute: number;
  itemsPerHour: number;
  /** Stacks (of the given stack size) per hour. */
  stacksPerHour: number;
  /** Extra latency before the first item arrives, in game ticks. */
  startupTicks: number;
  tps: number;
  note: string;
}

export interface ThroughputOptions {
  version?: string;
  /** Parallel copies of the transport, all feeding the same target. */
  lines?: number;
  /** Units in series, for chainable transports. Latency only. */
  chainLength?: number;
  /** Stack size of the item being moved: 64, 16 or 1. */
  stackSize?: number;
  /** Clock period in game ticks, for clock-driven transports. */
  clockPeriod?: number;
  /** Server tick rate. */
  tps?: number;
}

/** Items per second, per hour, and the latency for one transport method. */
export function throughput(transportId: string, opts: ThroughputOptions = {}): ThroughputResult {
  const version = requireVersion(opts.version ?? REDSTONE_VERSIONS[REDSTONE_VERSIONS.length - 1]!);
  const spec = transportById(version, transportId);
  const lines = Math.max(1, Math.round(opts.lines ?? 1));
  if (lines > 1000) {
    throw new ToolError(
      "too-many-lines",
      "The planner models up to 1000 parallel lines.",
      "Lower the number of parallel lines.",
    );
  }
  const stackSize = requireStackSize(opts.stackSize ?? 64);
  const tps = requireTps(opts.tps ?? TICKS_PER_SECOND);
  const chainLength = Math.max(1, Math.round(opts.chainLength ?? 1));

  const itemsPerTransfer = spec.itemsPerTransfer === "stack" ? stackSize : spec.itemsPerTransfer;
  let ticksPerTransfer = spec.ticksPerItem;
  if (spec.clockDriven && opts.clockPeriod !== undefined) {
    const period = requireFiniteInt(
      opts.clockPeriod,
      "The clock period",
      "Enter a whole number of game ticks.",
    );
    const floor = spec.minClockPeriod ?? spec.ticksPerItem;
    if (period < floor) {
      throw new ToolError(
        "clock-too-fast",
        `A ${spec.label.toLowerCase()} cannot keep up with a ${period} game tick clock.`,
        `The shortest period it can follow is ${floor} game ticks.`,
      );
    }
    ticksPerTransfer = period;
  }

  const perLinePerSecond = (itemsPerTransfer / ticksPerTransfer) * tps;
  const itemsPerSecond = perLinePerSecond * lines;
  const startupTicks = spec.chainable ? ticksPerTransfer * chainLength : spec.startupTicks;

  return {
    transport: spec,
    lines,
    ticksPerItem: ticksPerTransfer / itemsPerTransfer,
    itemsPerSecond,
    itemsPerMinute: itemsPerSecond * 60,
    itemsPerHour: itemsPerSecond * 3600,
    stacksPerHour: (itemsPerSecond * 3600) / stackSize,
    startupTicks,
    tps,
    note: spec.note,
  };
}

function requireStackSize(stackSize: number): number {
  if (stackSize !== 64 && stackSize !== 16 && stackSize !== 1) {
    throw new ToolError(
      "bad-stack-size",
      `Stack size ${stackSize} does not exist in Minecraft.`,
      "Items stack to 64, 16 (snowballs, signs, eggs) or 1 (tools, armor, potions).",
    );
  }
  return stackSize;
}

export interface FillResult {
  containerLabel: string;
  slots: number;
  stackSize: number;
  /** Items needed to fill the container completely. */
  capacity: number;
  gameTicks: number;
  seconds: number;
  formatted: string;
  itemsPerSecond: number;
}

/** How long one transport takes to fill or empty a given container. */
export function fillTime(
  containerId: string,
  transportId: string,
  opts: ThroughputOptions = {},
): FillResult {
  const version = requireVersion(opts.version ?? REDSTONE_VERSIONS[REDSTONE_VERSIONS.length - 1]!);
  const container = containerById(version, containerId);
  const stackSize = requireStackSize(opts.stackSize ?? 64);
  const perSlot = Math.min(container.maxStackSize, stackSize);
  const capacity = container.slots * perSlot;
  const rate = throughput(transportId, { ...opts, version, stackSize });
  const seconds = capacity / rate.itemsPerSecond;
  return {
    containerLabel: container.label,
    slots: container.slots,
    stackSize: perSlot,
    capacity,
    gameTicks: seconds * rate.tps,
    seconds,
    formatted: formatDuration(seconds),
    itemsPerSecond: rate.itemsPerSecond,
  };
}

/* ------------------------------------------------------------------ */
/* 5. comparator container fullness                                    */
/* ------------------------------------------------------------------ */

/**
 * The container fullness signal, reimplemented from the game's
 * AbstractContainerMenu.getRedstoneSignalFromContainer:
 *
 *   fraction = sum over slots of (count in slot / min(container cap, item cap))
 *   fraction = fraction / slot count
 *   signal   = floor(fraction * 14) + (anything in the container ? 1 : 0)
 *
 * 1.16.5 and 1.18.2 write that last line out longhand and count occupied
 * slots; 1.20.6 and later call Mth.lerpDiscrete(fraction, 0, 15), which is
 * literally 0 + floor(fraction * 14) + (fraction > 0 ? 1 : 0). The two are the
 * same number in every reachable case.
 *
 * The game does this in 32 bit floats, so the rounding is reproduced with
 * Math.fround rather than left to double precision. Because every occupied
 * slot contributes its count divided by the SAME per-slot cap, and every
 * partial sum is exactly representable, the arrangement of a given item count
 * across slots never changes the answer: only the total does.
 */
export function comparatorSignal(items: number, slots: number, stackSize: number): number {
  if (!Number.isInteger(items) || items < 0) {
    throw new ToolError(
      "bad-item-count",
      "The item count must be a whole number of zero or more.",
      "Enter how many items are in the container.",
    );
  }
  if (!Number.isInteger(slots) || slots < 1) {
    throw new ToolError(
      "bad-slot-count",
      "A container must have at least one slot.",
      "Pick a container from the list, or enter its real slot count.",
    );
  }
  const perSlot = requireStackSize(stackSize);
  const capacity = slots * perSlot;
  if (items > capacity) {
    throw new ToolError(
      "container-overfull",
      `${items} items do not fit: ${slots} slots hold at most ${capacity} at a stack size of ${perSlot}.`,
      `Lower the item count to ${capacity} or fewer.`,
    );
  }
  if (items === 0) return 0;
  const fraction = Math.fround(Math.fround(items / perSlot) / slots);
  return Math.floor(Math.fround(fraction * 14)) + 1;
}

export interface SignalBand {
  signal: number;
  /** Fewest items that produce this signal, or null when unreachable. */
  minItems: number | null;
  /** Most items that still produce this signal, or null when unreachable. */
  maxItems: number | null;
  /** minItems expressed as full stacks plus a remainder, e.g. "1 stack + 5". */
  minItemsAsStacks: string;
  /** How many item counts land on this signal. */
  span: number;
}

export interface FullnessTable {
  container: ContainerSpec | null;
  slots: number;
  stackSize: number;
  capacity: number;
  bands: SignalBand[];
  /** Signals this container and stack size can never produce. */
  unreachable: number[];
}

/**
 * The full signal table for a container, built by scanning the forward
 * formula over every possible item count. Scanning rather than inverting the
 * algebra means the "items needed for signal 7" answer can never disagree
 * with the "signal for this many items" answer, including at the rounding
 * boundaries where small containers skip signal levels entirely.
 */
export function fullnessTable(slots: number, stackSize: number): FullnessTable {
  const perSlot = requireStackSize(stackSize);
  if (!Number.isInteger(slots) || slots < 1 || slots > 128) {
    throw new ToolError(
      "bad-slot-count",
      "Slot count must be a whole number from 1 to 128.",
      "Pick a container from the list, or enter its real slot count.",
    );
  }
  const capacity = slots * perSlot;
  const bands: SignalBand[] = [];
  for (let signal = 0; signal <= 15; signal += 1) {
    bands.push({
      signal,
      minItems: null,
      maxItems: null,
      minItemsAsStacks: "",
      span: 0,
    });
  }
  for (let items = 0; items <= capacity; items += 1) {
    const signal = comparatorSignal(items, slots, perSlot);
    const band = bands[signal]!;
    if (band.minItems === null) band.minItems = items;
    band.maxItems = items;
    band.span += 1;
  }
  for (const band of bands) {
    band.minItemsAsStacks = band.minItems === null ? "" : asStacks(band.minItems, perSlot);
  }
  return {
    container: null,
    slots,
    stackSize: perSlot,
    capacity,
    bands,
    unreachable: bands.filter((b) => b.minItems === null).map((b) => b.signal),
  };
}

/** The same table, resolved from a named container in the version data. */
export function containerFullnessTable(
  containerId: string,
  stackSize: number,
  version: string = REDSTONE_VERSIONS[REDSTONE_VERSIONS.length - 1]!,
): FullnessTable {
  const v = requireVersion(version);
  const container = containerById(v, containerId);
  const perSlot = Math.min(container.maxStackSize, requireStackSize(stackSize));
  const table = fullnessTable(container.slots, perSlot as 1 | 16 | 64);
  return { ...table, container };
}

/** Fewest items for a target signal strength, the inverse everyone searches for. */
export function itemsForSignal(
  signal: number,
  slots: number,
  stackSize: number,
): SignalBand | null {
  if (!Number.isInteger(signal) || signal < 0 || signal > 15) {
    throw new ToolError(
      "bad-signal",
      "Signal strength runs from 0 to 15.",
      "Enter a signal strength between 0 and 15.",
    );
  }
  const band = fullnessTable(slots, stackSize).bands[signal]!;
  return band.minItems === null ? null : band;
}

function asStacks(items: number, stackSize: number): string {
  if (stackSize === 1) return `${items} item${items === 1 ? "" : "s"}`;
  const stacks = Math.floor(items / stackSize);
  const rest = items - stacks * stackSize;
  if (stacks === 0) return `${rest} item${rest === 1 ? "" : "s"}`;
  if (rest === 0) return `${stacks} stack${stacks === 1 ? "" : "s"}`;
  return `${stacks} stack${stacks === 1 ? "" : "s"} plus ${rest}`;
}

/* ------------------------------------------------------------------ */
/* 6. component reference                                              */
/* ------------------------------------------------------------------ */

/** What the headline number on each component measures, in plain words. */
export const TIMING_KIND_LABEL: Record<TimingKind, string> = {
  delay: "input to output delay",
  pulse: "output pulse length",
  duration: "how long it stays on",
  period: "how often it repeats",
  fuse: "fuse length",
  instant: "no delay",
};

export interface ComponentRow {
  id: string;
  label: string;
  group: string;
  /** Timing in game ticks for this version. */
  delayTicks: number;
  kind: TimingKind;
  /** "input to output delay", "how long it stays on", and so on. */
  kindLabel: string;
  delayLabel: string;
  redstoneTicks: string;
  seconds: string;
  pulseTicks: number | null;
  note: string;
  source: string;
}

/** Every timed component in one version, sorted by timing then by name. */
export function componentReference(version: string): ComponentRow[] {
  const v = requireVersion(version);
  return componentsForVersion(v)
    .map((c) => {
      const delay = delayForVersion(c, v);
      const range = c.delayRange;
      return {
        id: c.id,
        label: c.label,
        group: c.group,
        delayTicks: delay,
        kind: c.kind,
        kindLabel: TIMING_KIND_LABEL[c.kind],
        delayLabel: range
          ? `${range[0]} to ${range[1]} game ticks`
          : `${delay} game tick${delay === 1 ? "" : "s"}`,
        redstoneTicks: range
          ? `${range[0] / 2} to ${range[1] / 2}`
          : String(delay / REDSTONE_TICK_GAME_TICKS),
        seconds: range
          ? `${round(range[0] / TICKS_PER_SECOND, 2)} to ${round(range[1] / TICKS_PER_SECOND, 2)} s`
          : `${round(delay / TICKS_PER_SECOND, 2)} s`,
        pulseTicks: c.pulseTicks ?? null,
        note: c.note,
        source: c.source,
      };
    })
    .sort((a, b) => a.delayTicks - b.delayTicks || a.label.localeCompare(b.label));
}

/** The delay one component has in one version, honouring per-version overrides. */
export function delayForVersion(component: ComponentTiming, version: VersionId): number {
  return component.perVersion?.[version] ?? component.delayTicks;
}

export interface ComponentDifference {
  id: string;
  label: string;
  /** Delay in each supported version, oldest first. */
  perVersion: { version: VersionId; delayTicks: number | null }[];
}

/** Components whose delay or availability is not the same in every version. */
export function componentDifferences(): ComponentDifference[] {
  const out: ComponentDifference[] = [];
  for (const c of COMPONENTS) {
    const perVersion = REDSTONE_VERSIONS.map((version) => ({
      version,
      delayTicks: (c.availableIn ?? REDSTONE_VERSIONS).includes(version)
        ? delayForVersion(c, version)
        : null,
    }));
    const first = perVersion[0]!.delayTicks;
    if (perVersion.some((p) => p.delayTicks !== first)) {
      out.push({ id: c.id, label: c.label, perVersion });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* generic run() surface (the page uses the bespoke panel)             */
/* ------------------------------------------------------------------ */

export type RunMode = "convert" | "delay" | "clock" | "throughput" | "signal" | "components";

interface RunOpts {
  version?: string;
  tps?: number;
}

interface RunInput {
  mode?: RunMode;
  /** convert */
  value?: number;
  unit?: TimeUnit;
  /** delay and clock */
  ticks?: number;
  clock?: ClockKind;
  /** throughput */
  transport?: string;
  lines?: number;
  chainLength?: number;
  container?: string;
  /** signal */
  items?: number;
  signal?: number;
  slots?: number;
  stackSize?: number;
}

function describeLine(line: DelayLine | null): string {
  if (!line) return "none";
  if (line.componentCount === 0) return "0 game ticks (straight wire, no components)";
  const parts = line.parts
    .map((p) => `${p.count} repeater${p.count === 1 ? "" : "s"} on ${p.setting}`)
    .join(", ");
  return `${line.gameTicks} game ticks: ${parts} (${line.componentCount} components)`;
}

function describeClock(plan: ClockPlan | null): string {
  if (!plan) return "none";
  return `${plan.periodGameTicks} game ticks (${round(plan.periodGameTicks / TICKS_PER_SECOND, 2)} s): ${plan.recipe}`;
}

/**
 * JSON in, labeled record out. The page uses the bespoke panel; this surface
 * exists for the generic shell, the tests, and anyone scripting the tool.
 */
function run(input: string, opts: RunOpts = {}): Record<string, string> {
  const version = requireVersion(opts.version ?? REDSTONE_VERSIONS[REDSTONE_VERSIONS.length - 1]!);
  const tps = requireTps(opts.tps ?? TICKS_PER_SECOND);
  if (!input || input.trim() === "") {
    throw new ToolError(
      "empty-input",
      "Provide a JSON object describing what to calculate.",
      'Example: {"mode":"convert","value":8,"unit":"gameTicks"}',
    );
  }
  let parsed: RunInput;
  try {
    parsed = JSON.parse(input) as RunInput;
  } catch {
    throw new ToolError(
      "invalid-json",
      "The input is not valid JSON.",
      'Check for missing quotes or trailing commas. Example: {"mode":"delay","ticks":10}',
    );
  }
  const mode = parsed.mode ?? "convert";

  if (mode === "convert") {
    const c = convertTime(parsed.value ?? 0, parsed.unit ?? "gameTicks", tps);
    return {
      "Game ticks": String(c.gameTicks),
      "Redstone ticks": c.wholeRedstoneTicks === null ? `${c.redstoneTicks} (not a whole redstone tick)` : String(c.wholeRedstoneTicks),
      "Seconds at 20 TPS": `${round(c.nominalSeconds, 4)} s`,
      [`Real time at ${round(c.tps, 3)} TPS`]: c.formattedReal,
      "Lag factor": `${round(c.lagFactor, 3)}x`,
    };
  }

  if (mode === "delay") {
    const s = buildDelay(parsed.ticks ?? 0);
    return {
      Target: `${s.targetGameTicks} game ticks`,
      Exact: describeLine(s.exact),
      "Closest below": describeLine(s.below),
      "Closest above": describeLine(s.above),
      Note: s.note,
    };
  }

  if (mode === "clock") {
    const s = buildClock(parsed.ticks ?? 0, parsed.clock ?? "repeater-loop", version);
    return {
      Target: `${s.targetGameTicks} game ticks`,
      Exact: describeClock(s.exact),
      "Closest below": describeClock(s.below),
      "Closest above": describeClock(s.above),
      Note: s.note,
    };
  }

  if (mode === "throughput") {
    const r = throughput(parsed.transport ?? "hopper", {
      version,
      lines: parsed.lines,
      chainLength: parsed.chainLength,
      stackSize: parsed.stackSize,
      tps,
    });
    const out: Record<string, string> = {
      Transport: r.transport.label,
      "Game ticks per item": String(round(r.ticksPerItem, 4)),
      "Items per second": String(round(r.itemsPerSecond, 3)),
      "Items per hour": String(Math.round(r.itemsPerHour)),
      "Stacks per hour": String(round(r.stacksPerHour, 2)),
      Note: r.note,
    };
    if (parsed.container) {
      const f = fillTime(parsed.container, parsed.transport ?? "hopper", {
        version,
        lines: parsed.lines,
        stackSize: parsed.stackSize,
        tps,
      });
      out[`Time to fill a ${f.containerLabel}`] = `${f.formatted} for ${f.capacity} items`;
    }
    return out;
  }

  if (mode === "signal") {
    const slots = parsed.container
      ? containerById(version, parsed.container).slots
      : (parsed.slots ?? 54);
    const stackSize = parsed.stackSize ?? 64;
    if (parsed.signal !== undefined) {
      const band = itemsForSignal(parsed.signal, slots, stackSize);
      if (!band) {
        return {
          "Signal strength": String(parsed.signal),
          Result: `Signal ${parsed.signal} is unreachable with ${slots} slots at a stack size of ${stackSize}.`,
        };
      }
      return {
        "Signal strength": String(band.signal),
        "Fewest items": `${band.minItems} (${band.minItemsAsStacks})`,
        "Most items": String(band.maxItems),
        Container: `${slots} slots, stack size ${stackSize}`,
      };
    }
    const items = parsed.items ?? 0;
    return {
      Items: String(items),
      "Signal strength": String(comparatorSignal(items, slots, stackSize)),
      Container: `${slots} slots, stack size ${stackSize}`,
    };
  }

  if (mode === "components") {
    const rows = componentReference(version);
    const out: Record<string, string> = {};
    for (const r of rows) out[r.label] = `${r.delayLabel} (${r.seconds})`;
    return out;
  }

  throw new ToolError(
    "unknown-mode",
    `"${String(mode)}" is not a mode this tool knows.`,
    'Use one of: convert, delay, clock, throughput, signal, components.',
  );
}

export { run };
export default { run } satisfies ToolLogic<string, Record<string, string>, RunOpts>;

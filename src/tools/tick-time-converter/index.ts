import { ToolError, type ToolLogic } from "../types";

/**
 * Minecraft's tick clock. The server runs at a fixed target of 20 ticks per
 * second (TPS) regardless of Minecraft version; nothing about this schedule
 * has changed across any release. A redstone tick is 2 game ticks, the unit
 * most redstone mechanics (repeater delay steps, comparator updates,
 * daylight sensor checks) are specified in. The day/night cycle is 24000
 * ticks long (20 real minutes at full speed) and `/time set` and
 * `/time add` both take a raw tick count on that same clock.
 */

export const TICKS_PER_SECOND = 20;
export const GAME_TICKS_PER_REDSTONE_TICK = 2;
export const TICKS_PER_DAY = 24000;

export interface DayTimeMarker {
  ticks: number;
  label: string;
  description: string;
}

/** `/time set` named and numeric markers for the day/night cycle. */
export const DAY_TIME_MARKERS: readonly DayTimeMarker[] = [
  { ticks: 0, label: "day", description: "Sunrise; the start of the day cycle" },
  { ticks: 1000, label: "sunrise passes", description: "Sun fully up" },
  { ticks: 6000, label: "noon", description: "Sun directly overhead" },
  {
    ticks: 12000,
    label: "sunset",
    description:
      "Sun starts dropping; hostile mobs can begin spawning above ground once it is dark enough",
  },
  {
    ticks: 13000,
    label: "night",
    description: "Full dark; most hostile mobs can spawn in the open",
  },
  { ticks: 18000, label: "midnight", description: "Sun directly below" },
  {
    ticks: 23000,
    label: "sunrise",
    description: "Sun starts rising; mob spawning above ground stops as it brightens",
  },
  {
    ticks: 24000,
    label: "day (next cycle)",
    description: "Same instant as tick 0 of the next day",
  },
];

export function ticksToSeconds(ticks: number): number {
  return ticks / TICKS_PER_SECOND;
}

export function secondsToTicks(seconds: number): number {
  return seconds * TICKS_PER_SECOND;
}

export function ticksToRedstoneTicks(ticks: number): number {
  return ticks / GAME_TICKS_PER_REDSTONE_TICK;
}

export function redstoneTicksToGameTicks(redstoneTicks: number): number {
  return redstoneTicks * GAME_TICKS_PER_REDSTONE_TICK;
}

/** Milliseconds per tick from a TPS figure; 50ms at a healthy 20 TPS. */
export function tpsToMspt(tps: number): number {
  if (tps <= 0)
    throw new ToolError(
      "invalid-tps",
      "TPS must be greater than 0.",
      "Enter a positive number of ticks per second.",
    );
  return 1000 / tps;
}

/** TPS a server is actually running at, given its measured mean tick time. */
export function msptToTps(mspt: number): number {
  if (mspt <= 0)
    throw new ToolError(
      "invalid-mspt",
      "MSPT must be greater than 0.",
      "Enter a positive average milliseconds-per-tick figure.",
    );
  return Math.min(TICKS_PER_SECOND, 1000 / mspt);
}

/** The in-world clock time (0 to 23999) for an absolute day-time tick count, day rolled off. */
export function timeOfDay(ticks: number): number {
  const m = ticks % TICKS_PER_DAY;
  return m < 0 ? m + TICKS_PER_DAY : m;
}

/** The nearest named marker to a given time-of-day tick, and how far past it. */
export function nearestMarker(ticks: number): { marker: DayTimeMarker; ticksSince: number } {
  const t = timeOfDay(ticks);
  let best = DAY_TIME_MARKERS[0]!;
  for (const marker of DAY_TIME_MARKERS) {
    if (marker.ticks <= t && marker.ticks > best.ticks) best = marker;
  }
  return { marker: best, ticksSince: t - best.ticks };
}

export interface CommonDuration {
  label: string;
  ticks: number;
}

export const COMMON_DURATIONS: readonly CommonDuration[] = [
  { label: "1 second", ticks: 20 },
  { label: "1 redstone tick", ticks: 2 },
  { label: "1 minute", ticks: 1200 },
  { label: "1 in-game hour (1/24 of a day)", ticks: 1000 },
  { label: "1 in-game day (sunrise to sunrise)", ticks: 24000 },
  { label: "1 in-game day, real time (20 minutes)", ticks: 24000 },
  { label: "A furnace smelting one item (10 seconds)", ticks: 200 },
  { label: "A full furnace fuel of coal (80 seconds)", ticks: 1600 },
  { label: "Sweet berry bush regrowth minimum (20000 ticks)", ticks: 20000 },
];

export interface TickTimeOpts {
  mode: string; // 'ticks-to-time' | 'time-to-ticks' | 'redstone' | 'day-cycle' | 'time-add' | 'tps-mspt' | 'durations'
  ticks: number;
  seconds: number;
  redstoneTicks: number;
  tps: number;
  mspt: number;
  currentTime: number;
  addTicks: number;
  [key: string]: unknown;
}

export type TickTimeResult = Record<string, string>;

function fmtNum(n: number): string {
  const rounded = Math.round(n * 1000) / 1000;
  return rounded.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function hms(totalSeconds: number): string {
  const sign = totalSeconds < 0 ? "-" : "";
  const s = Math.abs(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (h > 0 || m > 0) parts.push(`${m}m`);
  parts.push(`${fmtNum(sec)}s`);
  return sign + parts.join(" ");
}

function requireFinite(label: string, v: number): void {
  if (!Number.isFinite(v))
    throw new ToolError(
      `invalid-${label.toLowerCase()}`,
      `${label} must be a finite number.`,
      "Enter a numeric value.",
    );
}

export function run(_input: undefined, opts: TickTimeOpts): TickTimeResult {
  const mode = opts.mode ?? "ticks-to-time";

  if (mode === "ticks-to-time") {
    requireFinite("Ticks", opts.ticks);
    const seconds = ticksToSeconds(opts.ticks);
    return {
      Ticks: fmtNum(opts.ticks),
      Seconds: fmtNum(seconds),
      Minutes: fmtNum(seconds / 60),
      Hours: fmtNum(seconds / 3600),
      "Redstone ticks": fmtNum(ticksToRedstoneTicks(opts.ticks)),
      Duration: hms(seconds),
    };
  }

  if (mode === "time-to-ticks") {
    requireFinite("Seconds", opts.seconds);
    const ticks = secondsToTicks(opts.seconds);
    return {
      Seconds: fmtNum(opts.seconds),
      Ticks: fmtNum(ticks),
      "Redstone ticks": fmtNum(ticksToRedstoneTicks(ticks)),
    };
  }

  if (mode === "redstone") {
    requireFinite("Redstone ticks", opts.redstoneTicks);
    const gameTicks = redstoneTicksToGameTicks(opts.redstoneTicks);
    return {
      "Redstone ticks": fmtNum(opts.redstoneTicks),
      "Game ticks": fmtNum(gameTicks),
      Seconds: fmtNum(ticksToSeconds(gameTicks)),
    };
  }

  if (mode === "day-cycle") {
    requireFinite("Current time", opts.currentTime);
    const t = timeOfDay(opts.currentTime);
    const { marker, ticksSince } = nearestMarker(t);
    return {
      "Time of day (ticks)": String(Math.floor(t)),
      "Nearest marker": `${marker.label} (${marker.ticks})`,
      "Ticks since marker": String(Math.floor(ticksSince)),
      "Marker meaning": marker.description,
      "Real time since day start": hms(ticksToSeconds(t)),
    };
  }

  if (mode === "time-add") {
    requireFinite("Current time", opts.currentTime);
    requireFinite("Ticks to add", opts.addTicks);
    const start = timeOfDay(opts.currentTime);
    const after = timeOfDay(start + opts.addTicks);
    return {
      "Starting time of day": String(Math.floor(start)),
      "/time add": String(Math.floor(opts.addTicks)),
      "Resulting time of day": String(Math.floor(after)),
      Note: "/time add always moves time forward; a negative value here shows what a full day cycle minus that amount would land on",
    };
  }

  if (mode === "tps-to-mspt") {
    requireFinite("TPS", opts.tps);
    const mspt = tpsToMspt(opts.tps);
    return {
      TPS: fmtNum(opts.tps),
      MSPT: fmtNum(mspt),
      "Server health":
        opts.tps >= TICKS_PER_SECOND - 0.1
          ? "Running at full speed"
          : "Behind schedule; ticks are taking longer than 50ms",
    };
  }

  if (mode === "mspt-to-tps") {
    requireFinite("MSPT", opts.mspt);
    const tps = msptToTps(opts.mspt);
    return {
      MSPT: fmtNum(opts.mspt),
      TPS: fmtNum(tps),
      "Server health":
        tps >= TICKS_PER_SECOND - 0.1
          ? "Running at full speed"
          : "Behind schedule; ticks are taking longer than 50ms",
    };
  }

  if (mode === "durations") {
    const out: TickTimeResult = {};
    for (const d of COMMON_DURATIONS) {
      out[d.label] = `${d.ticks} ticks (${fmtNum(ticksToSeconds(d.ticks))}s)`;
    }
    return out;
  }

  throw new ToolError(
    "invalid-mode",
    `Unknown mode "${mode}".`,
    "Choose one of the tick converter modes.",
  );
}

export default { run } satisfies ToolLogic<undefined, TickTimeResult, TickTimeOpts>;

import { ToolError, type ToolLogic } from "../types";

/**
 * Pomodoro Timer: pure schedule math, clock formatting, fragment-safe state
 * encoding, and chime synthesis.
 *
 * Nothing here reads the clock or touches the DOM. The custom panel owns the
 * live parts: it starts/pauses/skips/resets, drives the big phase clock and
 * page title from timestamps (so it stays correct while backgrounded), plays
 * chimes through WebAudio, asks for Notification permission, and mirrors
 * state into the URL fragment so a pop-out Document Picture-in-Picture window
 * (opened via the shared PopoutButton) and a pasted link both resume the same
 * timer. Every function below takes time as an explicit parameter; nothing
 * calls Date.now() so the whole module stays deterministic under test.
 */

/* ------------------------------------------------------------------ */
/* Schedule                                                            */
/* ------------------------------------------------------------------ */

export type PhaseKind = "work" | "short" | "long";

export interface Phase {
  kind: PhaseKind;
  /** Phase length in minutes. */
  minutes: number;
  /** 0-based position of this phase within the schedule array. */
  index: number;
  /** 1-based group number: which run of `cyclesBeforeLong` work sessions this phase belongs to. */
  cycle: number;
}

export interface ScheduleConfig {
  /** Work session length in minutes. Default 25. */
  work?: number;
  /** Short break length in minutes. Default 5. */
  shortBreak?: number;
  /** Long break length in minutes. Default 15. */
  longBreak?: number;
  /** Work sessions between each long break. Default 4. */
  cyclesBeforeLong?: number;
  /** Total number of work sessions in the schedule. Default 8. */
  sessions?: number;
}

function requirePositiveInt(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new ToolError(
      "bad-option",
      `${label} must be a whole number greater than 0, but ${value} was given.`,
      `Pick a whole number of minutes or sessions for ${label.toLowerCase()}.`,
    );
  }
  return value;
}

/**
 * Build the ordered list of work and break phases for a Pomodoro run.
 *
 * A break follows every work session except the last one, so the schedule
 * always starts and ends on a work phase. A break is "long" when it follows
 * a work session whose 1-based position is a multiple of `cyclesBeforeLong`
 * (so the default 8-session, 4-cycle schedule has exactly one long break,
 * after session 4), otherwise it is "short".
 */
export function buildSchedule(config: ScheduleConfig = {}): Phase[] {
  const work = requirePositiveInt(config.work ?? 25, "Work");
  const shortBreak = requirePositiveInt(config.shortBreak ?? 5, "Short break");
  const longBreak = requirePositiveInt(config.longBreak ?? 15, "Long break");
  const cyclesBeforeLong = requirePositiveInt(config.cyclesBeforeLong ?? 4, "Cycles before long break");
  const sessions = requirePositiveInt(config.sessions ?? 8, "Sessions");

  const phases: Phase[] = [];
  let index = 0;
  for (let session = 1; session <= sessions; session++) {
    const cycle = Math.ceil(session / cyclesBeforeLong);
    phases.push({ kind: "work", minutes: work, index: index++, cycle });
    if (session < sessions) {
      const isLong = session % cyclesBeforeLong === 0;
      phases.push({
        kind: isLong ? "long" : "short",
        minutes: isLong ? longBreak : shortBreak,
        index: index++,
        cycle,
      });
    }
  }
  return phases;
}

/** Total schedule length in milliseconds. */
export function totalDuration(schedule: Phase[]): number {
  return schedule.reduce((sum, p) => sum + p.minutes * 60_000, 0);
}

/* ------------------------------------------------------------------ */
/* Playhead                                                             */
/* ------------------------------------------------------------------ */

export interface PhaseAtResult {
  phase: Phase;
  /** Milliseconds left in the current phase. */
  remainingMs: number;
  /** 0 to 1 progress through the current phase. */
  progress: number;
  /** 0-based index of the current phase within the schedule. */
  phaseIndex: number;
  /** Count of work phases fully completed so far. */
  sessionsDone: number;
}

/**
 * Locate the phase a given elapsed time falls into.
 *
 * Intervals are half-open: the instant a phase ends belongs to the next
 * phase, so a running timer's countdown never lands on 0 while still
 * "in" the finishing phase. `elapsedMs` is clamped to [0, totalDuration];
 * past the end, the schedule reports the final phase as complete
 * (remainingMs 0, progress 1, every work phase counted as done).
 */
export function phaseAt(schedule: Phase[], elapsedMs: number): PhaseAtResult {
  if (schedule.length === 0) {
    throw new ToolError("bad-option", "Schedule has no phases to look up.");
  }
  const total = totalDuration(schedule);
  const clamped = Math.min(Math.max(elapsedMs, 0), total);

  let cursor = 0;
  let sessionsDone = 0;
  for (const phase of schedule) {
    const durationMs = phase.minutes * 60_000;
    const phaseEnd = cursor + durationMs;
    const isLast = phase.index === schedule[schedule.length - 1]!.index;
    if (clamped < phaseEnd || (isLast && clamped >= phaseEnd)) {
      const into = Math.min(clamped - cursor, durationMs);
      const remainingMs = isLast && clamped >= phaseEnd ? 0 : durationMs - into;
      const progress = durationMs === 0 ? 1 : Math.min(1, into / durationMs);
      return {
        phase,
        remainingMs,
        progress,
        phaseIndex: phase.index,
        sessionsDone: phase.kind === "work" && progress >= 1 ? sessionsDone + 1 : sessionsDone,
      };
    }
    if (phase.kind === "work") sessionsDone++;
    cursor = phaseEnd;
  }
  // Unreachable given the clamp above, but keeps TypeScript satisfied.
  const last = schedule[schedule.length - 1]!;
  return { phase: last, remainingMs: 0, progress: 1, phaseIndex: last.index, sessionsDone };
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/** Format milliseconds as "MM:SS", or "H:MM:SS" once an hour is reached. Negative values clamp to zero. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatTotal(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} hr`;
  return `${hours} hr ${minutes} min`;
}

/* ------------------------------------------------------------------ */
/* Fragment-safe state                                                 */
/* ------------------------------------------------------------------ */

export interface TimerConfig {
  work: number;
  shortBreak: number;
  longBreak: number;
  cyclesBeforeLong: number;
  sessions: number;
  autoStartBreaks: boolean;
}

export interface TimerState {
  config: TimerConfig;
  /** Timestamp the current run started, or undefined if never started. */
  startedAtMs?: number;
  /** Timestamp the current run was paused, or undefined while running or unstarted. */
  pausedAtMs?: number;
  /** Elapsed time banked before the most recent start (0 for a fresh timer). */
  elapsedBeforePauseMs: number;
  /** 0-based schedule position the state was captured at. */
  phaseIndex: number;
}

/** Encode timer state into a compact, URL-fragment-safe string. Round-trips through `decodeState`. */
export function encodeState(state: TimerState): string {
  const params = new URLSearchParams();
  params.set("w", String(state.config.work));
  params.set("sb", String(state.config.shortBreak));
  params.set("lb", String(state.config.longBreak));
  params.set("cbl", String(state.config.cyclesBeforeLong));
  params.set("se", String(state.config.sessions));
  params.set("as", state.config.autoStartBreaks ? "1" : "0");
  params.set("eb", String(state.elapsedBeforePauseMs));
  params.set("pi", String(state.phaseIndex));
  if (state.startedAtMs !== undefined) params.set("sa", String(state.startedAtMs));
  if (state.pausedAtMs !== undefined) params.set("pa", String(state.pausedAtMs));
  return params.toString();
}

function requireFiniteNumber(params: URLSearchParams, key: string): number {
  const raw = params.get(key);
  if (raw === null || raw === "") {
    throw new ToolError("bad-state", `Timer link is missing "${key}".`, "Copy the pop-out timer link again.");
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new ToolError(
      "bad-state",
      `Timer link has an invalid "${key}" value.`,
      "Copy the pop-out timer link again.",
    );
  }
  return n;
}

/** Decode a string produced by `encodeState` back into a `TimerState`. */
export function decodeState(raw: string): TimerState {
  const stripped = raw.replace(/^[#?]/, "");
  const params = new URLSearchParams(stripped);

  const config: TimerConfig = {
    work: requireFiniteNumber(params, "w"),
    shortBreak: requireFiniteNumber(params, "sb"),
    longBreak: requireFiniteNumber(params, "lb"),
    cyclesBeforeLong: requireFiniteNumber(params, "cbl"),
    sessions: requireFiniteNumber(params, "se"),
    autoStartBreaks: params.get("as") === "1",
  };

  const state: TimerState = {
    config,
    elapsedBeforePauseMs: requireFiniteNumber(params, "eb"),
    phaseIndex: requireFiniteNumber(params, "pi"),
  };
  if (params.has("sa")) state.startedAtMs = requireFiniteNumber(params, "sa");
  if (params.has("pa")) state.pausedAtMs = requireFiniteNumber(params, "pa");
  return state;
}

/* ------------------------------------------------------------------ */
/* Live derived values                                                 */
/* ------------------------------------------------------------------ */

function scheduleFromConfig(config: TimerConfig): Phase[] {
  return buildSchedule({
    work: config.work,
    shortBreak: config.shortBreak,
    longBreak: config.longBreak,
    cyclesBeforeLong: config.cyclesBeforeLong,
    sessions: config.sessions,
  });
}

function elapsedFor(state: TimerState, now: number): number {
  const running = state.startedAtMs !== undefined && state.pausedAtMs === undefined;
  if (!running) return state.elapsedBeforePauseMs;
  return state.elapsedBeforePauseMs + Math.max(0, now - state.startedAtMs!);
}

/**
 * Milliseconds until the next phase change, for the panel's setTimeout and
 * title updates. Returns null when there is nothing to wait for: the timer
 * was never started, is paused, or has already finished the schedule.
 */
export function nextTransition(state: TimerState, now: number): number | null {
  if (state.startedAtMs === undefined) return null;
  if (state.pausedAtMs !== undefined) return null;

  const schedule = scheduleFromConfig(state.config);
  const elapsed = elapsedFor(state, now);
  if (elapsed >= totalDuration(schedule)) return null;

  return phaseAt(schedule, elapsed).remainingMs;
}

/** Focused-minutes and session-count summary for a set of completed work phases. */
export function summarizeDay(completedWorkPhases: Phase[]): { focusedMinutes: number; sessions: number } {
  const workOnly = completedWorkPhases.filter((p) => p.kind === "work");
  return {
    focusedMinutes: workOnly.reduce((sum, p) => sum + p.minutes, 0),
    sessions: workOnly.length,
  };
}

/* ------------------------------------------------------------------ */
/* Chimes                                                               */
/* ------------------------------------------------------------------ */

export type ChimeKind = "work-end" | "break-end";

/**
 * Synthesize a short, distinct chime as a mono Float32Array in [-1, 1].
 *
 * "work-end" plays a rising two-note ping (A5 to C#6) to signal it's break
 * time; "break-end" plays a falling two-note ping (C#6 to E5) to signal it's
 * back to work. Each note is a decaying sine so the chime sounds like a bell
 * rather than a harsh tone. Purely additive synthesis, no randomness.
 */
export function chimeSamples(sampleRate: number, kind: ChimeKind): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate < 1000) {
    throw new ToolError(
      "bad-option",
      `Sample rate must be at least 1000, but ${sampleRate} was given.`,
      "Use a sample rate like 44100 or 48000.",
    );
  }

  const notes = kind === "work-end" ? [880, 1108.73] : [1108.73, 659.25];
  const noteSeconds = 0.16;
  const perNote = Math.round(noteSeconds * sampleRate);
  const samples = new Float32Array(perNote * notes.length);

  notes.forEach((freq, n) => {
    for (let i = 0; i < perNote; i++) {
      const t = i / sampleRate;
      const envelope = Math.exp(-6 * t);
      samples[n * perNote + i] = Math.sin(2 * Math.PI * freq * t) * envelope * 0.6;
    }
  });

  return samples;
}

/* ------------------------------------------------------------------ */
/* run                                                                  */
/* ------------------------------------------------------------------ */

export interface PomodoroOpts {
  work: number;
  shortBreak: number;
  longBreak: number;
  cyclesBeforeLong: number;
  sessions: number;
  autoStartBreaks: boolean;
  [key: string]: unknown;
}

export type PomodoroResult = Record<string, string>;

interface ShorthandMatch {
  work: number;
  shortBreak: number;
  longBreak?: number;
  cyclesBeforeLong?: number;
}

/** Parse "25/5" or "50/10/30x3" (work/short[/long][xCycles]) shorthand. */
function parseShorthand(raw: string): ShorthandMatch {
  const match = /^\s*(\d+)\s*\/\s*(\d+)(?:\s*\/\s*(\d+))?(?:\s*x\s*(\d+))?\s*$/i.exec(raw);
  if (!match) {
    throw new ToolError(
      "bad-shorthand",
      `"${raw}" is not a schedule shorthand pomodoro-timer understands.`,
      'Use "work/short" like "25/5", or "work/short/longxcycles" like "50/10/30x3".',
    );
  }
  const work = Number(match[1]);
  const shortBreak = Number(match[2]);
  const longBreak = match[3] !== undefined ? Number(match[3]) : undefined;
  const cyclesBeforeLong = match[4] !== undefined ? Number(match[4]) : undefined;
  return { work, shortBreak, longBreak, cyclesBeforeLong };
}

function checkRange(value: number, label: string, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ToolError(
      "bad-option",
      `${label} must be between ${min} and ${max}, but ${value} was given.`,
      `Pick a ${label.toLowerCase()} between ${min} and ${max}.`,
    );
  }
  return value;
}

const KIND_LABEL: Record<PhaseKind, string> = {
  work: "Work",
  short: "Short break",
  long: "Long break",
};

/**
 * Build the schedule described by `input` (shorthand) and/or `opts`, and
 * summarize it as page copy. The live timer, chimes, and Notification
 * permission all belong to the custom panel; this only computes the plan.
 */
export function run(input: string, opts: PomodoroOpts): PomodoroResult {
  const raw = (input ?? "").trim();
  const shorthand = raw ? parseShorthand(raw) : undefined;

  const work = checkRange(shorthand?.work ?? opts.work ?? 25, "Work", 1, 120);
  const shortBreak = checkRange(shorthand?.shortBreak ?? opts.shortBreak ?? 5, "Short break", 1, 60);
  const longBreak = checkRange(
    shorthand?.longBreak ?? opts.longBreak ?? 15,
    "Long break",
    1,
    60,
  );
  const cyclesBeforeLong = checkRange(
    shorthand?.cyclesBeforeLong ?? opts.cyclesBeforeLong ?? 4,
    "Cycles before long break",
    1,
    10,
  );
  const sessions = checkRange(opts.sessions ?? 8, "Sessions", 1, 16);

  const schedule = buildSchedule({ work, shortBreak, longBreak, cyclesBeforeLong, sessions });

  const out: PomodoroResult = {};
  schedule.forEach((phase, i) => {
    out[`Phase ${i + 1}`] = `${KIND_LABEL[phase.kind]}, ${phase.minutes} min`;
  });
  out["Total duration"] = formatTotal(totalDuration(schedule));
  out["Note"] =
    "This page only lists the schedule. Open the pop-out button above to run the live timer in an always-on-top window that keeps counting even while this tab is backgrounded.";
  return out;
}

export default { run } satisfies ToolLogic<string, PomodoroResult, PomodoroOpts>;

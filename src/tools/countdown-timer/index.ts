import { Temporal } from "@js-temporal/polyfill";
import { ToolError, type ToolLogic } from "../types";

/**
 * Countdown Timer and Stopwatch: pure duration/date parsing, remaining-time
 * formatting, lap math, and compact URL-fragment state encoding.
 *
 * Actually running a live countdown or stopwatch (ticking, start/pause/reset,
 * WebAudio playback, Notification permission) needs the DOM and timers, so
 * that lives in a custom panel. This file only turns text into numbers and
 * numbers into text, deterministically.
 */

/* ------------------------------------------------------------------ */
/* Duration parsing                                                    */
/* ------------------------------------------------------------------ */

const DURATION_FIX =
  'Use a duration like "5m" or "1h 30m", a bare number of seconds like "90", or a clock time like "2:30" (mm:ss) or "01:30:00" (hh:mm:ss).';

/** Unit suffix -> seconds per unit. Matched case-insensitively. */
const DURATION_UNIT_SECONDS: Record<string, number> = {
  ms: 0.001,
  millisecond: 0.001,
  milliseconds: 0.001,
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
};

/**
 * Parses a whitespace-separated run of number+unit pairs (e.g. "1h 30m",
 * "90s"). Returns null if the text isn't fully consumed by such pairs.
 */
function parseUnitComposite(text: string): number | null {
  const re = /(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/y;
  let idx = 0;
  let total = 0;
  let matchedAny = false;

  while (idx < text.length) {
    while (idx < text.length && /\s/.test(text[idx]!)) idx++;
    if (idx >= text.length) break;

    re.lastIndex = idx;
    const m = re.exec(text);
    if (!m || m.index !== idx) return null;

    const unit = m[2]!.toLowerCase();
    const unitSeconds = DURATION_UNIT_SECONDS[unit];
    if (unitSeconds === undefined) return null;

    total += Number(m[1]) * unitSeconds;
    matchedAny = true;
    idx = re.lastIndex;
  }

  return matchedAny ? total : null;
}

/**
 * Parses a duration into seconds. Accepts unit shorthand ("5m", "1h 30m",
 * "90s"), a bare number (read as seconds), or a clock form: "mm:ss" or
 * "hh:mm:ss" ("2:30" is 2 minutes 30 seconds, "01:30:00" is 1 hour 30
 * minutes).
 */
export function parseDuration(raw: string): number {
  const text = (raw ?? "").trim();
  if (!text) {
    throw new ToolError("bad-duration", "Enter a duration to count down.", DURATION_FIX);
  }

  const noSpace = text.replace(/\s+/g, "");

  // Clock forms: mm:ss or hh:mm:ss (minutes/seconds 0-59).
  const clockMatch = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/.exec(noSpace);
  if (clockMatch) {
    const a = Number(clockMatch[1]);
    const b = Number(clockMatch[2]);
    if (clockMatch[3] !== undefined) {
      const c = Number(clockMatch[3]);
      return a * 3600 + b * 60 + c;
    }
    return a * 60 + b;
  }

  // Bare number -> seconds.
  if (/^\d+(?:\.\d+)?$/.test(noSpace)) {
    return Number(noSpace);
  }

  // Unit shorthand, possibly composite ("1h 30m").
  const compact = text.replace(/\s+/g, " ").trim();
  const seconds = parseUnitComposite(compact);
  if (seconds === null) {
    throw new ToolError("bad-duration", `Could not parse "${text}" as a duration.`, DURATION_FIX);
  }
  return seconds;
}

/* ------------------------------------------------------------------ */
/* Target date/time parsing                                            */
/* ------------------------------------------------------------------ */

const TARGET_FIX =
  'Use an ISO date and time like "2026-12-31T23:59", optionally followed by an IANA zone like "2026-12-31 15:00 America/Chicago".';

/** A trailing " Zone/Name" (or "UTC"/"GMT") token to split off the date/time text. */
const ZONE_TOKEN = /\s+([A-Za-z_]+(?:\/[A-Za-z_]+){1,2}|UTC|GMT)$/;

/** An offset or "Z" designator at the end, which pins an instant on its own. */
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parses a target date/time to epoch milliseconds. Accepts plain ISO 8601
 * ("2026-12-31T23:59", with or without seconds, with or without a "Z"/offset
 * that pins an instant directly), or a wall-clock date/time followed by an
 * IANA zone name either embedded in the text ("2026-12-31 15:00
 * America/Chicago") or passed as `tz`. When no zone or offset is present at
 * all, the wall-clock text is interpreted as UTC.
 */
export function parseTarget(raw: string, tz?: string): number {
  const text = (raw ?? "").trim();
  if (!text) {
    throw new ToolError("bad-target", "Enter a target date and time.", TARGET_FIX);
  }

  let body = text;
  let zone = tz && tz.trim() ? tz.trim() : undefined;
  const zoneMatch = ZONE_TOKEN.exec(text);
  if (zoneMatch && !zone) {
    zone = zoneMatch[1];
    body = text.slice(0, zoneMatch.index);
  }

  // Normalize a space date/time separator to ISO's "T".
  const normalized = body.trim().replace(" ", "T");
  if (!normalized) {
    throw new ToolError("bad-target", `Could not parse "${text}" as a date and time.`, TARGET_FIX);
  }

  // An explicit offset or "Z" pins an instant directly; no zone needed.
  if (HAS_OFFSET.test(normalized)) {
    const d = new Date(normalized);
    if (isNaN(d.getTime())) {
      throw new ToolError("bad-target", `Could not parse "${text}" as a date and time.`, TARGET_FIX);
    }
    return d.getTime();
  }

  const zoneName = !zone || zone === "local" ? "UTC" : zone;
  try {
    const pdt = Temporal.PlainDateTime.from(normalized);
    return pdt.toZonedDateTime(zoneName).epochMilliseconds;
  } catch {
    if (zone && zone !== "UTC" && zone !== "local") {
      throw new ToolError(
        "bad-target",
        `Could not parse "${text}" as a date, time, and zone.`,
        `Check the date and time are valid and the zone is an IANA name like America/Chicago (got "${zone}").`,
      );
    }
    throw new ToolError("bad-target", `Could not parse "${text}" as a date and time.`, TARGET_FIX);
  }
}

/* ------------------------------------------------------------------ */
/* Remaining-time formatting                                           */
/* ------------------------------------------------------------------ */

export type RemainingStyle = "clock" | "words" | "compact";

const STYLE_SYNONYMS: Record<string, RemainingStyle> = {
  clock: "clock",
  digits: "clock",
  numeric: "clock",
  "hh:mm:ss": "clock",
  words: "words",
  long: "words",
  full: "words",
  verbose: "words",
  "spelled-out": "words",
  compact: "compact",
  short: "compact",
  abbreviated: "compact",
  abbr: "compact",
};

function normalizeStyle(raw?: string): RemainingStyle {
  const key = (raw ?? "clock").trim().toLowerCase();
  return STYLE_SYNONYMS[key] ?? "clock";
}

interface DurationParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

function breakdown(msAbs: number): DurationParts {
  const totalSeconds = Math.floor(msAbs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return { days, hours, minutes, seconds };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatClockStyle(msAbs: number): string {
  const { days, hours, minutes, seconds } = breakdown(msAbs);
  const clock = `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  return days > 0 ? `${days}d ${clock}` : clock;
}

function formatWordsStyle(msAbs: number): string {
  const { days, hours, minutes, seconds } = breakdown(msAbs);
  const parts: string[] = [];
  if (days) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  if (seconds || parts.length === 0) parts.push(`${seconds} second${seconds === 1 ? "" : "s"}`);
  return parts.join(" ");
}

function formatCompactStyle(msAbs: number): string {
  const { days, hours, minutes, seconds } = breakdown(msAbs);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

/**
 * Formats a signed millisecond duration as remaining time. Negative values
 * (the target has already passed) render as "overdue by ...".
 */
export function formatRemaining(ms: number, opts?: { style?: string }): string {
  const style = normalizeStyle(opts?.style);
  const isOverdue = ms < 0;
  const msAbs = Math.abs(Math.round(ms));

  let formatted: string;
  if (style === "words") formatted = formatWordsStyle(msAbs);
  else if (style === "compact") formatted = formatCompactStyle(msAbs);
  else formatted = formatClockStyle(msAbs);

  return isOverdue ? `overdue by ${formatted}` : formatted;
}

/** Formats elapsed stopwatch time as "hh:mm:ss.cc" (centiseconds). */
export function formatStopwatch(ms: number): string {
  const msAbs = Math.max(0, Math.round(ms));
  const totalCentis = Math.floor(msAbs / 10);
  const centis = totalCentis % 100;
  const totalSeconds = Math.floor(totalCentis / 100);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}.${pad2(centis)}`;
}

/* ------------------------------------------------------------------ */
/* Laps                                                                 */
/* ------------------------------------------------------------------ */

export interface LapStats {
  fastest: number;
  slowest: number;
  average: number;
  total: number;
}

/**
 * Summarizes per-lap durations in milliseconds (each entry is the time that
 * lap took, not a cumulative split total). An empty array returns all zeros
 * rather than throwing, since a stopwatch panel calls this before any lap
 * has been recorded.
 */
export function lapStats(laps: number[]): LapStats {
  if (!laps || laps.length === 0) {
    return { fastest: 0, slowest: 0, average: 0, total: 0 };
  }
  const total = laps.reduce((sum, l) => sum + l, 0);
  return {
    fastest: Math.min(...laps),
    slowest: Math.max(...laps),
    average: total / laps.length,
    total,
  };
}

/* ------------------------------------------------------------------ */
/* Shareable state encoding                                            */
/* ------------------------------------------------------------------ */

export type TimerKind = "countdown" | "stopwatch" | "until";

export interface TimerState {
  kind: TimerKind;
  /** Countdown duration in seconds (kind "countdown"). */
  seconds?: number;
  /** Target epoch ms (kind "until"). */
  targetMs?: number;
  /** Optional user label, e.g. "Tea timer". */
  label?: string;
  /** Epoch ms the countdown or stopwatch was started (kinds "countdown"/"stopwatch"). */
  startedAtMs?: number;
}

const KIND_CODE: Record<TimerKind, string> = { countdown: "c", stopwatch: "s", until: "u" };
const CODE_KIND: Record<string, TimerKind> = { c: "countdown", s: "stopwatch", u: "until" };

function encodeNumField(n: number | undefined): string {
  return n === undefined || !Number.isFinite(n) ? "" : Math.round(n).toString(36);
}

function decodeNumField(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = parseInt(s, 36);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Encodes timer state as a compact, fragment-safe string:
 * "<kind-code>:<seconds>:<targetMs>:<startedAtMs>:<label>", numbers in
 * base36 and the label percent-encoded. Meant to be stored as one field's
 * value in the URL fragment (see src/lib/fragment.ts), not the whole hash.
 */
export function encodeTimerState(state: TimerState): string {
  const kindCode = KIND_CODE[state.kind] ?? "c";
  const fields = [
    kindCode,
    encodeNumField(state.seconds),
    encodeNumField(state.targetMs),
    encodeNumField(state.startedAtMs),
    state.label ? encodeURIComponent(state.label) : "",
  ];
  return fields.join(":");
}

/**
 * Decodes a string produced by `encodeTimerState`. Tolerant of missing or
 * malformed fields: unknown kind codes fall back to "countdown", unparsable
 * numbers are simply omitted, and an empty or garbage string decodes to an
 * empty countdown state rather than throwing.
 */
export function decodeTimerState(str: string): TimerState {
  const raw = (str ?? "").trim();
  if (!raw) return { kind: "countdown" };

  const parts = raw.split(":");
  const kind = CODE_KIND[parts[0] ?? ""] ?? "countdown";
  const seconds = decodeNumField(parts[1]);
  const targetMs = decodeNumField(parts[2]);
  const startedAtMs = decodeNumField(parts[3]);
  const labelRaw = parts.slice(4).join(":");

  let label: string | undefined;
  if (labelRaw) {
    try {
      label = decodeURIComponent(labelRaw);
    } catch {
      label = undefined;
    }
  }

  const state: TimerState = { kind };
  if (seconds !== undefined) state.seconds = seconds;
  if (targetMs !== undefined) state.targetMs = targetMs;
  if (startedAtMs !== undefined) state.startedAtMs = startedAtMs;
  if (label) state.label = label;
  return state;
}

/* ------------------------------------------------------------------ */
/* Progress                                                             */
/* ------------------------------------------------------------------ */

/**
 * Fraction of a countdown elapsed, clamped to [0, 1]. `seconds` is the total
 * countdown length; a non-positive length is treated as already complete.
 */
export function timerProgress(startedAtMs: number, seconds: number, now: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  const elapsedMs = now - startedAtMs;
  const totalMs = seconds * 1000;
  return Math.min(1, Math.max(0, elapsedMs / totalMs));
}

/* ------------------------------------------------------------------ */
/* Alarm chime                                                         */
/* ------------------------------------------------------------------ */

/**
 * Renders a short two-tone chime (a rising fifth: A5 then E6) as a mono
 * Float32Array in [-1, 1], ready to hand to an AudioBuffer in the panel.
 * Each tone has a short fade in/out to avoid clicks, with a brief silent gap
 * between them.
 */
export function renderChimeSamples(sampleRate: number): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate < 1) {
    throw new ToolError(
      "bad-option",
      `Sample rate must be a positive number, but ${sampleRate} was given.`,
      "Use a sample rate like 44100 or 48000.",
    );
  }

  const TONE1_HZ = 880; // A5
  const TONE2_HZ = 1318.51; // E6, a perfect fifth above
  const TONE1_SEC = 0.15;
  const GAP_SEC = 0.04;
  const TONE2_SEC = 0.28;
  const FADE_SEC = 0.012;
  const AMPLITUDE = 0.5;

  const tone1Count = Math.round(TONE1_SEC * sampleRate);
  const gapCount = Math.round(GAP_SEC * sampleRate);
  const tone2Count = Math.round(TONE2_SEC * sampleRate);
  const total = tone1Count + gapCount + tone2Count;
  const samples = new Float32Array(total);

  const writeTone = (start: number, count: number, hz: number): void => {
    const fadeCount = Math.max(1, Math.min(Math.round(FADE_SEC * sampleRate), Math.floor(count / 2)));
    for (let i = 0; i < count; i++) {
      const t = i / sampleRate;
      let envelope = 1;
      if (i < fadeCount) envelope = i / fadeCount;
      else if (i >= count - fadeCount) envelope = (count - i) / fadeCount;
      samples[start + i] = Math.sin(2 * Math.PI * hz * t) * AMPLITUDE * envelope;
    }
  };

  writeTone(0, tone1Count, TONE1_HZ);
  // The gap region is left at 0 (silence) by the Float32Array's zero-init.
  writeTone(tone1Count + gapCount, tone2Count, TONE2_HZ);

  return samples;
}

/* ------------------------------------------------------------------ */
/* run                                                                  */
/* ------------------------------------------------------------------ */

export interface CountdownOpts {
  /** "clock" | "words" | "compact", or a synonym. */
  style: string;
  /** Injectable current time in epoch ms, for deterministic output. Defaults to Date.now(). */
  now?: number;
  [key: string]: unknown;
}

export type CountdownResult = Record<string, string>;

/** "2026-12-31", "2026-1-5", followed by a T, a space, or the string's end. */
const LOOKS_LIKE_TARGET = /^\d{4}-\d{1,2}-\d{1,2}(?:[T\s]|$)/;

function formatIsoAndLocal(ms: number): string {
  const d = new Date(ms);
  const iso = d.toISOString();
  try {
    const local = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" }).format(d);
    return `${iso} (${local})`;
  } catch {
    return iso;
  }
}

/**
 * Parses a duration or a target date/time out of free text and reports when
 * it ends, how much time is left right now, and a compact link fragment
 * that reproduces it. Empty input explains the panel instead of erroring,
 * since the panel also supports a stopwatch with no text input at all.
 */
export function run(input: string, opts: CountdownOpts): CountdownResult {
  const raw = (input ?? "").trim();
  const now = typeof opts?.now === "number" && Number.isFinite(opts.now) ? opts.now : Date.now();

  if (!raw) {
    return {
      "Countdown timer":
        'Enter a duration like "5m" or "1h 30m", or a target date and time like "2026-12-31T23:59", to build a share link and starting point for the panel.',
      Stopwatch:
        "Leave this blank and use the panel's start, pause, lap, and reset controls. Lap and split times stay in your browser.",
      Alarm:
        "The panel can play a short chime and, with your permission, show a browser notification when a countdown reaches zero.",
    };
  }

  let state: TimerState;
  let targetMs: number;

  if (LOOKS_LIKE_TARGET.test(raw)) {
    targetMs = parseTarget(raw);
    state = { kind: "until", targetMs };
  } else {
    const seconds = parseDuration(raw);
    targetMs = now + seconds * 1000;
    state = { kind: "countdown", seconds, startedAtMs: now };
  }

  const remainingMs = targetMs - now;

  return {
    Kind: state.kind === "until" ? "Until (countdown to a target date)" : "Countdown (from a duration)",
    "Duration/Target": raw,
    "Ends at": formatIsoAndLocal(targetMs),
    "Remaining now": formatRemaining(remainingMs, { style: opts?.style }),
    "Share link fragment": encodeTimerState(state),
  };
}

export default { run } satisfies ToolLogic<string, CountdownResult, CountdownOpts>;

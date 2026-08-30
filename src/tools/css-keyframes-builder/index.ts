import { ToolError, type ToolLogic } from "../types";

/**
 * CSS @keyframes as a timeline model.
 *
 * A keyframe stop is a percentage plus the values a handful of animatable
 * properties take at that point. Keeping the transform as separate translate,
 * rotate, and scale numbers rather than as a string is what lets a slider edit
 * one of them without reparsing the others, and it is also what makes the
 * generator able to emit the same function list at every stop, which is what a
 * browser needs in order to interpolate a transform at all.
 */

export interface KeyframeStop {
  /** Position on the timeline, in percent. */
  at: number;
  /** translate() in px. */
  translateX: number;
  translateY: number;
  /** scale(), 1 being unchanged. */
  scale: number;
  /** rotate() in degrees. */
  rotate: number;
  /** 0 to 1. */
  opacity: number;
  /** "#rrggbb", or empty for "do not set a background at this stop". */
  background: string;
}

export interface AnimationSettings {
  name: string;
  /** Milliseconds. */
  duration: number;
  /** Milliseconds. */
  delay: number;
  /** Any CSS easing keyword or function. */
  timing: string;
  /** A count, or "infinite". */
  iteration: string;
  direction: string;
  fill: string;
  /** Wrap the animation in a prefers-reduced-motion: no-preference query. */
  reducedMotion: boolean;
}

export interface KeyframesOpts {
  preset?: string;
  duration?: number;
  delay?: number;
  timing?: string;
  iteration?: string;
  direction?: string;
  fill?: string;
  reducedMotion?: boolean;
  [key: string]: unknown;
}

export const DIRECTIONS: readonly string[] = [
  "normal",
  "reverse",
  "alternate",
  "alternate-reverse",
];

export const FILL_MODES: readonly string[] = ["none", "forwards", "backwards", "both"];

export const TIMING_FUNCTIONS: readonly string[] = [
  "ease",
  "linear",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "cubic-bezier(0.4, 0, 0.2, 1)",
  "cubic-bezier(0.34, 1.56, 0.64, 1)",
  "steps(6, end)",
];

/* -------------------------------- numbers ---------------------------------- */

export function trimNumber(value: number, places: number): string {
  let text = value.toFixed(places);
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text === "-0" ? "0" : text;
}

/** A stop with everything at its resting value. */
export const IDENTITY_STOP: KeyframeStop = {
  at: 0,
  translateX: 0,
  translateY: 0,
  scale: 1,
  rotate: 0,
  opacity: 1,
  background: "",
};

function stop(at: number, part: Partial<KeyframeStop> = {}): KeyframeStop {
  return { ...IDENTITY_STOP, at, ...part };
}

/* -------------------------------- the name --------------------------------- */

/**
 * CSS-wide keywords are not valid custom idents, so an animation called "none"
 * or "initial" silently disables the animation instead of naming it.
 */
const RESERVED_NAMES = new Set([
  "none",
  "inherit",
  "initial",
  "unset",
  "revert",
  "revert-layer",
  "default",
]);

export function normalizeAnimationName(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "my-animation";
  if (/\s/.test(trimmed)) {
    throw new ToolError(
      "bad-name",
      `An animation name cannot contain spaces: "${trimmed}".`,
      "Use hyphens instead of spaces, for example fade-in.",
    );
  }
  if (RESERVED_NAMES.has(trimmed.toLowerCase())) {
    throw new ToolError(
      "reserved-name",
      `"${trimmed}" is a CSS-wide keyword, so it cannot be an animation name.`,
      "A rule that says animation-name: none turns the animation off instead of naming it. Pick something like fade-in.",
    );
  }
  if (!/^-?[A-Za-z_][A-Za-z0-9_-]*$/.test(trimmed)) {
    throw new ToolError(
      "bad-name",
      `"${trimmed}" is not a valid CSS identifier.`,
      "Start with a letter, an underscore, or a single leading hyphen, then use letters, digits, hyphens, and underscores. For example slide-up.",
    );
  }
  return trimmed;
}

/* -------------------------------- presets ---------------------------------- */

export interface KeyframePreset {
  value: string;
  label: string;
  note: string;
  name: string;
  stops: KeyframeStop[];
  /** Settings that suit this preset, merged over the defaults. */
  settings: Partial<AnimationSettings>;
}

export const KEYFRAME_PRESETS: readonly KeyframePreset[] = [
  {
    value: "fade-in",
    label: "Fade in",
    note: "Opacity with a small lift, which reads better than opacity alone.",
    name: "fade-in",
    stops: [stop(0, { opacity: 0, translateY: 8 }), stop(100, { opacity: 1 })],
    settings: { duration: 320, timing: "ease-out", fill: "both" },
  },
  {
    value: "slide-up",
    label: "Slide up",
    note: "A longer travel for something entering a page.",
    name: "slide-up",
    stops: [stop(0, { opacity: 0, translateY: 32 }), stop(100, { opacity: 1 })],
    settings: { duration: 420, timing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "both" },
  },
  {
    value: "pop-in",
    label: "Pop in",
    note: "Scale and opacity together. Keep it short or it reads as slow.",
    name: "pop-in",
    stops: [
      stop(0, { opacity: 0, scale: 0.8 }),
      stop(70, { opacity: 1, scale: 1.03 }),
      stop(100, { opacity: 1, scale: 1 }),
    ],
    settings: { duration: 280, timing: "ease-out", fill: "both" },
  },
  {
    value: "bounce",
    label: "Bounce",
    note: "Two decreasing hops. The flat stops at the start and end are what make it land.",
    name: "bounce",
    stops: [
      stop(0),
      stop(20),
      stop(40, { translateY: -30 }),
      stop(55, { translateY: 0 }),
      stop(70, { translateY: -14 }),
      stop(85, { translateY: 0 }),
      stop(100),
    ],
    settings: { duration: 1000, timing: "ease-out", iteration: "infinite" },
  },
  {
    value: "pulse",
    label: "Pulse",
    note: "A small scale breath. Anything past about 1.08 reads as a jump.",
    name: "pulse",
    stops: [stop(0), stop(50, { scale: 1.06 }), stop(100)],
    settings: { duration: 1600, timing: "ease-in-out", iteration: "infinite" },
  },
  {
    value: "shake",
    label: "Shake",
    note: "Decreasing horizontal swings, for an invalid field.",
    name: "shake",
    stops: [
      stop(0),
      stop(15, { translateX: -8 }),
      stop(30, { translateX: 8 }),
      stop(45, { translateX: -6 }),
      stop(60, { translateX: 6 }),
      stop(75, { translateX: -3 }),
      stop(100),
    ],
    settings: { duration: 480, timing: "ease-in-out" },
  },
  {
    value: "spin",
    label: "Spin",
    note: "A full turn. Pair it with linear timing or the loop stutters at the seam.",
    name: "spin",
    stops: [stop(0), stop(100, { rotate: 360 })],
    settings: { duration: 900, timing: "linear", iteration: "infinite" },
  },
  {
    value: "color-shift",
    label: "Color shift",
    note: "A background fade that loops back on itself with alternate.",
    name: "color-shift",
    stops: [stop(0, { background: "#5b4bd6" }), stop(100, { background: "#8a79f5" })],
    settings: {
      duration: 2000,
      timing: "ease-in-out",
      iteration: "infinite",
      direction: "alternate",
    },
  },
];

export function presetStops(value: string): KeyframePreset {
  const preset = KEYFRAME_PRESETS.find((p) => p.value === value);
  if (!preset) {
    throw new ToolError(
      "unknown-preset",
      `There is no animation preset called "${value}".`,
      `Pick one of: ${KEYFRAME_PRESETS.map((p) => p.value).join(", ")}.`,
    );
  }
  return { ...preset, stops: preset.stops.map((s) => ({ ...s })) };
}

export const DEFAULT_SETTINGS: AnimationSettings = {
  name: "my-animation",
  duration: 600,
  delay: 0,
  timing: "ease",
  iteration: "1",
  direction: "normal",
  fill: "both",
  reducedMotion: true,
};

/* ------------------------------- generation -------------------------------- */

function hasTransform(s: KeyframeStop): boolean {
  return s.translateX !== 0 || s.translateY !== 0 || s.scale !== 1 || s.rotate !== 0;
}

/** The transform for one stop, written as the same function list every time. */
export function formatTransform(s: KeyframeStop): string {
  const parts = [
    `translate(${trimNumber(s.translateX, 3)}px, ${trimNumber(s.translateY, 3)}px)`,
    `rotate(${trimNumber(s.rotate, 3)}deg)`,
    `scale(${trimNumber(s.scale, 4)})`,
  ];
  return parts.join(" ");
}

/** Sorts by position and rejects a timeline that cannot be written. */
export function normalizeStops(stops: KeyframeStop[]): KeyframeStop[] {
  if (stops.length < 2) {
    throw new ToolError(
      "too-few-stops",
      `An animation needs at least two keyframe stops, and this one has ${stops.length}.`,
      "Add a stop at 100% so the animation has somewhere to go.",
    );
  }
  const sorted = stops.slice().sort((a, b) => a.at - b.at);
  for (const s of sorted) {
    if (!(s.at >= 0 && s.at <= 100)) {
      throw new ToolError(
        "bad-stop",
        `A keyframe stop is at ${trimNumber(s.at, 3)}%, and stops run from 0 to 100.`,
        "Move the stop back inside the timeline.",
      );
    }
  }
  for (let i = 1; i < sorted.length; i += 1) {
    if (Math.abs(sorted[i].at - sorted[i - 1].at) < 0.0001) {
      throw new ToolError(
        "duplicate-stop",
        `Two keyframe stops sit at ${trimNumber(sorted[i].at, 3)}%.`,
        "Move one of them, or remove it. Two rules at the same percentage means the later one silently wins.",
      );
    }
  }
  return sorted;
}

export function formatKeyframes(stops: KeyframeStop[], name: string): string {
  const sorted = normalizeStops(stops);
  const animateTransform = sorted.some(hasTransform);
  const lines: string[] = [`@keyframes ${name} {`];
  for (const s of sorted) {
    const body: string[] = [];
    // The same function list at every stop: a browser can only interpolate two
    // transforms that have matching functions in matching order.
    if (animateTransform) body.push(`transform: ${formatTransform(s)};`);
    body.push(`opacity: ${trimNumber(s.opacity, 4)};`);
    if (s.background) body.push(`background-color: ${s.background};`);
    lines.push(`  ${trimNumber(s.at, 3)}% {`);
    for (const line of body) lines.push(`    ${line}`);
    lines.push("  }");
  }
  lines.push("}");
  return lines.join("\n");
}

export function formatShorthand(settings: AnimationSettings): string {
  const parts = [
    settings.name,
    `${trimNumber(settings.duration, 3)}ms`,
    settings.timing,
    `${trimNumber(settings.delay, 3)}ms`,
    settings.iteration,
    settings.direction,
    settings.fill,
  ];
  return `animation: ${parts.join(" ")};`;
}

/** The whole stylesheet: the keyframes, the rule that uses them, and the guard. */
export function formatAnimationCss(stops: KeyframeStop[], settings: AnimationSettings): string {
  const keyframes = formatKeyframes(stops, settings.name);
  const selector = `.${settings.name}`;
  const shorthand = formatShorthand(settings);

  if (!settings.reducedMotion) {
    return `${keyframes}\n\n${selector} {\n  ${shorthand}\n}`;
  }

  return [
    keyframes,
    "",
    "/* Only animate when the visitor has not asked for less motion. Written as",
    "   no-preference rather than as a reduce override, so a browser that does",
    "   not understand the query never starts the animation at all. */",
    "@media (prefers-reduced-motion: no-preference) {",
    `  ${selector} {`,
    `    ${shorthand}`,
    "  }",
    "}",
  ].join("\n");
}

/* ------------------------------ serialization ------------------------------ */

/**
 * The whole timeline as one short string, so a shared link can carry it.
 *
 * One stop per semicolon, seven comma separated fields in the order at,
 * translateX, translateY, scale, rotate, opacity, background. The background
 * drops its leading hash and is empty when the stop sets none. Kept here
 * rather than in the panel because it is pure, and because a format the tests
 * cover is a format a stale link cannot break.
 */
export function encodeStops(stops: KeyframeStop[]): string {
  return stops
    .map((s) =>
      [
        trimNumber(s.at, 3),
        trimNumber(s.translateX, 3),
        trimNumber(s.translateY, 3),
        trimNumber(s.scale, 4),
        trimNumber(s.rotate, 3),
        trimNumber(s.opacity, 4),
        s.background.replace(/^#/, ""),
      ].join(","),
    )
    .join(";");
}

export function decodeStops(text: string): KeyframeStop[] {
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    throw new ToolError(
      "empty-timeline",
      "There is no timeline to read.",
      "Pick a preset to start from.",
    );
  }
  const stops = trimmed.split(";").map((part) => {
    const fields = part.split(",");
    if (fields.length !== 7) {
      throw new ToolError(
        "bad-timeline",
        `A keyframe stop needs seven fields, and "${part}" has ${fields.length}.`,
        "The timeline format is at,x,y,scale,rotate,opacity,background per stop.",
      );
    }
    const numbers = fields.slice(0, 6).map((f) => {
      const n = Number(f);
      if (!Number.isFinite(n)) {
        throw new ToolError(
          "bad-timeline",
          `"${f}" in "${part}" is not a number.`,
          "The first six fields of a stop are all numbers.",
        );
      }
      return n;
    });
    const background = fields[6].trim();
    if (background && !/^[0-9a-f]{6}$/i.test(background)) {
      throw new ToolError(
        "bad-timeline",
        `"${background}" is not a six digit hex color.`,
        "Write the background as six hex digits with no leading hash, or leave it empty.",
      );
    }
    return {
      at: numbers[0],
      translateX: numbers[1],
      translateY: numbers[2],
      scale: numbers[3],
      rotate: numbers[4],
      opacity: numbers[5],
      background: background ? `#${background.toLowerCase()}` : "",
    };
  });
  return normalizeStops(stops);
}

/* ---------------------------------- run ------------------------------------ */

function readNumber(
  value: unknown,
  fallback: number,
  label: string,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ToolError(
      "bad-option",
      `${label} must be a number between ${min} and ${max}, not ${JSON.stringify(value)}.`,
      `Try ${fallback}.`,
    );
  }
  return n;
}

function readChoice(
  value: unknown,
  allowed: readonly string[],
  fallback: string,
  label: string,
): string {
  if (value === undefined || value === null || value === "") return fallback;
  const key = String(value).trim();
  if (allowed.includes(key)) return key;
  throw new ToolError(
    "bad-option",
    `Unknown ${label} "${key}".`,
    `Pick one of: ${allowed.join(", ")}.`,
  );
}

export function readIteration(value: unknown): string {
  if (value === undefined || value === null || value === "") return "1";
  const key = String(value).trim().toLowerCase();
  if (key === "infinite") return "infinite";
  const n = Number(key);
  if (!Number.isFinite(n) || n < 0 || n > 1000) {
    throw new ToolError(
      "bad-option",
      `Iteration count must be a number from 0 to 1000, or the word infinite, not "${String(value)}".`,
      "Type 1 for a single run, or infinite to loop.",
    );
  }
  return trimNumber(n, 3);
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function run(input: string, opts: KeyframesOpts = {}): string {
  const preset = presetStops(String(opts?.preset ?? "fade-in"));
  const typed = typeof input === "string" ? input.trim() : "";
  const settings: AnimationSettings = {
    ...DEFAULT_SETTINGS,
    ...preset.settings,
    name: normalizeAnimationName(typed || preset.name),
  };

  settings.duration = readNumber(opts?.duration, settings.duration, "Duration", 1, 600000);
  settings.delay = readNumber(opts?.delay, settings.delay, "Delay", 0, 600000);
  settings.timing = String(opts?.timing ?? settings.timing).trim() || settings.timing;
  settings.iteration =
    opts?.iteration === undefined ? settings.iteration : readIteration(opts.iteration);
  settings.direction = readChoice(opts?.direction, DIRECTIONS, settings.direction, "direction");
  settings.fill = readChoice(opts?.fill, FILL_MODES, settings.fill, "fill mode");
  settings.reducedMotion = readBool(opts?.reducedMotion, settings.reducedMotion);

  return formatAnimationCss(preset.stops, settings);
}

export default { run } satisfies ToolLogic<string, string, KeyframesOpts>;

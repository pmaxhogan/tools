import { ToolError, type ToolLogic } from "../types";

/**
 * Cubic bezier easing, as math rather than as a string.
 *
 * A CSS easing curve is a cubic bezier from (0, 0) to (1, 1) with two control
 * points. The x axis is progress through the duration and the y axis is
 * progress through the change, which is why CSS pins both x coordinates to the
 * 0 to 1 range (a curve that doubled back in x would ask the animation to run
 * backwards in time) while leaving y free, so a curve may overshoot past 1 and
 * spring back.
 *
 * This module owns the evaluation, the `linear()` approximation, the parser,
 * and the preset table. The panel only draws what it returns.
 */

export interface BezierControls {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface BezierOpts {
  /** Preset used when there is no input to parse. */
  preset?: string;
  /** Also emit a linear() approximation of the curve. */
  linearApproximation?: boolean;
  /** Number of samples in the linear() approximation. */
  stops?: number;
  /** Duration in milliseconds, used for the transition shorthand. */
  duration?: number;
  [key: string]: unknown;
}

/* -------------------------------- numbers --------------------------------- */

export function trimNumber(value: number, places: number): string {
  let text = value.toFixed(places);
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text === "-0" ? "0" : text;
}

/* --------------------------------- presets --------------------------------- */

export interface EasingPreset {
  value: string;
  label: string;
  note: string;
  controls: BezierControls;
}

/**
 * The five CSS keywords come first, because a browser resolves them to exactly
 * these numbers. The rest are the curves people copy most: the Material
 * Design 3 emphasis set and the two overshoot shapes that make a spring.
 */
export const EASING_PRESETS: readonly EasingPreset[] = [
  {
    value: "linear",
    label: "linear",
    note: "No easing at all. Correct for a color fade, wrong for movement.",
    controls: { x1: 0, y1: 0, x2: 1, y2: 1 },
  },
  {
    value: "ease",
    label: "ease",
    note: "The CSS default: a quick start and a long settle.",
    controls: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 },
  },
  {
    value: "ease-in",
    label: "ease-in",
    note: "Slow start, abrupt finish. Best for something leaving the screen.",
    controls: { x1: 0.42, y1: 0, x2: 1, y2: 1 },
  },
  {
    value: "ease-out",
    label: "ease-out",
    note: "Fast start, soft landing. The safe default for anything entering.",
    controls: { x1: 0, y1: 0, x2: 0.58, y2: 1 },
  },
  {
    value: "ease-in-out",
    label: "ease-in-out",
    note: "Symmetric. Reads as deliberate on longer moves.",
    controls: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
  },
  {
    value: "material-standard",
    label: "Material standard",
    note: "The Material Design emphasized curve for a move that starts and ends on screen.",
    controls: { x1: 0.4, y1: 0, x2: 0.2, y2: 1 },
  },
  {
    value: "material-decelerate",
    label: "Material decelerate",
    note: "For something entering the screen.",
    controls: { x1: 0, y1: 0, x2: 0.2, y2: 1 },
  },
  {
    value: "material-accelerate",
    label: "Material accelerate",
    note: "For something leaving the screen.",
    controls: { x1: 0.4, y1: 0, x2: 1, y2: 1 },
  },
  {
    value: "spring",
    label: "Spring",
    note: "Overshoots past the target and settles back. The y control point above 1 is what does it.",
    controls: { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 },
  },
  {
    value: "anticipate",
    label: "Anticipate",
    note: "Pulls back before it moves, then overshoots. A wind up.",
    controls: { x1: 0.68, y1: -0.55, x2: 0.27, y2: 1.55 },
  },
  {
    value: "quart-out",
    label: "Quartic out",
    note: "A very fast start that spends most of the time settling.",
    controls: { x1: 0.25, y1: 1, x2: 0.5, y2: 1 },
  },
  {
    value: "expo-in-out",
    label: "Exponential in out",
    note: "Almost still at both ends, very fast through the middle.",
    controls: { x1: 0.87, y1: 0, x2: 0.13, y2: 1 },
  },
];

export function presetControls(value: string): BezierControls {
  const preset = EASING_PRESETS.find((p) => p.value === value);
  if (!preset) {
    throw new ToolError(
      "unknown-preset",
      `There is no easing preset called "${value}".`,
      `Pick one of: ${EASING_PRESETS.map((p) => p.value).join(", ")}.`,
    );
  }
  return { ...preset.controls };
}

/* -------------------------------- evaluation ------------------------------- */

/** One axis of a cubic bezier whose end points are pinned to 0 and 1. */
function axis(a: number, b: number, t: number): number {
  const mt = 1 - t;
  return 3 * mt * mt * t * a + 3 * mt * t * t * b + t * t * t;
}

/** The point on the curve at parameter t, which is not the same as progress. */
export function bezierPoint(c: BezierControls, t: number): { x: number; y: number } {
  const clamped = Math.min(1, Math.max(0, t));
  return { x: axis(c.x1, c.x2, clamped), y: axis(c.y1, c.y2, clamped) };
}

/**
 * The eased value at a given progress along the duration.
 *
 * x(t) is monotonic whenever both x controls are inside 0 to 1, which CSS
 * requires, so a bisection always converges. Bisection rather than Newton on
 * purpose: it needs no derivative, cannot diverge, and 40 halvings put the
 * answer well inside float noise.
 */
export function easingAt(c: BezierControls, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (low + high) / 2;
    if (axis(c.x1, c.x2, mid) < x) low = mid;
    else high = mid;
  }
  return axis(c.y1, c.y2, (low + high) / 2);
}

/** Evenly spaced points along the curve, for drawing it. */
export function sampleCurve(c: BezierControls, steps = 64): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i <= steps; i += 1) out.push(bezierPoint(c, i / steps));
  return out;
}

/** The highest and lowest y the curve reaches, so a preview can be scaled. */
export function curveExtent(c: BezierControls): { min: number; max: number } {
  let min = 0;
  let max = 1;
  for (const point of sampleCurve(c, 128)) {
    min = Math.min(min, point.y);
    max = Math.max(max, point.y);
  }
  return { min, max };
}

/* --------------------------------- parsing --------------------------------- */

const KEYWORDS: Record<string, string> = {
  linear: "linear",
  ease: "ease",
  "ease-in": "ease-in",
  "ease-out": "ease-out",
  "ease-in-out": "ease-in-out",
};

/** Reads a CSS timing function into control points. */
export function parseCubicBezier(text: string): BezierControls {
  const trimmed = (text ?? "").trim().replace(/;$/, "");
  if (!trimmed) {
    throw new ToolError(
      "empty-input",
      "There is no easing function to read.",
      "Paste a value such as cubic-bezier(0.25, 0.1, 0.25, 1), or pick a preset.",
    );
  }
  const stripped = trimmed.replace(/^[a-z-]*timing-function\s*:\s*/i, "").trim();

  const keyword = KEYWORDS[stripped.toLowerCase()];
  if (keyword) return presetControls(keyword);

  if (/^steps?\s*\(/i.test(stripped) || /^step-(start|end)$/i.test(stripped)) {
    throw new ToolError(
      "not-a-bezier",
      "Step easings jump between fixed values, so they have no bezier curve to edit.",
      "Use a cubic-bezier() value, or one of the ease keywords.",
    );
  }

  const match = /^cubic-bezier\s*\(([^)]*)\)$/i.exec(stripped);
  const body = match ? match[1] : stripped;
  const parts = body
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length !== 4) {
    throw new ToolError(
      "bad-bezier",
      `A cubic-bezier() takes four numbers, and "${trimmed.slice(0, 60)}" has ${parts.length}.`,
      "Write it as cubic-bezier(x1, y1, x2, y2), for example cubic-bezier(0.25, 0.1, 0.25, 1).",
    );
  }
  const numbers = parts.map((p) => {
    const n = Number(p);
    if (!Number.isFinite(n)) {
      throw new ToolError(
        "bad-bezier",
        `"${p}" is not a number.`,
        "All four cubic-bezier values are plain numbers, with no units.",
      );
    }
    return n;
  });

  return validateControls({ x1: numbers[0], y1: numbers[1], x2: numbers[2], y2: numbers[3] });
}

/** CSS pins both x coordinates to 0 through 1. y is deliberately unbounded. */
export function validateControls(c: BezierControls): BezierControls {
  for (const [name, value] of [
    ["x1", c.x1],
    ["x2", c.x2],
  ] as const) {
    if (!(value >= 0 && value <= 1)) {
      throw new ToolError(
        "out-of-range",
        `${name} is ${trimNumber(value, 4)}, and CSS requires both x values to be between 0 and 1.`,
        "The x axis is time, so a value outside that range would ask the animation to run outside its own duration. Only the y values may go past 0 and 1, which is what makes a curve overshoot.",
      );
    }
  }
  if (!Number.isFinite(c.y1) || !Number.isFinite(c.y2)) {
    throw new ToolError(
      "bad-bezier",
      "Both y values have to be real numbers.",
      "Try something between -1 and 2: values above 1 overshoot, values below 0 pull back first.",
    );
  }
  return { ...c };
}

/* ------------------------------- formatting -------------------------------- */

export function formatCubicBezier(c: BezierControls): string {
  return `cubic-bezier(${[c.x1, c.y1, c.x2, c.y2].map((n) => trimNumber(n, 4)).join(", ")})`;
}

/**
 * The `linear()` approximation.
 *
 * Sampling at even t rather than even x is deliberate: it needs no inversion,
 * and it puts more stops where the curve is actually turning. Each entry is a
 * value plus the input percentage it belongs to, which is the syntax linear()
 * takes.
 */
export function linearApproximation(c: BezierControls, steps = 16): string {
  if (!Number.isInteger(steps) || steps < 2 || steps > 100) {
    throw new ToolError(
      "bad-option",
      `The linear() approximation needs between 2 and 100 stops, not ${steps}.`,
      "Sixteen is enough for almost every curve; raise it only for something with a sharp turn.",
    );
  }
  const entries: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const point = bezierPoint(c, i / steps);
    const value = trimNumber(point.y, 4);
    if (i === 0 || i === steps) entries.push(value);
    else entries.push(`${value} ${trimNumber(point.x * 100, 2)}%`);
  }
  return `linear(${entries.join(", ")})`;
}

/* ------------------------------- comparison -------------------------------- */

export interface PresetMatch {
  preset: EasingPreset;
  /** Root mean square difference in eased value, sampled at even progress. */
  distance: number;
  /** True when the curve is the preset, to four decimals. */
  exact: boolean;
}

/**
 * The named preset whose curve is closest, compared at equal progress rather
 * than at equal t: two curves with the same shape but different parameter
 * spacing should read as the same easing.
 */
export function nearestPreset(c: BezierControls, samples = 24): PresetMatch {
  let best: PresetMatch | null = null;
  for (const preset of EASING_PRESETS) {
    let sum = 0;
    for (let i = 0; i <= samples; i += 1) {
      const x = i / samples;
      const diff = easingAt(c, x) - easingAt(preset.controls, x);
      sum += diff * diff;
    }
    const distance = Math.sqrt(sum / (samples + 1));
    if (!best || distance < best.distance) {
      best = { preset, distance, exact: false };
    }
  }
  const match = best as PresetMatch;
  const p = match.preset.controls;
  match.exact =
    Math.abs(p.x1 - c.x1) < 0.0001 &&
    Math.abs(p.y1 - c.y1) < 0.0001 &&
    Math.abs(p.x2 - c.x2) < 0.0001 &&
    Math.abs(p.y2 - c.y2) < 0.0001;
  return match;
}

/* ---------------------------------- run ------------------------------------ */

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function readInt(
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
  return Math.round(n);
}

export function run(input: string, opts: BezierOpts = {}): string {
  const text = typeof input === "string" ? input.trim() : "";
  const controls = text ? parseCubicBezier(text) : presetControls(String(opts?.preset ?? "ease"));
  const duration = readInt(opts?.duration, 400, "Duration", 1, 60000);
  const steps = readInt(opts?.stops, 16, "linear() stops", 2, 100);
  const wantLinear = readBool(opts?.linearApproximation, true);

  const value = formatCubicBezier(controls);
  const match = nearestPreset(controls);
  const extent = curveExtent(controls);

  const blocks: string[] = [
    value,
    "",
    `transition-timing-function: ${value};`,
    `transition: all ${duration}ms ${value};`,
    `animation: my-animation ${duration}ms ${value} both;`,
  ];

  if (wantLinear) {
    blocks.push(
      "",
      `/* linear() approximation, ${steps} samples. Useful where a curve has to be`,
      "   handed to something that only understands a list of points. */",
      `transition-timing-function: ${linearApproximation(controls, steps)};`,
    );
  }

  blocks.push(
    "",
    match.exact
      ? `/* This is exactly the ${match.preset.label} curve. ${match.preset.note} */`
      : `/* Closest named curve: ${match.preset.label}, average difference ${trimNumber(match.distance, 4)}. ${match.preset.note} */`,
  );

  if (extent.max > 1.0001 || extent.min < -0.0001) {
    blocks.push(
      `/* This curve leaves the 0 to 1 range (${trimNumber(extent.min, 3)} to ${trimNumber(extent.max, 3)}),`,
      "   so the animated property overshoots. That is what you want on transform,",
      "   which has no limits of its own. A property that clamps, such as opacity,",
      "   flattens out at its own limit instead and the overshoot is wasted. */",
    );
  }

  return blocks.join("\n");
}

export default { run } satisfies ToolLogic<string, string, BezierOpts>;

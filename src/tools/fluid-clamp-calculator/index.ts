import { ToolError, type ToolLogic } from "../types";

/**
 * Fluid type sizing with CSS clamp().
 *
 * The whole tool is one straight line: a size that is `minSize` at
 * `minViewport` and `maxSize` at `maxViewport`, expressed as
 * `clamp(min, intercept + slope * 100vw, max)`. Everything else here is
 * presentation of that line: the preview table, the type scale, and the
 * zoom notes.
 */

export interface FluidClampOpts {
  /** "single" for one size, "scale" for a whole type scale. */
  mode?: string;
  /** Size in px at the smallest viewport. */
  minSize?: number;
  /** Size in px at the largest viewport. */
  maxSize?: number;
  /** Smallest viewport width, in px. */
  minViewport?: number;
  /** Largest viewport width, in px. */
  maxViewport?: number;
  /** Root font size in px, used for the rem conversions. */
  rootSize?: number;
  /** "rem" (default) or "px". */
  unit?: string;
  /** Scale ratio at the smallest viewport, e.g. "1.2". */
  minRatio?: string;
  /** Scale ratio at the largest viewport, e.g. "1.25". */
  maxRatio?: string;
  /** Steps above the base size in scale mode. */
  stepsUp?: number;
  /** Steps below the base size in scale mode. */
  stepsDown?: number;
  /** Custom property prefix in scale mode, e.g. "step" gives --step-0. */
  prefix?: string;
  [key: string]: unknown;
}

/** Widths the preview table reports, chosen to cover phone through desktop. */
export const PREVIEW_WIDTHS: readonly number[] = [320, 375, 768, 1024, 1440, 1920];

/** Ratios offered by the scale selects, as strings so they round-trip exactly. */
export const SCALE_RATIOS: readonly { value: string; name: string }[] = [
  { value: "1.067", name: "Minor second" },
  { value: "1.125", name: "Major second" },
  { value: "1.2", name: "Minor third" },
  { value: "1.25", name: "Major third" },
  { value: "1.333", name: "Perfect fourth" },
  { value: "1.414", name: "Augmented fourth" },
  { value: "1.5", name: "Perfect fifth" },
  { value: "1.618", name: "Golden ratio" },
];

/* -------------------------------- numbers --------------------------------- */

/** Fixed-place rounding with the trailing zeros removed, and no "-0". */
export function trimNumber(value: number, places: number): string {
  let text = value.toFixed(places);
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text === "-0" ? "0" : text;
}

/** Renders a px measurement in the requested output unit. */
export function formatLength(px: number, unit: "rem" | "px", rootSize: number): string {
  return unit === "rem" ? `${trimNumber(px / rootSize, 4)}rem` : `${trimNumber(px, 3)}px`;
}

function readNumber(
  value: unknown,
  fallback: number,
  label: string,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new ToolError(
      "bad-option",
      `${label} must be a number, not ${JSON.stringify(value)}.`,
      `Type a number between ${min} and ${max}.`,
    );
  }
  if (n < min || n > max) {
    throw new ToolError(
      "bad-option",
      `${label} must be between ${min} and ${max}, not ${trimNumber(n, 4)}.`,
      `Pick a value inside that range, for example ${trimNumber(fallback, 4)}.`,
    );
  }
  return n;
}

function readUnit(value: unknown): "rem" | "px" {
  if (value === undefined || value === null || value === "") return "rem";
  const key = String(value).trim().toLowerCase();
  if (key === "rem" || key === "px") return key;
  throw new ToolError("bad-option", `Unknown output unit "${String(value)}".`, "Pick rem or px.");
}

function readMode(value: unknown): "single" | "scale" {
  if (value === undefined || value === null || value === "") return "single";
  const key = String(value).trim().toLowerCase();
  if (key === "single" || key === "scale") return key;
  throw new ToolError(
    "bad-option",
    `Unknown mode "${String(value)}".`,
    "Pick single for one size or scale for a full type scale.",
  );
}

function readRatio(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 3) {
    throw new ToolError(
      "bad-option",
      `${label} must be a number between 1 and 3, not ${JSON.stringify(value)}.`,
      "A type scale ratio is usually between 1.067 and 1.618.",
    );
  }
  return n;
}

/** Turns free text into a CSS custom property name body, e.g. "step". */
export function normalizePrefix(raw: string): string {
  const trimmed = (raw ?? "").trim().replace(/^-+/, "");
  if (!trimmed) return "step";
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(trimmed)) {
    throw new ToolError(
      "bad-prefix",
      `"${raw}" is not a valid CSS custom property name.`,
      "Start with a letter and use only letters, digits, hyphens, and underscores, for example step.",
    );
  }
  return trimmed;
}

/* ------------------------------- shorthand -------------------------------- */

export interface ClampSpec {
  minSize: number;
  maxSize: number;
  minViewport: number;
  maxViewport: number;
}

/**
 * Reads the optional quick-entry line. Accepts lengths in the order min size,
 * max size, min viewport, max viewport, separated by spaces, commas, or the
 * words "at" and "to". Units may be px or rem; a bare number is read as px.
 */
export function parseShorthand(text: string, rootSize: number): Partial<ClampSpec> {
  const cleaned = (text ?? "")
    .replace(/[,;]/g, " ")
    .replace(/\b(at|to|from|between|and|viewport|vw)\b/gi, " ")
    .replace(/@/g, " ")
    .trim();
  if (!cleaned) return {};

  const tokens = cleaned.split(/\s+/);
  const values: number[] = [];
  for (const token of tokens) {
    const match = /^(-?\d*\.?\d+)(px|rem|em)?$/i.exec(token);
    if (!match) {
      throw new ToolError(
        "bad-shorthand",
        `"${token}" is not a length this tool understands.`,
        "Write four lengths, for example: 16px 24px 320px 1280px.",
      );
    }
    const n = Number(match[1]);
    const unit = (match[2] ?? "px").toLowerCase();
    values.push(unit === "px" ? n : n * rootSize);
  }

  if (values.length !== 2 && values.length !== 4) {
    throw new ToolError(
      "bad-shorthand",
      `Quick entry needs two or four lengths, not ${values.length}.`,
      "Two lengths set the min and max size; four also set the min and max viewport, for example: 16px 24px 320px 1280px.",
    );
  }

  const spec: Partial<ClampSpec> = { minSize: values[0], maxSize: values[1] };
  if (values.length === 4) {
    spec.minViewport = values[2];
    spec.maxViewport = values[3];
  }
  return spec;
}

/* ------------------------------ the clamp math ----------------------------- */

export interface ClampResult {
  spec: ClampSpec;
  /** px of size gained per px of viewport. Negative on a descending scale. */
  slope: number;
  /** The rem or px term of the preferred value, in px. */
  interceptPx: number;
  /** The vw coefficient, already multiplied by 100. */
  vw: number;
  /** The lower clamp argument in px (the smaller of the two sizes). */
  lowerPx: number;
  /** The upper clamp argument in px. */
  upperPx: number;
  /** "1rem + 0.5vw" or "-0.25rem + 2vw". */
  preferred: string;
  /** The whole "clamp(...)" value. */
  expression: string;
  /** True when the size shrinks as the viewport grows. */
  descending: boolean;
}

export function buildClamp(spec: ClampSpec, unit: "rem" | "px", rootSize: number): ClampResult {
  if (spec.maxViewport <= spec.minViewport) {
    throw new ToolError(
      "bad-range",
      `The max viewport (${trimNumber(spec.maxViewport, 2)}px) must be wider than the min viewport (${trimNumber(spec.minViewport, 2)}px).`,
      "Widen the max viewport, for example 320px to 1280px.",
    );
  }
  if (spec.minSize === spec.maxSize) {
    throw new ToolError(
      "flat-range",
      "The min and max sizes are the same, so the result would not be fluid.",
      "Give the two sizes different values, for example 16px and 24px.",
    );
  }

  const slope = (spec.maxSize - spec.minSize) / (spec.maxViewport - spec.minViewport);
  const interceptPx = spec.minSize - slope * spec.minViewport;
  const vw = slope * 100;
  const descending = spec.maxSize < spec.minSize;
  const lowerPx = Math.min(spec.minSize, spec.maxSize);
  const upperPx = Math.max(spec.minSize, spec.maxSize);

  // CSS math needs a real operator between the terms: "1rem + -2vw" does not
  // parse, so a negative slope has to become a subtraction.
  const interceptText = formatLength(interceptPx, unit, rootSize);
  const vwText = `${trimNumber(Math.abs(vw), 4)}vw`;
  const preferred =
    interceptPx === 0
      ? `${vw < 0 ? "-" : ""}${vwText}`
      : `${interceptText} ${vw < 0 ? "-" : "+"} ${vwText}`;
  const expression = `clamp(${formatLength(lowerPx, unit, rootSize)}, ${preferred}, ${formatLength(upperPx, unit, rootSize)})`;

  return { spec, slope, interceptPx, vw, lowerPx, upperPx, preferred, expression, descending };
}

/** The size the browser actually renders at a given viewport width, in px. */
export function sizeAt(result: ClampResult, viewportPx: number): number {
  const raw = result.interceptPx + result.slope * viewportPx;
  return Math.min(result.upperPx, Math.max(result.lowerPx, raw));
}

/* -------------------------------- the scale -------------------------------- */

export interface ScaleStep {
  /** -2, -1, 0, 1, 2 and so on. */
  index: number;
  /** "--step--1", "--step-0", "--step-1". */
  property: string;
  result: ClampResult;
}

export function buildScale(
  base: ClampSpec,
  minRatio: number,
  maxRatio: number,
  stepsDown: number,
  stepsUp: number,
  prefix: string,
  unit: "rem" | "px",
  rootSize: number,
): ScaleStep[] {
  const steps: ScaleStep[] = [];
  for (let i = -stepsDown; i <= stepsUp; i += 1) {
    const spec: ClampSpec = {
      minSize: base.minSize * Math.pow(minRatio, i),
      maxSize: base.maxSize * Math.pow(maxRatio, i),
      minViewport: base.minViewport,
      maxViewport: base.maxViewport,
    };
    steps.push({
      index: i,
      property: `--${prefix}-${i < 0 ? `-${Math.abs(i)}` : String(i)}`,
      result: buildClamp(spec, unit, rootSize),
    });
  }
  return steps;
}

/* --------------------------------- notes ---------------------------------- */

/**
 * WCAG 1.4.4 asks that text survive a 200 percent resize. A preferred value
 * built only from vw ignores the browser's text size setting, so the rem term
 * is what keeps the rule satisfied. A negative rem term inverts it.
 */
export function zoomNote(result: ClampResult): string {
  if (result.interceptPx > 0) {
    return "The preferred value keeps a positive rem term, so browser text zoom still changes this size. That is what keeps it inside WCAG 1.4.4, which asks that text survive a 200 percent resize.";
  }
  if (result.interceptPx === 0) {
    return "The preferred value has no rem term, so this size follows the viewport alone and ignores the browser text size setting. WCAG 1.4.4 asks that text survive a 200 percent resize, so raise the min size or narrow the viewport range before using this on body copy.";
  }
  return "The rem term is negative, so raising the browser text size makes this text smaller rather than larger. WCAG 1.4.4 asks that text survive a 200 percent resize, so raise the min size, lower the max size, or narrow the viewport range before using this on body copy.";
}

/* ------------------------------- generation -------------------------------- */

function previewRows(
  result: ClampResult,
  unit: "rem" | "px",
  rootSize: number,
  out: Record<string, string>,
  prefixLabel: string,
): void {
  for (const width of PREVIEW_WIDTHS) {
    const px = sizeAt(result, width);
    const clamped =
      width <= result.spec.minViewport || width >= result.spec.maxViewport ? " (clamped)" : "";
    const alt = unit === "rem" ? `${trimNumber(px, 2)}px` : `${trimNumber(px / rootSize, 4)}rem`;
    out[`${prefixLabel}${width}px viewport`] =
      `${formatLength(px, unit, rootSize)} (${alt})${clamped}`;
  }
}

export function run(input: string, opts: FluidClampOpts = {}): Record<string, string> {
  const mode = readMode(opts?.mode);
  const unit = readUnit(opts?.unit);
  const rootSize = readNumber(opts?.rootSize, 16, "Root font size", 1, 100);

  const spec: ClampSpec = {
    minSize: readNumber(opts?.minSize, 16, "Min size", 0.1, 2000),
    maxSize: readNumber(opts?.maxSize, 24, "Max size", 0.1, 2000),
    minViewport: readNumber(opts?.minViewport, 320, "Min viewport", 1, 10000),
    maxViewport: readNumber(opts?.maxViewport, 1280, "Max viewport", 1, 10000),
  };

  Object.assign(spec, parseShorthand(typeof input === "string" ? input : "", rootSize));

  const result = buildClamp(spec, unit, rootSize);
  const out: Record<string, string> = {};

  if (mode === "single") {
    out["CSS value"] = result.expression;
    out["Custom property"] = `--fluid-size: ${result.expression};`;
    out["Applied to font-size"] = `font-size: ${result.expression};`;
    out["Preferred value"] = result.preferred;
    out["Slope"] =
      `${trimNumber(result.vw, 4)}vw (${trimNumber(result.slope * 1000, 3)}px of size per 1000px of viewport)`;
    out["Intercept"] = formatLength(result.interceptPx, unit, rootSize);
    out["Range"] =
      `${formatLength(spec.minSize, unit, rootSize)} at ${trimNumber(spec.minViewport, 2)}px to ${formatLength(spec.maxSize, unit, rootSize)} at ${trimNumber(spec.maxViewport, 2)}px`;
    if (result.descending) {
      out["Direction"] =
        "This size shrinks as the viewport grows, so the clamp arguments are written smallest first as CSS requires.";
    }
    previewRows(result, unit, rootSize, out, "At ");
    out["Zoom check (WCAG 1.4.4)"] = zoomNote(result);
    return out;
  }

  const minRatio = readRatio(opts?.minRatio, 1.2, "Min viewport ratio");
  const maxRatio = readRatio(opts?.maxRatio, 1.25, "Max viewport ratio");
  const stepsUp = Math.round(readNumber(opts?.stepsUp, 5, "Steps above the base", 0, 12));
  const stepsDown = Math.round(readNumber(opts?.stepsDown, 2, "Steps below the base", 0, 6));
  const prefix = normalizePrefix(String(opts?.prefix ?? "step"));

  const steps = buildScale(spec, minRatio, maxRatio, stepsDown, stepsUp, prefix, unit, rootSize);

  const block = [
    ":root {",
    ...steps.map((s) => `  ${s.property}: ${s.result.expression};`),
    "}",
  ].join("\n");

  out["CSS custom properties"] = block;
  for (const step of steps) {
    out[step.property] = step.result.expression;
  }
  out["Scale"] =
    `${trimNumber(minRatio, 4)} at ${trimNumber(spec.minViewport, 2)}px, ${trimNumber(maxRatio, 4)} at ${trimNumber(spec.maxViewport, 2)}px`;
  const base = steps.find((s) => s.index === 0);
  if (base) {
    previewRows(base.result, unit, rootSize, out, "Base step at ");
    out["Zoom check (WCAG 1.4.4)"] = zoomNote(base.result);
  }
  return out;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, FluidClampOpts>;

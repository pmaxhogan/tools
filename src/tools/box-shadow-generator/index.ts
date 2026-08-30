import { ToolError, type ToolLogic } from "../types";

/**
 * Layered CSS box-shadow, as a model rather than a string.
 *
 * A box-shadow value is a comma separated list of layers, each one up to four
 * lengths, a color, and an optional `inset` keyword. This module owns that
 * model in both directions: `parseBoxShadow` reads an existing value into
 * layers so a pasted shadow can be edited, and `formatShadow` writes layers
 * back out. The panel is only a set of sliders over the same model.
 *
 * Colors are kept as an opaque hex plus a separate opacity, because a native
 * `<input type="color">` cannot carry alpha. The two are recombined at format
 * time in whichever syntax the caller asked for.
 */

export interface ShadowLayer {
  /** Horizontal offset in px. Positive moves the shadow right. */
  x: number;
  /** Vertical offset in px. Positive moves the shadow down. */
  y: number;
  /** Blur radius in px. Never negative. */
  blur: number;
  /** Spread radius in px. Negative shrinks the shadow. */
  spread: number;
  /** Opaque "#rrggbb". */
  color: string;
  /** 0 to 1. */
  opacity: number;
  /** Draws the shadow inside the box instead of outside it. */
  inset: boolean;
}

export interface BoxShadowOpts {
  /** Preset used when there is no input to parse. */
  preset?: string;
  /** "rgba" (default), "hex" for #rrggbbaa, or "modern" for rgb(r g b / a%). */
  colorSyntax?: string;
  /** "css" (default), "tailwind", or "both". */
  format?: string;
  /** Multiplies every offset, blur, and spread. 1 leaves them alone. */
  scale?: number;
  [key: string]: unknown;
}

/* -------------------------------- defaults -------------------------------- */

export const DEFAULT_LAYER: ShadowLayer = {
  x: 0,
  y: 2,
  blur: 6,
  spread: 0,
  color: "#000000",
  opacity: 0.16,
  inset: false,
};

function layer(
  x: number,
  y: number,
  blur: number,
  spread: number,
  color: string,
  opacity: number,
  inset = false,
): ShadowLayer {
  return { x, y, blur, spread, color, opacity, inset };
}

export interface ShadowPreset {
  value: string;
  label: string;
  /** One sentence for the panel's preset row. */
  note: string;
  layers: ShadowLayer[];
}

/**
 * The Material elevations are the umbra, penumbra, and ambient triple from the
 * Material Design 2 elevation table, which is still the most copied shadow
 * recipe on the web. The rest are the shapes people actually reach for.
 */
export const SHADOW_PRESETS: readonly ShadowPreset[] = [
  {
    value: "material-1",
    label: "Material elevation 1",
    note: "The Material Design umbra, penumbra, and ambient triple at 1dp.",
    layers: [
      layer(0, 2, 1, -1, "#000000", 0.2),
      layer(0, 1, 1, 0, "#000000", 0.14),
      layer(0, 1, 3, 0, "#000000", 0.12),
    ],
  },
  {
    value: "material-2",
    label: "Material elevation 2",
    note: "Resting elevation for a card.",
    layers: [
      layer(0, 3, 1, -2, "#000000", 0.2),
      layer(0, 2, 2, 0, "#000000", 0.14),
      layer(0, 1, 5, 0, "#000000", 0.12),
    ],
  },
  {
    value: "material-3",
    label: "Material elevation 3",
    note: "A card lifted on hover.",
    layers: [
      layer(0, 3, 3, -2, "#000000", 0.2),
      layer(0, 3, 4, 0, "#000000", 0.14),
      layer(0, 1, 8, 0, "#000000", 0.12),
    ],
  },
  {
    value: "material-4",
    label: "Material elevation 4",
    note: "App bars and raised buttons.",
    layers: [
      layer(0, 2, 4, -1, "#000000", 0.2),
      layer(0, 4, 5, 0, "#000000", 0.14),
      layer(0, 1, 10, 0, "#000000", 0.12),
    ],
  },
  {
    value: "material-5",
    label: "Material elevation 5",
    note: "Floating action buttons and menus.",
    layers: [
      layer(0, 3, 5, -1, "#000000", 0.2),
      layer(0, 6, 10, 0, "#000000", 0.14),
      layer(0, 1, 18, 0, "#000000", 0.12),
    ],
  },
  {
    value: "soft",
    label: "Soft ambient",
    note: "A tight contact shadow under a wide, faint one. Reads as depth rather than as a shadow.",
    layers: [layer(0, 1, 2, 0, "#000000", 0.04), layer(0, 8, 24, -4, "#000000", 0.1)],
  },
  {
    value: "neumorphic",
    label: "Neumorphic",
    note: "A dark shadow and a light highlight on opposite corners. Needs a background close to the element's own.",
    layers: [layer(8, 8, 16, 0, "#a3b1c6", 0.6), layer(-8, -8, 16, 0, "#ffffff", 0.7)],
  },
  {
    value: "hard",
    label: "Hard offset",
    note: "No blur at all, so the shadow reads as a second solid shape.",
    layers: [layer(4, 4, 0, 0, "#111111", 1)],
  },
  {
    value: "inset-well",
    label: "Inset well",
    note: "Draws inside the box, so the surface reads as carved rather than raised.",
    layers: [layer(0, 1, 2, 0, "#000000", 0.15, true), layer(0, 2, 6, -2, "#000000", 0.1, true)],
  },
  {
    value: "focus-ring",
    label: "Focus ring",
    note: "Spread with no blur draws an even outline that follows the border radius.",
    layers: [layer(0, 0, 0, 3, "#5b4bd6", 0.35)],
  },
];

export function presetLayers(value: string): ShadowLayer[] {
  const preset = SHADOW_PRESETS.find((p) => p.value === value);
  if (!preset) {
    throw new ToolError(
      "unknown-preset",
      `There is no shadow preset called "${value}".`,
      `Pick one of: ${SHADOW_PRESETS.map((p) => p.value).join(", ")}.`,
    );
  }
  return preset.layers.map((l) => ({ ...l }));
}

/* --------------------------------- colors ---------------------------------- */

/** The only named colors worth carrying: the ones that show up in real shadows. */
const NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  gray: "#808080",
  grey: "#808080", // spelling: allow
  silver: "#c0c0c0",
  red: "#ff0000",
  blue: "#0000ff",
  green: "#008000",
};

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Rounds to at most `places` decimals and drops the trailing zeros. */
export function trimNumber(value: number, places: number): string {
  let text = value.toFixed(places);
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text === "-0" ? "0" : text;
}

function hexPair(n: number): string {
  return Math.round(clamp01(n / 255) * 255)
    .toString(16)
    .padStart(2, "0");
}

export interface ShadowColor {
  /** Opaque "#rrggbb", always lowercase. */
  hex: string;
  opacity: number;
}

/** Reads one color token from a shadow layer into a hex plus an opacity. */
export function parseShadowColor(token: string): ShadowColor {
  const text = token.trim();
  const named = NAMED_COLORS[text.toLowerCase()];
  if (named) return { hex: named, opacity: 1 };
  if (text.toLowerCase() === "transparent") return { hex: "#000000", opacity: 0 };

  const hex = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (hex) {
    const body = hex[1].toLowerCase();
    if (body.length === 3 || body.length === 4) {
      const expanded = body
        .split("")
        .map((c) => c + c)
        .join("");
      return {
        hex: `#${expanded.slice(0, 6)}`,
        opacity: body.length === 4 ? parseInt(expanded.slice(6, 8), 16) / 255 : 1,
      };
    }
    if (body.length === 6) return { hex: `#${body}`, opacity: 1 };
    if (body.length === 8) {
      return { hex: `#${body.slice(0, 6)}`, opacity: parseInt(body.slice(6, 8), 16) / 255 };
    }
    throw new ToolError(
      "bad-color",
      `"${text}" is not a hex color this tool understands.`,
      "Hex colors have 3, 4, 6, or 8 digits, for example #000 or #00000029.",
    );
  }

  const fn = /^rgba?\(([^)]*)\)$/i.exec(text);
  if (fn) {
    const parts = fn[1]
      .replace(/\//g, " ")
      .split(/[,\s]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length !== 3 && parts.length !== 4) {
      throw new ToolError(
        "bad-color",
        `"${text}" does not have three or four color components.`,
        "Write it as rgb(0, 0, 0) or rgba(0, 0, 0, 0.2).",
      );
    }
    const channel = (raw: string): number => {
      const n = raw.endsWith("%") ? (Number(raw.slice(0, -1)) / 100) * 255 : Number(raw);
      if (!Number.isFinite(n)) {
        throw new ToolError(
          "bad-color",
          `"${raw}" is not a number inside ${text}.`,
          "Each channel is 0 to 255, or a percentage.",
        );
      }
      return Math.min(255, Math.max(0, n));
    };
    const [r, g, b] = [channel(parts[0]), channel(parts[1]), channel(parts[2])];
    let opacity = 1;
    if (parts.length === 4) {
      const raw = parts[3];
      const n = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
      if (!Number.isFinite(n)) {
        throw new ToolError(
          "bad-color",
          `"${raw}" is not an alpha value inside ${text}.`,
          "Alpha is 0 to 1, or a percentage.",
        );
      }
      opacity = clamp01(n);
    }
    return { hex: `#${hexPair(r)}${hexPair(g)}${hexPair(b)}`, opacity };
  }

  throw new ToolError(
    "bad-color",
    `"${text}" is not a color the shadow editor can take apart.`,
    "Use a hex color, rgb(), or rgba(). Keywords like currentColor cannot be split into a color and an opacity.",
  );
}

/** Recombines a hex and an opacity in the requested syntax. */
export function formatShadowColor(
  hex: string,
  opacity: number,
  syntax: "rgba" | "hex" | "modern",
  compact = false,
): string {
  const a = clamp01(opacity);
  if (a >= 1) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if (syntax === "hex") {
    return `${hex}${Math.round(a * 255)
      .toString(16)
      .padStart(2, "0")}`;
  }
  if (syntax === "modern") {
    const value = `rgb(${r} ${g} ${b} / ${trimNumber(a * 100, 2)}%)`;
    return compact ? value.replace(/\s+/g, "_") : value;
  }
  const sep = compact ? "," : ", ";
  return `rgba(${r}${sep}${g}${sep}${b}${sep}${trimNumber(a, 4)})`;
}

/* -------------------------------- parsing ---------------------------------- */

/** Splits on a separator that is not inside parentheses. */
function splitTop(text: string, separator: (ch: string) => boolean): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && separator(ch)) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseLength(token: string, field: string): number {
  const match = /^(-?\d*\.?\d+)(px)?$/i.exec(token);
  if (!match) {
    const unit = /^-?\d*\.?\d+([a-z%]+)$/i.exec(token)?.[1];
    if (unit) {
      throw new ToolError(
        "unsupported-unit",
        `The ${field} is written in ${unit}, and this editor works in pixels.`,
        "Convert the value to px first, for example 1rem becomes 16px.",
      );
    }
    throw new ToolError(
      "bad-length",
      `"${token}" is not a length.`,
      "Each layer takes two to four pixel lengths, for example 0 2px 6px 0.",
    );
  }
  return Number(match[1]);
}

/** Reads a single layer, for example "inset 0 1px 2px rgba(0, 0, 0, 0.2)". */
export function parseShadowLayer(text: string): ShadowLayer {
  const tokens = splitTop(text, (ch) => /\s/.test(ch));
  let inset = false;
  const lengths: number[] = [];
  let colorToken: string | null = null;

  for (const token of tokens) {
    if (token.toLowerCase() === "inset") {
      inset = true;
      continue;
    }
    if (/^-?\d*\.?\d+[a-z%]*$/i.test(token)) {
      const field = ["x offset", "y offset", "blur", "spread"][lengths.length] ?? "extra length";
      if (lengths.length >= 4) {
        throw new ToolError(
          "too-many-lengths",
          `"${text}" has more than four lengths.`,
          "A shadow layer takes at most x, y, blur, and spread.",
        );
      }
      lengths.push(parseLength(token, field));
      continue;
    }
    if (colorToken !== null) {
      throw new ToolError(
        "two-colors",
        `"${text}" names more than one color.`,
        "Each shadow layer carries a single color. Split it into two comma separated layers.",
      );
    }
    colorToken = token;
  }

  if (lengths.length < 2) {
    throw new ToolError(
      "too-few-lengths",
      `"${text}" needs at least an x and a y offset.`,
      "Write the layer as x y blur spread color, for example 0 2px 6px 0 rgba(0, 0, 0, 0.2).",
    );
  }

  const color = colorToken ? parseShadowColor(colorToken) : { hex: "#000000", opacity: 1 };
  const blur = lengths[2] ?? 0;
  if (blur < 0) {
    throw new ToolError(
      "negative-blur",
      `The blur radius in "${text}" is negative.`,
      "Blur cannot be negative. Use a negative spread instead to shrink the shadow.",
    );
  }
  return {
    x: lengths[0],
    y: lengths[1],
    blur,
    spread: lengths[3] ?? 0,
    color: color.hex,
    opacity: color.opacity,
    inset,
  };
}

/** Reads a whole box-shadow value, with or without the property name. */
export function parseBoxShadow(css: string): ShadowLayer[] {
  let text = (css ?? "").trim();
  if (!text) {
    throw new ToolError(
      "empty-input",
      "There is no box-shadow value to read.",
      "Paste a value such as 0 1px 3px rgba(0, 0, 0, 0.2), or pick a preset.",
    );
  }
  text = text.replace(/^box-shadow\s*:\s*/i, "").replace(/;\s*$/, "");
  if (/^none$/i.test(text)) return [];

  const layers = splitTop(text, (ch) => ch === ",").map(parseShadowLayer);
  if (!layers.length) {
    throw new ToolError(
      "empty-input",
      "That value has no shadow layers in it.",
      "Paste a value such as 0 1px 3px rgba(0, 0, 0, 0.2).",
    );
  }
  return layers;
}

/* ------------------------------- formatting -------------------------------- */

export function formatShadowLayer(
  input: ShadowLayer,
  syntax: "rgba" | "hex" | "modern" = "rgba",
  compact = false,
): string {
  const px = (n: number): string => (n === 0 ? "0" : `${trimNumber(n, 3)}px`);
  const parts: string[] = [];
  if (input.inset) parts.push("inset");
  parts.push(px(input.x), px(input.y), px(input.blur));
  if (input.spread !== 0) parts.push(px(input.spread));
  parts.push(formatShadowColor(input.color, input.opacity, syntax, compact));
  return parts.join(compact ? "_" : " ");
}

/** The property value: layers joined with commas, one per line when multiline. */
export function formatShadow(
  layers: ShadowLayer[],
  syntax: "rgba" | "hex" | "modern" = "rgba",
  multiline = true,
): string {
  if (!layers.length) return "none";
  const parts = layers.map((l) => formatShadowLayer(l, syntax));
  return multiline && parts.length > 1 ? parts.join(",\n  ") : parts.join(", ");
}

/** The Tailwind arbitrary value. Tailwind forbids spaces, so they become underscores. */
export function formatTailwind(layers: ShadowLayer[], syntax: "rgba" | "hex" | "modern"): string {
  if (!layers.length) return "shadow-none";
  return `shadow-[${layers.map((l) => formatShadowLayer(l, syntax, true)).join(",")}]`;
}

/** Multiplies every length. Colors and the inset flag are left alone. */
export function scaleLayers(layers: ShadowLayer[], factor: number): ShadowLayer[] {
  if (factor === 1) return layers.map((l) => ({ ...l }));
  return layers.map((l) => ({
    ...l,
    x: Math.round(l.x * factor * 1000) / 1000,
    y: Math.round(l.y * factor * 1000) / 1000,
    blur: Math.round(l.blur * factor * 1000) / 1000,
    spread: Math.round(l.spread * factor * 1000) / 1000,
  }));
}

/* ---------------------------------- run ------------------------------------ */

function readSyntax(value: unknown): "rgba" | "hex" | "modern" {
  if (value === undefined || value === null || value === "") return "rgba";
  const key = String(value).trim().toLowerCase();
  if (key === "rgba" || key === "hex" || key === "modern") return key;
  throw new ToolError(
    "bad-option",
    `Unknown color syntax "${String(value)}".`,
    "Pick rgba, hex, or modern.",
  );
}

function readFormat(value: unknown): "css" | "tailwind" | "both" {
  if (value === undefined || value === null || value === "") return "css";
  const key = String(value).trim().toLowerCase();
  if (key === "css" || key === "tailwind" || key === "both") return key;
  throw new ToolError(
    "bad-option",
    `Unknown output format "${String(value)}".`,
    "Pick css, tailwind, or both.",
  );
}

function readScale(value: unknown): number {
  if (value === undefined || value === null || value === "") return 1;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 8) {
    throw new ToolError(
      "bad-option",
      `Scale must be a number between 0 and 8, not ${JSON.stringify(value)}.`,
      "Leave it at 1 to keep the shadow as it is.",
    );
  }
  return n;
}

export function run(input: string, opts: BoxShadowOpts = {}): string {
  const syntax = readSyntax(opts?.colorSyntax);
  const format = readFormat(opts?.format);
  const scale = readScale(opts?.scale);

  const text = typeof input === "string" ? input.trim() : "";
  const layers = scaleLayers(
    text ? parseBoxShadow(text) : presetLayers(String(opts?.preset ?? "material-2")),
    scale,
  );

  const css = `box-shadow: ${formatShadow(layers, syntax)};`;
  const tailwind = formatTailwind(layers, syntax);

  if (format === "css") return css;
  if (format === "tailwind") return tailwind;
  return `${css}\n\n/* Tailwind arbitrary value */\n${tailwind}`;
}

export default { run } satisfies ToolLogic<string, string, BoxShadowOpts>;

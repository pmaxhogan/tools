import { ToolError, type ToolLogic } from "../types";

/**
 * CSS gradients as a model, in both directions.
 *
 * A background-image can hold several gradients stacked front to back, which
 * is how a mesh gradient is built, so the top level model here is a list of
 * layers rather than a single gradient. `parseBackgroundImage` reads an
 * existing value back into that list and `formatBackground` writes it out
 * again, which is what lets the panel edit a gradient someone pasted in.
 *
 * Colors are kept as an opaque hex plus a separate opacity, because a native
 * `<input type="color">` cannot carry alpha.
 */

export type GradientType = "linear" | "radial" | "conic";

export interface ColorStop {
  /** Opaque "#rrggbb". */
  color: string;
  /** 0 to 1. */
  opacity: number;
  /** Percentage along the gradient line, or null to let the browser space it. */
  position: number | null;
}

export interface GradientLayer {
  type: GradientType;
  /** Degrees. The gradient line for linear, the starting angle for conic. */
  angle: number;
  /** Radial only. */
  shape: "circle" | "ellipse";
  /** Radial only: one of the four extent keywords. */
  size: string;
  /** Center of a radial or conic gradient, in percent. */
  centerX: number;
  centerY: number;
  /** The `in <colorspace>` clause, without the "in". Empty means none. */
  interpolation: string;
  /** Emits repeating-linear-gradient and friends. */
  repeating: boolean;
  stops: ColorStop[];
}

export interface GradientOpts {
  /** Preset used when there is nothing to parse. */
  preset?: string;
  /** "keep" leaves each layer alone; anything else rewrites every layer. */
  interpolation?: string;
  /** "rgba" (default), "hex", or "modern". */
  colorSyntax?: string;
  /** "css" (default), "tailwind", or "both". */
  format?: string;
  [key: string]: unknown;
}

export const RADIAL_SIZES: readonly string[] = [
  "closest-side",
  "closest-corner",
  "farthest-side",
  "farthest-corner",
];

/**
 * Color spaces worth offering. oklch and oklab avoid the gray dead zone that
 * srgb interpolation produces between complementary colors; the hue methods
 * only apply to the polar spaces.
 */
export const INTERPOLATION_SPACES: readonly string[] = [
  "",
  "srgb",
  "srgb-linear",
  "oklab",
  "oklch",
  "oklch longer hue",
  "hsl",
  "display-p3",
];

/* --------------------------------- numbers --------------------------------- */

export function trimNumber(value: number, places: number): string {
  let text = value.toFixed(places);
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text === "-0" ? "0" : text;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function hexPair(n: number): string {
  return Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, "0");
}

/* --------------------------------- colors ---------------------------------- */

const NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  lime: "#00ff00",
  blue: "#0000ff",
  yellow: "#ffff00",
  cyan: "#00ffff",
  aqua: "#00ffff",
  magenta: "#ff00ff",
  fuchsia: "#ff00ff",
  silver: "#c0c0c0",
  gray: "#808080",
  grey: "#808080", // spelling: allow
  maroon: "#800000",
  olive: "#808000",
  green: "#008000",
  purple: "#800080",
  teal: "#008080",
  navy: "#000080",
  orange: "#ffa500",
  pink: "#ffc0cb",
  gold: "#ffd700",
  indigo: "#4b0082",
  violet: "#ee82ee",
  tomato: "#ff6347",
  coral: "#ff7f50",
};

export interface StopColor {
  hex: string;
  opacity: number;
}

export function parseStopColor(token: string): StopColor {
  const text = token.trim();
  if (text.toLowerCase() === "transparent") return { hex: "#000000", opacity: 0 };
  const named = NAMED_COLORS[text.toLowerCase()];
  if (named) return { hex: named, opacity: 1 };

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
      "Hex colors have 3, 4, 6, or 8 digits, for example #f00 or #ff000080.",
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
        "Write it as rgb(255, 0, 0) or rgba(255, 0, 0, 0.5).",
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
      return n;
    };
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
    return {
      hex: `#${hexPair(channel(parts[0]))}${hexPair(channel(parts[1]))}${hexPair(channel(parts[2]))}`,
      opacity,
    };
  }

  throw new ToolError(
    "bad-color",
    `"${text}" is not a color the gradient editor can take apart.`,
    "Use a hex color, rgb(), rgba(), or one of the basic CSS color keywords. A color that depends on the page, like currentColor, cannot be edited as a swatch.",
  );
}

export function formatStopColor(
  hex: string,
  opacity: number,
  syntax: "rgba" | "hex" | "modern" = "rgba",
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

/* -------------------------------- presets ---------------------------------- */

function stop(color: string, position: number | null, opacity = 1): ColorStop {
  return { color, opacity, position };
}

function linear(angle: number, stops: ColorStop[], interpolation = "oklch"): GradientLayer {
  return {
    type: "linear",
    angle,
    shape: "ellipse",
    size: "farthest-corner",
    centerX: 50,
    centerY: 50,
    interpolation,
    repeating: false,
    stops,
  };
}

export interface GradientPreset {
  value: string;
  label: string;
  note: string;
  layers: GradientLayer[];
}

export const GRADIENT_PRESETS: readonly GradientPreset[] = [
  {
    value: "sunset",
    label: "Sunset",
    note: "Three warm stops on a steep diagonal.",
    layers: [linear(160, [stop("#ff9a44", 0), stop("#ff5f6d", 48), stop("#6a3093", 100)])],
  },
  {
    value: "aurora",
    label: "Aurora",
    note: "Cool blues into green, interpolated in oklch so the middle stays saturated.",
    layers: [linear(120, [stop("#00c6ff", 0), stop("#0072ff", 45), stop("#7bffcd", 100)])],
  },
  {
    value: "ocean",
    label: "Ocean",
    note: "A simple vertical two stop fade.",
    layers: [linear(180, [stop("#2e3192", 0), stop("#1bffff", 100)])],
  },
  {
    value: "peach",
    label: "Peach",
    note: "Low contrast, safe behind text.",
    layers: [linear(135, [stop("#ffd3a5", 0), stop("#fd6585", 100)])],
  },
  {
    value: "spotlight",
    label: "Spotlight",
    note: "A radial gradient with the center pushed off to one side.",
    layers: [
      {
        type: "radial",
        angle: 0,
        shape: "circle",
        size: "farthest-corner",
        centerX: 30,
        centerY: 20,
        interpolation: "oklch",
        repeating: false,
        stops: [stop("#ffe259", 0), stop("#ffa751", 55), stop("#2b1055", 100)],
      },
    ],
  },
  {
    value: "wheel",
    label: "Color wheel",
    note: "A conic gradient all the way around the hue circle.",
    layers: [
      {
        type: "conic",
        angle: 0,
        shape: "circle",
        size: "farthest-corner",
        centerX: 50,
        centerY: 50,
        interpolation: "",
        repeating: false,
        stops: [
          stop("#ff0000", 0),
          stop("#ffff00", 17),
          stop("#00ff00", 33),
          stop("#00ffff", 50),
          stop("#0000ff", 67),
          stop("#ff00ff", 83),
          stop("#ff0000", 100),
        ],
      },
    ],
  },
  {
    value: "mesh",
    label: "Mesh",
    note: "Two transparent radial blobs stacked over a flat base, which is how a mesh gradient is faked in plain CSS.",
    layers: [
      {
        type: "radial",
        angle: 0,
        shape: "circle",
        size: "farthest-side",
        centerX: 15,
        centerY: 20,
        interpolation: "",
        repeating: false,
        stops: [stop("#ff4d9d", 0, 0.75), stop("#ff4d9d", 65, 0)],
      },
      {
        type: "radial",
        angle: 0,
        shape: "circle",
        size: "farthest-side",
        centerX: 85,
        centerY: 75,
        interpolation: "",
        repeating: false,
        stops: [stop("#00d4ff", 0, 0.7), stop("#00d4ff", 70, 0)],
      },
      linear(180, [stop("#2b1055", 0), stop("#4527a0", 100)], ""),
    ],
  },
  {
    value: "stripes",
    label: "Stripes",
    note: "A repeating gradient with hard stops, so the bands have crisp edges.",
    layers: [
      {
        type: "linear",
        angle: 45,
        shape: "ellipse",
        size: "farthest-corner",
        centerX: 50,
        centerY: 50,
        interpolation: "",
        repeating: true,
        stops: [stop("#5b4bd6", 0), stop("#5b4bd6", 50), stop("#8a79f5", 50), stop("#8a79f5", 100)],
      },
    ],
  },
];

export function presetLayers(value: string): GradientLayer[] {
  const preset = GRADIENT_PRESETS.find((p) => p.value === value);
  if (!preset) {
    throw new ToolError(
      "unknown-preset",
      `There is no gradient preset called "${value}".`,
      `Pick one of: ${GRADIENT_PRESETS.map((p) => p.value).join(", ")}.`,
    );
  }
  return preset.layers.map((l) => ({ ...l, stops: l.stops.map((s) => ({ ...s })) }));
}

/* -------------------------------- splitting -------------------------------- */

/** Splits on a separator character that is not inside parentheses. */
export function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && ch === separator) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts.filter((p) => p.length > 0);
}

function splitWords(text: string): string[] {
  return splitTop(text, " ");
}

/* --------------------------------- angles ---------------------------------- */

const SIDE_ANGLES: Record<string, number> = {
  top: 0,
  "top right": 45,
  "right top": 45,
  right: 90,
  "bottom right": 135,
  "right bottom": 135,
  bottom: 180,
  "bottom left": 225,
  "left bottom": 225,
  left: 270,
  "top left": 315,
  "left top": 315,
};

/** Reads an angle in any CSS angle unit and returns degrees in [0, 360). */
export function parseAngle(token: string): number {
  const match = /^(-?\d*\.?\d+)(deg|grad|rad|turn)?$/i.exec(token.trim());
  if (!match) {
    throw new ToolError(
      "bad-angle",
      `"${token}" is not an angle.`,
      "Write an angle such as 45deg, 0.25turn, or a side such as to bottom right.",
    );
  }
  const n = Number(match[1]);
  const unit = (match[2] ?? "deg").toLowerCase();
  const deg =
    unit === "deg"
      ? n
      : unit === "grad"
        ? (n * 360) / 400
        : unit === "rad"
          ? (n * 180) / Math.PI
          : n * 360;
  return ((deg % 360) + 360) % 360;
}

const POSITION_KEYWORDS: Record<string, number> = {
  left: 0,
  top: 0,
  center: 50,
  right: 100,
  bottom: 100,
};

const VERTICAL_KEYWORDS = new Set(["top", "bottom"]);
const HORIZONTAL_KEYWORDS = new Set(["left", "right"]);

/**
 * Puts a position back into x then y order.
 *
 * CSS lets the two keywords appear in either order as long as they name
 * different axes, so "at top right" and "at right top" are the same place.
 * Reading them positionally would put "at top right" in the bottom left
 * corner, which is wrong in a way that produces no error at all.
 */
export function orderPositionTokens(tokens: string[]): [string, string] {
  if (tokens.length === 0) return ["center", "center"];
  if (tokens.length === 1) {
    return VERTICAL_KEYWORDS.has(tokens[0].toLowerCase())
      ? ["center", tokens[0]]
      : [tokens[0], "center"];
  }
  const first = tokens[0].toLowerCase();
  const second = tokens[1].toLowerCase();
  if (VERTICAL_KEYWORDS.has(first) || HORIZONTAL_KEYWORDS.has(second)) {
    return [tokens[1], tokens[0]];
  }
  return [tokens[0], tokens[1]];
}

function parsePositionPair(tokens: string[], source: string): { x: number; y: number } {
  const read = (token: string): number => {
    const key = token.toLowerCase();
    if (key in POSITION_KEYWORDS) return POSITION_KEYWORDS[key];
    const pct = /^(-?\d*\.?\d+)%$/.exec(token);
    if (pct) return Number(pct[1]);
    throw new ToolError(
      "unsupported-position",
      `"${token}" in "${source}" is not a percentage or a position keyword.`,
      "The editor works in percentages, so write the center as at 30% 40% or with keywords like at center top.",
    );
  };
  const [xToken, yToken] = orderPositionTokens(tokens);
  return { x: read(xToken), y: read(yToken) };
}

/* -------------------------------- parsing ---------------------------------- */

/**
 * Whether the first argument is the gradient's shape rather than its first
 * color stop. A leading length counts, so an explicit radial size lands in the
 * prelude reader and gets the "this editor works in keywords" error rather
 * than being mistaken for a color.
 */
const PRELUDE_START =
  /^(to\s|from\s|at\s|in\s|circle\b|ellipse\b|closest-|farthest-|-?\d*\.?\d+(deg|grad|rad|turn|px|rem|em|%|vw|vh|ch|pt|cm|mm|in|pc)(\s|$))/i;

/** Reads one gradient function, for example "linear-gradient(45deg, red, blue)". */
export function parseGradientLayer(text: string): GradientLayer {
  const trimmed = text.trim();
  const head = /^(repeating-)?(linear|radial|conic)-gradient\s*\(([\s\S]*)\)$/i.exec(trimmed);
  if (!head) {
    throw new ToolError(
      "not-a-gradient",
      `"${trimmed.slice(0, 60)}" is not a CSS gradient function.`,
      "Paste a value such as linear-gradient(45deg, #ff0000, #0000ff).",
    );
  }

  const repeating = Boolean(head[1]);
  const type = head[2].toLowerCase() as GradientType;
  const args = splitTop(head[3], ",");
  if (!args.length) {
    throw new ToolError(
      "no-stops",
      "That gradient has nothing between its parentheses.",
      "A gradient needs at least two color stops.",
    );
  }

  const layer: GradientLayer = {
    type,
    angle: type === "linear" ? 180 : 0,
    shape: type === "radial" ? "ellipse" : "circle",
    size: "farthest-corner",
    centerX: 50,
    centerY: 50,
    interpolation: "",
    repeating,
    stops: [],
  };

  let stopArgs = args;
  if (PRELUDE_START.test(args[0])) {
    stopArgs = args.slice(1);
    const words = splitWords(args[0]);
    let i = 0;
    while (i < words.length) {
      const word = words[i].toLowerCase();
      if (word === "to") {
        const sides: string[] = [];
        while (i + 1 < words.length && /^(top|bottom|left|right)$/i.test(words[i + 1])) {
          sides.push(words[i + 1].toLowerCase());
          i += 1;
        }
        const key = sides.join(" ");
        if (!(key in SIDE_ANGLES)) {
          throw new ToolError(
            "bad-angle",
            `"to ${key}" is not a gradient direction.`,
            "Use to top, to right, to bottom left, and so on.",
          );
        }
        layer.angle = SIDE_ANGLES[key];
        i += 1;
        continue;
      }
      if (word === "from") {
        layer.angle = parseAngle(words[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (word === "at") {
        const rest: string[] = [];
        while (i + 1 < words.length && words[i + 1].toLowerCase() !== "in") {
          rest.push(words[i + 1]);
          i += 1;
        }
        const pos = parsePositionPair(rest, args[0]);
        layer.centerX = pos.x;
        layer.centerY = pos.y;
        i += 1;
        continue;
      }
      if (word === "in") {
        layer.interpolation = words
          .slice(i + 1)
          .join(" ")
          .toLowerCase();
        break;
      }
      if (word === "circle" || word === "ellipse") {
        layer.shape = word;
        i += 1;
        continue;
      }
      if (RADIAL_SIZES.includes(word)) {
        layer.size = word;
        i += 1;
        continue;
      }
      if (/^-?\d*\.?\d+(deg|grad|rad|turn)?$/i.test(word)) {
        layer.angle = parseAngle(word);
        i += 1;
        continue;
      }
      throw new ToolError(
        "unsupported-gradient",
        `"${words[i]}" is part of a gradient shape this editor cannot take apart.`,
        "Explicit radial sizes in px or rem are not supported. Use one of the extent keywords such as farthest-corner.",
      );
    }
  }

  for (const arg of stopArgs) {
    const words = splitWords(arg);
    if (!words.length) continue;
    const colorToken = words[0];
    const positions = words.slice(1);
    if (positions.length > 2) {
      throw new ToolError(
        "bad-stop",
        `"${arg}" has more than two positions.`,
        "A color stop takes a color and at most two positions.",
      );
    }
    const color = parseStopColor(colorToken);
    if (!positions.length) {
      layer.stops.push({ color: color.hex, opacity: color.opacity, position: null });
      continue;
    }
    for (const raw of positions) {
      const pct = /^(-?\d*\.?\d+)%$/.exec(raw);
      if (!pct) {
        throw new ToolError(
          "unsupported-position",
          `"${raw}" in "${arg}" is not a percentage.`,
          "The stop bar works in percentages, so convert lengths like 40px to a percentage first.",
        );
      }
      layer.stops.push({ color: color.hex, opacity: color.opacity, position: Number(pct[1]) });
    }
  }

  if (layer.stops.length < 2) {
    throw new ToolError(
      "no-stops",
      "A gradient needs at least two color stops.",
      "Add another stop, for example linear-gradient(90deg, #ff0000, #0000ff).",
    );
  }
  return layer;
}

/** Reads a whole background-image value, which may stack several gradients. */
export function parseBackgroundImage(css: string): GradientLayer[] {
  let text = (css ?? "").trim();
  if (!text) {
    throw new ToolError(
      "empty-input",
      "There is no gradient to read.",
      "Paste a value such as linear-gradient(45deg, #ff0000, #0000ff), or pick a preset.",
    );
  }
  text = text
    .replace(/^background(-image)?\s*:\s*/i, "")
    .replace(/;\s*$/, "")
    .trim();
  // Commas inside a gradient's own parentheses sit at depth 1, so a top level
  // split is exactly the layer list.
  const parts = splitTop(text, ",");
  if (!parts.length) {
    throw new ToolError(
      "empty-input",
      "There is no gradient to read.",
      "Paste a value such as linear-gradient(45deg, #ff0000, #0000ff).",
    );
  }
  return parts.map(parseGradientLayer);
}

/* ------------------------------- formatting -------------------------------- */

function formatStop(input: ColorStop, syntax: "rgba" | "hex" | "modern", compact: boolean): string {
  const color = formatStopColor(input.color, input.opacity, syntax, compact);
  if (input.position === null) return color;
  return `${color}${compact ? "_" : " "}${trimNumber(input.position, 3)}%`;
}

export function formatGradientLayer(
  layer: GradientLayer,
  syntax: "rgba" | "hex" | "modern" = "rgba",
  compact = false,
): string {
  const prelude: string[] = [];
  if (layer.type === "linear") {
    prelude.push(`${trimNumber(layer.angle, 3)}deg`);
  } else if (layer.type === "radial") {
    prelude.push(layer.shape, layer.size);
    prelude.push(`at ${trimNumber(layer.centerX, 3)}% ${trimNumber(layer.centerY, 3)}%`);
  } else {
    if (layer.angle !== 0) prelude.push(`from ${trimNumber(layer.angle, 3)}deg`);
    prelude.push(`at ${trimNumber(layer.centerX, 3)}% ${trimNumber(layer.centerY, 3)}%`);
  }
  if (layer.interpolation) prelude.push(`in ${layer.interpolation}`);

  const parts = [prelude.join(" "), ...layer.stops.map((s) => formatStop(s, syntax, compact))];
  const name = `${layer.repeating ? "repeating-" : ""}${layer.type}-gradient`;
  const body = parts.join(compact ? "," : ", ");
  return compact ? `${name}(${body.replace(/\s+/g, "_")})` : `${name}(${body})`;
}

/** The whole background-image value: layers front to back. */
export function formatBackground(
  layers: GradientLayer[],
  syntax: "rgba" | "hex" | "modern" = "rgba",
  compact = false,
): string {
  if (!layers.length) return "none";
  return layers.map((l) => formatGradientLayer(l, syntax, compact)).join(compact ? "," : ", ");
}

/** The Tailwind arbitrary value. Tailwind forbids spaces, so they become underscores. */
export function formatTailwind(
  layers: GradientLayer[],
  syntax: "rgba" | "hex" | "modern" = "rgba",
): string {
  if (!layers.length) return "bg-none";
  return `bg-[${formatBackground(layers, syntax, true)}]`;
}

/**
 * Evens out the stops that carry no explicit position, the way a browser does:
 * the first is 0%, the last is 100%, and the rest are spaced between their
 * nearest positioned neighbors. The panel needs real numbers to draw handles.
 */
export function resolveStopPositions(stops: ColorStop[]): number[] {
  const out: (number | null)[] = stops.map((s) => s.position);
  if (out.length && out[0] === null) out[0] = 0;
  if (out.length > 1 && out[out.length - 1] === null) out[out.length - 1] = 100;
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] !== null) continue;
    let end = i;
    while (end < out.length && out[end] === null) end += 1;
    const before = (out[i - 1] as number) ?? 0;
    const after = (out[end] as number) ?? 100;
    const gaps = end - i + 1;
    for (let k = i; k < end; k += 1) {
      out[k] = before + ((after - before) * (k - i + 1)) / gaps;
    }
    i = end - 1;
  }
  return out.map((n) => n ?? 0);
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

function applyInterpolation(layers: GradientLayer[], value: unknown): GradientLayer[] {
  if (value === undefined || value === null || value === "" || value === "keep") return layers;
  const key = String(value).trim().toLowerCase();
  const resolved = key === "none" ? "" : key;
  if (!INTERPOLATION_SPACES.includes(resolved)) {
    throw new ToolError(
      "bad-option",
      `Unknown interpolation color space "${String(value)}".`,
      `Pick keep, none, or one of: ${INTERPOLATION_SPACES.filter(Boolean).join(", ")}.`,
    );
  }
  return layers.map((l) => ({ ...l, interpolation: resolved }));
}

export function run(input: string, opts: GradientOpts = {}): string {
  const syntax = readSyntax(opts?.colorSyntax);
  const format = readFormat(opts?.format);

  const text = typeof input === "string" ? input.trim() : "";
  const layers = applyInterpolation(
    text ? parseBackgroundImage(text) : presetLayers(String(opts?.preset ?? "sunset")),
    opts?.interpolation,
  );

  const css = `background-image: ${formatBackground(layers, syntax)};`;
  const tailwind = formatTailwind(layers, syntax);

  if (format === "css") return css;
  if (format === "tailwind") return tailwind;
  return `${css}\n\n/* Tailwind arbitrary value */\n${tailwind}`;
}

export default { run } satisfies ToolLogic<string, string, GradientOpts>;

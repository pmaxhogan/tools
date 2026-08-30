import { ToolError, type ToolLogic } from "../types";

/**
 * CSS clip-path shapes as a model.
 *
 * Everything is stored in percentages of the element's own box, which is what
 * makes a shape reusable at any size and what lets the editor draw handles
 * without knowing how big the element will be. `parseClipPath` reads an
 * existing value back so a shape can be adjusted, and `toSvgPath` converts the
 * same model into an SVG path for the cases where clip-path is not the right
 * tool (an actual SVG, a mask, or a Figma import).
 */

export type ClipShapeKind = "polygon" | "circle" | "ellipse" | "inset";

export interface ClipPoint {
  /** Percent of the element's width. */
  x: number;
  /** Percent of the element's height. */
  y: number;
}

export interface ClipShape {
  kind: ClipShapeKind;
  /** polygon only. */
  points: ClipPoint[];
  /** polygon only: how overlapping subpaths are filled. */
  fillRule: "nonzero" | "evenodd";
  /** circle and ellipse: the center, in percent. */
  centerX: number;
  centerY: number;
  /** circle only: the radius, in percent of the diagonal reference. */
  radius: number;
  /** ellipse only, in percent of the width and the height. */
  radiusX: number;
  radiusY: number;
  /** inset only: the four edge insets, in percent. */
  top: number;
  right: number;
  bottom: number;
  left: number;
  /** inset only: corner rounding, in percent. */
  round: number;
}

export interface ClipPathOpts {
  /** Preset used when there is nothing to parse. */
  preset?: string;
  /** "css" (default), "svg", or "both". */
  format?: string;
  /** Box width used by the SVG path export. */
  width?: number;
  /** Box height used by the SVG path export. */
  height?: number;
  [key: string]: unknown;
}

/* -------------------------------- numbers --------------------------------- */

export function trimNumber(value: number, places: number): string {
  let text = value.toFixed(places);
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text === "-0" ? "0" : text;
}

function pct(n: number): string {
  return `${trimNumber(n, 3)}%`;
}

/** Everything a shape needs, so a partial preset can be filled in. */
export const BASE_SHAPE: ClipShape = {
  kind: "polygon",
  points: [
    { x: 50, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ],
  fillRule: "nonzero",
  centerX: 50,
  centerY: 50,
  radius: 50,
  radiusX: 50,
  radiusY: 35,
  top: 10,
  right: 10,
  bottom: 10,
  left: 10,
  round: 12,
};

/* -------------------------------- presets ---------------------------------- */

function polygon(points: number[][]): ClipShape {
  return { ...BASE_SHAPE, kind: "polygon", points: points.map(([x, y]) => ({ x, y })) };
}

export interface ClipPreset {
  value: string;
  label: string;
  note: string;
  shape: ClipShape;
}

export const CLIP_PRESETS: readonly ClipPreset[] = [
  {
    value: "triangle",
    label: "Triangle",
    note: "Three points. The simplest shape that is not a rectangle.",
    shape: polygon([
      [50, 0],
      [100, 100],
      [0, 100],
    ]),
  },
  {
    value: "rhombus",
    label: "Rhombus",
    note: "A diamond on the four edge midpoints.",
    shape: polygon([
      [50, 0],
      [100, 50],
      [50, 100],
      [0, 50],
    ]),
  },
  {
    value: "parallelogram",
    label: "Parallelogram",
    note: "A slanted rectangle. Useful for a diagonal section divider.",
    shape: polygon([
      [25, 0],
      [100, 0],
      [75, 100],
      [0, 100],
    ]),
  },
  {
    value: "trapezoid",
    label: "Trapezoid",
    note: "A wide base narrowing toward the top.",
    shape: polygon([
      [20, 0],
      [80, 0],
      [100, 100],
      [0, 100],
    ]),
  },
  {
    value: "hexagon",
    label: "Hexagon",
    note: "Six points, flat top and bottom.",
    shape: polygon([
      [25, 0],
      [75, 0],
      [100, 50],
      [75, 100],
      [25, 100],
      [0, 50],
    ]),
  },
  {
    value: "star",
    label: "Star",
    note: "A five pointed star, ten points in all.",
    shape: polygon([
      [50, 0],
      [61, 35],
      [98, 35],
      [68, 57],
      [79, 91],
      [50, 70],
      [21, 91],
      [32, 57],
      [2, 35],
      [39, 35],
    ]),
  },
  {
    value: "arrow",
    label: "Arrow",
    note: "A right pointing arrow with a shaft and a head.",
    shape: polygon([
      [0, 20],
      [60, 20],
      [60, 0],
      [100, 50],
      [60, 100],
      [60, 80],
      [0, 80],
    ]),
  },
  {
    value: "chevron",
    label: "Chevron",
    note: "A banner end. Repeat it along a row for a breadcrumb trail.",
    shape: polygon([
      [75, 0],
      [100, 50],
      [75, 100],
      [0, 100],
      [25, 50],
      [0, 0],
    ]),
  },
  {
    value: "bubble",
    label: "Message bubble",
    note: "A rectangle with a tail on the bottom edge.",
    shape: polygon([
      [0, 0],
      [100, 0],
      [100, 75],
      [75, 75],
      [75, 100],
      [50, 75],
      [0, 75],
    ]),
  },
  {
    value: "blob",
    label: "Blob",
    note: "An irregular nine point polygon. Add points and drag them for something organic.",
    shape: polygon([
      [30, 0],
      [70, 2],
      [95, 25],
      [100, 60],
      [82, 90],
      [45, 100],
      [12, 88],
      [0, 50],
      [8, 18],
    ]),
  },
  {
    value: "circle",
    label: "Circle",
    note: "A circle centered on the box. Faster for the browser than an equivalent polygon.",
    shape: { ...BASE_SHAPE, kind: "circle", radius: 50, centerX: 50, centerY: 50 },
  },
  {
    value: "ellipse",
    label: "Ellipse",
    note: "Independent horizontal and vertical radii.",
    shape: { ...BASE_SHAPE, kind: "ellipse", radiusX: 50, radiusY: 35 },
  },
  {
    value: "rounded-inset",
    label: "Rounded inset",
    note: "A rectangle pulled in from all four edges, with rounded corners.",
    shape: { ...BASE_SHAPE, kind: "inset", top: 10, right: 10, bottom: 10, left: 10, round: 12 },
  },
];

export function presetShape(value: string): ClipShape {
  const preset = CLIP_PRESETS.find((p) => p.value === value);
  if (!preset) {
    throw new ToolError(
      "unknown-preset",
      `There is no clip path preset called "${value}".`,
      `Pick one of: ${CLIP_PRESETS.map((p) => p.value).join(", ")}.`,
    );
  }
  return { ...preset.shape, points: preset.shape.points.map((p) => ({ ...p })) };
}

/* ------------------------------- formatting -------------------------------- */

export function formatClipPath(shape: ClipShape): string {
  switch (shape.kind) {
    case "polygon": {
      if (shape.points.length < 3) {
        throw new ToolError(
          "too-few-points",
          `A polygon needs at least three points, and this one has ${shape.points.length}.`,
          "Add a point by clicking an edge in the editor.",
        );
      }
      const prefix = shape.fillRule === "evenodd" ? "evenodd, " : "";
      return `polygon(${prefix}${shape.points.map((p) => `${pct(p.x)} ${pct(p.y)}`).join(", ")})`;
    }
    case "circle":
      return `circle(${pct(shape.radius)} at ${pct(shape.centerX)} ${pct(shape.centerY)})`;
    case "ellipse":
      return `ellipse(${pct(shape.radiusX)} ${pct(shape.radiusY)} at ${pct(shape.centerX)} ${pct(shape.centerY)})`;
    default: {
      const edges = [shape.top, shape.right, shape.bottom, shape.left].map(pct).join(" ");
      return shape.round > 0 ? `inset(${edges} round ${pct(shape.round)})` : `inset(${edges})`;
    }
  }
}

/* -------------------------------- parsing ---------------------------------- */

function splitTop(text: string, separator: string): string[] {
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

const VERTICAL_KEYWORDS = new Set(["top", "bottom"]);
const HORIZONTAL_KEYWORDS = new Set(["left", "right"]);

/**
 * Puts a position back into x then y order.
 *
 * CSS lets the two keywords appear in either order as long as they name
 * different axes, so "at top right" and "at right top" are the same corner.
 * Reading them positionally would put "at top right" in the bottom left,
 * which is wrong in a way that produces no error at all.
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

function readPercent(token: string, context: string): number {
  const match = /^(-?\d*\.?\d+)%$/.exec(token.trim());
  if (match) return Number(match[1]);
  const keyword: Record<string, number> = { left: 0, top: 0, center: 50, right: 100, bottom: 100 };
  const key = token.trim().toLowerCase();
  if (key in keyword) return keyword[key];
  if (/^-?\d*\.?\d+[a-z]+$/i.test(token.trim())) {
    throw new ToolError(
      "unsupported-unit",
      `"${token}" in ${context} uses an absolute length, and this editor works in percentages.`,
      "Percentages keep the shape correct at any size. Convert the value against your element's own width or height first.",
    );
  }
  throw new ToolError(
    "bad-value",
    `"${token}" in ${context} is not a percentage.`,
    "Write coordinates as percentages, for example 50% 0%.",
  );
}

/** Reads a clip-path value, with or without the property name. */
export function parseClipPath(css: string): ClipShape {
  const raw = (css ?? "").trim();
  if (!raw) {
    throw new ToolError(
      "empty-input",
      "There is no clip-path value to read.",
      "Paste a value such as polygon(50% 0%, 100% 100%, 0% 100%), or pick a preset.",
    );
  }
  const text = raw
    .replace(/^(-webkit-)?clip-path\s*:\s*/i, "")
    .replace(/;\s*$/, "")
    .trim();

  if (/^(none|url\(|path\(|shape\()/i.test(text)) {
    throw new ToolError(
      "unsupported-shape",
      `"${text.slice(0, 40)}" is not a basic shape this editor can take apart.`,
      "The editor works on polygon(), circle(), ellipse(), and inset(). A path() or an SVG reference has to be edited where it was drawn.",
    );
  }

  const head = /^(polygon|circle|ellipse|inset)\s*\(([\s\S]*)\)$/i.exec(text);
  if (!head) {
    throw new ToolError(
      "unsupported-shape",
      `"${text.slice(0, 40)}" is not a CSS basic shape.`,
      "Paste a value such as polygon(50% 0%, 100% 100%, 0% 100%) or circle(50% at 50% 50%).",
    );
  }

  const kind = head[1].toLowerCase() as ClipShapeKind;
  const body = head[2].trim();
  const shape: ClipShape = { ...BASE_SHAPE, kind, points: [] };

  if (kind === "polygon") {
    let parts = splitTop(body, ",");
    if (parts.length && /^(nonzero|evenodd)$/i.test(parts[0])) {
      shape.fillRule = parts[0].toLowerCase() as "nonzero" | "evenodd";
      parts = parts.slice(1);
    }
    shape.points = parts.map((part) => {
      const words = part.split(/\s+/).filter(Boolean);
      if (words.length !== 2) {
        throw new ToolError(
          "bad-value",
          `"${part}" is not an x and y pair.`,
          "Each polygon point is two percentages, for example 50% 0%.",
        );
      }
      return { x: readPercent(words[0], "the polygon"), y: readPercent(words[1], "the polygon") };
    });
    if (shape.points.length < 3) {
      throw new ToolError(
        "too-few-points",
        `A polygon needs at least three points, and this one has ${shape.points.length}.`,
        "Add more points, for example polygon(50% 0%, 100% 100%, 0% 100%).",
      );
    }
    return shape;
  }

  const [sizePart, positionPart] = splitAtKeyword(body);

  if (positionPart !== undefined) {
    const [xToken, yToken] = orderPositionTokens(positionPart.split(/\s+/).filter(Boolean));
    shape.centerX = readPercent(xToken, `the ${kind} center`);
    shape.centerY = readPercent(yToken, `the ${kind} center`);
  }

  if (kind === "circle") {
    const words = sizePart.split(/\s+/).filter(Boolean);
    shape.radius = words.length ? readPercent(words[0], "the circle radius") : 50;
    return shape;
  }
  if (kind === "ellipse") {
    const words = sizePart.split(/\s+/).filter(Boolean);
    shape.radiusX = words.length > 0 ? readPercent(words[0], "the ellipse radius") : 50;
    shape.radiusY = words.length > 1 ? readPercent(words[1], "the ellipse radius") : shape.radiusX;
    return shape;
  }

  // inset(): one to four edge values, then an optional round clause.
  const roundSplit = sizePart.split(/\s+round\s+/i);
  const edges = roundSplit[0].split(/\s+/).filter(Boolean);
  if (!edges.length) {
    throw new ToolError(
      "bad-value",
      "inset() needs at least one edge value.",
      "Write it as inset(10%) or inset(10% 20% 30% 40%).",
    );
  }
  const values = edges.map((e) => readPercent(e, "the inset"));
  shape.top = values[0];
  shape.right = values.length > 1 ? values[1] : values[0];
  shape.bottom = values.length > 2 ? values[2] : values[0];
  shape.left = values.length > 3 ? values[3] : shape.right;
  shape.round = roundSplit[1]
    ? readPercent(roundSplit[1].split(/\s+/)[0], "the inset corner radius")
    : 0;
  return shape;
}

/** Splits "50% at 30% 40%" into its size and its position halves. */
function splitAtKeyword(body: string): [string, string | undefined] {
  const match = /\bat\b/i.exec(body);
  if (!match) return [body.trim(), undefined];
  return [body.slice(0, match.index).trim(), body.slice(match.index + 2).trim()];
}

/* ------------------------------- SVG export -------------------------------- */

/**
 * The same shape as an SVG path, for a box of the given size.
 *
 * A circle's percentage radius resolves against the box diagonal divided by
 * the square root of two, not against the width, which is the rule most people
 * get wrong when they convert a clip-path by hand.
 */
export function toSvgPath(shape: ClipShape, width = 100, height = 100): string {
  const round3 = (n: number): string => trimNumber(n, 3);
  const px = (x: number): number => (x / 100) * width;
  const py = (y: number): number => (y / 100) * height;

  if (shape.kind === "polygon") {
    if (shape.points.length < 3) {
      throw new ToolError(
        "too-few-points",
        "A polygon needs at least three points before it can become a path.",
        "Add a point in the editor first.",
      );
    }
    const [first, ...rest] = shape.points;
    return [
      `M ${round3(px(first.x))} ${round3(py(first.y))}`,
      ...rest.map((p) => `L ${round3(px(p.x))} ${round3(py(p.y))}`),
      "Z",
    ].join(" ");
  }

  if (shape.kind === "circle") {
    const reference = Math.sqrt(width * width + height * height) / Math.SQRT2;
    const r = (shape.radius / 100) * reference;
    const cx = px(shape.centerX);
    const cy = py(shape.centerY);
    return `M ${round3(cx - r)} ${round3(cy)} a ${round3(r)} ${round3(r)} 0 1 0 ${round3(r * 2)} 0 a ${round3(r)} ${round3(r)} 0 1 0 ${round3(-r * 2)} 0 Z`;
  }

  if (shape.kind === "ellipse") {
    const rx = px(shape.radiusX);
    const ry = py(shape.radiusY);
    const cx = px(shape.centerX);
    const cy = py(shape.centerY);
    return `M ${round3(cx - rx)} ${round3(cy)} a ${round3(rx)} ${round3(ry)} 0 1 0 ${round3(rx * 2)} 0 a ${round3(rx)} ${round3(ry)} 0 1 0 ${round3(-rx * 2)} 0 Z`;
  }

  const x0 = px(shape.left);
  const y0 = py(shape.top);
  const x1 = width - px(shape.right);
  const y1 = height - py(shape.bottom);
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const r = Math.min((shape.round / 100) * Math.min(width, height), w / 2, h / 2);
  if (r <= 0) {
    return `M ${round3(x0)} ${round3(y0)} H ${round3(x1)} V ${round3(y1)} H ${round3(x0)} Z`;
  }
  return [
    `M ${round3(x0 + r)} ${round3(y0)}`,
    `H ${round3(x1 - r)}`,
    `A ${round3(r)} ${round3(r)} 0 0 1 ${round3(x1)} ${round3(y0 + r)}`,
    `V ${round3(y1 - r)}`,
    `A ${round3(r)} ${round3(r)} 0 0 1 ${round3(x1 - r)} ${round3(y1)}`,
    `H ${round3(x0 + r)}`,
    `A ${round3(r)} ${round3(r)} 0 0 1 ${round3(x0)} ${round3(y1 - r)}`,
    `V ${round3(y0 + r)}`,
    `A ${round3(r)} ${round3(r)} 0 0 1 ${round3(x0 + r)} ${round3(y0)}`,
    "Z",
  ].join(" ");
}

/* -------------------------------- editing ---------------------------------- */

/** Inserts a point on the edge nearest the given coordinates. */
export function insertPointNear(shape: ClipShape, x: number, y: number): ClipShape {
  if (shape.kind !== "polygon" || shape.points.length < 2) return shape;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < shape.points.length; i += 1) {
    const a = shape.points[i];
    const b = shape.points[(i + 1) % shape.points.length];
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const distance = (midX - x) ** 2 + (midY - y) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i + 1;
    }
  }
  const points = shape.points.slice();
  points.splice(bestIndex, 0, { x, y });
  return { ...shape, points };
}

/* ---------------------------------- run ------------------------------------ */

function readFormat(value: unknown): "css" | "svg" | "both" {
  if (value === undefined || value === null || value === "") return "css";
  const key = String(value).trim().toLowerCase();
  if (key === "css" || key === "svg" || key === "both") return key;
  throw new ToolError(
    "bad-option",
    `Unknown output format "${String(value)}".`,
    "Pick css, svg, or both.",
  );
}

function readSize(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 10000) {
    throw new ToolError(
      "bad-option",
      `${label} must be a number between 1 and 10000, not ${JSON.stringify(value)}.`,
      `Try ${fallback}.`,
    );
  }
  return n;
}

export function run(input: string, opts: ClipPathOpts = {}): string {
  const format = readFormat(opts?.format);
  const width = readSize(opts?.width, 200, "Width");
  const height = readSize(opts?.height, 200, "Height");

  const text = typeof input === "string" ? input.trim() : "";
  const shape = text ? parseClipPath(text) : presetShape(String(opts?.preset ?? "triangle"));

  const css = `clip-path: ${formatClipPath(shape)};`;
  if (format === "css") return css;

  const path = toSvgPath(shape, width, height);
  const svg = [
    `<svg viewBox="0 0 ${trimNumber(width, 3)} ${trimNumber(height, 3)}" xmlns="http://www.w3.org/2000/svg">`,
    `  <path d="${path}" fill="currentColor"${shape.kind === "polygon" && shape.fillRule === "evenodd" ? ' fill-rule="evenodd"' : ""} />`,
    "</svg>",
  ].join("\n");

  if (format === "svg") return svg;
  return `${css}\n\n/* The same shape as an SVG path, for a ${trimNumber(width, 3)} by ${trimNumber(height, 3)} box */\n${svg}`;
}

export default { run } satisfies ToolLogic<string, string, ClipPathOpts>;

import { ToolError, type ToolLogic } from "../types";

/**
 * Bed mesh visualizer.
 *
 * Takes the mesh text a 3D printer prints (Klipper BED_MESH_OUTPUT, a saved
 * `[bed_mesh default]` block from printer.cfg, Marlin G29 T / M420 V grids, a
 * plain numeric grid, or JSON) and turns it into statistics plus two
 * deterministic SVG renders.
 *
 * Row order convention: `rows[0]` is the row nearest the front of the bed (the
 * lowest Y), and column 0 is the left of the bed (the lowest X). Klipper prints
 * meshes in that order already; Marlin's UBL map prints the highest Y first, so
 * a descending row label column triggers a flip.
 */

/* ------------------------------------------------------------------ types */

export type MeshSource =
  | "klipper-config"
  | "klipper-console"
  | "marlin-grid"
  | "json"
  | "plain-grid";

export interface Mesh {
  /** rows[y][x]. Row 0 is the front of the bed, column 0 the left. */
  rows: number[][];
  xCount: number;
  yCount: number;
  /** Bed coordinates of the mesh area, when the input carried them. */
  minX?: number;
  maxX?: number;
  minY?: number;
  maxY?: number;
  source: MeshSource;
}

/** Least squares plane in normalized mesh coordinates: z = a*u + b*v + c. */
export interface PlaneFit {
  /** Millimeters of rise across the whole X span. */
  a: number;
  /** Millimeters of rise across the whole Y span. */
  b: number;
  /** Height of the fitted plane at the front left corner. */
  c: number;
}

export interface MeshCorners {
  frontLeft: number;
  frontRight: number;
  backLeft: number;
  backRight: number;
}

export type MeshGrade = "excellent" | "good" | "acceptable" | "needs-tramming";

export interface MeshPoint {
  xIndex: number;
  yIndex: number;
  value: number;
  /** Distance from the mesh average. */
  deviation: number;
  xMm?: number;
  yMm?: number;
}

export interface MeshStats {
  min: number;
  max: number;
  /** max - min, the number people call "total deviation". */
  range: number;
  mean: number;
  /** Population standard deviation (divided by N, not N-1). */
  stdDev: number;
  corners: MeshCorners;
  /** Bilinear sample at the middle of the mesh, so even grids need no case. */
  center: number;
  plane: PlaneFit;
  /** Millimeters of tilt across the full X span. */
  tiltX: number;
  /** Millimeters of tilt across the full Y span. */
  tiltY: number;
  residualMin: number;
  residualMax: number;
  /** Flatness left after the tilt plane is subtracted. */
  residualRange: number;
  /** Fraction of the range that the tilt explains, 0 to 1. */
  tiltShare: number;
  worst: MeshPoint;
  lowest: MeshPoint;
  highest: MeshPoint;
  grade: MeshGrade;
  verdict: string;
  advice: string;
}

export interface BedMeshOpts {
  /** Add the rendered SVG rows to the output. Default false. */
  svg?: boolean;
  /** Where the neutral color sits: "zero" (default) or "mean". */
  centerOn?: string;
  /** Height exaggeration for the isometric render, 1 to 50. Default 10. */
  zScale?: number;
  [key: string]: unknown;
}

/* ------------------------------------------------------------- formatting */

/** toFixed that never prints a negative zero. */
export function fixed(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return (0).toFixed(digits);
  const s = n.toFixed(digits);
  return /^-0(?:\.0*)?$/.test(s) ? s.slice(1) : s;
}

function mm(n: number, digits = 4): string {
  return `${fixed(n, digits)} mm`;
}

function signedMm(n: number, digits = 4): string {
  const s = fixed(n, digits);
  if (/^0(?:\.0*)?$/.test(s)) return `${s} mm`;
  return `${s.startsWith("-") ? s : `+${s}`} mm`;
}

/** Compact SVG coordinate: two decimals, and never the string "-0". */
function r2(n: number): string {
  const v = Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  return String(v === 0 ? 0 : v);
}

function pct(fraction: number): number {
  return Math.round(Math.max(0, Math.min(1, fraction)) * 100);
}

function toNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return Math.min(max, Math.max(min, toNumber(value, fallback)));
}

/* ---------------------------------------------------------------- parsing */

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

const SOURCE_LABELS: Record<MeshSource, string> = {
  "klipper-config": "Klipper printer.cfg bed_mesh section",
  "klipper-console": "Klipper BED_MESH_OUTPUT console text",
  "marlin-grid": "Marlin G29 or M420 V mesh report",
  json: "JSON array of arrays",
  "plain-grid": "Plain numeric grid",
};

/** Strips terminal and firmware chatter: "Recv:", "//", "!!", "echo:", ">". */
function stripPrefix(line: string): string {
  let s = line;
  for (;;) {
    const next = s.replace(/^\s*(?:Recv:|Send:|echo:|\/\/|!!|>+)\s*/i, "");
    if (next === s) return s.trim();
    s = next;
  }
}

function tokenize(line: string): string[] {
  return line.split(/[\s,|]+/).filter(Boolean);
}

function allNumeric(tokens: string[]): boolean {
  return tokens.length > 0 && tokens.every((t) => NUMBER_RE.test(t));
}

/**
 * True for a column header row like "0 1 2 3": bare integers counting up by
 * one. Real mesh values are decimals, so this never eats data.
 */
function isIndexHeader(tokens: string[]): boolean {
  if (tokens.length < 2) return false;
  if (!tokens.every((t) => /^\d+$/.test(t))) return false;
  const first = Number(tokens[0]);
  return tokens.every((t, i) => Number(t) === first + i);
}

interface RawRow {
  tokens: string[];
  /** 1-based line number in the pasted input, for error messages. */
  lineNo: number;
}

function isGridLine(tokens: string[]): boolean {
  return tokens.length >= 2 && allNumeric(tokens) && !isIndexHeader(tokens);
}

/**
 * Drops a leading row label column when every row starts with a bare integer
 * and every other cell is signed or has a decimal point. Reports whether the
 * labels counted down, which means the input printed the back of the bed first.
 */
function stripRowLabels(rows: RawRow[]): { rows: RawRow[]; descending: boolean } {
  if (rows.length < 2) return { rows, descending: false };
  if (!rows.every((r) => r.tokens.length >= 3)) return { rows, descending: false };
  if (!rows.every((r) => /^\d+$/.test(r.tokens[0]))) return { rows, descending: false };

  const looksLikeValue = (t: string): boolean => t.includes(".") || /^[+-]/.test(t);
  if (!rows.every((r) => r.tokens.slice(1).every(looksLikeValue)))
    return { rows, descending: false };

  const labels = rows.map((r) => Number(r.tokens[0]));
  if (new Set(labels).size !== labels.length) return { rows, descending: false };

  const descending = labels.every((n, i) => i === 0 || n < labels[i - 1]);
  return { rows: rows.map((r) => ({ ...r, tokens: r.tokens.slice(1) })), descending };
}

function checkRectangular(rows: RawRow[]): void {
  const expected = rows[0].tokens.length;
  for (let i = 1; i < rows.length; i++) {
    const got = rows[i].tokens.length;
    if (got === expected) continue;
    throw new ToolError(
      "ragged",
      `Mesh row ${i + 1} (input line ${rows[i].lineNo}) has ${got} ${got === 1 ? "value" : "values"}, but row 1 has ${expected}.`,
      "Every row of a bed mesh has the same number of probe points. A row that is short or long is usually a wrapped console line or a value lost in the copy, so paste the block again.",
    );
  }
}

function toNumbers(rows: RawRow[]): number[][] {
  return rows.map((r) => r.tokens.map((t) => Number(t)));
}

function detectTextSource(text: string): MeshSource {
  if (
    /bilinear leveling grid|mesh z values|bed topography|unified bed leveling|subdivided with catmull|\bg29\b|\bm420\b/i.test(
      text,
    )
  )
    return "marlin-grid";
  if (/mesh leveling|bed_?mesh|probed z positions/i.test(text)) return "klipper-console";
  return "plain-grid";
}

function parseJsonMesh(text: string): Mesh | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[")) return null;

  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(data) || data.length === 0) return null;
  if (!data.every((row) => Array.isArray(row))) return null;

  const raw = data as unknown[][];
  const rows: RawRow[] = [];
  for (let i = 0; i < raw.length; i++) {
    const cells = raw[i];
    if (cells.length === 0) return null;
    if (!cells.every((c) => typeof c === "number" && Number.isFinite(c))) return null;
    rows.push({ tokens: cells.map((c) => String(c)), lineNo: i + 1 });
  }

  const expected = rows[0].tokens.length;
  for (let i = 1; i < rows.length; i++) {
    const got = rows[i].tokens.length;
    if (got === expected) continue;
    throw new ToolError(
      "ragged",
      `Mesh row ${i + 1} (JSON array index ${i}) has ${got} ${got === 1 ? "value" : "values"}, but row 1 has ${expected}.`,
      "Every inner array must be the same length, because a bed mesh is a rectangular grid of probe points.",
    );
  }

  const numbers = raw.map((row) => row.map((c) => c as number));
  return {
    rows: numbers,
    xCount: numbers[0].length,
    yCount: numbers.length,
    source: "json",
  };
}

function pickNumber(section: string, key: string): number | undefined {
  const m = new RegExp(`^\\s*${key}\\s*[:=]\\s*(-?[0-9.]+)`, "im").exec(section);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** Reads a saved `[bed_mesh default]` block out of a printer.cfg paste. */
function parseKlipperConfigMesh(text: string): Mesh | null {
  const lines = text.split(/\r?\n/);

  for (let start = 0; start < lines.length; start++) {
    if (!/^\s*\[bed_mesh\b/i.test(lines[start])) continue;

    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i])) {
        end = i;
        break;
      }
    }

    const body = lines.slice(start + 1, end);
    const pointsAt = body.findIndex((l) => /^\s*points\s*[:=]/i.test(l));
    if (pointsAt === -1) continue;

    const rows: RawRow[] = [];
    const inline = body[pointsAt]
      .replace(/^\s*points\s*[:=]\s*/i, "")
      .replace(/#.*$/, "")
      .trim();
    if (inline) {
      const tokens = tokenize(inline);
      if (allNumeric(tokens)) rows.push({ tokens, lineNo: start + pointsAt + 2 });
    }

    for (let i = pointsAt + 1; i < body.length; i++) {
      if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*[:=]/.test(body[i])) break;
      const line = body[i].replace(/#.*$/, "").trim();
      if (!line) {
        if (rows.length) break;
        continue;
      }
      const tokens = tokenize(line);
      if (!allNumeric(tokens)) break;
      rows.push({ tokens, lineNo: start + i + 2 });
    }

    if (rows.length === 0) continue;
    checkRectangular(rows);

    const section = body.slice(0, end - start - 1).join("\n");
    return {
      rows: toNumbers(rows),
      xCount: rows[0].tokens.length,
      yCount: rows.length,
      minX: pickNumber(section, "min_x"),
      maxX: pickNumber(section, "max_x"),
      minY: pickNumber(section, "min_y"),
      maxY: pickNumber(section, "max_y"),
      source: "klipper-config",
    };
  }

  return null;
}

/** Finds the biggest run of consecutive numeric lines anywhere in the paste. */
function parseTextGrid(text: string): Mesh | null {
  const lines = text.split(/\r?\n/);
  const blocks: RawRow[][] = [];
  let current: RawRow[] = [];

  const flush = (): void => {
    if (current.length) blocks.push(current);
    current = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const clean = stripPrefix(lines[i]).replace(/#.*$/, "").trim();
    if (!clean) {
      flush();
      continue;
    }
    const tokens = tokenize(clean);
    if (isGridLine(tokens)) current.push({ tokens, lineNo: i + 1 });
    else flush();
  }
  flush();

  if (blocks.length === 0) return null;

  let best = blocks[0];
  for (const block of blocks) if (block.length > best.length) best = block;

  const { rows, descending } = stripRowLabels(best);
  checkRectangular(rows);

  const numbers = toNumbers(rows);
  if (descending) numbers.reverse();

  return {
    rows: numbers,
    xCount: numbers[0].length,
    yCount: numbers.length,
    source: detectTextSource(text),
  };
}

/** Parses any supported mesh text into the canonical grid. */
export function parseMesh(input: string): Mesh {
  const text = typeof input === "string" ? input : String(input ?? "");
  if (!text.trim())
    throw new ToolError(
      "empty-input",
      "Paste a bed mesh to visualize.",
      "In Klipper run BED_MESH_CALIBRATE then BED_MESH_OUTPUT and copy the console text, or in Marlin run G29 followed by M420 V and copy the grid. A saved [bed_mesh default] block or a plain grid of numbers works too.",
    );

  const mesh = parseJsonMesh(text) ?? parseKlipperConfigMesh(text) ?? parseTextGrid(text);
  if (!mesh)
    throw new ToolError(
      "unparseable",
      "No grid of numbers was found in that text.",
      "Paste the rows of mesh values themselves, not just the summary line. Each row should be a line of numbers separated by spaces or commas, and every row should have the same number of values.",
    );

  if (mesh.yCount < 2 || mesh.xCount < 2)
    throw new ToolError(
      "too-small",
      `That is a ${mesh.xCount} by ${mesh.yCount} mesh, which is too small to plot.`,
      "A surface needs at least 2 by 2 probe points. Re-probe with a larger grid, for example BED_MESH_CALIBRATE with probe_count: 5,5 in Klipper or GRID_MAX_POINTS set to 5 in Marlin.",
    );

  return mesh;
}

/* ------------------------------------------------------------- geometry */

function extent(values: number[]): { min: number; max: number } {
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/** Bilinear sample of the mesh at normalized position (u, v), both 0 to 1. */
export function sampleMesh(mesh: Mesh, u: number, v: number): number {
  const fx = Math.max(0, Math.min(1, u)) * (mesh.xCount - 1);
  const fy = Math.max(0, Math.min(1, v)) * (mesh.yCount - 1);
  const x0 = Math.min(Math.floor(fx), mesh.xCount - 2);
  const y0 = Math.min(Math.floor(fy), mesh.yCount - 2);
  const tx = fx - x0;
  const ty = fy - y0;

  const z00 = mesh.rows[y0][x0];
  const z10 = mesh.rows[y0][x0 + 1];
  const z01 = mesh.rows[y0 + 1][x0];
  const z11 = mesh.rows[y0 + 1][x0 + 1];

  return z00 * (1 - tx) * (1 - ty) + z10 * tx * (1 - ty) + z01 * (1 - tx) * ty + z11 * tx * ty;
}

/**
 * Bilinear upsampling. `factor` is how many cells each original cell becomes
 * per axis, clamped to 1 through 8. Original probe points are preserved.
 */
export function interpolateMesh(mesh: Mesh, factor: number): Mesh {
  const f = Math.max(1, Math.min(8, Math.floor(toNumber(factor, 1))));
  if (f === 1) return { ...mesh, rows: mesh.rows.map((row) => row.slice()) };

  const xCount = (mesh.xCount - 1) * f + 1;
  const yCount = (mesh.yCount - 1) * f + 1;
  const rows: number[][] = [];

  for (let j = 0; j < yCount; j++) {
    const v = j / (yCount - 1);
    const row: number[] = [];
    for (let i = 0; i < xCount; i++) row.push(sampleMesh(mesh, i / (xCount - 1), v));
    rows.push(row);
  }

  return { ...mesh, rows, xCount, yCount };
}

/**
 * Least squares plane through the mesh in normalized coordinates.
 *
 * On a complete rectangular grid the u and v cross covariance is exactly zero,
 * so the two slopes decouple and no matrix solve is needed. `a` and `b` come
 * out directly as millimeters of rise across the whole X and Y spans.
 */
export function fitPlane(mesh: Mesh): PlaneFit {
  const { xCount, yCount, rows } = mesh;
  const n = xCount * yCount;

  let sumZ = 0;
  for (const row of rows) for (const z of row) sumZ += z;
  const meanZ = sumZ / n;

  const uBar = 0.5;
  const vBar = 0.5;
  let suz = 0;
  let svz = 0;
  let suu = 0;
  let svv = 0;

  for (let j = 0; j < yCount; j++) {
    const v = j / (yCount - 1) - vBar;
    for (let i = 0; i < xCount; i++) {
      const u = i / (xCount - 1) - uBar;
      const dz = rows[j][i] - meanZ;
      suz += u * dz;
      svz += v * dz;
      suu += u * u;
      svv += v * v;
    }
  }

  const a = suu === 0 ? 0 : suz / suu;
  const b = svv === 0 ? 0 : svz / svv;
  return { a, b, c: meanZ - a * uBar - b * vBar };
}

function gradeOf(range: number): MeshGrade {
  const eps = 1e-9;
  if (range < 0.1) return "excellent";
  if (range <= 0.2 + eps) return "good";
  if (range <= 0.35 + eps) return "acceptable";
  return "needs-tramming";
}

function verdictText(grade: MeshGrade, range: number): string {
  const total = mm(range);
  switch (grade) {
    case "excellent":
      return `Excellent. ${total} of total deviation is flatter than most printers ever get, and mesh compensation barely has to do anything.`;
    case "good":
      return `Good. ${total} of total deviation is normal for a well trammed printer, and mesh compensation hides it without any help from you.`;
    case "acceptable":
      return `Acceptable. ${total} of total deviation still prints fine with mesh compensation on, but first layers get more consistent if you close some of that gap mechanically.`;
    default:
      return `Needs tramming. ${total} of total deviation is more than mesh compensation should have to hide, and it will show up as uneven first layers and squish that changes across the plate.`;
  }
}

function adviceText(stats: Omit<MeshStats, "advice">): string {
  const { range, residualRange, tiltShare, grade, corners } = stats;

  if (range < 0.02)
    return "The whole bed sits inside 0.02 mm, which is at or below what most probes can even resolve. There is nothing here worth adjusting.";

  const entries: { name: string; value: number }[] = [
    { name: "front left", value: corners.frontLeft },
    { name: "front right", value: corners.frontRight },
    { name: "back left", value: corners.backLeft },
    { name: "back right", value: corners.backRight },
  ];
  let low = entries[0];
  let high = entries[0];
  for (const e of entries) {
    if (e.value < low.value) low = e;
    if (e.value > high.value) high = e;
  }
  const cornerLine = `The ${low.name} corner is the lowest at ${signedMm(low.value)} and the ${high.name} corner is the highest at ${signedMm(high.value)}.`;

  const share = pct(tiltShare);

  if (tiltShare >= 0.6)
    return `About ${share}% of the deviation is a flat tilt, so this is a tramming problem rather than a warped plate. ${cornerLine} Turn the bed screws to bring the low side up, re-probe, and repeat. Once the tilt is gone the surface is flat to ${mm(residualRange)}, so that is the best this bed can do mechanically.`;

  if (tiltShare <= 0.35) {
    const closing =
      grade === "excellent"
        ? "At this size it is not worth chasing, so leave mesh compensation on and print."
        : "Bed screws cannot take a bow out of a plate. Keep mesh compensation on, check the plate is seated flat and the magnets are clean, and if you need it flatter the fix is a different plate rather than more levelling.";
    return `Only about ${share}% of the deviation is a flat tilt, so the plate itself is bowed or warped rather than sitting crooked. ${mm(residualRange)} is left after the tilt is removed. ${closing}`;
  }

  return `About ${share}% of the deviation is a flat tilt and the rest is shape in the plate. ${cornerLine} Tramming the screws should take out roughly ${mm(range - residualRange)}, which leaves ${mm(residualRange)} of warp for mesh compensation to handle.`;
}

function xMmOf(mesh: Mesh, xIndex: number): number | undefined {
  if (mesh.minX === undefined || mesh.maxX === undefined) return undefined;
  if (mesh.xCount < 2) return mesh.minX;
  return mesh.minX + ((mesh.maxX - mesh.minX) * xIndex) / (mesh.xCount - 1);
}

function yMmOf(mesh: Mesh, yIndex: number): number | undefined {
  if (mesh.minY === undefined || mesh.maxY === undefined) return undefined;
  if (mesh.yCount < 2) return mesh.minY;
  return mesh.minY + ((mesh.maxY - mesh.minY) * yIndex) / (mesh.yCount - 1);
}

function pointAt(mesh: Mesh, xIndex: number, yIndex: number, mean: number): MeshPoint {
  const value = mesh.rows[yIndex][xIndex];
  return {
    xIndex,
    yIndex,
    value,
    deviation: value - mean,
    xMm: xMmOf(mesh, xIndex),
    yMm: yMmOf(mesh, yIndex),
  };
}

/** Every number the page reports, derived from one parsed mesh. */
export function analyzeMesh(mesh: Mesh): MeshStats {
  const values = mesh.rows.flat();
  const n = values.length;
  const { min, max } = extent(values);
  const range = max - min;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const variance = values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / n;
  const stdDev = Math.sqrt(variance);

  const plane = fitPlane(mesh);
  const residuals: number[] = [];
  for (let j = 0; j < mesh.yCount; j++) {
    const v = j / (mesh.yCount - 1);
    for (let i = 0; i < mesh.xCount; i++) {
      const u = i / (mesh.xCount - 1);
      residuals.push(mesh.rows[j][i] - (plane.a * u + plane.b * v + plane.c));
    }
  }
  const residualExtent = extent(residuals);
  const residualRange = residualExtent.max - residualExtent.min;
  const tiltShare = range > 0 ? Math.max(0, Math.min(1, (range - residualRange) / range)) : 0;

  let worstX = 0;
  let worstY = 0;
  let lowX = 0;
  let lowY = 0;
  let highX = 0;
  let highY = 0;
  for (let j = 0; j < mesh.yCount; j++) {
    for (let i = 0; i < mesh.xCount; i++) {
      const z = mesh.rows[j][i];
      if (Math.abs(z - mean) > Math.abs(mesh.rows[worstY][worstX] - mean)) {
        worstX = i;
        worstY = j;
      }
      if (z < mesh.rows[lowY][lowX]) {
        lowX = i;
        lowY = j;
      }
      if (z > mesh.rows[highY][highX]) {
        highX = i;
        highY = j;
      }
    }
  }

  const corners: MeshCorners = {
    frontLeft: mesh.rows[0][0],
    frontRight: mesh.rows[0][mesh.xCount - 1],
    backLeft: mesh.rows[mesh.yCount - 1][0],
    backRight: mesh.rows[mesh.yCount - 1][mesh.xCount - 1],
  };

  const grade = gradeOf(range);

  const base: Omit<MeshStats, "advice"> = {
    min,
    max,
    range,
    mean,
    stdDev,
    corners,
    center: sampleMesh(mesh, 0.5, 0.5),
    plane,
    tiltX: plane.a,
    tiltY: plane.b,
    residualMin: residualExtent.min,
    residualMax: residualExtent.max,
    residualRange,
    tiltShare,
    worst: pointAt(mesh, worstX, worstY, mean),
    lowest: pointAt(mesh, lowX, lowY, mean),
    highest: pointAt(mesh, highX, highY, mean),
    grade,
    verdict: verdictText(grade, range),
  };

  return { ...base, advice: adviceText(base) };
}

/* --------------------------------------------------------------- renders */

export type PaletteCenter = "zero" | "mean";

export interface HeatmapOptions {
  width?: number;
  height?: number;
  /** Where the neutral color of the ramp sits. Default "zero". */
  palette?: PaletteCenter;
}

export interface IsometricOptions {
  width?: number;
  height?: number;
  /** Height exaggeration, 1 to 50. Default 10. */
  zScale?: number;
  /** Where the neutral color of the ramp sits. Default "zero". */
  palette?: PaletteCenter;
}

const RAMP_LOW: readonly number[] = [37, 99, 235];
const RAMP_MID: readonly number[] = [248, 250, 252];
const RAMP_HIGH: readonly number[] = [220, 38, 38];
const AXIS_COLOR = "#64748b";
const LINE_COLOR = "#475569";

function rgb(parts: readonly number[]): string {
  return `rgb(${parts[0]},${parts[1]},${parts[2]})`;
}

/** Diverging blue to white to red for t in -1 to 1. Non-finite t reads as 0. */
export function divergingColor(t: number): string {
  const k = Math.max(-1, Math.min(1, Number.isFinite(t) ? t : 0));
  const end = k < 0 ? RAMP_LOW : RAMP_HIGH;
  const m = Math.abs(k);
  return rgb(RAMP_MID.map((mid, i) => Math.round(mid + (end[i] - mid) * m)));
}

interface Ramp {
  center: number;
  spread: number;
  /** Maps a height to -1..1 for the color ramp. */
  t(z: number): number;
}

function makeRamp(values: number[], palette: PaletteCenter): Ramp {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const center = palette === "mean" ? mean : 0;
  const { min, max } = extent(values);
  const spread = Math.max(Math.abs(max - center), Math.abs(min - center));
  return {
    center,
    spread,
    t: (z: number) => (spread > 0 ? (z - center) / spread : 0),
  };
}

function svgOpen(width: number, height: number, title: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">`,
    `<title>${title}</title>`,
  ].join("");
}

/**
 * Flat grid of cells colored by height. Deterministic: same mesh and options
 * always produce byte-identical markup.
 */
export function renderHeatmapSvg(mesh: Mesh, options: HeatmapOptions = {}): string {
  const width = Math.max(240, Math.round(clampNumber(options.width, 240, 4000, 560)));
  const height = Math.max(200, Math.round(clampNumber(options.height, 200, 4000, 420)));
  const palette: PaletteCenter = options.palette === "mean" ? "mean" : "zero";

  const values = mesh.rows.flat();
  const { min, max } = extent(values);
  const ramp = makeRamp(values, palette);

  const padLeft = 58;
  const padRight = 22;
  const padTop = 34;
  const padBottom = 84;
  const plotW = Math.max(40, width - padLeft - padRight);
  const plotH = Math.max(40, height - padTop - padBottom);
  const cellW = plotW / mesh.xCount;
  const cellH = plotH / mesh.yCount;
  const labelCells = mesh.xCount <= 9 && mesh.yCount <= 9;
  const fontSize = Math.max(7, Math.min(11, Math.round(Math.min(cellW / 4.2, cellH / 2.6))));

  const parts: string[] = [
    svgOpen(width, height, "Bed mesh heat map"),
    "<defs>",
    '<linearGradient id="bedMeshRamp" x1="0" y1="0" x2="1" y2="0">',
    `<stop offset="0" stop-color="${rgb(RAMP_LOW)}"/>`,
    `<stop offset="0.5" stop-color="${rgb(RAMP_MID)}"/>`,
    `<stop offset="1" stop-color="${rgb(RAMP_HIGH)}"/>`,
    "</linearGradient>",
    "</defs>",
  ];

  for (let j = 0; j < mesh.yCount; j++) {
    for (let i = 0; i < mesh.xCount; i++) {
      const z = mesh.rows[j][i];
      const t = ramp.t(z);
      const x = padLeft + i * cellW;
      const y = padTop + (mesh.yCount - 1 - j) * cellH;
      parts.push(
        `<rect class="cell" x="${r2(x)}" y="${r2(y)}" width="${r2(cellW)}" height="${r2(cellH)}" fill="${divergingColor(t)}" stroke="#ffffff" stroke-width="1"/>`,
      );
      if (labelCells)
        parts.push(
          `<text x="${r2(x + cellW / 2)}" y="${r2(y + cellH / 2 + fontSize / 3)}" font-family="ui-monospace,monospace" font-size="${fontSize}" text-anchor="middle" fill="${Math.abs(t) > 0.55 ? "#ffffff" : "#0f172a"}">${fixed(z, 3)}</text>`,
        );
    }
  }

  parts.push(
    `<rect x="${r2(padLeft)}" y="${r2(padTop)}" width="${r2(plotW)}" height="${r2(plotH)}" fill="none" stroke="${LINE_COLOR}" stroke-width="1"/>`,
  );

  // Column labels along the bottom, row labels down the left.
  for (let i = 0; i < mesh.xCount; i++) {
    const xMm = xMmOf(mesh, i);
    const label = xMm === undefined ? String(i) : fixed(xMm, 0);
    parts.push(
      `<text x="${r2(padLeft + (i + 0.5) * cellW)}" y="${r2(padTop + plotH + 15)}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10" text-anchor="middle" fill="${AXIS_COLOR}">${label}</text>`,
    );
  }
  for (let j = 0; j < mesh.yCount; j++) {
    const yMm = yMmOf(mesh, j);
    const label = yMm === undefined ? String(j) : fixed(yMm, 0);
    parts.push(
      `<text x="${r2(padLeft - 8)}" y="${r2(padTop + (mesh.yCount - 1 - j + 0.5) * cellH + 3)}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10" text-anchor="end" fill="${AXIS_COLOR}">${label}</text>`,
    );
  }

  parts.push(
    `<text x="${r2(padLeft + plotW / 2)}" y="${r2(padTop + plotH + 30)}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" text-anchor="middle" fill="${AXIS_COLOR}">X ${mesh.minX === undefined ? "column index" : "position in mm"}, front of the bed at the bottom</text>`,
    `<text x="14" y="${r2(padTop + plotH / 2)}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" text-anchor="middle" fill="${AXIS_COLOR}" transform="rotate(-90 14 ${r2(padTop + plotH / 2)})">Y ${mesh.minY === undefined ? "row index" : "position in mm"}</text>`,
  );

  // Legend bar.
  const legendY = padTop + plotH + 42;
  const legendW = Math.min(plotW, 240);
  const legendX = padLeft + (plotW - legendW) / 2;
  parts.push(
    `<rect x="${r2(legendX)}" y="${r2(legendY)}" width="${r2(legendW)}" height="10" fill="url(#bedMeshRamp)" stroke="${LINE_COLOR}" stroke-width="0.5"/>`,
    `<text x="${r2(legendX)}" y="${r2(legendY + 24)}" font-family="ui-monospace,monospace" font-size="10" text-anchor="start" fill="${AXIS_COLOR}">${fixed(Math.min(min, ramp.center - ramp.spread), 3)}</text>`,
    `<text x="${r2(legendX + legendW / 2)}" y="${r2(legendY + 24)}" font-family="ui-monospace,monospace" font-size="10" text-anchor="middle" fill="${AXIS_COLOR}">${fixed(ramp.center, 3)}</text>`,
    `<text x="${r2(legendX + legendW)}" y="${r2(legendY + 24)}" font-family="ui-monospace,monospace" font-size="10" text-anchor="end" fill="${AXIS_COLOR}">${fixed(Math.max(max, ramp.center + ramp.spread), 3)}</text>`,
    `<text x="${r2(width / 2)}" y="20" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12" text-anchor="middle" fill="${AXIS_COLOR}">Bed mesh, ${mesh.xCount} by ${mesh.yCount} points, heights in mm</text>`,
  );

  parts.push("</svg>");
  return parts.join("");
}

interface Projected {
  x: number;
  y: number;
}

/**
 * Isometric surface plot. Quads are drawn back to front in painter's order,
 * which is ascending i + j for this projection. Deterministic.
 */
export function renderIsometricSvg(mesh: Mesh, options: IsometricOptions = {}): string {
  const width = Math.max(240, Math.round(clampNumber(options.width, 240, 4000, 560)));
  const height = Math.max(200, Math.round(clampNumber(options.height, 200, 4000, 420)));
  const zScale = clampNumber(options.zScale, 1, 50, 10);
  const palette: PaletteCenter = options.palette === "mean" ? "mean" : "zero";

  const values = mesh.rows.flat();
  const { min, max } = extent(values);
  const range = max - min;
  const mid = (min + max) / 2;
  const ramp = makeRamp(values, palette);

  const cos30 = Math.cos(Math.PI / 6);
  const sin30 = 0.5;
  const relief = (zScale / 50) * 0.9;

  // Height in projection units, normalized so a flat mesh sits on the plane.
  const lift = (z: number): number => (range > 0 ? ((z - mid) / range) * relief : 0);
  const floorLift = -relief / 2 - 0.14;

  const raw = (i: number, j: number, z: number): Projected => {
    const u = i / (mesh.xCount - 1) - 0.5;
    const v = j / (mesh.yCount - 1) - 0.5;
    return { x: (u - v) * cos30, y: (u + v) * sin30 - z };
  };

  const surface: Projected[][] = [];
  for (let j = 0; j < mesh.yCount; j++) {
    const row: Projected[] = [];
    for (let i = 0; i < mesh.xCount; i++) row.push(raw(i, j, lift(mesh.rows[j][i])));
    surface.push(row);
  }
  const floor: Projected[][] = [];
  for (let j = 0; j < mesh.yCount; j++) {
    const row: Projected[] = [];
    for (let i = 0; i < mesh.xCount; i++) row.push(raw(i, j, floorLift));
    floor.push(row);
  }

  const all = [...surface.flat(), ...floor.flat()];
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const bx = extent(xs);
  const by = extent(ys);

  const pad = 26;
  const captionSpace = 26;
  const spanX = bx.max - bx.min || 1;
  const spanY = by.max - by.min || 1;
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2 - captionSpace) / spanY);
  const offsetX = (width - spanX * scale) / 2 - bx.min * scale;
  const offsetY = (height - captionSpace - spanY * scale) / 2 - by.min * scale;

  const sx = (p: Projected): number => p.x * scale + offsetX;
  const sy = (p: Projected): number => p.y * scale + offsetY;
  const place = (p: Projected): string => `${r2(sx(p))},${r2(sy(p))}`;

  const parts: string[] = [svgOpen(width, height, "Bed mesh isometric surface")];

  // Base grid under the surface, drawn first so the surface sits on top.
  for (let j = 0; j < mesh.yCount; j++)
    parts.push(
      `<polyline points="${floor[j].map(place).join(" ")}" fill="none" stroke="${LINE_COLOR}" stroke-opacity="0.28" stroke-width="0.6"/>`,
    );
  for (let i = 0; i < mesh.xCount; i++)
    parts.push(
      `<polyline points="${floor.map((row) => place(row[i])).join(" ")}" fill="none" stroke="${LINE_COLOR}" stroke-opacity="0.28" stroke-width="0.6"/>`,
    );

  const posts: [number, number][] = [
    [0, 0],
    [mesh.xCount - 1, 0],
    [0, mesh.yCount - 1],
    [mesh.xCount - 1, mesh.yCount - 1],
  ];
  for (const [i, j] of posts)
    parts.push(
      `<line x1="${r2(floor[j][i].x * scale + offsetX)}" y1="${r2(floor[j][i].y * scale + offsetY)}" x2="${r2(surface[j][i].x * scale + offsetX)}" y2="${r2(surface[j][i].y * scale + offsetY)}" stroke="${LINE_COLOR}" stroke-opacity="0.4" stroke-width="0.8"/>`,
    );

  // Painter's order: screen Y grows with i + j, so larger sums are nearer.
  const quads: { i: number; j: number }[] = [];
  for (let j = 0; j < mesh.yCount - 1; j++)
    for (let i = 0; i < mesh.xCount - 1; i++) quads.push({ i, j });
  quads.sort((p, q) => p.i + p.j - (q.i + q.j));

  for (const { i, j } of quads) {
    const corners = [surface[j][i], surface[j][i + 1], surface[j + 1][i + 1], surface[j + 1][i]];
    const avg =
      (mesh.rows[j][i] + mesh.rows[j][i + 1] + mesh.rows[j + 1][i + 1] + mesh.rows[j + 1][i]) / 4;
    parts.push(
      `<polygon points="${corners.map(place).join(" ")}" fill="${divergingColor(ramp.t(avg))}" stroke="${LINE_COLOR}" stroke-opacity="0.35" stroke-width="0.5"/>`,
    );
  }

  parts.push(
    `<text x="${r2(width / 2)}" y="${r2(height - 8)}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" text-anchor="middle" fill="${AXIS_COLOR}">Height exaggerated, total deviation ${mm(range)} across a ${mesh.xCount} by ${mesh.yCount} mesh</text>`,
    `<text x="${r2(sx(floor[0][mesh.xCount - 1]) + 12)}" y="${r2(sy(floor[0][mesh.xCount - 1]) + 12)}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10" text-anchor="middle" fill="${AXIS_COLOR}">X</text>`,
    `<text x="${r2(sx(floor[mesh.yCount - 1][0]) - 12)}" y="${r2(sy(floor[mesh.yCount - 1][0]) + 12)}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10" text-anchor="middle" fill="${AXIS_COLOR}">Y</text>`,
    "</svg>",
  );

  return parts.join("");
}

/* -------------------------------------------------------------------- run */

function describePoint(point: MeshPoint): string {
  const at =
    point.xMm !== undefined && point.yMm !== undefined
      ? ` (X ${fixed(point.xMm, 1)} mm, Y ${fixed(point.yMm, 1)} mm)`
      : "";
  return `column ${point.xIndex}, row ${point.yIndex}${at}`;
}

function describeTilt(amount: number, axis: string, low: string, high: string): string {
  if (Math.abs(amount) < 5e-5) return `${mm(0)}, level across ${axis}`;
  const rising = amount > 0;
  return `${signedMm(amount)}, the ${rising ? high : low} side sits higher than the ${rising ? low : high} side`;
}

function gridSize(mesh: Mesh): string {
  const points = `${mesh.xCount} by ${mesh.yCount} points, ${mesh.xCount * mesh.yCount} probe ${mesh.xCount * mesh.yCount === 1 ? "point" : "points"}`;
  if (mesh.minX === undefined || mesh.maxX === undefined) return points;
  const area =
    mesh.minY === undefined || mesh.maxY === undefined
      ? `X ${fixed(mesh.minX, 1)} to ${fixed(mesh.maxX, 1)} mm`
      : `X ${fixed(mesh.minX, 1)} to ${fixed(mesh.maxX, 1)} mm, Y ${fixed(mesh.minY, 1)} to ${fixed(mesh.maxY, 1)} mm`;
  return `${points}, covering ${area}`;
}

export function run(input: string, opts: BedMeshOpts = {}): Record<string, string> {
  const mesh = parseMesh(input);
  const stats = analyzeMesh(mesh);

  const palette: PaletteCenter = String(opts?.centerOn ?? "zero") === "mean" ? "mean" : "zero";
  const zScale = clampNumber(opts?.zScale, 1, 50, 10);

  const out: Record<string, string> = {
    Source: SOURCE_LABELS[mesh.source],
    "Grid size": gridSize(mesh),
    Min: `${signedMm(stats.min)} at ${describePoint(stats.lowest)}`,
    Max: `${signedMm(stats.max)} at ${describePoint(stats.highest)}`,
    Range: `${mm(stats.range)} of total deviation`,
    Mean: signedMm(stats.mean),
    "Std dev": mm(stats.stdDev),
    "Corners and center": `front left ${signedMm(stats.corners.frontLeft)}, front right ${signedMm(stats.corners.frontRight)}, back left ${signedMm(stats.corners.backLeft)}, back right ${signedMm(stats.corners.backRight)}, center ${signedMm(stats.center)}`,
    "Tilt across X": describeTilt(stats.tiltX, "X", "left", "right"),
    "Tilt across Y": describeTilt(stats.tiltY, "Y", "front", "back"),
    "Flatness after removing tilt": `${mm(stats.residualRange)} left once the best fit tilt plane is subtracted, so tilt explains ${pct(stats.tiltShare)}% of the ${mm(stats.range)} range`,
    "Worst point": `${signedMm(stats.worst.value)} at ${describePoint(stats.worst)}, ${mm(Math.abs(stats.worst.deviation))} away from the mesh average`,
    Verdict: stats.verdict,
    Advice: stats.advice,
  };

  if (opts?.svg === true) {
    out["Heatmap SVG"] = renderHeatmapSvg(mesh, { palette });
    out["3D SVG"] = renderIsometricSvg(mesh, { zScale, palette });
  }

  return out;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, BedMeshOpts>;

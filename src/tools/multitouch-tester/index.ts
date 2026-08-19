import { ToolError, type ToolLogic } from "../types";

/** Pointer types a browser's Pointer Events API reports. */
export type PointerType = "touch" | "pen" | "mouse";

/** One active pointer, as read off a `pointermove`/`touchmove`-style event. */
export interface TouchPoint {
  id: number | string;
  x: number;
  y: number;
  pressure?: number;
  radiusX?: number;
  radiusY?: number;
  rotationAngle?: number;
  pointerType?: PointerType;
}

/** A sequence of point snapshots sampled over time, oldest first. */
export type TouchHistory = TouchPoint[][];

export interface CoverageResult {
  /** grid[row][col] is true once any recorded point landed in that cell. */
  grid: boolean[][];
  cols: number;
  rows: number;
  coveragePercent: number;
}

export interface PressureStats {
  min: number;
  max: number;
  avg: number;
  /** True only when the samples actually vary; a constant reading (including a constant 0) means no support. */
  supportsPressure: boolean;
}

export interface GesturePoint {
  x: number;
  y: number;
}

const DEFAULT_GRID_COLS = 10;
const DEFAULT_GRID_ROWS = 16;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Human label for a pointer type, falling back to "Unknown" for anything else. */
export function describePointerType(type: PointerType | string | undefined): string {
  switch (type) {
    case "touch":
      return "Touch (finger)";
    case "pen":
      return "Pen / stylus";
    case "mouse":
      return "Mouse";
    default:
      return "Unknown";
  }
}

/** Straight-line distance between two points, in the same units as x/y (usually CSS pixels). */
export function distanceBetween(a: GesturePoint, b: GesturePoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Ratio of the current distance between two fingers to their starting distance.
 * Greater than 1 is a spread-apart pinch-out, less than 1 is a pinch-in. Returns
 * 1 (no change) when the two start points coincide, since scale is undefined there.
 */
export function pinchScale(startA: GesturePoint, startB: GesturePoint, currentA: GesturePoint, currentB: GesturePoint): number {
  const startDistance = distanceBetween(startA, startB);
  if (startDistance === 0) return 1;
  return distanceBetween(currentA, currentB) / startDistance;
}

/**
 * Change in the angle between two fingers from start to current, in degrees,
 * normalized to (-180, 180]. Positive is clockwise on a standard screen
 * coordinate system (y grows downward).
 */
export function rotation(startA: GesturePoint, startB: GesturePoint, currentA: GesturePoint, currentB: GesturePoint): number {
  const startAngle = Math.atan2(startB.y - startA.y, startB.x - startA.x);
  const currentAngle = Math.atan2(currentB.y - currentA.y, currentB.x - currentA.x);
  let deltaDeg = ((currentAngle - startAngle) * 180) / Math.PI;
  while (deltaDeg > 180) deltaDeg -= 360;
  while (deltaDeg <= -180) deltaDeg += 360;
  return deltaDeg;
}

/**
 * Labeled, copyable rows describing the currently active pointers: how many,
 * the running max seen this session (tracked by the panel and passed in,
 * since a single snapshot cannot know history), one line per point with its
 * coordinates/pressure/radius, and which pointer types have shown up.
 */
export function summarizeTouches(points: TouchPoint[], maxSeen?: number): Record<string, string> {
  const rows: Record<string, string> = {};
  rows["Active points"] = String(points.length);
  rows["Max simultaneous"] = typeof maxSeen === "number" && Number.isFinite(maxSeen) ? String(maxSeen) : "(not tracked)";

  const types = Array.from(new Set(points.map((p) => p.pointerType).filter((t): t is PointerType => Boolean(t))));
  rows["Pointer types seen"] = types.length ? types.map(describePointerType).join(", ") : "(none)";

  points.forEach((p) => {
    const parts: string[] = [`x=${round1(p.x)}, y=${round1(p.y)}`];
    if (typeof p.pressure === "number") parts.push(`pressure=${p.pressure.toFixed(2)}`);
    if (typeof p.radiusX === "number" || typeof p.radiusY === "number") {
      parts.push(`radius=${round1(p.radiusX ?? 0)}x${round1(p.radiusY ?? 0)}`);
    }
    if (typeof p.rotationAngle === "number") parts.push(`angle=${round1(p.rotationAngle)} deg`);
    if (p.pointerType) parts.push(`type=${describePointerType(p.pointerType)}`);
    rows[`Point ${p.id}`] = parts.join(", ");
  });

  return rows;
}

/** Largest number of simultaneously active points across a recorded history of snapshots. */
export function maxSimultaneous(history: TouchHistory): number {
  return history.reduce((max, snapshot) => Math.max(max, snapshot.length), 0);
}

/**
 * Buckets every point in a recorded history into a `cols` by `rows` grid over
 * a `width` by `height` viewport, marking each cell that ever received a
 * touch. Used to sweep for dead zones: spots on the screen the digitizer
 * never registers. Returns an empty (all-false) grid when the viewport size
 * is not yet known.
 */
export function coverageGrid(
  history: TouchHistory,
  width: number,
  height: number,
  cols: number = DEFAULT_GRID_COLS,
  rows: number = DEFAULT_GRID_ROWS,
): CoverageResult {
  const safeCols = Math.max(1, Math.round(cols));
  const safeRows = Math.max(1, Math.round(rows));
  const grid: boolean[][] = Array.from({ length: safeRows }, () => Array<boolean>(safeCols).fill(false));

  if (width > 0 && height > 0) {
    for (const snapshot of history) {
      for (const p of snapshot) {
        if (typeof p.x !== "number" || typeof p.y !== "number") continue;
        const col = clamp(Math.floor((p.x / width) * safeCols), 0, safeCols - 1);
        const row = clamp(Math.floor((p.y / height) * safeRows), 0, safeRows - 1);
        grid[row][col] = true;
      }
    }
  }

  const total = safeCols * safeRows;
  const touched = grid.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const coveragePercent = total > 0 ? (touched / total) * 100 : 0;

  return { grid, cols: safeCols, rows: safeRows, coveragePercent };
}

/** Min/max/average of a set of pressure samples, and whether they vary at all (a constant reading, including 0, means no real pressure support). */
export function pressureStats(samples: number[]): PressureStats {
  const valid = samples.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (valid.length === 0) {
    return { min: 0, max: 0, avg: 0, supportsPressure: false };
  }
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const avg = valid.reduce((sum, v) => sum + v, 0) / valid.length;
  return { min, max, avg, supportsPressure: max - min > 1e-6 };
}

function renderGrid(grid: boolean[][]): string {
  return grid.map((row) => row.map((cell) => (cell ? "#" : ".")).join("")).join("\n");
}

function normalizePoint(raw: unknown): TouchPoint | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const id = typeof p.id === "number" || typeof p.id === "string" ? p.id : null;
  const x = typeof p.x === "number" && Number.isFinite(p.x) ? p.x : null;
  const y = typeof p.y === "number" && Number.isFinite(p.y) ? p.y : null;
  if (id === null || x === null || y === null) return null;

  const pointerType = p.pointerType === "touch" || p.pointerType === "pen" || p.pointerType === "mouse" ? p.pointerType : undefined;
  const pressure = typeof p.pressure === "number" && Number.isFinite(p.pressure) ? p.pressure : undefined;
  const radiusX = typeof p.radiusX === "number" && Number.isFinite(p.radiusX) ? p.radiusX : undefined;
  const radiusY = typeof p.radiusY === "number" && Number.isFinite(p.radiusY) ? p.radiusY : undefined;
  const rotationAngle = typeof p.rotationAngle === "number" && Number.isFinite(p.rotationAngle) ? p.rotationAngle : undefined;

  return { id, x, y, pointerType, pressure, radiusX, radiusY, rotationAngle };
}

function normalizePoints(raw: unknown): TouchPoint[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizePoint).filter((p): p is TouchPoint => p !== null);
}

function normalizeHistory(raw: unknown): TouchHistory {
  if (!Array.isArray(raw)) return [];
  return raw.map((snapshot) => normalizePoints(snapshot));
}

export interface MultitouchOptions {
  view?: "live" | "coverage" | "pressure";
  gridCols?: number;
  [key: string]: unknown;
}

const SAMPLE =
  '{"points":[{"id":0,"x":120,"y":340,"pressure":0.6,"pointerType":"touch"}],"viewport":{"width":390,"height":844}}';

export function run(input: string, opts: MultitouchOptions = {}): Record<string, string> {
  const raw = (input ?? "").trim();

  if (!raw) {
    return {
      Status: "No touch data yet",
      Instructions: "Touch the screen with as many fingers as you can at once to see them tracked live.",
      "Next steps":
        "Sweep a finger across the whole screen to check for dead zones, then try a stylus or mouse to compare pointer types.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolError("bad-json", "Could not parse input as JSON.", `Provide a JSON touch report, e.g. ${SAMPLE}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !("points" in parsed)) {
    throw new ToolError(
      "not-a-report",
      "Expected a JSON object with a points field.",
      `Provide a JSON touch report, e.g. ${SAMPLE}`,
    );
  }

  const body = parsed as { points: unknown; history?: unknown; maxSeen?: unknown; viewport?: unknown };
  if (!Array.isArray(body.points)) {
    throw new ToolError(
      "not-a-report",
      "The points field must be an array of touch points.",
      `Provide a JSON touch report, e.g. ${SAMPLE}`,
    );
  }

  const points = normalizePoints(body.points);
  const history = normalizeHistory(body.history);
  const maxSeen = typeof body.maxSeen === "number" && Number.isFinite(body.maxSeen) ? body.maxSeen : undefined;

  const viewportRaw =
    typeof body.viewport === "object" && body.viewport !== null && !Array.isArray(body.viewport)
      ? (body.viewport as Record<string, unknown>)
      : {};
  const width = typeof viewportRaw.width === "number" && Number.isFinite(viewportRaw.width) ? viewportRaw.width : 0;
  const height = typeof viewportRaw.height === "number" && Number.isFinite(viewportRaw.height) ? viewportRaw.height : 0;

  const view = opts.view === "coverage" || opts.view === "pressure" ? opts.view : "live";

  if (view === "coverage") {
    const gridCols =
      typeof opts.gridCols === "number" && Number.isFinite(opts.gridCols) ? clamp(Math.round(opts.gridCols), 5, 20) : DEFAULT_GRID_COLS;
    const sampleHistory: TouchHistory = history.length > 0 ? history : [points];
    const coverage = coverageGrid(sampleHistory, width, height, gridCols, DEFAULT_GRID_ROWS);
    const touched = coverage.grid.reduce((sum, row) => sum + row.filter(Boolean).length, 0);

    const rows: Record<string, string> = {
      "Active points": String(points.length),
      "Grid size": `${coverage.cols} x ${coverage.rows}`,
      "Cells touched": `${touched} / ${coverage.cols * coverage.rows}`,
      Coverage: `${coverage.coveragePercent.toFixed(1)}%`,
    };
    if (width <= 0 || height <= 0) {
      rows.Note = "No viewport size reported yet, so coverage cannot be computed until the panel reports width and height.";
    } else {
      rows["Coverage grid"] = renderGrid(coverage.grid);
    }
    return rows;
  }

  if (view === "pressure") {
    const allPoints: TouchPoint[] = history.length > 0 ? history.flat() : points;
    const samples = allPoints.map((p) => p.pressure).filter((v): v is number => typeof v === "number");
    const stats = pressureStats(samples);

    const rows: Record<string, string> = {
      Samples: String(samples.length),
      "Min pressure": stats.min.toFixed(2),
      "Max pressure": stats.max.toFixed(2),
      "Average pressure": stats.avg.toFixed(2),
      "Supports pressure": stats.supportsPressure ? "yes, pressure varies" : "no, pressure is constant or unreported",
    };

    const penSamples = allPoints
      .filter((p) => p.pointerType === "pen")
      .map((p) => p.pressure)
      .filter((v): v is number => typeof v === "number");
    if (penSamples.length > 0) {
      const penStats = pressureStats(penSamples);
      rows["Stylus pressure range"] = `${penStats.min.toFixed(2)} to ${penStats.max.toFixed(2)}`;
    }
    return rows;
  }

  const rows = summarizeTouches(points, maxSeen);

  if (points.length === 2) {
    rows["Distance between points"] = `${distanceBetween(points[0], points[1]).toFixed(1)}px`;
  }

  if (history.length >= 2) {
    const first = history[0];
    const last = history[history.length - 1];
    if (first.length >= 2 && last.length >= 2) {
      rows["Pinch scale"] = `${pinchScale(first[0], first[1], last[0], last[1]).toFixed(2)}x`;
      rows["Rotation"] = `${rotation(first[0], first[1], last[0], last[1]).toFixed(1)} deg`;
    }
  }

  return rows;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, MultitouchOptions>;

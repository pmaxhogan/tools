import { ToolError, type ToolLogic } from "../types";
import { formatBytes } from "@/lib/format";

/**
 * G-code viewer.
 *
 * Reads a 3D printer or CNC G-code program, walks the motion commands the way
 * firmware would, and builds a compact model of the toolpath: one entry per
 * layer, each holding the 2D segments drawn on that layer, plus the totals a
 * print needs (filament, distance, a rough time estimate, temperatures, fan,
 * tool changes) and whatever the slicer wrote in its header comments.
 *
 * Supported motion: G0/G1 linear moves, G2/G3 arcs in the XY plane (I/J and R
 * forms, approximated into short line segments), G90/G91 absolute and relative
 * positioning, M82/M83 absolute and relative extrusion, G92 position resets,
 * G28 homing, G20/G21 units. Everything else is read for metadata only.
 *
 * Layers come from slicer markers when the file has them (";LAYER:n" from Cura,
 * ";LAYER_CHANGE" plus ";Z:" from PrusaSlicer, SuperSlicer, OrcaSlicer and
 * Bambu Studio, "; layer 1, Z = 0.2" from Simplify3D). When the file has no
 * markers at all, a layer break is detected from a Z change on an extruding
 * move instead.
 */

/* ------------------------------------------------------------------ types */

/** One drawn move, flattened to the XY plane. Arcs arrive already subdivided. */
export interface GcodeSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** True when filament was pushed while the head moved. */
  extruding: boolean;
  /** Feed rate in force for this move, in mm per minute. */
  feed: number;
  /** Filament delta for this move, in mm of filament. */
  e: number;
}

export interface GcodeLayer {
  index: number;
  /** Z height of the layer, from its marker or its first extruding move. */
  z: number;
  segments: GcodeSegment[];
  /** Path length of the extruding segments, in mm. */
  extrudingLength: number;
  /** Path length of the travel segments, in mm. */
  travelLength: number;
  /** Filament consumed on this layer, in mm, retractions included. */
  filamentMm: number;
  /** Rough time for this layer, in seconds. */
  timeSec: number;
}

export interface GcodeBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface GcodeTemps {
  /** Distinct hotend targets above zero, in the order they were set. */
  hotend: number[];
  /** Distinct bed targets above zero, in the order they were set. */
  bed: number[];
  maxHotend: number | null;
  maxBed: number | null;
}

export interface GcodeFan {
  /** Distinct fan speeds as percentages, in the order they were set. */
  values: number[];
  maxPercent: number;
  /** True when the file ever mentions M106 or M107. */
  used: boolean;
}

export type LayerDetection = "marker" | "z-change";

export interface GcodeModel {
  layers: GcodeLayer[];
  /**
   * Extent of the extruding moves, which is the printed object rather than the
   * machine envelope. Files with no extrusion at all fall back to every move.
   */
  bounds: GcodeBounds;
  /** Net filament from the E deltas, so a retract and its unretract cancel. */
  totalFilamentMm: number;
  totalDistance: number;
  extrudingDistance: number;
  travelDistance: number;
  /** Rough seconds: distance over feed per move, with no acceleration model. */
  estimatedTimeSec: number;
  temps: GcodeTemps;
  fan: GcodeFan;
  toolChanges: number;
  toolsUsed: number[];
  /** Lines actually read, which is capped by the maxLines option. */
  lineCount: number;
  /** True when the file had more lines than maxLines allowed. */
  truncated: boolean;
  layerDetection: LayerDetection;
  slicer: string | null;
  printTimeFromSlicer: string | null;
  filamentUsedFromSlicer: string | null;
}

export interface ParseGcodeOptions {
  /** Stop after this many lines. Default 2000000. */
  maxLines?: number;
}

export type ColorBy = "type" | "speed";

export interface LayerSvgOptions {
  width?: number;
  height?: number;
  /** Draw the non extruding moves as faint dashes. Default false. */
  showTravel?: boolean;
  /** "type" paints every extrusion alike, "speed" ramps by feed rate. */
  colorBy?: ColorBy;
}

export interface AllLayersSvgOptions {
  width?: number;
  height?: number;
  /** Highest layer index to draw, inclusive. Default the top layer. */
  upToLayer?: number;
}

export interface LayerStats {
  index: number;
  z: number;
  /** Rise from the layer below, or the layer Z itself for the first layer. */
  layerHeight: number;
  segments: number;
  extrudingSegments: number;
  travelSegments: number;
  extrudingLength: number;
  travelLength: number;
  filamentMm: number;
  estimatedTimeSec: number;
  minFeed: number;
  maxFeed: number;
  bounds: GcodeBounds;
}

export interface GcodeViewerOpts {
  /** Add an SVG preview row to the output. Default false. */
  svg?: boolean;
  /** 1 based layer to draw. 0 draws the whole stack plus the middle layer. */
  layer?: number;
  /** Include travel moves in the layer render. Default false. */
  showTravel?: boolean;
  /** "type" or "speed". Default "type". */
  colorBy?: string;
  [key: string]: unknown;
}

/* -------------------------------------------------------------- constants */

const MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_LINES = 2_000_000;
/** Feed used before the file sets one, in mm per minute. */
const DEFAULT_FEED = 1200;
/** Filament deltas below this do not count as extrusion. */
const EPS_E = 1e-9;
const EPS_Z = 1e-6;
/** Angular step for arc flattening: 7.5 degrees. */
const ARC_STEP = Math.PI / 24;
const ARC_MIN_STEPS = 8;
const ARC_MAX_STEPS = 240;
const FIX_DROP = "Drop a .gcode, .gco or .nc file, or paste the text of one.";

/* ------------------------------------------------------------- formatting */

/** toFixed that never prints a negative zero. */
export function fixed(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return (0).toFixed(digits);
  const s = n.toFixed(digits);
  return /^-0(?:\.0*)?$/.test(s) ? s.slice(1) : s;
}

/** Compact SVG coordinate: two decimals, and never the string "-0". */
function r2(n: number): string {
  const v = Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  return String(v === 0 ? 0 : v);
}

function mm(n: number, digits = 2): string {
  return `${fixed(n, digits)} mm`;
}

/** Seconds as "1h 5m 30s". Sub minute durations keep only seconds. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (h > 0 || m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = toFiniteNumber(value);
  return Math.min(max, Math.max(min, n ?? fallback));
}

function isTruthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true" || value === "1" || value === "on";
  if (typeof value === "number") return value !== 0;
  return false;
}

/**
 * Filament weight in grams for a length of filament.
 * Default 1.75 mm diameter and 1.24 g/cm3, which is ordinary PLA.
 */
export function filamentWeight(lengthMm: number, diameter = 1.75, density = 1.24): number {
  const len = Number.isFinite(lengthMm) ? lengthMm : 0;
  const d = Number.isFinite(diameter) && diameter > 0 ? diameter : 1.75;
  const rho = Number.isFinite(density) && density > 0 ? density : 1.24;
  const areaMm2 = Math.PI * (d / 2) * (d / 2);
  const volumeCm3 = (areaMm2 * len) / 1000;
  return volumeCm3 * rho;
}

/* ------------------------------------------------------- comment scanning */

const MARKER_LAYER_INDEX = /^;\s*LAYER:\s*(-?\d+)/i;
const MARKER_LAYER_CHANGE = /^;\s*LAYER_CHANGE\b/i;
const MARKER_LAYER_WORD = /^;\s*layer\s+(-?\d+)(?:.*?\bZ\s*=\s*(-?[\d.]+))?/i;
const MARKER_Z = /^;\s*Z:\s*(-?[\d.]+)/i;

interface LayerMarker {
  z?: number;
}

/** Reads a slicer layer marker off a whole comment line, or null. */
function layerMarker(line: string): LayerMarker | null {
  if (MARKER_LAYER_INDEX.test(line)) return {};
  if (MARKER_LAYER_CHANGE.test(line)) return {};
  const word = MARKER_LAYER_WORD.exec(line);
  if (word) {
    const z = word[2] === undefined ? undefined : Number(word[2]);
    return { z: z !== undefined && Number.isFinite(z) ? z : undefined };
  }
  const zOnly = MARKER_Z.exec(line);
  if (zOnly) {
    const z = Number(zOnly[1]);
    return { z: Number.isFinite(z) ? z : undefined };
  }
  return null;
}

const SLICER_RULES: { name: string; re: RegExp }[] = [
  { name: "OrcaSlicer", re: /\bOrcaSlicer\s*v?([\d][\w.+-]*)?/i },
  { name: "Bambu Studio", re: /\bBambu\s*Studio\s*v?([\d][\w.+-]*)?/i },
  { name: "SuperSlicer", re: /\bSuperSlicer\s*v?([\d][\w.+-]*)?/i },
  { name: "PrusaSlicer", re: /\bPrusaSlicer\s*v?([\d][\w.+-]*)?/i },
  { name: "Simplify3D", re: /\bSimplify3D(?:\(R\))?\s*(?:Version\s*)?v?([\d][\w.]*)?/i },
  { name: "Cura", re: /\bCura(?:_SteamEngine)?\s*v?([\d][\w.]*)?/i },
  { name: "ideaMaker", re: /\bideaMaker\s*v?([\d][\w.]*)?/i },
  { name: "KISSlicer", re: /\bKISSlicer\s*v?([\d][\w.]*)?/i },
  { name: "Slic3r", re: /\bSlic3r\s*v?([\d][\w.+-]*)?/i },
];

const BANNER_RE = /generated (?:by|with)|g-?code generated by|sliced by|created by/i;
/** How far into the file the weaker slicer name search is allowed to look. */
const SLICER_SCAN_LINES = 400;

function matchSlicer(line: string): string | null {
  for (const rule of SLICER_RULES) {
    const m = rule.re.exec(line);
    if (m) return m[1] ? `${rule.name} ${m[1]}` : rule.name;
  }
  return null;
}

const TIME_RULES: RegExp[] = [
  /^;\s*TIME:\s*(\d+(?:\.\d+)?)\s*$/i,
  /estimated printing time[^=]*=\s*(.+?)\s*$/i,
  /model printing time:\s*([^;]+?)\s*$/i,
  /total estimated time:\s*([^;]+?)\s*$/i,
  /build time:\s*(.+?)\s*$/i,
  /^;\s*print time:\s*(.+?)\s*$/i,
];

const FILAMENT_MM_RULES: RegExp[] = [
  /filament used\s*\[mm\]\s*=\s*([\d.]+)/i,
  /filament length:\s*([\d.]+)\s*mm/i,
];
const FILAMENT_G_RULES: RegExp[] = [
  /filament used\s*\[g\]\s*=\s*([\d.]+)/i,
  /plastic weight:\s*([\d.]+)\s*g/i,
  /filament weight total:\s*([\d.]+)/i,
];
const FILAMENT_M_RULES: RegExp[] = [/^;\s*filament used:\s*([\d.]+)\s*m\b/i];

interface HeaderScan {
  slicer: string | null;
  printTime: string | null;
  filamentUsed: string | null;
  hasMarkers: boolean;
}

function firstCapture(rules: RegExp[], line: string): string | null {
  for (const re of rules) {
    const m = re.exec(line);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

/**
 * One pass over the comment lines for the metadata the motion pass does not
 * need: which slicer wrote the file, what it estimated, and whether the file
 * carries layer markers at all.
 */
function scanHeader(lines: string[], lineCount: number): HeaderScan {
  let strongSlicer: string | null = null;
  let weakSlicer: string | null = null;
  let printTime: string | null = null;
  let filamentMm: string | null = null;
  let filamentG: string | null = null;
  let filamentM: string | null = null;
  let hasMarkers = false;

  for (let i = 0; i < lineCount; i++) {
    const line = lines[i].trim();
    if (line === "" || line.charCodeAt(0) !== 59) continue;

    if (!hasMarkers && layerMarker(line) !== null) hasMarkers = true;

    if (strongSlicer === null && BANNER_RE.test(line)) strongSlicer = matchSlicer(line);
    if (weakSlicer === null && i < SLICER_SCAN_LINES) weakSlicer = matchSlicer(line);

    if (printTime === null) {
      const raw = firstCapture(TIME_RULES, line);
      if (raw !== null) printTime = /^\d+(?:\.\d+)?$/.test(raw) ? formatDuration(Number(raw)) : raw;
    }
    if (filamentMm === null) filamentMm = firstCapture(FILAMENT_MM_RULES, line);
    if (filamentG === null) filamentG = firstCapture(FILAMENT_G_RULES, line);
    if (filamentM === null) filamentM = firstCapture(FILAMENT_M_RULES, line);
  }

  const filamentParts: string[] = [];
  if (filamentMm !== null) filamentParts.push(`${filamentMm} mm`);
  else if (filamentM !== null) filamentParts.push(`${filamentM} m`);
  if (filamentG !== null) filamentParts.push(`${filamentG} g`);

  return {
    slicer: strongSlicer ?? weakSlicer,
    printTime,
    filamentUsed: filamentParts.length > 0 ? filamentParts.join(", ") : null,
    hasMarkers,
  };
}

/* --------------------------------------------------------- word tokenizer */

const WORD_RE = /([A-Za-z])\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))?/g;

interface GcodeWords {
  /** The command letter, upper case: "G", "M", "T" and so on. */
  letter: string;
  /** The command number. NaN when the letter carried no number. */
  value: number;
  /** Parameter letters to values. A bare letter stores NaN. */
  params: Record<string, number>;
}

/** Splits a raw line into its code half and its trailing comment. */
function stripComment(raw: string): string {
  const semi = raw.indexOf(";");
  const code = semi >= 0 ? raw.slice(0, semi) : raw;
  return code.includes("(") ? code.replace(/\([^)]*\)/g, " ") : code;
}

function parseWords(code: string): GcodeWords | null {
  const cleaned = code.replace(/^\s*[Nn]\d+\s*/, "").replace(/\*\s*\d+\s*$/, "");
  if (cleaned.trim() === "") return null;

  WORD_RE.lastIndex = 0;
  let letter = "";
  let value = Number.NaN;
  const params: Record<string, number> = {};
  let match: RegExpExecArray | null;
  while ((match = WORD_RE.exec(cleaned)) !== null) {
    const key = match[1].toUpperCase();
    const num = match[2] === undefined ? Number.NaN : Number(match[2]);
    if (letter === "") {
      letter = key;
      value = num;
      continue;
    }
    if (params[key] === undefined) params[key] = num;
  }
  return letter === "" ? null : { letter, value, params };
}

/* ---------------------------------------------------------------- parsing */

function emptyLayer(index: number, z: number): GcodeLayer {
  return {
    index,
    z,
    segments: [],
    extrudingLength: 0,
    travelLength: 0,
    filamentMm: 0,
    timeSec: 0,
  };
}

interface BoundsAccumulator {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  seen: boolean;
}

function newBounds(): BoundsAccumulator {
  return {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
    seen: false,
  };
}

function extend(acc: BoundsAccumulator, x: number, y: number, z: number): void {
  acc.seen = true;
  if (x < acc.minX) acc.minX = x;
  if (x > acc.maxX) acc.maxX = x;
  if (y < acc.minY) acc.minY = y;
  if (y > acc.maxY) acc.maxY = y;
  if (z < acc.minZ) acc.minZ = z;
  if (z > acc.maxZ) acc.maxZ = z;
}

function finishBounds(acc: BoundsAccumulator): GcodeBounds {
  if (!acc.seen) return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  return {
    minX: acc.minX,
    maxX: acc.maxX,
    minY: acc.minY,
    maxY: acc.maxY,
    minZ: acc.minZ,
    maxZ: acc.maxZ,
  };
}

/**
 * Walks the program and returns the toolpath model. Throws `empty-input` for a
 * blank file and `not-gcode` for a file with no motion commands in it.
 */
export function parseGcode(text: string, options: ParseGcodeOptions = {}): GcodeModel {
  if (text.trim() === "") {
    throw new ToolError("empty-input", "There is no G-code to read.", FIX_DROP);
  }

  const maxLines = Math.round(clampNumber(options.maxLines, 1, 50_000_000, DEFAULT_MAX_LINES));
  const rawLines = text.split(/\r?\n/);
  const truncated = rawLines.length > maxLines;
  const lineCount = truncated ? maxLines : rawLines.length;

  const header = scanHeader(rawLines, lineCount);
  const layerDetection: LayerDetection = header.hasMarkers ? "marker" : "z-change";

  // Machine state, all in millimeters and mm per minute.
  let x = 0;
  let y = 0;
  let z = 0;
  let e = 0;
  let feed = DEFAULT_FEED;
  let absolutePos = true;
  let absoluteExt = true;
  let unitScale = 1;

  let motionCount = 0;
  let totalFilamentMm = 0;
  let totalDistance = 0;
  let extrudingDistance = 0;
  let travelDistance = 0;
  let estimatedTimeSec = 0;
  let toolChanges = 0;
  let tool = 0;
  const toolsUsed = new Set<number>([0]);
  const hotend: number[] = [];
  const bed: number[] = [];
  const fanValues: number[] = [];
  let fanUsed = false;

  const extrudingBounds = newBounds();
  const allBounds = newBounds();

  const layers: GcodeLayer[] = [];
  let current = emptyLayer(0, 0);
  let currentHasExtrusion = false;
  let currentZLocked = false;

  /** Marker driven break: an untouched layer only takes the new Z. */
  function markerLayer(zHint: number | undefined): void {
    if (!currentHasExtrusion) {
      if (zHint !== undefined) {
        current.z = zHint;
        currentZLocked = true;
      }
      return;
    }
    layers.push(current);
    current = emptyLayer(layers.length, zHint ?? z);
    currentHasExtrusion = false;
    currentZLocked = zHint !== undefined;
  }

  /** Fallback break: a Z change on an extruding move always starts a layer. */
  function forceLayer(newZ: number): void {
    layers.push(current);
    current = emptyLayer(layers.length, newZ);
    currentHasExtrusion = false;
    currentZLocked = true;
  }

  function scaled(value: number | undefined): number | undefined {
    return value === undefined || !Number.isFinite(value) ? undefined : value * unitScale;
  }

  function axisTarget(value: number | undefined, currentValue: number): number {
    const v = scaled(value);
    if (v === undefined) return currentValue;
    return absolutePos ? v : currentValue + v;
  }

  /** Filament delta for an E word, without committing it to the machine state. */
  function extruderDelta(value: number | undefined): number {
    const v = scaled(value);
    if (v === undefined) return 0;
    return absoluteExt ? v - e : v;
  }

  function commitExtruder(value: number | undefined, delta: number): void {
    const v = scaled(value);
    if (v === undefined) return;
    e = absoluteExt ? v : e + v;
    totalFilamentMm += delta;
    current.filamentMm += delta;
  }

  function moveTo(nx: number, ny: number, nz: number, eDelta: number): void {
    const dx = nx - x;
    const dy = ny - y;
    const dz = nz - z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const drawn = dx !== 0 || dy !== 0;
    const extruding = eDelta > EPS_E && drawn;

    if (dist > 0) {
      const seconds = (dist / Math.max(feed, 1)) * 60;
      totalDistance += dist;
      estimatedTimeSec += seconds;
      current.timeSec += seconds;
      if (extruding) extrudingDistance += dist;
      else travelDistance += dist;
    }

    if (drawn) {
      current.segments.push({ x1: x, y1: y, x2: nx, y2: ny, extruding, feed, e: eDelta });
      if (extruding) {
        current.extrudingLength += dist;
        currentHasExtrusion = true;
        if (!currentZLocked) {
          current.z = nz;
          currentZLocked = true;
        }
      } else {
        current.travelLength += dist;
      }
    }

    if (extruding) {
      extend(extrudingBounds, x, y, z);
      extend(extrudingBounds, nx, ny, nz);
    }
    extend(allBounds, nx, ny, nz);

    x = nx;
    y = ny;
    z = nz;
  }

  function readFeed(params: Record<string, number>): void {
    const f = scaled(params.F);
    if (f !== undefined && f > 0) feed = f;
  }

  /** Starts a new layer when the fallback detector sees a Z change. */
  function checkZLayer(extruding: boolean, nz: number): void {
    if (layerDetection !== "z-change") return;
    if (!extruding || !currentHasExtrusion) return;
    if (Math.abs(nz - current.z) > EPS_Z) forceLayer(nz);
  }

  function linearMove(params: Record<string, number>): void {
    readFeed(params);
    const nx = axisTarget(params.X, x);
    const ny = axisTarget(params.Y, y);
    const nz = axisTarget(params.Z, z);
    const eDelta = extruderDelta(params.E);
    checkZLayer(eDelta > EPS_E && (nx !== x || ny !== y), nz);
    commitExtruder(params.E, eDelta);
    moveTo(nx, ny, nz, eDelta);
  }

  function arcMove(params: Record<string, number>, clockwise: boolean): void {
    readFeed(params);
    const tx = axisTarget(params.X, x);
    const ty = axisTarget(params.Y, y);
    const tz = axisTarget(params.Z, z);
    const eDelta = extruderDelta(params.E);
    const willExtrude = eDelta > EPS_E && (tx !== x || ty !== y);
    checkZLayer(willExtrude, tz);

    const i = scaled(params.I);
    const j = scaled(params.J);
    const rWord = scaled(params.R);

    let cx: number;
    let cy: number;
    if (i !== undefined || j !== undefined) {
      cx = x + (i ?? 0);
      cy = y + (j ?? 0);
    } else if (rWord !== undefined && rWord !== 0) {
      const dx = tx - x;
      const dy = ty - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-9) {
        // A radius arc back to the same point has no defined center.
        commitExtruder(params.E, eDelta);
        moveTo(tx, ty, tz, eDelta);
        return;
      }
      // The grbl construction: h is the half chord height over half the chord.
      let h = -Math.sqrt(Math.max(0, 4 * rWord * rWord - d * d)) / d;
      if (!clockwise) h = -h;
      // A negative radius asks for the long way round the circle.
      if (rWord < 0) h = -h;
      cx = x + 0.5 * (dx - dy * h);
      cy = y + 0.5 * (dy + dx * h);
    } else {
      // No center and no radius: the only honest reading is a straight line.
      commitExtruder(params.E, eDelta);
      moveTo(tx, ty, tz, eDelta);
      return;
    }

    const radius = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
    const a0 = Math.atan2(y - cy, x - cx);
    const a1 = Math.atan2(ty - cy, tx - cx);
    let sweep: number;
    if (clockwise) {
      sweep = a0 - a1;
      if (sweep <= 1e-12) sweep += 2 * Math.PI;
      sweep = -sweep;
    } else {
      sweep = a1 - a0;
      if (sweep <= 1e-12) sweep += 2 * Math.PI;
    }

    const steps = Math.min(
      ARC_MAX_STEPS,
      Math.max(ARC_MIN_STEPS, Math.ceil(Math.abs(sweep) / ARC_STEP)),
    );
    const ePerStep = eDelta / steps;
    const z0 = z;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      if (s === steps) {
        // The last point is the commanded endpoint, never a rounded one.
        moveTo(tx, ty, tz, ePerStep);
      } else {
        const angle = a0 + sweep * t;
        moveTo(
          cx + radius * Math.cos(angle),
          cy + radius * Math.sin(angle),
          z0 + (tz - z0) * t,
          ePerStep,
        );
      }
    }
    commitExtruder(params.E, eDelta);
  }

  function setPosition(params: Record<string, number>): void {
    const hasAny = ["X", "Y", "Z", "E"].some((k) => params[k] !== undefined);
    if (!hasAny) {
      x = 0;
      y = 0;
      z = 0;
      e = 0;
      return;
    }
    const nx = scaled(params.X);
    const ny = scaled(params.Y);
    const nz = scaled(params.Z);
    const ne = scaled(params.E);
    if (nx !== undefined) x = nx;
    if (ny !== undefined) y = ny;
    if (nz !== undefined) z = nz;
    if (ne !== undefined) e = ne;
  }

  function home(params: Record<string, number>): void {
    const named = ["X", "Y", "Z"].filter((k) => params[k] !== undefined);
    const axes = named.length > 0 ? named : ["X", "Y", "Z"];
    if (axes.includes("X")) x = 0;
    if (axes.includes("Y")) y = 0;
    if (axes.includes("Z")) z = 0;
  }

  function recordTemp(list: number[], params: Record<string, number>): void {
    const raw = Number.isFinite(params.S) ? params.S : params.R;
    if (!Number.isFinite(raw) || raw <= 0) return;
    if (!list.includes(raw)) list.push(raw);
  }

  for (let index = 0; index < lineCount; index++) {
    const raw = rawLines[index];
    if (raw === "") continue;
    const trimmed = raw.trim();
    if (trimmed === "") continue;

    if (trimmed.charCodeAt(0) === 59) {
      if (layerDetection === "marker") {
        const marker = layerMarker(trimmed);
        if (marker !== null) markerLayer(marker.z);
      }
      continue;
    }

    const words = parseWords(stripComment(trimmed));
    if (words === null) continue;

    if (words.letter === "G") {
      switch (words.value) {
        case 0:
        case 1:
          motionCount++;
          linearMove(words.params);
          break;
        case 2:
          motionCount++;
          arcMove(words.params, true);
          break;
        case 3:
          motionCount++;
          arcMove(words.params, false);
          break;
        case 20:
          unitScale = 25.4;
          break;
        case 21:
          unitScale = 1;
          break;
        case 28:
          home(words.params);
          break;
        // Marlin and Klipper apply G90 and G91 to every axis, the extruder
        // included. M82 and M83 then override the extruder on its own, which
        // is why slicers write G90 first and M82 or M83 after it.
        case 90:
          absolutePos = true;
          absoluteExt = true;
          break;
        case 91:
          absolutePos = false;
          absoluteExt = false;
          break;
        case 92:
          setPosition(words.params);
          break;
        default:
          break;
      }
      continue;
    }

    if (words.letter === "M") {
      switch (words.value) {
        case 82:
          absoluteExt = true;
          break;
        case 83:
          absoluteExt = false;
          break;
        case 104:
        case 109:
          recordTemp(hotend, words.params);
          break;
        case 140:
        case 190:
          recordTemp(bed, words.params);
          break;
        case 106: {
          fanUsed = true;
          const s = Number.isFinite(words.params.S) ? words.params.S : 255;
          const percent = Math.max(0, Math.min(100, Math.round((s / 255) * 100)));
          if (!fanValues.includes(percent)) fanValues.push(percent);
          break;
        }
        case 107:
          fanUsed = true;
          if (!fanValues.includes(0)) fanValues.push(0);
          break;
        default:
          break;
      }
      continue;
    }

    if (words.letter === "T" && Number.isFinite(words.value) && words.value >= 0) {
      toolsUsed.add(words.value);
      if (words.value !== tool) {
        toolChanges++;
        tool = words.value;
      }
    }
  }

  if (current.segments.length > 0) layers.push(current);

  if (motionCount === 0) {
    throw new ToolError(
      "not-gcode",
      "That file has no G0, G1, G2 or G3 moves in it, so it is not G-code.",
      FIX_DROP,
    );
  }

  return {
    layers,
    bounds: finishBounds(extrudingBounds.seen ? extrudingBounds : allBounds),
    totalFilamentMm,
    totalDistance,
    extrudingDistance,
    travelDistance,
    estimatedTimeSec,
    temps: {
      hotend,
      bed,
      maxHotend: hotend.length > 0 ? Math.max(...hotend) : null,
      maxBed: bed.length > 0 ? Math.max(...bed) : null,
    },
    fan: {
      values: fanValues,
      maxPercent: fanValues.length > 0 ? Math.max(...fanValues) : 0,
      used: fanUsed,
    },
    toolChanges,
    toolsUsed: [...toolsUsed].sort((a, b) => a - b),
    lineCount,
    truncated,
    layerDetection,
    slicer: header.slicer,
    printTimeFromSlicer: header.printTime,
    filamentUsedFromSlicer: header.filamentUsed,
  };
}

/* ------------------------------------------------------------ layer stats */

function requireLayer(model: GcodeModel, index: number): GcodeLayer {
  const layer = model.layers[index];
  if (layer === undefined) {
    throw new ToolError(
      "bad-option",
      `This file has ${model.layers.length} ${model.layers.length === 1 ? "layer" : "layers"}, so layer ${index} does not exist.`,
      `Pick a layer from 0 to ${Math.max(0, model.layers.length - 1)}.`,
    );
  }
  return layer;
}

/** Per layer counts, lengths, feed range and extent. */
export function layerStats(model: GcodeModel, index: number): LayerStats {
  const layer = requireLayer(model, index);
  const below = index > 0 ? model.layers[index - 1].z : 0;
  const acc = newBounds();
  let extrudingSegments = 0;
  let minFeed = Infinity;
  let maxFeed = 0;
  for (const s of layer.segments) {
    if (!s.extruding) continue;
    extrudingSegments++;
    extend(acc, s.x1, s.y1, layer.z);
    extend(acc, s.x2, s.y2, layer.z);
    if (s.feed < minFeed) minFeed = s.feed;
    if (s.feed > maxFeed) maxFeed = s.feed;
  }
  return {
    index,
    z: layer.z,
    layerHeight: layer.z - below,
    segments: layer.segments.length,
    extrudingSegments,
    travelSegments: layer.segments.length - extrudingSegments,
    extrudingLength: layer.extrudingLength,
    travelLength: layer.travelLength,
    filamentMm: layer.filamentMm,
    estimatedTimeSec: layer.timeSec,
    minFeed: Number.isFinite(minFeed) ? minFeed : 0,
    maxFeed,
    bounds: finishBounds(acc),
  };
}

/* --------------------------------------------------------------- renderer */

const EXTRUSION_COLOR = "#2563eb";
const TRAVEL_COLOR = "#94a3b8";
/** Slow to fast, blue through green and amber to red. */
const SPEED_RAMP = [
  "#1d4ed8",
  "#0284c7",
  "#0d9488",
  "#65a30d",
  "#ca8a04",
  "#ea580c",
  "#dc2626",
  "#b91c1c",
];

interface Fit {
  sx(x: number): number;
  sy(y: number): number;
}

function fitTo(bounds: GcodeBounds, width: number, height: number, pad: number): Fit {
  const spanX = Math.max(bounds.maxX - bounds.minX, 1e-6);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1e-6);
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;
  return {
    sx: (vx: number) => offsetX + (vx - bounds.minX) * scale,
    // G-code Y grows towards the back of the bed, SVG Y grows downwards.
    sy: (vy: number) => height - offsetY - (vy - bounds.minY) * scale,
  };
}

function svgOpen(width: number, height: number, title: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">`,
    `<title>${title}</title>`,
  ].join("");
}

/** Joins segments into subpaths, continuing a run while the ends line up. */
function pathData(segments: GcodeSegment[], fit: Fit): string {
  const parts: string[] = [];
  let lastX = Number.NaN;
  let lastY = Number.NaN;
  for (const s of segments) {
    if (s.x1 !== lastX || s.y1 !== lastY) {
      parts.push(`M${r2(fit.sx(s.x1))} ${r2(fit.sy(s.y1))}`);
    }
    parts.push(`L${r2(fit.sx(s.x2))} ${r2(fit.sy(s.y2))}`);
    lastX = s.x2;
    lastY = s.y2;
  }
  return parts.join("");
}

function speedBucket(feed: number, minFeed: number, maxFeed: number): number {
  if (!(maxFeed > minFeed)) return 0;
  const t = (feed - minFeed) / (maxFeed - minFeed);
  return Math.max(0, Math.min(SPEED_RAMP.length - 1, Math.floor(t * SPEED_RAMP.length)));
}

/**
 * A top down SVG of one layer. Extrusion is drawn as solid strokes, travel as
 * faint dashes, and "speed" coloring ramps each stroke by its feed rate.
 * Deterministic: the same model and options always produce identical markup.
 */
export function renderLayerSvg(
  model: GcodeModel,
  layerIndex: number,
  options: LayerSvgOptions = {},
): string {
  const layer = requireLayer(model, layerIndex);
  const width = Math.round(clampNumber(options.width, 120, 4000, 640));
  const height = Math.round(clampNumber(options.height, 120, 4000, 480));
  const showTravel = options.showTravel === true;
  const colorBy: ColorBy = options.colorBy === "speed" ? "speed" : "type";

  const fit = fitTo(model.bounds, width, height, 14);
  const title = `Layer ${layerIndex + 1} at Z ${fixed(layer.z, 2)} mm`;
  const parts: string[] = [svgOpen(width, height, title)];

  if (showTravel) {
    const travel = layer.segments.filter((s) => !s.extruding);
    if (travel.length > 0) {
      parts.push(
        `<path d="${pathData(travel, fit)}" fill="none" stroke="${TRAVEL_COLOR}" stroke-width="0.6" stroke-dasharray="3 3" stroke-opacity="0.7"/>`,
      );
    }
  }

  const extruding = layer.segments.filter((s) => s.extruding);
  if (colorBy === "speed" && extruding.length > 0) {
    let minFeed = Infinity;
    let maxFeed = 0;
    for (const s of extruding) {
      if (s.feed < minFeed) minFeed = s.feed;
      if (s.feed > maxFeed) maxFeed = s.feed;
    }
    const buckets: GcodeSegment[][] = SPEED_RAMP.map(() => []);
    for (const s of extruding) buckets[speedBucket(s.feed, minFeed, maxFeed)].push(s);
    buckets.forEach((bucket, i) => {
      if (bucket.length === 0) return;
      parts.push(
        `<path d="${pathData(bucket, fit)}" fill="none" stroke="${SPEED_RAMP[i]}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    });
  } else if (extruding.length > 0) {
    parts.push(
      `<path d="${pathData(extruding, fit)}" fill="none" stroke="${EXTRUSION_COLOR}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
  }

  parts.push("</svg>");
  return parts.join("");
}

/**
 * A top down SVG of the whole stack up to `upToLayer`, with the lower layers
 * faded so the newest one reads first. Travel moves are left out.
 */
export function renderAllLayersSvg(model: GcodeModel, options: AllLayersSvgOptions = {}): string {
  const width = Math.round(clampNumber(options.width, 120, 4000, 640));
  const height = Math.round(clampNumber(options.height, 120, 4000, 480));
  const last =
    model.layers.length === 0
      ? -1
      : Math.round(
          clampNumber(options.upToLayer, 0, model.layers.length - 1, model.layers.length - 1),
        );

  const fit = fitTo(model.bounds, width, height, 14);
  const title = last < 0 ? "No printed layers" : `Layers 1 to ${last + 1}, top down preview`;
  const parts: string[] = [svgOpen(width, height, title)];

  for (let i = 0; i <= last; i++) {
    const extruding = model.layers[i].segments.filter((s) => s.extruding);
    if (extruding.length === 0) continue;
    const t = last === 0 ? 1 : i / last;
    const opacity = Math.round((0.18 + 0.82 * t) * 100) / 100;
    parts.push(
      `<path d="${pathData(extruding, fit)}" fill="none" stroke="${EXTRUSION_COLOR}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="${opacity}"/>`,
    );
  }

  parts.push("</svg>");
  return parts.join("");
}

/* -------------------------------------------------------------- summarize */

function averageLayerHeight(model: GcodeModel): number {
  const layers = model.layers;
  if (layers.length < 2) return layers.length === 1 ? layers[0].z : 0;
  let sum = 0;
  let count = 0;
  for (let i = 1; i < layers.length; i++) {
    const d = layers[i].z - layers[i - 1].z;
    if (d > EPS_Z) {
      sum += d;
      count++;
    }
  }
  return count === 0 ? 0 : sum / count;
}

function describeTemps(temps: GcodeTemps): string {
  const parts: string[] = [];
  if (temps.maxHotend !== null) parts.push(`hotend ${fixed(temps.maxHotend, 0)} C`);
  if (temps.maxBed !== null) parts.push(`bed ${fixed(temps.maxBed, 0)} C`);
  return parts.length === 0 ? "Not set in this file" : parts.join(", ");
}

function describeFan(fan: GcodeFan): string {
  if (!fan.used) return "Not set in this file";
  return `${fan.maxPercent}% at the fastest`;
}

/** The labeled rows the generic panel renders. */
export function summarize(model: GcodeModel): Record<string, string> {
  const b = model.bounds;
  const grams = filamentWeight(model.totalFilamentMm);
  const layerCount = model.layers.length;
  const detection =
    model.layerDetection === "marker"
      ? "found from the slicer layer markers"
      : "found from Z height changes, since the file has no layer markers";

  const out: Record<string, string> = {
    Slicer: model.slicer ?? "Not detected",
    Layers: `${layerCount} ${layerCount === 1 ? "layer" : "layers"}, ${detection}`,
    "Layer height":
      layerCount === 0
        ? "No printed layers"
        : `${mm(averageLayerHeight(model))} average, first layer at Z ${mm(model.layers[0].z)}`,
    Bounds: `X ${fixed(b.minX)} to ${fixed(b.maxX)} mm, Y ${fixed(b.minY)} to ${fixed(b.maxY)} mm, Z ${fixed(b.minZ)} to ${fixed(b.maxZ)} mm (${fixed(b.maxX - b.minX)} by ${fixed(b.maxY - b.minY)} by ${fixed(b.maxZ - b.minZ)} mm)`,
    Filament: `${mm(model.totalFilamentMm)} of filament, about ${fixed(grams, 3)} g as 1.75 mm PLA`,
    Distance: `${mm(model.extrudingDistance)} extruding, ${mm(model.travelDistance)} travel, ${mm(model.totalDistance)} total`,
    "Rough time": `${formatDuration(model.estimatedTimeSec)}, a rough figure that ignores acceleration and firmware limits`,
  };

  if (model.printTimeFromSlicer !== null) out["Slicer time"] = model.printTimeFromSlicer;
  if (model.filamentUsedFromSlicer !== null) out["Slicer filament"] = model.filamentUsedFromSlicer;

  out.Temperatures = describeTemps(model.temps);
  out.Fan = describeFan(model.fan);
  out["Tool changes"] =
    model.toolChanges === 0
      ? "None, one tool for the whole file"
      : `${model.toolChanges}, across tools ${model.toolsUsed.map((t) => `T${t}`).join(", ")}`;
  out["Lines read"] = model.truncated
    ? `${model.lineCount}, stopped at the line limit so the totals cover the start of the file only`
    : String(model.lineCount);

  return out;
}

/* -------------------------------------------------------------------- run */

function readColorBy(value: unknown): ColorBy {
  if (value === undefined || value === null || value === "") return "type";
  if (value === "type" || value === "speed") return value;
  throw new ToolError(
    "bad-option",
    `"${String(value)}" is not a coloring mode.`,
    'Use "type" to paint every extrusion alike, or "speed" to ramp by feed rate.',
  );
}

function readLayerOption(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const n = toFiniteNumber(value);
  if (n === undefined || !Number.isInteger(n) || n < 0 || n > 10000) {
    throw new ToolError(
      "bad-option",
      `"${String(value)}" is not a layer number.`,
      "Use a whole number from 0 to 10000, where 0 draws the whole stack.",
    );
  }
  return n;
}

export function run(
  input: Uint8Array | string,
  opts: GcodeViewerOpts = {},
): Record<string, string> {
  const size = typeof input === "string" ? input.length : input.byteLength;
  if (size > MAX_BYTES) {
    throw new ToolError(
      "too-large",
      `That file is about ${formatBytes(size)}, larger than the ${formatBytes(MAX_BYTES)} limit.`,
      "Slice a smaller model, or split the program before loading it.",
    );
  }

  const text = typeof input === "string" ? input : new TextDecoder("utf-8").decode(input);
  if (text.trim() === "") {
    throw new ToolError("empty-input", "There is no G-code to read.", FIX_DROP);
  }

  const colorBy = readColorBy(opts.colorBy);
  const layerOption = readLayerOption(opts.layer);
  const showTravel = isTruthy(opts.showTravel);

  const model = parseGcode(text);
  const out = summarize(model);

  if (isTruthy(opts.svg) && model.layers.length > 0) {
    if (layerOption === 0) {
      const middle = Math.floor((model.layers.length - 1) / 2);
      out["All layers SVG"] = renderAllLayersSvg(model);
      out[`Layer ${middle + 1} SVG`] = renderLayerSvg(model, middle, { showTravel, colorBy });
    } else {
      const index = Math.min(layerOption - 1, model.layers.length - 1);
      out[`Layer ${index + 1} SVG`] = renderLayerSvg(model, index, { showTravel, colorBy });
    }
  }

  return out;
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  Record<string, string>,
  GcodeViewerOpts
>;

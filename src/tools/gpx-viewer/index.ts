/**
 * Track Viewer: GPX, KML and GeoJSON in, one common track model out.
 *
 * The logic layer is pure, so it cannot use DOMParser (it exists in neither
 * Node tests nor a Worker). XML is read with the small tolerant tokenizer
 * below: it understands tags, attributes, CDATA, comments, processing
 * instructions and character entities, ignores namespaces by folding every
 * tag to its lowercase local name, and raises `bad-xml` when the tag stack
 * does not balance. That is enough for GPX and KML, which are shallow and
 * machine generated.
 *
 * Nothing here fetches a map tile. `renderTrackSvg` projects the track onto a
 * plain SVG with an equirectangular projection whose x axis is corrected by
 * the cosine of the middle latitude, so shapes stay close to true at the scale
 * of a single activity.
 */
import { formatBytes } from "@/lib/format";
import { ToolError, type ToolLogic } from "../types";

/* ------------------------------------------------------------ the model -- */

export interface TrackPoint {
  lat: number;
  lon: number;
  /** Meters above sea level, when the file carried one. */
  ele?: number;
  /** Epoch milliseconds. Kept as a number so exports round trip exactly. */
  time?: number;
  /** 0-based segment index. Segments are flattened but the break is kept. */
  seg: number;
}

export interface TrackWaypoint {
  lat: number;
  lon: number;
  name?: string;
  ele?: number;
}

export type TrackSource = "gpx" | "kml" | "geojson";

export interface Track {
  name?: string;
  points: TrackPoint[];
  waypoints: TrackWaypoint[];
  source: TrackSource;
}

export interface BoundingBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export interface TrackStats {
  pointCount: number;
  segmentCount: number;
  waypointCount: number;
  distanceMeters: number;
  distanceKm: number;
  distanceMiles: number;
  hasElevation: boolean;
  gainMeters: number;
  lossMeters: number;
  minEle?: number;
  maxEle?: number;
  avgEle?: number;
  maxGradePercent?: number;
  hasTime: boolean;
  startTime?: number;
  endTime?: number;
  durationSeconds?: number;
  movingSeconds?: number;
  avgSpeedMps?: number;
  movingSpeedMps?: number;
  maxSpeedMps?: number;
  bounds?: BoundingBox;
}

export interface StatsOptions {
  /**
   * Elevation hysteresis in meters. A climb or descent only counts once the
   * reading differs from the last accepted reading by at least this much,
   * which stops GPS noise from inflating the totals. Default 3.
   */
  smoothing?: number;
  /**
   * Minimum horizontal run in meters before a grade sample is taken. Without
   * it, two points a meter apart turn half a meter of noise into a 50 percent
   * grade. Default 10.
   */
  minGradeRun?: number;
  /** Speed in m/s above which elapsed time counts as moving. Default 0.5. */
  movingThresholdMps?: number;
}

export interface GpxViewerOpts {
  units?: string;
  svg?: boolean;
  smoothing?: number;
  [key: string]: unknown;
}

/** Refuse anything past this, before decoding, so a huge drop fails fast. */
const MAX_BYTES = 50 * 1024 * 1024;
/** IUGG mean Earth radius in meters. */
const EARTH_RADIUS_M = 6371008.8;
/** Meters per degree of latitude, the constant the equirectangular scale uses. */
const METERS_PER_DEGREE = 111320;
const METERS_PER_MILE = 1609.344;
const METERS_PER_FOOT = 0.3048;

const DEFAULT_SMOOTHING = 3;
const DEFAULT_MIN_GRADE_RUN = 10;
const DEFAULT_MOVING_THRESHOLD = 0.5;

const FIX_DROP = "Drop a .gpx, .kml or .geojson file, or paste its text.";
const FONT_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const START_COLOR = "#16a34a";
const END_COLOR = "#dc2626";
const WAYPOINT_COLOR = "#2563eb";

/* -------------------------------------------------------- xml tokenizer -- */

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode the character entities GPX and KML actually use. Unknown ones stay as written. */
function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (whole: string, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        const code = Number.parseInt(body.slice(2), 16);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      if (body.startsWith("#")) {
        const code = Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named === undefined ? whole : named;
    },
  );
}

/** "gx:coord" and "GPX" both fold to a bare lowercase local name. */
function localName(raw: string): string {
  const colon = raw.lastIndexOf(":");
  return (colon === -1 ? raw : raw.slice(colon + 1)).toLowerCase();
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_:][-\w:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>]+)/g;
  let m = re.exec(source);
  while (m !== null) {
    let value = m[2];
    const first = value.charAt(0);
    if ((first === '"' || first === "'") && value.endsWith(first)) value = value.slice(1, -1);
    attrs[localName(m[1])] = decodeEntities(value);
    m = re.exec(source);
  }
  return attrs;
}

function badXml(message: string): ToolError {
  return new ToolError(
    "bad-xml",
    message,
    "Open the file in a text editor and check that every tag is closed, or export it again from the app that made it.",
  );
}

/**
 * Tolerant XML reader. Returns a synthetic root whose children are the
 * document's top level elements. Throws `bad-xml` when a tag is left open or
 * a close tag does not match the element it closes.
 */
export function parseXml(text: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const len = text.length;
  let i = 0;

  while (i < len) {
    const lt = text.indexOf("<", i);
    if (lt === -1) {
      stack[stack.length - 1].text += decodeEntities(text.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(text.slice(i, lt));

    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      if (end === -1) throw badXml("A comment starts but is never closed.");
      i = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      if (end === -1) throw badXml("A CDATA section starts but is never closed.");
      stack[stack.length - 1].text += text.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt + 2);
      if (end === -1) throw badXml("An XML declaration starts but is never closed.");
      i = end + 2;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      let j = lt + 2;
      let depth = 0;
      while (j < len) {
        const c = text.charAt(j);
        if (c === "[") depth += 1;
        else if (c === "]") depth -= 1;
        else if (c === ">" && depth <= 0) break;
        j += 1;
      }
      if (j >= len) throw badXml("A document type declaration is never closed.");
      i = j + 1;
      continue;
    }

    let j = lt + 1;
    let quote = "";
    while (j < len) {
      const c = text.charAt(j);
      if (quote !== "") {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        break;
      }
      j += 1;
    }
    if (j >= len) throw badXml("A tag is missing its closing angle bracket.");

    const raw = text.slice(lt + 1, j);
    i = j + 1;

    if (raw.startsWith("/")) {
      const name = localName(raw.slice(1).trim());
      const top = stack[stack.length - 1];
      if (stack.length > 1 && top.name === name) {
        stack.pop();
        continue;
      }
      if (stack.some((node) => node.name === name)) {
        throw badXml(`The tag <${top.name}> is closed by </${name}>.`);
      }
      // A stray close tag with no matching open tag: ignore it and read on.
      continue;
    }

    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^\s*([^\s/>]+)/.exec(body);
    if (!nameMatch) continue;
    const node: XmlNode = {
      name: localName(nameMatch[1]),
      attrs: parseAttrs(body.slice(nameMatch[0].length)),
      children: [],
      text: "",
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  if (stack.length > 1) {
    throw badXml(`The tag <${stack[stack.length - 1].name}> is never closed.`);
  }
  return root;
}

function firstNamed(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name);
}

function childText(node: XmlNode, name: string): string | undefined {
  const child = firstNamed(node, name);
  if (!child) return undefined;
  const value = child.text.trim();
  return value === "" ? undefined : value;
}

function findAllNamed(node: XmlNode, names: string[], out: XmlNode[] = []): XmlNode[] {
  for (const child of node.children) {
    if (names.includes(child.name)) out.push(child);
    findAllNamed(child, names, out);
  }
  return out;
}

function findFirstNamed(node: XmlNode, name: string): XmlNode | undefined {
  for (const child of node.children) {
    if (child.name === name) return child;
    const nested = findFirstNamed(child, name);
    if (nested) return nested;
  }
  return undefined;
}

/* -------------------------------------------------------- shared helpers -- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const n = Number.parseFloat(value.trim());
  return Number.isFinite(n) ? n : undefined;
}

function isLatLon(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/** ISO 8601 timestamps only, which is what GPX, KML and GeoJSON all use. */
function parseTimeText(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? ms : undefined;
}

function makePoint(
  lat: number,
  lon: number,
  ele: number | undefined,
  time: number | undefined,
  seg: number,
): TrackPoint {
  const point: TrackPoint = { lat, lon, seg };
  if (ele !== undefined) point.ele = ele;
  if (time !== undefined) point.time = time;
  return point;
}

/* ------------------------------------------------------ format detection -- */

/** Sniff the file type from its first meaningful characters and its tag names. */
export function detectFormat(text: string): TrackSource | null {
  const t = text.replace(/^\uFEFF/, "").trimStart();
  if (t.startsWith("{") || t.startsWith("[")) return "geojson";
  if (!t.startsWith("<")) return null;
  if (/<(?:[\w.-]+:)?gpx[\s>/]/i.test(t)) return "gpx";
  if (/<(?:[\w.-]+:)?kml[\s>/]/i.test(t)) return "kml";
  if (/<(?:[\w.-]+:)?(?:trkpt|trkseg|rtept|wpt)[\s>/]/i.test(t)) return "gpx";
  if (/<(?:[\w.-]+:)?(?:placemark|linestring|coordinates)[\s>/]/i.test(t)) return "kml";
  return null;
}

/* ------------------------------------------------------------ gpx parser -- */

function gpxPoint(node: XmlNode, seg: number): TrackPoint | null {
  const lat = toFiniteNumber(node.attrs.lat);
  const lon = toFiniteNumber(node.attrs.lon);
  if (lat === undefined || lon === undefined || !isLatLon(lat, lon)) return null;
  return makePoint(
    lat,
    lon,
    toFiniteNumber(childText(node, "ele")),
    parseTimeText(childText(node, "time")),
    seg,
  );
}

function parseGpx(root: XmlNode): Track {
  const gpx = firstNamed(root, "gpx") ?? root;
  const points: TrackPoint[] = [];
  const waypoints: TrackWaypoint[] = [];
  let seg = 0;

  const pushSegment = (nodes: XmlNode[]): void => {
    const collected: TrackPoint[] = [];
    for (const node of nodes) {
      const point = gpxPoint(node, seg);
      if (point) collected.push(point);
    }
    if (collected.length === 0) return;
    points.push(...collected);
    seg += 1;
  };

  for (const trk of findAllNamed(gpx, ["trk"])) {
    const segments = findAllNamed(trk, ["trkseg"]);
    if (segments.length === 0) {
      pushSegment(findAllNamed(trk, ["trkpt"]));
    } else {
      for (const trkseg of segments) pushSegment(findAllNamed(trkseg, ["trkpt"]));
    }
  }
  for (const rte of findAllNamed(gpx, ["rte"])) {
    pushSegment(findAllNamed(rte, ["rtept"]));
  }
  for (const wpt of findAllNamed(gpx, ["wpt"])) {
    const lat = toFiniteNumber(wpt.attrs.lat);
    const lon = toFiniteNumber(wpt.attrs.lon);
    if (lat === undefined || lon === undefined || !isLatLon(lat, lon)) continue;
    const waypoint: TrackWaypoint = { lat, lon };
    const name = childText(wpt, "name");
    if (name !== undefined) waypoint.name = name;
    const ele = toFiniteNumber(childText(wpt, "ele"));
    if (ele !== undefined) waypoint.ele = ele;
    waypoints.push(waypoint);
  }

  const metadata = findFirstNamed(gpx, "metadata");
  const firstTrk = findFirstNamed(gpx, "trk");
  const name =
    (metadata ? childText(metadata, "name") : undefined) ??
    (firstTrk ? childText(firstTrk, "name") : undefined);

  const track: Track = { points, waypoints, source: "gpx" };
  if (name !== undefined) track.name = name;
  return track;
}

/* ------------------------------------------------------------ kml parser -- */

/** KML `<coordinates>` holds whitespace separated "lon,lat[,alt]" tuples. */
function parseKmlCoordinates(text: string | undefined, seg: number): TrackPoint[] {
  if (text === undefined) return [];
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const out: TrackPoint[] = [];
  for (const tuple of trimmed.split(/\s+/)) {
    const parts = tuple.split(",");
    if (parts.length < 2) continue;
    const lon = toFiniteNumber(parts[0]);
    const lat = toFiniteNumber(parts[1]);
    if (lon === undefined || lat === undefined || !isLatLon(lat, lon)) continue;
    out.push(
      makePoint(lat, lon, parts.length > 2 ? toFiniteNumber(parts[2]) : undefined, undefined, seg),
    );
  }
  return out;
}

function parseKml(root: XmlNode): Track {
  const points: TrackPoint[] = [];
  const waypoints: TrackWaypoint[] = [];
  let seg = 0;
  let name: string | undefined;

  const placemarks = findAllNamed(root, ["placemark"]);
  const containers = placemarks.length > 0 ? placemarks : [root];

  for (const placemark of containers) {
    const placemarkName = childText(placemark, "name");
    const before = points.length;

    for (const line of findAllNamed(placemark, ["linestring", "linearring"])) {
      const coords = findFirstNamed(line, "coordinates");
      const collected = parseKmlCoordinates(coords?.text, seg);
      if (collected.length === 0) continue;
      points.push(...collected);
      seg += 1;
    }

    // gx:Track pairs <when> timestamps with <gx:coord> "lon lat ele" triples.
    for (const trackNode of findAllNamed(placemark, ["track"])) {
      const whens = trackNode.children.filter((c) => c.name === "when");
      const coords = trackNode.children.filter((c) => c.name === "coord");
      const collected: TrackPoint[] = [];
      coords.forEach((coord, index) => {
        const parts = coord.text.trim().split(/\s+/);
        if (parts.length < 2) return;
        const lon = toFiniteNumber(parts[0]);
        const lat = toFiniteNumber(parts[1]);
        if (lon === undefined || lat === undefined || !isLatLon(lat, lon)) return;
        const when = whens[index];
        collected.push(
          makePoint(
            lat,
            lon,
            parts.length > 2 ? toFiniteNumber(parts[2]) : undefined,
            when ? parseTimeText(when.text) : undefined,
            seg,
          ),
        );
      });
      if (collected.length === 0) continue;
      points.push(...collected);
      seg += 1;
    }

    if (name === undefined && points.length > before && placemarkName !== undefined) {
      name = placemarkName;
    }

    for (const pointNode of findAllNamed(placemark, ["point"])) {
      const coords = findFirstNamed(pointNode, "coordinates");
      for (const parsed of parseKmlCoordinates(coords?.text, 0)) {
        const waypoint: TrackWaypoint = { lat: parsed.lat, lon: parsed.lon };
        if (placemarkName !== undefined) waypoint.name = placemarkName;
        if (parsed.ele !== undefined) waypoint.ele = parsed.ele;
        waypoints.push(waypoint);
      }
    }
  }

  const documentNode = findFirstNamed(root, "document");
  const documentName = documentNode ? childText(documentNode, "name") : undefined;

  const track: Track = { points, waypoints, source: "kml" };
  const resolved = documentName ?? name;
  if (resolved !== undefined) track.name = resolved;
  return track;
}

/* -------------------------------------------------------- geojson parser -- */

function coordToPoint(value: unknown, seg: number): TrackPoint | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lon = toFiniteNumber(value[0]);
  const lat = toFiniteNumber(value[1]);
  if (lon === undefined || lat === undefined || !isLatLon(lat, lon)) return null;
  return makePoint(
    lat,
    lon,
    value.length > 2 ? toFiniteNumber(value[2]) : undefined,
    undefined,
    seg,
  );
}

/**
 * A coordTimes entry: an ISO string, epoch milliseconds, or epoch seconds.
 * Values under 1e11 are read as seconds, which covers every plausible date up
 * to the year 5138 without mistaking milliseconds for seconds.
 */
function timeAt(times: unknown, index: number): number | undefined {
  if (!Array.isArray(times)) return undefined;
  const value = times[index];
  if (typeof value === "string") return parseTimeText(value);
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e11 ? value * 1000 : value;
  }
  return undefined;
}

function parseGeoJson(text: string): Track {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new ToolError(
      "unknown-format",
      "That looks like JSON but it could not be parsed.",
      "Check for a trailing comma or a missing bracket, then try again.",
    );
  }

  const points: TrackPoint[] = [];
  const waypoints: TrackWaypoint[] = [];
  let seg = 0;
  let name: string | undefined;

  const addLine = (coords: unknown, times: unknown): void => {
    if (!Array.isArray(coords)) return;
    const collected: TrackPoint[] = [];
    coords.forEach((raw, index) => {
      const point = coordToPoint(raw, seg);
      if (!point) return;
      const time = timeAt(times, index);
      if (time !== undefined) point.time = time;
      collected.push(point);
    });
    if (collected.length === 0) return;
    points.push(...collected);
    seg += 1;
  };

  const addWaypoint = (raw: unknown, props: Record<string, unknown> | undefined): void => {
    const point = coordToPoint(raw, 0);
    if (!point) return;
    const waypoint: TrackWaypoint = { lat: point.lat, lon: point.lon };
    const label = props && typeof props.name === "string" ? props.name : undefined;
    if (label !== undefined) waypoint.name = label;
    if (point.ele !== undefined) waypoint.ele = point.ele;
    waypoints.push(waypoint);
  };

  const visitGeometry = (geometry: unknown, props: Record<string, unknown> | undefined): void => {
    if (!isRecord(geometry)) return;
    const type = typeof geometry.type === "string" ? geometry.type : "";
    const coords = geometry.coordinates;
    const times = props ? (props.coordTimes ?? props.times) : undefined;
    switch (type) {
      case "LineString":
        addLine(coords, times);
        break;
      case "MultiLineString":
        if (Array.isArray(coords)) {
          coords.forEach((line, index) =>
            addLine(line, Array.isArray(times) ? times[index] : undefined),
          );
        }
        break;
      case "Polygon":
        if (Array.isArray(coords)) coords.forEach((ring) => addLine(ring, undefined));
        break;
      case "MultiPolygon":
        if (Array.isArray(coords)) {
          for (const polygon of coords) {
            if (Array.isArray(polygon)) polygon.forEach((ring) => addLine(ring, undefined));
          }
        }
        break;
      case "Point":
        addWaypoint(coords, props);
        break;
      case "MultiPoint":
        if (Array.isArray(coords)) coords.forEach((raw) => addWaypoint(raw, props));
        break;
      case "GeometryCollection":
        if (Array.isArray(geometry.geometries)) {
          geometry.geometries.forEach((child) => visitGeometry(child, props));
        }
        break;
      default:
        break;
    }
  };

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRecord(node)) return;
    const type = typeof node.type === "string" ? node.type : "";
    if (type === "FeatureCollection") {
      if (name === undefined && typeof node.name === "string") name = node.name;
      if (Array.isArray(node.features)) node.features.forEach(visit);
      return;
    }
    if (type === "Feature") {
      const props = isRecord(node.properties) ? node.properties : undefined;
      const before = points.length;
      visitGeometry(node.geometry, props);
      if (name === undefined && points.length > before && props && typeof props.name === "string") {
        name = props.name;
      }
      return;
    }
    visitGeometry(node, undefined);
  };

  visit(data);

  const track: Track = { points, waypoints, source: "geojson" };
  if (name !== undefined) track.name = name;
  return track;
}

/* ------------------------------------------------------------- parseTrack -- */

/** Detect the format and parse it into the common track model. */
export function parseTrack(text: string): Track {
  const format = detectFormat(text);
  if (format === null) {
    throw new ToolError("unknown-format", "That does not look like GPX, KML or GeoJSON.", FIX_DROP);
  }
  if (format === "geojson") return parseGeoJson(text);
  const root = parseXml(text);
  return format === "gpx" ? parseGpx(root) : parseKml(root);
}

/* -------------------------------------------------------------- geo math -- */

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great circle distance in meters between two coordinates. */
export function haversineMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Distance from the first point to each point, in meters. The jump between two
 * segments adds nothing: a paused recording should not bill the user for the
 * straight line across the gap.
 */
export function cumulativeDistances(points: TrackPoint[]): number[] {
  const out: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    if (i > 0 && points[i].seg === points[i - 1].seg) {
      total += haversineMeters(points[i - 1], points[i]);
    }
    out.push(total);
  }
  return out;
}

function boundsOf(coords: { lat: number; lon: number }[]): BoundingBox | undefined {
  if (coords.length === 0) return undefined;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const c of coords) {
    if (c.lat < minLat) minLat = c.lat;
    if (c.lat > maxLat) maxLat = c.lat;
    if (c.lon < minLon) minLon = c.lon;
    if (c.lon > maxLon) maxLon = c.lon;
  }
  return { minLat, minLon, maxLat, maxLon };
}

/* ----------------------------------------------------------------- stats -- */

/**
 * Every number the panel and the output rows need.
 *
 * Elevation gain and loss use a last-accepted hysteresis: a change only counts
 * once the reading differs from the last accepted reading by `smoothing`
 * meters (3 by default), at which point the whole difference is booked and the
 * accepted reading moves. Grade samples need `minGradeRun` meters of
 * horizontal travel so a meter of GPS jitter cannot report a cliff. Both
 * counters restart at a segment boundary, as does distance.
 */
export function trackStats(track: Track, options: StatsOptions = {}): TrackStats {
  const smoothing = Math.max(0, options.smoothing ?? DEFAULT_SMOOTHING);
  const minGradeRun = Math.max(0, options.minGradeRun ?? DEFAULT_MIN_GRADE_RUN);
  const movingThreshold = Math.max(0, options.movingThresholdMps ?? DEFAULT_MOVING_THRESHOLD);

  const points = track.points;
  const segments = new Set<number>();
  for (const p of points) segments.add(p.seg);

  let distance = 0;
  let movingSeconds = 0;
  let maxSpeed: number | undefined;

  let gain = 0;
  let loss = 0;
  let lastAccepted: number | undefined;
  let minEle: number | undefined;
  let maxEle: number | undefined;
  let eleSum = 0;
  let eleCount = 0;

  let gradeAnchor: TrackPoint | undefined;
  let gradeRun = 0;
  let maxGrade: number | undefined;

  let startTime: number | undefined;
  let endTime: number | undefined;

  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    const sameSegment = i > 0 && point.seg === points[i - 1].seg;

    if (point.ele !== undefined) {
      eleSum += point.ele;
      eleCount += 1;
      if (minEle === undefined || point.ele < minEle) minEle = point.ele;
      if (maxEle === undefined || point.ele > maxEle) maxEle = point.ele;
      if (!sameSegment || lastAccepted === undefined) {
        lastAccepted = point.ele;
      } else {
        const delta = point.ele - lastAccepted;
        if (Math.abs(delta) >= smoothing) {
          if (delta > 0) gain += delta;
          else loss += -delta;
          lastAccepted = point.ele;
        }
      }
    }

    if (point.time !== undefined) {
      if (startTime === undefined || point.time < startTime) startTime = point.time;
      if (endTime === undefined || point.time > endTime) endTime = point.time;
    }

    if (!sameSegment) {
      gradeAnchor = point;
      gradeRun = 0;
      continue;
    }

    const previous = points[i - 1];
    const leg = haversineMeters(previous, point);
    distance += leg;

    if (previous.time !== undefined && point.time !== undefined) {
      const dt = (point.time - previous.time) / 1000;
      if (dt > 0) {
        const speed = leg / dt;
        if (maxSpeed === undefined || speed > maxSpeed) maxSpeed = speed;
        if (speed > movingThreshold) movingSeconds += dt;
      }
    }

    gradeRun += leg;
    if (gradeAnchor !== undefined && gradeRun >= minGradeRun && gradeRun > 0) {
      if (gradeAnchor.ele !== undefined && point.ele !== undefined) {
        const grade = ((point.ele - gradeAnchor.ele) / gradeRun) * 100;
        if (maxGrade === undefined || grade > maxGrade) maxGrade = grade;
      }
      gradeAnchor = point;
      gradeRun = 0;
    }
  }

  const bounds = boundsOf([...points, ...track.waypoints]);
  const hasTime = startTime !== undefined && endTime !== undefined;
  const durationSeconds =
    startTime !== undefined && endTime !== undefined ? (endTime - startTime) / 1000 : undefined;

  const stats: TrackStats = {
    pointCount: points.length,
    segmentCount: segments.size,
    waypointCount: track.waypoints.length,
    distanceMeters: distance,
    distanceKm: distance / 1000,
    distanceMiles: distance / METERS_PER_MILE,
    hasElevation: eleCount > 0,
    gainMeters: gain,
    lossMeters: loss,
    hasTime,
  };

  if (minEle !== undefined) stats.minEle = minEle;
  if (maxEle !== undefined) stats.maxEle = maxEle;
  if (eleCount > 0) stats.avgEle = eleSum / eleCount;
  if (maxGrade !== undefined) stats.maxGradePercent = maxGrade;
  if (startTime !== undefined) stats.startTime = startTime;
  if (endTime !== undefined) stats.endTime = endTime;
  if (durationSeconds !== undefined) {
    stats.durationSeconds = durationSeconds;
    stats.movingSeconds = movingSeconds;
    if (durationSeconds > 0) stats.avgSpeedMps = distance / durationSeconds;
    if (movingSeconds > 0) stats.movingSpeedMps = distance / movingSeconds;
  }
  if (maxSpeed !== undefined) stats.maxSpeedMps = maxSpeed;
  if (bounds !== undefined) stats.bounds = bounds;

  return stats;
}

/* ------------------------------------------------------ trim and reduce -- */

function clone(track: Track, points: TrackPoint[]): Track {
  const next: Track = { points, waypoints: track.waypoints.slice(), source: track.source };
  if (track.name !== undefined) next.name = track.name;
  return next;
}

/** Keep points from `startIndex` to `endIndex`, both inclusive. Indexes are clamped. */
export function trimTrack(track: Track, startIndex: number, endIndex: number): Track {
  const last = track.points.length - 1;
  if (last < 0) return clone(track, []);
  const lo = Math.min(Math.max(Math.trunc(startIndex), 0), last);
  const hi = Math.min(Math.max(Math.trunc(endIndex), lo), last);
  return clone(track, track.points.slice(lo, hi + 1));
}

/**
 * Keep points whose timestamp falls in [startMs, endMs], both inclusive.
 * Points with no timestamp are dropped, so a file without times trims to empty.
 */
export function trimByTime(track: Track, startMs: number, endMs: number): Track {
  const lo = Math.min(startMs, endMs);
  const hi = Math.max(startMs, endMs);
  return clone(
    track,
    track.points.filter((p) => p.time !== undefined && p.time >= lo && p.time <= hi),
  );
}

/** Keep every nth point so at most `maxPoints` remain. First and last always survive. */
export function downsample(track: Track, maxPoints: number): Track {
  const limit = Math.max(2, Math.trunc(maxPoints));
  const total = track.points.length;
  if (total <= limit) return clone(track, track.points.slice());
  const step = Math.ceil(total / limit);
  const kept: TrackPoint[] = [];
  for (let i = 0; i < total; i += step) kept.push(track.points[i]);
  if (kept[kept.length - 1] !== track.points[total - 1]) kept.push(track.points[total - 1]);
  return clone(track, kept);
}

/* ------------------------------------------------------------- exporters -- */

/** Escape for both element content and attribute values. */
function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

/** GPX 1.1. Coordinates go out with `String()` so a re-parse gives the same numbers. */
export function toGpx(track: Track): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<gpx version="1.1" creator="tools.maxhogan.dev" xmlns="http://www.topografix.com/GPX/1/1">',
  );
  if (track.name !== undefined) {
    lines.push(`  <metadata><name>${escapeXmlText(track.name)}</name></metadata>`);
  }
  for (const waypoint of track.waypoints) {
    lines.push(`  <wpt lat="${String(waypoint.lat)}" lon="${String(waypoint.lon)}">`);
    if (waypoint.ele !== undefined) lines.push(`    <ele>${String(waypoint.ele)}</ele>`);
    if (waypoint.name !== undefined) lines.push(`    <name>${escapeXmlText(waypoint.name)}</name>`);
    lines.push("  </wpt>");
  }
  if (track.points.length > 0) {
    lines.push("  <trk>");
    if (track.name !== undefined) lines.push(`    <name>${escapeXmlText(track.name)}</name>`);
    let open = false;
    let currentSeg: number | undefined;
    for (const point of track.points) {
      if (!open || point.seg !== currentSeg) {
        if (open) lines.push("    </trkseg>");
        lines.push("    <trkseg>");
        open = true;
        currentSeg = point.seg;
      }
      lines.push(`      <trkpt lat="${String(point.lat)}" lon="${String(point.lon)}">`);
      if (point.ele !== undefined) lines.push(`        <ele>${String(point.ele)}</ele>`);
      if (point.time !== undefined) lines.push(`        <time>${isoTime(point.time)}</time>`);
      lines.push("      </trkpt>");
    }
    if (open) lines.push("    </trkseg>");
    lines.push("  </trk>");
  }
  lines.push("</gpx>");
  return `${lines.join("\n")}\n`;
}

/** GeoJSON FeatureCollection: one line feature per segment plus a point per waypoint. */
export function toGeoJson(track: Track): string {
  const segments: TrackPoint[][] = [];
  for (const point of track.points) {
    const last = segments[segments.length - 1];
    if (!last || last[0].seg !== point.seg) segments.push([point]);
    else last.push(point);
  }

  const features: unknown[] = [];
  for (const segment of segments) {
    const coordinates = segment.map((p) =>
      p.ele === undefined ? [p.lon, p.lat] : [p.lon, p.lat, p.ele],
    );
    const properties: Record<string, unknown> = {};
    if (track.name !== undefined) properties.name = track.name;
    if (segment.some((p) => p.time !== undefined)) {
      properties.coordTimes = segment.map((p) => (p.time === undefined ? null : isoTime(p.time)));
    }
    features.push({
      type: "Feature",
      properties,
      geometry: { type: "LineString", coordinates },
    });
  }
  for (const waypoint of track.waypoints) {
    const properties: Record<string, unknown> = {};
    if (waypoint.name !== undefined) properties.name = waypoint.name;
    features.push({
      type: "Feature",
      properties,
      geometry: {
        type: "Point",
        coordinates:
          waypoint.ele === undefined
            ? [waypoint.lon, waypoint.lat]
            : [waypoint.lon, waypoint.lat, waypoint.ele],
      },
    });
  }

  return `${JSON.stringify({ type: "FeatureCollection", features }, null, 2)}\n`;
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** One row per track point, with the running distance already worked out. */
export function toCsv(track: Track): string {
  const distances = cumulativeDistances(track.points);
  const rows: string[] = ["segment,index,latitude,longitude,elevation_m,time,distance_m"];
  track.points.forEach((point, index) => {
    rows.push(
      [
        String(point.seg),
        String(index),
        String(point.lat),
        String(point.lon),
        point.ele === undefined ? "" : String(point.ele),
        point.time === undefined ? "" : isoTime(point.time),
        distances[index].toFixed(2),
      ]
        .map(csvCell)
        .join(","),
    );
  });
  return `${rows.join("\n")}\n`;
}

/* ------------------------------------------------------------ renderers -- */

export interface ElevationSample {
  distanceMeters: number;
  elevationMeters: number;
}

export interface RenderOptions {
  width?: number;
  height?: number;
  padding?: number;
  units?: string;
}

/**
 * Elevation against distance, resampled to `samples` evenly spaced positions so
 * a 20000 point ride still draws in a fixed number of path commands. Returns an
 * empty array when the file carries no elevation.
 */
export function elevationProfile(track: Track, samples = 200): ElevationSample[] {
  const distances = cumulativeDistances(track.points);
  const raw: ElevationSample[] = [];
  track.points.forEach((point, index) => {
    if (point.ele === undefined) return;
    raw.push({ distanceMeters: distances[index], elevationMeters: point.ele });
  });
  if (raw.length < 2) return raw;

  const total = raw[raw.length - 1].distanceMeters - raw[0].distanceMeters;
  const count = Math.max(2, Math.trunc(samples));
  if (total <= 0 || raw.length <= count) return raw;

  const start = raw[0].distanceMeters;
  const out: ElevationSample[] = [];
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    const target = start + (total * i) / (count - 1);
    while (cursor < raw.length - 2 && raw[cursor + 1].distanceMeters < target) cursor += 1;
    const a = raw[cursor];
    const b = raw[cursor + 1];
    const span = b.distanceMeters - a.distanceMeters;
    const t = span > 0 ? Math.min(1, Math.max(0, (target - a.distanceMeters) / span)) : 0;
    out.push({
      distanceMeters: target,
      elevationMeters: a.elevationMeters + (b.elevationMeters - a.elevationMeters) * t,
    });
  }
  return out;
}

/** Round a coordinate so the SVG never carries floating point dust. */
function n(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 100) / 100;
  return String(rounded === 0 ? 0 : rounded);
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}

function svgOpen(width: number, height: number, label: string, extra: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXmlText(label)}" font-family="${FONT_STACK}" font-size="11"${extra}>`;
}

function emptySvg(width: number, height: number, message: string): string {
  return [
    svgOpen(width, height, message, ""),
    `<text x="${n(width / 2)}" y="${n(height / 2)}" text-anchor="middle" fill="currentColor" opacity="0.6">${escapeXmlText(message)}</text>`,
    "</svg>",
  ].join("");
}

/** Largest 1, 2 or 5 times a power of ten that still fits inside `target`. */
function niceLength(target: number): number {
  if (!Number.isFinite(target) || target <= 0) return 1;
  const exponent = Math.floor(Math.log10(target));
  const base = Math.pow(10, exponent);
  for (const factor of [5, 2, 1]) {
    if (factor * base <= target) return factor * base;
  }
  return base;
}

function isImperial(units: string | undefined): boolean {
  if (typeof units !== "string") return false;
  const key = units.trim().toLowerCase();
  return ["imperial", "us", "mi", "mile", "miles", "feet", "ft", "statute"].includes(key);
}

function scaleBarLabel(meters: number, imperial: boolean): string {
  if (imperial) {
    const miles = meters / METERS_PER_MILE;
    return miles >= 0.1
      ? `${stripTrailingZeros(miles.toFixed(2))} mi`
      : `${Math.round(meters / METERS_PER_FOOT)} ft`;
  }
  return meters >= 1000
    ? `${stripTrailingZeros((meters / 1000).toFixed(2))} km`
    : `${Math.round(meters)} m`;
}

function stripTrailingZeros(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

/**
 * The track on a plain canvas: no basemap, no tiles, no third party request.
 * The projection is equirectangular with the x axis multiplied by the cosine
 * of the middle latitude, which keeps a single activity close to true shape.
 * Output is deterministic for a given track and options.
 */
export function renderTrackSvg(track: Track, options: RenderOptions = {}): string {
  const width = clampInt(options.width ?? 640, 80, 4000);
  const height = clampInt(options.height ?? 420, 80, 4000);
  const pad = clampInt(options.padding ?? 28, 4, Math.floor(Math.min(width, height) / 4));
  const imperial = isImperial(options.units);

  const coords: { lat: number; lon: number }[] = [...track.points, ...track.waypoints];
  const bounds = boundsOf(coords);
  if (bounds === undefined) return emptySvg(width, height, "No coordinates to draw");

  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const kx = Math.max(Math.cos(toRadians(midLat)), 0.01);
  const rawSpanX = (bounds.maxLon - bounds.minLon) * kx;
  const rawSpanY = bounds.maxLat - bounds.minLat;
  const degenerate = rawSpanX <= 0 && rawSpanY <= 0;
  const spanX = Math.max(rawSpanX, 1e-5);
  const spanY = Math.max(rawSpanY, 1e-5);
  const innerW = Math.max(width - pad * 2, 1);
  const innerH = Math.max(height - pad * 2, 1);
  const scale = Math.min(innerW / spanX, innerH / spanY);
  const offX = pad + (innerW - spanX * scale) / 2;
  const offY = pad + (innerH - spanY * scale) / 2;

  const px = (lon: number): number => offX + (lon - bounds.minLon) * kx * scale;
  const py = (lat: number): number => offY + (bounds.maxLat - lat) * scale;

  const parts: string[] = [];
  parts.push(
    svgOpen(
      width,
      height,
      track.name ? `Track map for ${track.name}` : "Track map",
      ` data-point-count="${track.points.length}" data-source="${track.source}"`,
    ),
  );

  if (track.points.length > 0) {
    const d: string[] = [];
    track.points.forEach((point, index) => {
      const command = index === 0 || point.seg !== track.points[index - 1].seg ? "M" : "L";
      d.push(`${command}${n(px(point.lon))} ${n(py(point.lat))}`);
    });
    parts.push(
      `<path class="track-line" d="${d.join(" ")}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
    const first = track.points[0];
    const last = track.points[track.points.length - 1];
    parts.push(
      `<circle class="track-start" cx="${n(px(first.lon))}" cy="${n(py(first.lat))}" r="5" fill="${START_COLOR}"/>`,
    );
    parts.push(
      `<circle class="track-end" cx="${n(px(last.lon))}" cy="${n(py(last.lat))}" r="5" fill="${END_COLOR}"/>`,
    );
  }

  for (const waypoint of track.waypoints) {
    const x = px(waypoint.lon);
    const y = py(waypoint.lat);
    parts.push(
      `<circle class="track-waypoint" cx="${n(x)}" cy="${n(y)}" r="3.5" fill="${WAYPOINT_COLOR}"/>`,
    );
    if (waypoint.name !== undefined) {
      const label = waypoint.name.length > 24 ? `${waypoint.name.slice(0, 23)}...` : waypoint.name;
      parts.push(
        `<text x="${n(x + 7)}" y="${n(y + 4)}" fill="currentColor">${escapeXmlText(label)}</text>`,
      );
    }
  }

  if (!degenerate) {
    const metersPerPixel = METERS_PER_DEGREE / scale;
    const barMeters = niceLength((innerW / 3) * metersPerPixel);
    const barPixels = Math.min(barMeters / metersPerPixel, innerW);
    const barY = height - pad / 2;
    const barX = pad;
    parts.push(
      `<path class="track-scale" d="M${n(barX)} ${n(barY - 4)}V${n(barY)}H${n(barX + barPixels)}V${n(barY - 4)}" fill="none" stroke="currentColor" stroke-width="1.5"/>`,
    );
    parts.push(
      `<text x="${n(barX + barPixels + 6)}" y="${n(barY + 1)}" fill="currentColor">${escapeXmlText(scaleBarLabel(barMeters, imperial))}</text>`,
    );
  }

  const arrowX = width - pad / 2;
  const arrowTop = pad / 2;
  parts.push(
    `<path class="track-north" d="M${n(arrowX)} ${n(arrowTop)}l-5 14l5 -4l5 4z" fill="currentColor"/>`,
  );
  parts.push(
    `<text x="${n(arrowX)}" y="${n(arrowTop + 26)}" text-anchor="middle" fill="currentColor">N</text>`,
  );

  parts.push("</svg>");
  return parts.join("");
}

/**
 * Elevation against distance as a filled area, with the min and max labeled.
 * Deterministic for a given track and options.
 */
export function renderElevationSvg(track: Track, options: RenderOptions = {}): string {
  const width = clampInt(options.width ?? 640, 80, 4000);
  const height = clampInt(options.height ?? 200, 60, 2000);
  const pad = clampInt(options.padding ?? 24, 4, Math.floor(Math.min(width, height) / 4));
  const imperial = isImperial(options.units);

  const profile = elevationProfile(track, Math.min(600, Math.max(2, Math.floor(width))));
  if (profile.length < 2) return emptySvg(width, height, "No elevation data in this track");

  const startDistance = profile[0].distanceMeters;
  const endDistance = profile[profile.length - 1].distanceMeters;
  const totalDistance = Math.max(endDistance - startDistance, 1e-6);

  let minEle = Infinity;
  let maxEle = -Infinity;
  for (const sample of profile) {
    if (sample.elevationMeters < minEle) minEle = sample.elevationMeters;
    if (sample.elevationMeters > maxEle) maxEle = sample.elevationMeters;
  }
  const eleSpan = Math.max(maxEle - minEle, 1e-6);

  const innerW = Math.max(width - pad * 2, 1);
  const innerH = Math.max(height - pad * 2, 1);
  const x = (distance: number): number =>
    pad + ((distance - startDistance) / totalDistance) * innerW;
  const y = (elevation: number): number => pad + (1 - (elevation - minEle) / eleSpan) * innerH;
  const baseline = pad + innerH;

  const line = profile
    .map(
      (sample, index) =>
        `${index === 0 ? "M" : "L"}${n(x(sample.distanceMeters))} ${n(y(sample.elevationMeters))}`,
    )
    .join(" ");
  const area = `${line} L${n(x(endDistance))} ${n(baseline)} L${n(x(startDistance))} ${n(baseline)} Z`;

  const parts: string[] = [];
  parts.push(
    svgOpen(
      width,
      height,
      "Elevation profile",
      ` data-min-elevation="${n(minEle)}" data-max-elevation="${n(maxEle)}" data-distance-m="${n(totalDistance)}"`,
    ),
  );
  parts.push(`<path class="elevation-area" d="${area}" fill="currentColor" opacity="0.15"/>`);
  parts.push(
    `<path class="elevation-line" d="${line}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>`,
  );
  parts.push(
    `<text x="${n(pad)}" y="${n(pad - 6)}" fill="currentColor">${escapeXmlText(formatElevation(maxEle, imperial))}</text>`,
  );
  parts.push(
    `<text x="${n(pad)}" y="${n(baseline + 14)}" fill="currentColor">${escapeXmlText(formatElevation(minEle, imperial))}</text>`,
  );
  parts.push(
    `<text x="${n(width - pad)}" y="${n(baseline + 14)}" text-anchor="end" fill="currentColor">${escapeXmlText(formatDistance(totalDistance, imperial))}</text>`,
  );
  parts.push("</svg>");
  return parts.join("");
}

/* ------------------------------------------------------------ formatting -- */

function pad2(value: number): string {
  return String(Math.trunc(value)).padStart(2, "0");
}

function formatDistance(meters: number, imperial: boolean): string {
  if (imperial) {
    const miles = meters / METERS_PER_MILE;
    return miles < 0.1 ? `${(meters / METERS_PER_FOOT).toFixed(0)} ft` : `${miles.toFixed(2)} mi`;
  }
  return meters < 1000 ? `${meters.toFixed(0)} m` : `${(meters / 1000).toFixed(2)} km`;
}

function formatElevation(meters: number, imperial: boolean, decimals = 0): string {
  return imperial
    ? `${(meters / METERS_PER_FOOT).toFixed(decimals)} ft`
    : `${meters.toFixed(decimals)} m`;
}

function formatSpeed(mps: number, imperial: boolean): string {
  return imperial
    ? `${((mps * 3600) / METERS_PER_MILE).toFixed(2)} mph`
    : `${(mps * 3.6).toFixed(2)} km/h`;
}

function formatPace(mps: number, imperial: boolean): string {
  if (!Number.isFinite(mps) || mps <= 0) return "n/a";
  const secondsPerUnit = (imperial ? METERS_PER_MILE : 1000) / mps;
  const minutes = Math.floor(secondsPerUnit / 60);
  const seconds = Math.round(secondsPerUnit - minutes * 60);
  const carry = seconds === 60;
  return `${carry ? minutes + 1 : minutes}:${pad2(carry ? 0 : seconds)} ${imperial ? "/mi" : "/km"}`;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${pad2(minutes)}m ${pad2(secs)}s`;
  if (minutes > 0) return `${minutes}m ${pad2(secs)}s`;
  return `${secs}s`;
}

function formatBounds(bounds: BoundingBox): string {
  return `${bounds.minLat.toFixed(5)}, ${bounds.minLon.toFixed(5)} to ${bounds.maxLat.toFixed(5)}, ${bounds.maxLon.toFixed(5)}`;
}

const SOURCE_LABELS: Record<TrackSource, string> = {
  gpx: "GPX",
  kml: "KML",
  geojson: "GeoJSON",
};

/* ------------------------------------------------------------------- run -- */

export function run(input: Uint8Array | string, opts: GpxViewerOpts = {}): Record<string, string> {
  const size = typeof input === "string" ? input.length : input.byteLength;
  if (size > MAX_BYTES) {
    throw new ToolError(
      "too-large",
      `That input is about ${formatBytes(size)}, larger than the ${formatBytes(MAX_BYTES)} limit.`,
      "Split the file or reduce the recording rate, then try again.",
    );
  }

  const text = typeof input === "string" ? input : new TextDecoder("utf-8").decode(input);
  if (text.trim() === "") {
    throw new ToolError("empty-input", "There is no track to read.", FIX_DROP);
  }

  const track = parseTrack(text);
  if (track.points.length === 0 && track.waypoints.length === 0) {
    throw new ToolError(
      "no-points",
      "That file parsed cleanly but holds no coordinates.",
      "Check that it contains a track, a route, or at least one waypoint.",
    );
  }

  const imperial = isImperial(typeof opts.units === "string" ? opts.units : undefined);
  const smoothingRaw = toFiniteNumber(opts.smoothing);
  const smoothing = Math.min(Math.max(smoothingRaw ?? DEFAULT_SMOOTHING, 0), 20);
  const stats = trackStats(track, { smoothing });

  const out: Record<string, string> = {
    Format: SOURCE_LABELS[track.source],
    "Track name": track.name ?? "(unnamed)",
    Points: String(stats.pointCount),
    Segments: String(stats.segmentCount),
    Waypoints: String(stats.waypointCount),
    Distance: formatDistance(stats.distanceMeters, imperial),
  };

  if (stats.hasElevation) {
    out["Elevation gain"] = formatElevation(stats.gainMeters, imperial);
    out["Elevation loss"] = formatElevation(stats.lossMeters, imperial);
    if (stats.minEle !== undefined) out["Min elevation"] = formatElevation(stats.minEle, imperial);
    if (stats.maxEle !== undefined) out["Max elevation"] = formatElevation(stats.maxEle, imperial);
    if (stats.avgEle !== undefined) {
      out["Average elevation"] = formatElevation(stats.avgEle, imperial, 1);
    }
    if (stats.maxGradePercent !== undefined) {
      out["Max grade"] = `${stats.maxGradePercent.toFixed(1)}%`;
    }
    out["Smoothing threshold"] = formatElevation(smoothing, imperial, imperial ? 1 : 0);
  }

  if (stats.hasTime && stats.startTime !== undefined && stats.endTime !== undefined) {
    out["Start time"] = isoTime(stats.startTime);
    out["End time"] = isoTime(stats.endTime);
    if (stats.durationSeconds !== undefined)
      out["Duration"] = formatDuration(stats.durationSeconds);
    if (stats.movingSeconds !== undefined) out["Moving time"] = formatDuration(stats.movingSeconds);
    if (stats.avgSpeedMps !== undefined) {
      out["Average speed"] = formatSpeed(stats.avgSpeedMps, imperial);
      out["Average pace"] = formatPace(stats.avgSpeedMps, imperial);
    }
    if (stats.movingSpeedMps !== undefined) {
      out["Moving speed"] = formatSpeed(stats.movingSpeedMps, imperial);
    }
    if (stats.maxSpeedMps !== undefined)
      out["Max speed"] = formatSpeed(stats.maxSpeedMps, imperial);
  }

  if (stats.bounds !== undefined) out["Bounding box"] = formatBounds(stats.bounds);

  if (opts.svg === true) {
    const units = imperial ? "imperial" : "metric";
    out["Track SVG"] = renderTrackSvg(track, { units });
    out["Elevation SVG"] = renderElevationSvg(track, { units });
  }

  return out;
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  Record<string, string>,
  GpxViewerOpts
>;

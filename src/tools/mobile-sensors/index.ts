import { ToolError, type ToolLogic } from "../types";

/**
 * The math core of the Mobile Sensors Explorer.
 *
 * The panel owns everything that only exists in a real browser session:
 * DeviceOrientationEvent, DeviceMotionEvent, the iOS permission gesture, and
 * the Generic Sensor API constructors. Every formula that turns a raw sensor
 * reading into a heading, a tilt angle, a vector magnitude, or a smoothed
 * value lives here, pure and unit tested, so the live readouts and the
 * bubble level and compass drawing never disagree with each other.
 */

/* ------------------------------------------------------------------ *
 * angles
 * ------------------------------------------------------------------ */

/** Wrap any angle in degrees into the range [0, 360). */
export function normalizeDegrees(deg: number): number {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Clamp a number between a minimum and a maximum. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Compass heading from a DeviceOrientationEvent's `alpha` value.
 *
 * `alpha` is 0 at the device's initial orientation, increasing counter
 * clockwise as the device turns, so a compass heading (0 at north,
 * increasing clockwise) is `360 - alpha`. When the page is viewed in a
 * rotated screen orientation (portrait vs landscape), `screenAngle` is the
 * `screen.orientation.angle` degrees the OS has rotated the viewport by, and
 * is subtracted to keep the heading aligned with true north regardless of
 * how the device is held.
 */
export function compassHeading(alpha: number, screenAngle = 0): number {
  return normalizeDegrees(360 - alpha - screenAngle);
}

const COMPASS_POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** The nearest of the 8 compass points for a heading in degrees. */
export function compassDirection(heading: number): string {
  const normalized = normalizeDegrees(heading);
  const index = Math.round(normalized / 45) % 8;
  return COMPASS_POINTS[index] as string;
}

/* ------------------------------------------------------------------ *
 * tilt
 * ------------------------------------------------------------------ */

export interface Tilt {
  /** Front-back tilt in degrees, from `beta`. Positive tips the top away from you. */
  pitch: number;
  /** Left-right tilt in degrees, from `gamma`. Positive tips the right edge down. */
  roll: number;
  /** Combined tilt off flat, in degrees. */
  magnitude: number;
}

/**
 * Pitch and roll from a DeviceOrientationEvent's `beta` (-180..180) and
 * `gamma` (-90..90). Both are clamped to their spec range so a noisy or
 * out-of-range reading cannot produce a nonsensical tilt, and the combined
 * magnitude is the Euclidean length of the two angles, which is a good
 * enough approximation of "how far off flat" for a bubble level at the
 * small angles a level is actually used at.
 */
export function tiltFromOrientation(beta: number, gamma: number): Tilt {
  const pitch = clamp(beta, -180, 180);
  const roll = clamp(gamma, -90, 90);
  const magnitude = Math.sqrt(pitch * pitch + roll * roll);
  return { pitch, roll, magnitude };
}

export interface BubbleOffset {
  /** -1..1, left to right. */
  x: number;
  /** -1..1, back to front. */
  y: number;
}

/**
 * Normalized bubble position for a simple two-axis level, mapping roll to
 * the horizontal axis and pitch to the vertical axis. `maxAngle` is the tilt,
 * in degrees, at which the bubble reaches the edge of its track; the default
 * of 45 keeps the bubble usably sensitive near flat while still saturating
 * before the device is on its side.
 */
export function bubbleLevelOffset(beta: number, gamma: number, maxAngle = 45): BubbleOffset {
  const { pitch, roll } = tiltFromOrientation(beta, gamma);
  const span = maxAngle <= 0 ? 1 : maxAngle;
  return {
    x: clamp(roll / span, -1, 1),
    y: clamp(pitch / span, -1, 1),
  };
}

/* ------------------------------------------------------------------ *
 * vectors
 * ------------------------------------------------------------------ */

/** Euclidean magnitude of a 3-axis vector, e.g. accelerometer x/y/z. */
export function vectorMagnitude(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

/* ------------------------------------------------------------------ *
 * smoothing
 * ------------------------------------------------------------------ */

/**
 * A single step of exponential moving average low-pass smoothing.
 *
 * `smoothing` is the weight given to the new sample, from 0 (ignore new
 * readings entirely, output never changes) to 1 (no smoothing, output
 * tracks the raw signal exactly). A live sensor readout typically wants
 * something around 0.15-0.3 so jitter is damped without feeling laggy.
 * `previous` of `null` means "no prior sample", which returns `next`
 * unchanged so the very first reading is not damped toward zero.
 */
export function lowPassFilter(previous: number | null, next: number, smoothing: number): number {
  if (previous === null || !Number.isFinite(previous)) return next;
  const weight = clamp(smoothing, 0, 1);
  return previous + weight * (next - previous);
}

/**
 * The same smoothing step applied independently to each field of a 3-axis
 * vector. Handy for smoothing accelerometer or rotation-rate readings, whose
 * three axes should not bleed into each other.
 */
export function lowPassFilterVector(
  previous: { x: number; y: number; z: number } | null,
  next: { x: number; y: number; z: number },
  smoothing: number,
): { x: number; y: number; z: number } {
  return {
    x: lowPassFilter(previous?.x ?? null, next.x, smoothing),
    y: lowPassFilter(previous?.y ?? null, next.y, smoothing),
    z: lowPassFilter(previous?.z ?? null, next.z, smoothing),
  };
}

/* ------------------------------------------------------------------ *
 * snapshot: a plain, serializable readout for the pure `run` surface
 * ------------------------------------------------------------------ */

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface OrientationReading {
  alpha: number;
  beta: number;
  gamma: number;
}

/** One point-in-time readout, as the live panel would serialize it. */
export interface SensorSnapshot {
  orientation?: OrientationReading;
  /** `screen.orientation.angle` at capture time, for heading compensation. */
  screenAngle?: number;
  /** DeviceMotionEvent.acceleration: gravity already subtracted, m/s². */
  acceleration?: Vector3;
  /** DeviceMotionEvent.accelerationIncludingGravity, m/s². */
  accelerationIncludingGravity?: Vector3;
  /** DeviceMotionEvent.rotationRate, degrees/second. */
  rotationRate?: OrientationReading;
  /** AmbientLightSensor reading or equivalent, in lux. */
  ambientLight?: number;
}

export interface MobileSensorsOpts {
  [key: string]: unknown;
}

const INVALID_SNAPSHOT_FIX =
  'The panel produces this JSON automatically while sensors are enabled. If pasting one by hand, it must be an object shaped like {"orientation":{"alpha":10,"beta":20,"gamma":-5}}, using any combination of "orientation", "screenAngle", "acceleration", "accelerationIncludingGravity", "rotationRate" and "ambientLight".';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isVector3(value: unknown): value is Vector3 {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return isFiniteNumber(v.x) && isFiniteNumber(v.y) && isFiniteNumber(v.z);
}

function isOrientation(value: unknown): value is OrientationReading {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return isFiniteNumber(v.alpha) && isFiniteNumber(v.beta) && isFiniteNumber(v.gamma);
}

function parseSnapshot(raw: string): SensorSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolError("invalid-json", "The input is not valid JSON.", INVALID_SNAPSHOT_FIX);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolError(
      "invalid-snapshot",
      "The JSON is not a sensor snapshot object.",
      INVALID_SNAPSHOT_FIX,
    );
  }

  const obj = parsed as Record<string, unknown>;
  const snapshot: SensorSnapshot = {};

  if (obj.orientation !== undefined) {
    if (!isOrientation(obj.orientation)) {
      throw new ToolError(
        "invalid-orientation",
        'The "orientation" field needs numeric alpha, beta and gamma values.',
        INVALID_SNAPSHOT_FIX,
      );
    }
    snapshot.orientation = obj.orientation;
  }

  if (obj.screenAngle !== undefined) {
    if (!isFiniteNumber(obj.screenAngle)) {
      throw new ToolError(
        "invalid-screen-angle",
        'The "screenAngle" field needs to be a number.',
        INVALID_SNAPSHOT_FIX,
      );
    }
    snapshot.screenAngle = obj.screenAngle;
  }

  if (obj.acceleration !== undefined) {
    if (!isVector3(obj.acceleration)) {
      throw new ToolError(
        "invalid-acceleration",
        'The "acceleration" field needs numeric x, y and z values.',
        INVALID_SNAPSHOT_FIX,
      );
    }
    snapshot.acceleration = obj.acceleration;
  }

  if (obj.accelerationIncludingGravity !== undefined) {
    if (!isVector3(obj.accelerationIncludingGravity)) {
      throw new ToolError(
        "invalid-acceleration-gravity",
        'The "accelerationIncludingGravity" field needs numeric x, y and z values.',
        INVALID_SNAPSHOT_FIX,
      );
    }
    snapshot.accelerationIncludingGravity = obj.accelerationIncludingGravity;
  }

  if (obj.rotationRate !== undefined) {
    if (!isOrientation(obj.rotationRate)) {
      throw new ToolError(
        "invalid-rotation-rate",
        'The "rotationRate" field needs numeric alpha, beta and gamma values.',
        INVALID_SNAPSHOT_FIX,
      );
    }
    snapshot.rotationRate = obj.rotationRate;
  }

  if (obj.ambientLight !== undefined) {
    if (!isFiniteNumber(obj.ambientLight)) {
      throw new ToolError(
        "invalid-ambient-light",
        'The "ambientLight" field needs to be a number.',
        INVALID_SNAPSHOT_FIX,
      );
    }
    snapshot.ambientLight = obj.ambientLight;
  }

  const hasAnyField =
    snapshot.orientation !== undefined ||
    snapshot.acceleration !== undefined ||
    snapshot.accelerationIncludingGravity !== undefined ||
    snapshot.rotationRate !== undefined ||
    snapshot.ambientLight !== undefined;

  if (!hasAnyField) {
    throw new ToolError(
      "empty-snapshot",
      "The snapshot has none of the recognized sensor fields.",
      INVALID_SNAPSHOT_FIX,
    );
  }

  return snapshot;
}

/* ------------------------------------------------------------------ *
 * formatting
 * ------------------------------------------------------------------ */

function round(value: number, places: number): number {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

function formatVector(v: Vector3, unit: string): string {
  return `${round(vectorMagnitude(v.x, v.y, v.z), 2)} ${unit} (x: ${round(v.x, 2)}, y: ${round(v.y, 2)}, z: ${round(v.z, 2)})`;
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

const USAGE_ROWS: Record<string, string> = {
  "How this works":
    "This tool is panel first. Click Enable sensors and, on iOS, grant the motion and orientation permission prompt. Readings then update live: a compass and tilt from the device orientation sensor, a bubble level and raw accelerometer, gyroscope and rotation rate values from the motion sensor, and ambient light where the browser exposes it.",
  "Devices that work":
    "Needs a phone or tablet with an accelerometer and, for the compass, a magnetometer. A laptop or desktop reports no orientation or motion events, so the panel shows an honest message instead of blank readouts.",
  "Decode a saved snapshot":
    'Paste a JSON object with any of "orientation", "screenAngle", "acceleration", "accelerationIncludingGravity", "rotationRate" or "ambientLight" to compute the same heading, tilt and magnitudes the live panel shows, without a device attached.',
  Privacy: "Everything runs on your device: your files and inputs never leave your device.",
};

/**
 * With no input this tool is panel first, so it returns usage rows: live
 * device sensors only exist in a real browser session. Given a sensor
 * snapshot it runs the same math the live panel runs on every reading,
 * which makes the pure surface useful for a saved capture and keeps the
 * heading, tilt and magnitude formulas unit tested in one place.
 */
export function run(input: string = "", _opts: MobileSensorsOpts = {}): Record<string, string> {
  void _opts;
  if (!input.trim()) return { ...USAGE_ROWS };

  const snapshot = parseSnapshot(input);
  const out: Record<string, string> = {};

  if (snapshot.orientation) {
    const { alpha, beta, gamma } = snapshot.orientation;
    const heading = compassHeading(alpha, snapshot.screenAngle ?? 0);
    const tilt = tiltFromOrientation(beta, gamma);
    out.Heading = `${round(heading, 1)}° (${compassDirection(heading)})`;
    out.Pitch = `${round(tilt.pitch, 1)}°`;
    out.Roll = `${round(tilt.roll, 1)}°`;
    out["Tilt off flat"] = `${round(tilt.magnitude, 1)}°`;
  }

  if (snapshot.acceleration) {
    out["Acceleration (gravity removed)"] = formatVector(snapshot.acceleration, "m/s²");
  }

  if (snapshot.accelerationIncludingGravity) {
    out["Acceleration (with gravity)"] = formatVector(
      snapshot.accelerationIncludingGravity,
      "m/s²",
    );
  }

  if (snapshot.rotationRate) {
    const { alpha, beta, gamma } = snapshot.rotationRate;
    out["Rotation rate"] =
      `${round(vectorMagnitude(alpha, beta, gamma), 1)} deg/s (alpha: ${round(alpha, 1)}, beta: ${round(beta, 1)}, gamma: ${round(gamma, 1)})`;
  }

  if (snapshot.ambientLight !== undefined) {
    out["Ambient light"] = `${round(snapshot.ambientLight, 1)} lux`;
  }

  return out;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, MobileSensorsOpts>;

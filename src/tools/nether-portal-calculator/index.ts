import { ToolError, type ToolLogic } from "../types";

/**
 * Nether portal coordinate math, Java Edition 1.7 and later (the modern
 * fixed 1:8 ratio; the pre 1.7 "Beta" 1:1 ratio does not exist in any
 * supported release and is intentionally not modeled).
 *
 * Portal search radius: when a player enters a portal, the game computes the
 * scaled target position in the destination dimension, then searches a
 * square (Chebyshev, not circular) box around it for a valid, already lit
 * portal, unbounded in Y. As of 1.21 that box is a radius of 128 blocks when
 * searching the Overworld (arriving from the Nether) and 16 blocks when
 * searching the Nether (arriving from the Overworld) -- the same real-world
 * distance on both sides of the 1:8 scale. No portal is found within the
 * box, a new one is generated near the target instead.
 */

export const NETHER_SCALE = 8;
/** Search radius in the Overworld, coming from the Nether. */
export const OVERWORLD_SEARCH_RADIUS = 128;
/** Search radius in the Nether, coming from the Overworld. */
export const NETHER_SEARCH_RADIUS = 16;
/**
 * Chebyshev distance, in Nether blocks, beyond which two portals' 16 block
 * search boxes can never overlap even in the worst case. One more than
 * twice the search radius.
 */
export const SAFE_SEPARATION = NETHER_SEARCH_RADIUS * 2 + 1;

/** Java Edition's world border, in blocks from origin, on each horizontal axis. */
const WORLD_BORDER = 30_000_000;

export interface Coord2 {
  x: number;
  z: number;
}

export interface OverworldRange {
  xMin: number;
  xMax: number;
  zMin: number;
  zMax: number;
}

export type LinkOutcome = "same" | "risk" | "separate";

export interface LinkCheckResult {
  scaledA: Coord2;
  scaledB: Coord2;
  scaledDistance: number;
  outcome: LinkOutcome;
  /** Nether coordinates to hand build portal B at, guaranteed clear of A's search box. */
  suggestion?: Coord2;
}

export interface DistanceSavedResult {
  overworldDistance: number;
  netherWalkDistance: number;
  blocksSaved: number;
  percentSaved: number;
}

/** Overworld (x, z) to the Nether coordinate it scales down to. Java rounds toward negative infinity. */
export function overworldToNether(x: number, z: number): Coord2 {
  return { x: Math.floor(x / NETHER_SCALE), z: Math.floor(z / NETHER_SCALE) };
}

/** Nether (x, z) to the 8x8 range of Overworld coordinates that scale up to it. */
export function netherToOverworldRange(x: number, z: number): OverworldRange {
  return {
    xMin: x * NETHER_SCALE,
    xMax: x * NETHER_SCALE + NETHER_SCALE - 1,
    zMin: z * NETHER_SCALE,
    zMax: z * NETHER_SCALE + NETHER_SCALE - 1,
  };
}

/** Square (Chebyshev) distance: what the portal search actually uses, not a circle. */
export function chebyshevDistance(a: Coord2, b: Coord2): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}

/**
 * Will two Overworld portals converge on the same Nether portal?
 *
 * Both scale down to a target Nether coordinate; each search box reaches 16
 * blocks from its own target. When the two targets are within 16 blocks of
 * each other, whichever portal generates first almost always falls inside
 * the other's search box too, so they link together. Between 16 and 32
 * blocks apart it depends on exactly where the first portal actually
 * materializes (it can land anywhere in its own search box, not only on the
 * target square), so this is flagged as a risk zone rather than a guarantee
 * either way. Past 32 blocks the two search boxes can never touch.
 */
export function checkPortalLink(a: Coord2, b: Coord2): LinkCheckResult {
  const scaledA = overworldToNether(a.x, a.z);
  const scaledB = overworldToNether(b.x, b.z);
  const scaledDistance = chebyshevDistance(scaledA, scaledB);

  let outcome: LinkOutcome;
  if (scaledDistance <= NETHER_SEARCH_RADIUS) outcome = "same";
  else if (scaledDistance <= NETHER_SEARCH_RADIUS * 2) outcome = "risk";
  else outcome = "separate";

  if (outcome === "separate") return { scaledA, scaledB, scaledDistance, outcome };

  // Push portal B's Nether target out along whichever axis already has the
  // bigger gap, just past the point where the two search boxes could ever
  // overlap. Only one axis needs to clear 32 blocks: the search box is a
  // square, so being far away on either axis alone is enough.
  const dx = scaledB.x - scaledA.x;
  const dz = scaledB.z - scaledA.z;
  const pushX = Math.abs(dx) >= Math.abs(dz);
  const suggestion: Coord2 = { ...scaledB };
  if (pushX) {
    const sign = dx >= 0 ? 1 : -1;
    suggestion.x = scaledA.x + sign * SAFE_SEPARATION;
  } else {
    const sign = dz >= 0 ? 1 : -1;
    suggestion.z = scaledA.z + sign * SAFE_SEPARATION;
  }
  return { scaledA, scaledB, scaledDistance, outcome, suggestion };
}

/**
 * Straight line Overworld walking distance versus the equivalent trip taken
 * through the Nether: the same ground covered at 1/8 the walking distance,
 * assuming portals sit right at the scaled entry and exit points.
 */
export function distanceSaved(x1: number, z1: number, x2: number, z2: number): DistanceSavedResult {
  const overworldDistance = Math.hypot(x2 - x1, z2 - z1);
  const netherWalkDistance = overworldDistance / NETHER_SCALE;
  const blocksSaved = overworldDistance - netherWalkDistance;
  const percentSaved = overworldDistance === 0 ? 0 : (blocksSaved / overworldDistance) * 100;
  return { overworldDistance, netherWalkDistance, blocksSaved, percentSaved };
}

export interface NetherPortalOpts {
  mode: string; // 'to-nether' | 'to-overworld' | 'link-check' | 'distance-saved'
  x: number;
  y: number;
  z: number;
  x2: number;
  z2: number;
  [key: string]: unknown;
}

export type NetherPortalResult = Record<string, string>;

function validateCoord(label: string, v: number): void {
  if (!Number.isFinite(v))
    throw new ToolError(
      "invalid-coordinate",
      `${label} must be a finite number.`,
      "Enter a whole number block coordinate.",
    );
  if (Math.abs(v) > WORLD_BORDER)
    throw new ToolError(
      "out-of-bounds",
      `${label} is outside the Java Edition world border.`,
      `Use a value between -${WORLD_BORDER.toLocaleString("en-US")} and ${WORLD_BORDER.toLocaleString("en-US")}.`,
    );
}

function num(n: number): string {
  return Math.trunc(n).toLocaleString("en-US");
}

function dec(n: number): string {
  return (Math.round(n * 100) / 100).toLocaleString("en-US");
}

const OUTCOME_LABEL: Record<LinkOutcome, string> = {
  same: "Will link to the same Nether portal",
  risk: "Risk zone: may or may not share a Nether portal",
  separate: "Safely separate: search boxes cannot overlap",
};

export function run(_input: undefined, opts: NetherPortalOpts): NetherPortalResult {
  const mode = opts.mode ?? "to-nether";

  if (mode === "to-nether") {
    validateCoord("X", opts.x);
    validateCoord("Z", opts.z);
    validateCoord("Y", opts.y);
    const n = overworldToNether(opts.x, opts.z);
    return {
      "Overworld coordinate": `${num(opts.x)}, ${num(opts.y)}, ${num(opts.z)}`,
      "Nether coordinate": `${n.x}, ${num(opts.y)}, ${n.z}`,
      Scale: "1 Nether block = 8 Overworld blocks; Y is unchanged",
    };
  }

  if (mode === "to-overworld") {
    validateCoord("X", opts.x);
    validateCoord("Z", opts.z);
    validateCoord("Y", opts.y);
    const r = netherToOverworldRange(opts.x, opts.z);
    return {
      "Nether coordinate": `${num(opts.x)}, ${num(opts.y)}, ${num(opts.z)}`,
      "Overworld X range": `${r.xMin} to ${r.xMax}`,
      "Overworld Z range": `${r.zMin} to ${r.zMax}`,
      "Overworld Y": num(opts.y),
    };
  }

  if (mode === "link-check") {
    validateCoord("Portal A X", opts.x);
    validateCoord("Portal A Z", opts.z);
    validateCoord("Portal B X", opts.x2);
    validateCoord("Portal B Z", opts.z2);
    const result = checkPortalLink({ x: opts.x, z: opts.z }, { x: opts.x2, z: opts.z2 });
    const out: NetherPortalResult = {
      "Portal A Nether target": `${result.scaledA.x}, ${result.scaledA.z}`,
      "Portal B Nether target": `${result.scaledB.x}, ${result.scaledB.z}`,
      "Scaled distance apart": `${result.scaledDistance} Nether blocks`,
      Outcome: OUTCOME_LABEL[result.outcome],
    };
    if (result.suggestion) {
      out["Suggested Nether placement for B"] =
        `${result.suggestion.x}, ${result.suggestion.z} (hand build a portal here instead of letting one auto generate)`;
    }
    return out;
  }

  if (mode === "distance-saved") {
    validateCoord("Start X", opts.x);
    validateCoord("Start Z", opts.z);
    validateCoord("End X", opts.x2);
    validateCoord("End Z", opts.z2);
    const d = distanceSaved(opts.x, opts.z, opts.x2, opts.z2);
    return {
      "Overworld walking distance": `${dec(d.overworldDistance)} blocks`,
      "Nether walking distance": `${dec(d.netherWalkDistance)} blocks`,
      "Blocks saved": `${dec(d.blocksSaved)} blocks`,
      "Percent saved": `${dec(d.percentSaved)}%`,
    };
  }

  throw new ToolError(
    "invalid-mode",
    `Unknown mode "${mode}".`,
    "Choose Overworld to Nether, Nether to Overworld, Link check, or Distance saved.",
  );
}

export default { run } satisfies ToolLogic<undefined, NetherPortalResult, NetherPortalOpts>;

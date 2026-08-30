import { ToolError, type ToolLogic } from "../types";

/**
 * Beacon pyramid math, current Java Edition mechanics (unchanged since the
 * beacon's 1.4.2 introduction other than the 1.9 addition of the level 4
 * Regeneration/Strength secondary power, which every version this tool
 * targets already has).
 *
 * A beacon reads its pyramid on activation: layer 1 is the 3x3 directly
 * beneath the beacon block, layer 2 is a 5x5 the layer below that, and so
 * on, up to 4 layers. Each additional layer unlocks a beam tier and widens
 * the effect range. Only iron, gold, diamond, emerald and (Java 1.20.5+)
 * netherite blocks count as valid pyramid material.
 */

export interface BeaconTier {
  layer: number;
  /** Blocks in this single layer (not cumulative). */
  layerBlocks: number;
  /** Total blocks required from layer 1 through this layer. */
  cumulativeBlocks: number;
  /** Primary power effect range, in blocks, radius from the beacon. */
  range: number;
}

export const BEACON_TIERS: readonly BeaconTier[] = [
  { layer: 1, layerBlocks: 9, cumulativeBlocks: 9, range: 20 },
  { layer: 2, layerBlocks: 34, cumulativeBlocks: 43, range: 30 },
  { layer: 3, layerBlocks: 83, cumulativeBlocks: 126, range: 40 },
  { layer: 4, layerBlocks: 164, cumulativeBlocks: 290, range: 50 },
];

export type BeaconMaterial = "iron" | "gold" | "diamond" | "emerald" | "netherite";

export const MATERIAL_LABEL: Record<BeaconMaterial, string> = {
  iron: "Iron block",
  gold: "Gold block",
  diamond: "Diamond block",
  emerald: "Emerald block",
  netherite: "Netherite block",
};

/** Raw ingots (or the emerald gem) that craft one of each material's block. */
export const INGOTS_PER_BLOCK: Record<BeaconMaterial, number> = {
  iron: 9,
  gold: 9,
  diamond: 9,
  emerald: 9,
  netherite: 9,
};

export const PRIMARY_POWERS_BY_LAYER: Record<number, string[]> = {
  1: ["Speed", "Haste"],
  2: ["Resistance", "Jump Boost"],
  3: ["Strength"],
  4: [],
};

export const SECONDARY_POWER_LAYER = 4;
export const SECONDARY_POWERS = ["Regeneration", "the level 1 primary power a second time"];

/**
 * Every effect the beacon grants is applied as a status effect with this
 * duration: 9 seconds plus 2 seconds per active pyramid layer (11, 13, 15,
 * 17 seconds for layers 1 through 4). The beacon re-applies it roughly
 * every 4 seconds to everyone standing in range, so the long duration is
 * mostly slack for lag and movement; once you leave the beam the effect
 * just counts down the remainder instead of ending immediately.
 */
export const EFFECT_DURATION_BASE_SECONDS = 9;
export const EFFECT_DURATION_PER_LAYER_SECONDS = 2;
/** How often the beacon re-applies its effects to players in range. */
export const EFFECT_REFRESH_SECONDS = 4;

export function effectDurationSeconds(layers: number): number {
  return EFFECT_DURATION_BASE_SECONDS + EFFECT_DURATION_PER_LAYER_SECONDS * layers;
}

export function tierForLayers(layers: number): BeaconTier {
  if (!Number.isInteger(layers) || layers < 1 || layers > 4)
    throw new ToolError(
      "invalid-layers",
      "Layer count must be a whole number from 1 to 4.",
      "Beacons only read up to 4 pyramid layers.",
    );
  return BEACON_TIERS[layers - 1]!;
}

/** Primary powers unlocked with a pyramid this many layers tall (cumulative through that layer). */
export function primaryPowersUpTo(layers: number): string[] {
  const out: string[] = [];
  for (let l = 1; l <= layers; l++) out.push(...(PRIMARY_POWERS_BY_LAYER[l] ?? []));
  return out;
}

export interface MaterialCost {
  material: BeaconMaterial;
  blocks: number;
  ingots: number;
}

export function materialCost(layers: number, material: BeaconMaterial): MaterialCost {
  const tier = tierForLayers(layers);
  const blocks = tier.cumulativeBlocks;
  return { material, blocks, ingots: blocks * INGOTS_PER_BLOCK[material] };
}

export interface SharedBaseResult {
  beaconCount: number;
  layers: number;
  /**
   * Blocks required for the shared base: layer-4 footprints tiled edge to
   * edge share their outer 7 rows/columns of blocks with neighbors, so the
   * total is well under `beaconCount * cumulativeBlocks`. Computed by
   * rasterizing the union of every pyramid's footprint layer by layer
   * rather than guessing at an overlap formula, so any grid arrangement is
   * exact.
   */
  totalBlocks: number;
  /** What the same beacons would cost with no shared base at all. */
  soloBlocks: number;
  blocksSaved: number;
}

/**
 * Beacons arranged in a grid, `cols` wide by `rows` tall, spaced the minimum
 * distance apart that still lets every beacon's full pyramid activate
 * (layer N's footprint is `2N+1` blocks wide, centered on the beacon), so
 * adjacent pyramids' bottom layers interlock into one shared base.
 */
export function sharedBaseBlocks(cols: number, rows: number, layers: number): SharedBaseResult {
  if (!Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1)
    throw new ToolError(
      "invalid-grid",
      "Beacon grid dimensions must be whole numbers of at least 1.",
      "Set columns and rows to at least 1.",
    );
  const tier = tierForLayers(layers);
  const beaconCount = cols * rows;

  // Beacon i (0-based) along an axis sits at position i * spacing, where
  // spacing is the largest footprint width for the deepest layer this
  // beacon's pyramid reaches (always `layers` here, since every beacon in
  // the base is built the same height). Adjacent pyramids' outermost layer
  // touches edge to edge with no gap and no overlap between beacon centers.
  const footprintWidth = 2 * layers + 1;
  const spacing = footprintWidth - 1;

  // Track every occupied (x, y) cell across every layer of every beacon by
  // rasterizing into a Set, which makes the shared-edge overlap exact for
  // any grid shape without deriving a closed-form overlap formula.
  const occupied = new Set<string>();
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const cx = bx * spacing;
      const cy = by * spacing;
      for (let layer = 1; layer <= layers; layer++) {
        const half = layer; // layer N's footprint extends N blocks from center
        for (let dx = -half; dx <= half; dx++) {
          for (let dy = -half; dy <= half; dy++) {
            occupied.add(`${cx + dx},${cy + dy}`);
          }
        }
      }
    }
  }

  const totalBlocks = occupied.size;
  const soloBlocks = beaconCount * tier.cumulativeBlocks;
  return { beaconCount, layers, totalBlocks, soloBlocks, blocksSaved: soloBlocks - totalBlocks };
}

export interface BeaconOpts {
  mode: string; // 'layers' | 'material' | 'shared'
  layers: number;
  material: string;
  gridCols: number;
  gridRows: number;
  [key: string]: unknown;
}

export type BeaconResult = Record<string, string>;

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function asMaterial(raw: string): BeaconMaterial {
  if (
    raw === "iron" ||
    raw === "gold" ||
    raw === "diamond" ||
    raw === "emerald" ||
    raw === "netherite"
  )
    return raw;
  throw new ToolError(
    "invalid-material",
    `Unknown material "${raw}".`,
    "Choose iron, gold, diamond, emerald, or netherite.",
  );
}

export function run(_input: undefined, opts: BeaconOpts): BeaconResult {
  const mode = opts.mode ?? "layers";

  if (mode === "layers") {
    const tier = tierForLayers(opts.layers);
    const powers = primaryPowersUpTo(opts.layers);
    const out: BeaconResult = {
      "Pyramid layers": String(tier.layer),
      "Blocks this layer": fmt(tier.layerBlocks),
      "Total blocks (all layers)": fmt(tier.cumulativeBlocks),
      "Effect range": `${tier.range} blocks in every horizontal direction, from the beacon up to the world height limit`,
      "Primary powers unlocked": powers.length ? powers.join(", ") : "none yet, build layer 1",
      "Effect duration": `${effectDurationSeconds(tier.layer)} seconds per application`,
      "Effect refresh rate": `about every ${EFFECT_REFRESH_SECONDS} seconds while in range`,
    };
    if (tier.layer >= SECONDARY_POWER_LAYER) {
      out["Secondary power (full pyramid)"] = SECONDARY_POWERS.join(" or ");
    }
    return out;
  }

  if (mode === "material") {
    const material = asMaterial(opts.material);
    const cost = materialCost(opts.layers, material);
    return {
      "Pyramid layers": String(opts.layers),
      Material: MATERIAL_LABEL[material],
      "Blocks needed": fmt(cost.blocks),
      "Ingots or gems needed": fmt(cost.ingots),
    };
  }

  if (mode === "shared") {
    const result = sharedBaseBlocks(opts.gridCols, opts.gridRows, opts.layers);
    return {
      Beacons: fmt(result.beaconCount),
      Grid: `${opts.gridCols} x ${opts.gridRows}`,
      "Pyramid layers": String(result.layers),
      "Shared base blocks": fmt(result.totalBlocks),
      "Blocks if built solo": fmt(result.soloBlocks),
      "Blocks saved by sharing": fmt(result.blocksSaved),
    };
  }

  throw new ToolError(
    "invalid-mode",
    `Unknown mode "${mode}".`,
    "Choose Layer requirements, Material cost, or Shared base.",
  );
}

export default { run } satisfies ToolLogic<undefined, BeaconResult, BeaconOpts>;

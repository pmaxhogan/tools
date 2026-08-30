import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "beacon-calculator",
  matrixSlug: "minecraft-beacon-calculator",
  icon: "Signal",
  name: "Minecraft Beacon Calculator",
  description:
    "Pyramid layer block counts, material cost in ingots, effect range and duration, and shared multi-beacon base totals.",
  category: "Minecraft",
  keywords: [
    "minecraft beacon calculator",
    "beacon pyramid blocks",
    "beacon range",
    "how many blocks for a beacon",
    "beacon material cost",
    "minecraft beacon base",
  ],
  searchTerms: [
    "how many iron blocks for a beacon",
    "beacon effect range by layer",
    "beacon pyramid layers",
    "full beacon cost",
    "beacon strength effect",
    "beacon secondary power",
    "multi beacon farm layout",
    "beacon base sharing blocks",
    "how big is a beacon pyramid",
    "beacon effect duration",
  ],
  input: "none",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Mode",
      default: "layers",
      options: [
        {
          value: "layers",
          label: "Layer requirements",
          synonyms: ["blocks per layer", "range", "powers unlocked", "effect duration"],
        },
        {
          value: "material",
          label: "Material cost",
          synonyms: ["ingots", "how many blocks", "iron gold diamond emerald netherite"],
        },
        {
          value: "shared",
          label: "Shared base",
          synonyms: ["multi beacon", "beacon farm", "grid of beacons", "shared pyramid"],
        },
      ],
    },
    {
      kind: "number",
      id: "layers",
      label: "Pyramid layers",
      default: 4,
      min: 1,
      max: 4,
      step: 1,
    },
    {
      kind: "select",
      id: "material",
      label: "Material (Material cost mode)",
      default: "iron",
      options: [
        { value: "iron", label: "Iron blocks", synonyms: ["iron ingots", "iron block"] },
        { value: "gold", label: "Gold blocks", synonyms: ["gold ingots", "gold block"] },
        { value: "diamond", label: "Diamond blocks", synonyms: ["diamonds", "diamond block"] },
        { value: "emerald", label: "Emerald blocks", synonyms: ["emeralds", "emerald block"] },
        {
          value: "netherite",
          label: "Netherite blocks",
          synonyms: ["netherite ingots", "netherite block"],
        },
      ],
    },
    {
      kind: "number",
      id: "gridCols",
      label: "Grid columns (Shared base mode)",
      default: 2,
      min: 1,
      max: 20,
      step: 1,
    },
    {
      kind: "number",
      id: "gridRows",
      label: "Grid rows (Shared base mode)",
      default: 3,
      min: 1,
      max: 20,
      step: 1,
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Beacon pyramid math: block counts per layer and cumulative, the ingot or gem cost for iron, gold, diamond, emerald, or netherite blocks, which primary powers and the secondary power each layer unlocks, effect range, and effect duration. A shared base mode lays out a grid of beacons close enough for their bottom layers to interlock and reports the exact block total, computed by rasterizing every pyramid's footprint rather than guessing at an overlap formula.",
    how: "Pick Layer requirements to see the block count, range, and unlocked powers for 1 to 4 layers. Switch to Material cost and choose a block type to see the ingot total for a given layer count. Switch to Shared base and set a grid of columns and rows to see the true block total for that many beacons built as one interlocking base, alongside what building them separately would have cost.",
    why: "Beacon calculators online usually stop at the block count per layer. This one also prices the pyramid in raw ingots for every valid material including netherite, and models an actual shared multi-beacon base by rasterizing overlapping footprints instead of a rough per-beacon estimate, so a farm layout gets an exact number rather than a guess. It runs entirely in your browser: your files and inputs never leave your device.",
    faq: [
      {
        q: "How many blocks does a full beacon pyramid need?",
        a: "290 blocks total across all four layers: 9 for layer 1, 34 more for layer 2 (43 total), 83 more for layer 3 (126 total), and 164 more for layer 4 (290 total). Any single material works as long as every block in a layer matches: iron, gold, diamond, emerald, or (as of Java 1.20.5) netherite.",
      },
      {
        q: "What does each beacon layer unlock?",
        a: "Layer 1 unlocks Speed or Haste, layer 2 adds Resistance or Jump Boost, layer 3 adds Strength, and a full 4 layer pyramid unlocks a secondary power: Regeneration, or the level 1 primary power applied a second time. Range grows with each layer too: 20, 30, 40, then 50 blocks in every horizontal direction from the beacon up to the world height limit.",
      },
      {
        q: "Can several beacons share one base to save blocks?",
        a: "Yes. Beacons spaced so their bottom pyramid layers touch edge to edge share that shared column or row of blocks between both pyramids, which the game reads correctly for each beacon independently. The Shared base mode computes the exact total for a grid arranged this way, which comes out lower than paying the full per-beacon cost for every beacon separately.",
      },
    ],
  },
};

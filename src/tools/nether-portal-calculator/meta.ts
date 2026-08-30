import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "nether-portal-calculator",
  matrixSlug: "minecraft-nether-portal-calculator",
  icon: "Route",
  name: "Minecraft Nether Portal Calculator",
  description:
    "Convert Overworld and Nether coordinates on the 1:8 ratio, check whether two portals will link together, and see the distance a Nether shortcut saves.",
  category: "Minecraft",
  keywords: [
    "minecraft nether portal calculator",
    "nether portal coordinates",
    "overworld to nether coordinates",
    "minecraft coordinate converter",
    "nether portal linking",
    "minecraft 1 to 8 ratio",
  ],
  searchTerms: [
    "why did my nether portal link somewhere else",
    "nether portal search radius",
    "minecraft nether coordinates calculator",
    "how far apart should nether portals be",
    "nether highway calculator",
    "minecraft portal not linking",
    "divide coordinates by 8 minecraft",
    "nether shortcut distance",
    "portal linking bug fix",
    "nether portal 128 blocks",
  ],
  input: "none",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Mode",
      default: "to-nether",
      options: [
        {
          value: "to-nether",
          label: "Overworld to Nether",
          synonyms: ["divide by 8", "scale down", "overworld coordinate"],
        },
        {
          value: "to-overworld",
          label: "Nether to Overworld",
          synonyms: ["multiply by 8", "scale up", "nether coordinate"],
        },
        {
          value: "link-check",
          label: "Will these portals link?",
          synonyms: ["portal linking", "same portal", "portal search radius", "two portals"],
        },
        {
          value: "distance-saved",
          label: "Distance saved",
          synonyms: ["nether shortcut", "travel time", "highway", "how much faster"],
        },
      ],
    },
    {
      kind: "number",
      id: "x",
      label:
        "X (Overworld to Nether, Nether to Overworld) / Portal A X (link check) / Start X (distance saved)",
      default: 0,
      min: -30_000_000,
      max: 30_000_000,
      step: 1,
    },
    {
      kind: "number",
      id: "y",
      label: "Y",
      default: 64,
      min: -2032,
      max: 2032,
      step: 1,
    },
    {
      kind: "number",
      id: "z",
      label:
        "Z (Overworld to Nether, Nether to Overworld) / Portal A Z (link check) / Start Z (distance saved)",
      default: 0,
      min: -30_000_000,
      max: 30_000_000,
      step: 1,
    },
    {
      kind: "number",
      id: "x2",
      label: "Portal B X (link check) / End X (distance saved)",
      default: 0,
      min: -30_000_000,
      max: 30_000_000,
      step: 1,
    },
    {
      kind: "number",
      id: "z2",
      label: "Portal B Z (link check) / End Z (distance saved)",
      default: 0,
      min: -30_000_000,
      max: 30_000_000,
      step: 1,
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Converts Minecraft Java Edition coordinates between the Overworld and the Nether on the fixed 1:8 ratio, checks whether two Overworld portals will merge into the same Nether portal, and works out how many blocks a Nether shortcut saves over walking. The link check uses the actual square search box the game runs (128 blocks in the Overworld, 16 blocks in the Nether, unbounded in height) rather than a rounded rule of thumb, and suggests a Nether coordinate to hand build a second portal at when two targets are too close to trust.",
    how: "Pick a mode: convert a single coordinate either direction, check two Overworld portal locations against each other, or compare a straight walk against the Nether route between two points. Type in X, Y, and Z (Y only matters for the coordinate conversion; it passes through unchanged). Every result updates live and the whole setup lives in the page address, so a link reproduces the exact coordinates.",
    why: "Most portal calculators only do the divide by 8 arithmetic and stop there, leaving the actual cause of a stray portal link a mystery. This one also models the search box the game runs when it looks for an existing portal, so it can say when two builds are safely apart, when they are in a genuine risk zone, and when they are certain to collide, plus a coordinate to hand build a portal at instead of letting one generate somewhere unwanted. It runs entirely in your browser: your files and inputs never leave your device.",
    faq: [
      {
        q: "Why did my new Nether portal link to the wrong place?",
        a: "When a portal is used, the game searches a square box up to 128 blocks wide in the Overworld (16 blocks in the Nether) around the scaled target position for any existing, already lit portal before creating a new one. If another portal's scaled target falls inside that box, the two link together even though you built them separately. Space Overworld portals more than roughly 128 to 144 blocks apart to avoid this reliably.",
      },
      {
        q: "How much faster is Nether travel really?",
        a: "Every 8 blocks walked in the Nether covers 64 blocks of Overworld ground, so a route through the Nether takes about 1/8 the walking distance of the same trip on the surface, an 87.5 percent reduction, assuming the portals sit close to the ideal scaled coordinates at both ends.",
      },
      {
        q: "Does Y matter for the 1:8 scaling?",
        a: "No. Only X and Z are divided or multiplied by 8; the Y coordinate carries straight across between dimensions. The Nether's build height is shorter than the Overworld's, so a very high or low Overworld Y can still place a portal target outside the Nether's buildable range.",
      },
    ],
  },
};

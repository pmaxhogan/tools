import type { ToolMeta } from "../types";
import { ANIMALS, GROWTH_VERSIONS, PLANTS } from "./data";

// Mirrors LAYOUT_PRESETS in index.ts. Kept as a literal so the eagerly
// imported meta module never pulls the logic layer into the shell bundle;
// index.test.ts asserts the two lists stay in step.
const LAYOUT_OPTIONS = [
  { value: "rows", label: "Hydrated rows, one bare farmland row between" },
  { value: "full", label: "Fully planted hydrated field" },
  { value: "water-rows", label: "Crop rows alternating with water channels" },
  { value: "dry-full", label: "Fully planted field, no water in range" },
  { value: "dry-rows", label: "Rows on dry farmland" },
  { value: "single", label: "One plant on a lone hydrated farmland block" },
];

const VERSION_SYNONYMS: Record<string, string[]> = {
  "1.16.5": ["nether update", "1.16"],
  "1.18.2": ["caves and cliffs", "1.18"],
  "1.20.6": ["trails and tales", "1.20"],
  "1.21.1": ["tricky trials", "1.21"],
  "1.21.11": ["1.21"],
  "26.2": ["latest", "newest", "current"],
};

const PLANT_CATEGORIES = ["Farmland crops", "Nether plants", "Stacking plants", "Bushes and trees"];

const CATEGORY_SYNONYMS: Record<string, string[]> = {
  "Farmland crops": ["farm", "hoe", "tilled", "hydration", "water"],
  "Nether plants": ["soul sand", "wart", "cocoa", "jungle"],
  "Stacking plants": ["column", "tall", "height", "sugar cane", "bamboo"],
  "Bushes and trees": ["sapling", "berry", "tree", "forest"],
};

export const meta: ToolMeta = {
  slug: "minecraft-crop-growth-calculator",
  matrixSlug: "minecraft-growth",
  icon: "Sprout",
  name: "Minecraft Crop Growth and Breeding Timer",
  description:
    "Exact growth times, farm layout throughput, bone meal costs, and animal breeding timers from the game's real random tick math.",
  category: "Minecraft",
  keywords: [
    "minecraft crop growth calculator",
    "how long does wheat take to grow minecraft",
    "minecraft farm layout hydration",
    "minecraft random tick speed growth",
    "minecraft bone meal how many",
    "minecraft breeding cooldown timer",
    "minecraft baby animal growth time",
  ],
  searchTerms: [
    "wheat growth time",
    "sugar cane growth rate",
    "melon stem fruit rate",
    "nether wart timer",
    "kelp growth chance",
    "bamboo growth speed",
    "farmland moisture",
    "growth speed formula",
    "how many bone meal for wheat",
    "how long until a baby cow grows up",
    "afk farm rates",
    "crops per hour",
  ],
  input: "none",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "version",
      label: "Minecraft version",
      default: GROWTH_VERSIONS[GROWTH_VERSIONS.length - 1],
      options: GROWTH_VERSIONS.map((v) => ({
        value: v,
        label: v,
        synonyms: VERSION_SYNONYMS[v] ?? [],
      })),
    },
    {
      kind: "select",
      id: "plant",
      label: "Plant",
      default: "wheat",
      groups: PLANT_CATEGORIES.map((cat) => ({
        label: cat,
        synonyms: CATEGORY_SYNONYMS[cat] ?? [],
        options: PLANTS.filter((p) => p.cat === cat).map((p) => ({
          value: p.id,
          label: p.label,
          synonyms: p.synonyms,
        })),
      })),
    },
    {
      kind: "select",
      id: "layout",
      label: "Farm layout",
      default: "full",
      options: LAYOUT_OPTIONS.map((l) => ({
        value: l.value,
        label: l.label,
        synonyms: [l.value.replace(/-/g, " "), "hydration", "water"],
      })),
    },
    {
      kind: "number",
      id: "randomTickSpeed",
      label: "Random tick speed",
      default: 3,
      min: 0,
      max: 100,
      step: 1,
    },
    {
      kind: "number",
      id: "fruitSides",
      label: "Free sides for a melon or pumpkin",
      default: 4,
      min: 1,
      max: 4,
      step: 1,
    },
    {
      kind: "select",
      id: "animal",
      label: "Animal to breed",
      default: "cow",
      options: ANIMALS.map((a) => ({
        value: a.id,
        label: a.label,
        synonyms: a.synonyms,
      })),
    },
  ],
  copy: {
    what: "Works out how long a Minecraft plant actually takes to grow, as a distribution rather than a single made-up number: the average, the median, and the slowest 5 percent, in game ticks, real minutes, and in game days. It applies the real growth speed formula, so every farmland block around the plant, its moisture, and whether the plant is crowded on one axis or two all change the answer. It also compares farm layouts by yield per hour per block, prices bone meal per crop type, shows what random tick speed and chunk loading do to an AFK farm (including the pre 1.21.11 rule that a chunk with no player close enough for mob spawning never random ticks at all), and covers animal breeding cooldowns, baby growth, and food cost per animal. Numbers cover 1.16.5, 1.18.2, 1.20.6, 1.21.1, 1.21.11, and 26.2. Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.",
    how: "Pick a version and a plant, then pick the farm layout you actually built: a fully planted hydrated field, rows with a gap between them, rows split by water channels, or dry farmland. The stat tiles update with the growth chance per random tick and the full time distribution, and the layout table ranks every option by harvests per hour per block of footprint. Plants that ignore farmland, like nether wart and sugar cane, hide the hydration controls, and plants that cannot be bone mealed say so instead of offering a control that does nothing. Switch to the breeding card for cooldowns, baby growth, and how much feeding a baby actually saves.",
    why: "Search results for crop growth are full of pages quoting one flat number, usually with no version, no layout, and no source. Growth is a random process: a wheat plant in a fully planted hydrated field averages about 48 minutes, but one in twenty takes over 80 minutes, and that spread is what determines whether a farm keeps up. Every constant here was read out of decompiled game code for six versions by this site's own pipeline, checked against crop grids measured on real dedicated servers for the two versions where a headless server random ticks at all, and the calculator reimplements the formulas rather than copying values from a wiki. It runs entirely in your browser, with no ads and no accounts, and your files and inputs never leave your device.",
    faq: [
      {
        q: "How are these numbers verified?",
        a: "Every constant is parsed straight out of decompiled server source for 1.16.5, 1.18.2, 1.20.6, 1.21.1, 1.21.11, and 26.2 by a generator in this repository, so a value that changes between releases shows up as a data diff instead of going unnoticed. The classes behind the math are CropBlock (the growth speed sum and the 1 in floor(25 divided by speed) plus 1 roll), FarmBlock and later FarmlandBlock (moisture and the hydration range), ServerLevel (the per section random tick selection), GameRules (the random tick speed default of 3), BoneMealItem, and Animal plus AgeableMob for breeding. The distribution itself is computed analytically as a negative binomial over random tick draws, never by simulation. On top of that, a test harness booted real dedicated servers, built controlled crop grids, opened exact tick windows at a known random tick speed, and read back the age of every plant, and the predicted age distributions are asserted against those measured histograms. Live measurement is only possible on 1.21.11 and 26.2: before 1.21.11, ServerChunkCache.tickChunks reaches the random tick loop only inside the natural spawning branch, gated on a player being close enough to the chunk for spawning, so a headless server with nobody online never random ticks anything. 1.21.11 moved random ticking to ChunkMap.forEachBlockTickingChunk, which is the only reason those two versions can be measured at all. For 1.16.5, 1.18.2, 1.20.6, and 1.21.1 the harness records the constants it read from the same classes instead, and the tests assert this tool's numbers against that independent reading. The measurement is what caught beetroot skipping one growth attempt in three, a detail no calculator we could find models.",
      },
      {
        q: "Which versions changed the answers?",
        a: "None of the growth math changed across the six covered versions, but the code around it did. 1.20 added the torchflower and pitcher crops, which use flat bone meal steps, and torchflower joined beetroot as the only crops that skip one growth attempt in three. 1.21.11 renamed the game rule from randomTickSpeed to minecraft:random_tick_speed, moved GameRules into its own package, and unhooked random ticking from mob spawning: before it, ServerChunkCache.tickChunks only random ticked a chunk when a player was close enough to it for spawning, so a farm outside that range grew nothing even though the chunk was loaded. 26.2 renamed FarmBlock to FarmlandBlock and turned the farmland check under a crop into a block tag lookup. 1.21.11 also added the cactus flower, which can occupy the space a new cactus block would use.",
      },
      {
        q: "Why does bone meal cost more on some crops than others?",
        a: "Because the crops do not share one rule. Wheat, carrots, potatoes, and melon or pumpkin stems advance a uniform 2 to 5 stages per bone meal, which works out to 2.39 bone meal on average from seed to harvest. Beetroot uses the same roll divided by three, so a roll of 2 advances nothing at all and a beetroot costs 4 bone meal despite having fewer than half the stages. Torchflower, pitcher plant, cocoa, and sweet berry bush advance exactly one stage. Saplings roll a separate 45 percent success check and the bone meal is consumed even when that roll fails, so a tree costs about 4.4. Nether wart, sugar cane, and cactus cannot be bone mealed at all.",
      },
    ],
  },
};

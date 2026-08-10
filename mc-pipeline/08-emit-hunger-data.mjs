// Emit the committed data module for minecraft-hunger-calculator.
//
// Reads two authoritative inputs and writes
// src/tools/minecraft-hunger-calculator/data.ts:
//
//   1. mc-pipeline/extracted/<version>/item_components.json
//      The vanilla item component dump (Mojang data generator output via
//      mcmeta). For 1.20.5 and later, food is data driven: the
//      `minecraft:food` component carries nutrition, ABSOLUTE saturation,
//      and can_always_eat. From 1.21.2 the eating animation length and the
//      on-eat effects moved to `minecraft:consumable`, and an item is only
//      edible when it HAS that component (the four fish buckets carry a
//      food component with no consumable component, so they are excluded).
//
//   2. mc-pipeline/work/<version>/src/ (decompiled, gitignored, never
//      redistributed). Used for the two eras with no data-driven food
//      (1.16.5 and 1.18.2), where the table lives in
//      net/minecraft/world/food/Foods.java and the item ids and stack
//      sizes live in net/minecraft/world/item/Items.java. Also used to
//      read net/minecraft/world/food/FoodConstants.java and to VERIFY the
//      exhaustion call sites, the FoodData tick thresholds, the Peaceful
//      regeneration timers, and the honey bottle use-duration override.
//
// Nothing in this script transcribes Java into TypeScript: it extracts
// numbers and item ids only. The mechanics are reimplemented by hand in
// src/tools/minecraft-hunger-calculator/index.ts.
//
// Idempotent: output is deterministic (sorted ids, stable era order), so
// re-running with unchanged inputs produces a byte-identical file.
// Node builtins only. Usage: node mc-pipeline/08-emit-hunger-data.mjs

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const EXTRACTED = join(ROOT, "extracted");
const WORK = join(ROOT, "work");
const OUT_DIR = join(ROOT, "..", "src", "tools", "minecraft-hunger-calculator");
const SIZE_LIMIT = 2 * 1024 * 1024;

/** Release order, oldest first. Drives the version picker. */
const VERSIONS = ["1.16.5", "1.18.2", "1.20.6", "1.21.1", "1.21.11", "26.2"];
/** Versions whose food table is data driven (1.20.5 moved food to components). */
const COMPONENT_ERA = new Set(["1.20.6", "1.21.1", "1.21.11", "26.2"]);

const problems = [];
function need(ok, message) {
  if (!ok) problems.push(message);
  return ok;
}

function src(version, relative) {
  const path = join(WORK, version, "src", relative);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

for (const v of VERSIONS) {
  if (!existsSync(join(WORK, v, "src"))) {
    console.error(`missing decompiled source for ${v} under mc-pipeline/work/${v}/src`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- names ----

const SPECIAL_NAMES = {
  cooked_beef: "Steak (Cooked Beef)",
  beef: "Raw Beef",
  chicken: "Raw Chicken",
  porkchop: "Raw Porkchop",
  mutton: "Raw Mutton",
  rabbit: "Raw Rabbit",
  cod: "Raw Cod",
  salmon: "Raw Salmon",
  cake_slice: "Cake (one slice)",
};

/** Grouping for the picker. Anything unlisted falls back to "Other". */
const CATEGORIES = {
  beef: "Meat",
  cooked_beef: "Meat",
  porkchop: "Meat",
  cooked_porkchop: "Meat",
  chicken: "Meat",
  cooked_chicken: "Meat",
  mutton: "Meat",
  cooked_mutton: "Meat",
  rabbit: "Meat",
  cooked_rabbit: "Meat",
  rotten_flesh: "Meat",
  cod: "Fish",
  cooked_cod: "Fish",
  salmon: "Fish",
  cooked_salmon: "Fish",
  tropical_fish: "Fish",
  pufferfish: "Fish",
  dried_kelp: "Fish",
  apple: "Crops and plants",
  carrot: "Crops and plants",
  potato: "Crops and plants",
  baked_potato: "Crops and plants",
  poisonous_potato: "Crops and plants",
  beetroot: "Crops and plants",
  melon_slice: "Crops and plants",
  sweet_berries: "Crops and plants",
  glow_berries: "Crops and plants",
  chorus_fruit: "Crops and plants",
  spider_eye: "Crops and plants",
  bread: "Baked and crafted",
  cookie: "Baked and crafted",
  pumpkin_pie: "Baked and crafted",
  cake_slice: "Baked and crafted",
  mushroom_stew: "Stews and bottles",
  rabbit_stew: "Stews and bottles",
  beetroot_soup: "Stews and bottles",
  suspicious_stew: "Stews and bottles",
  honey_bottle: "Stews and bottles",
  ominous_bottle: "Stews and bottles",
  golden_apple: "Golden and rare",
  enchanted_golden_apple: "Golden and rare",
  golden_carrot: "Golden and rare",
};

const SYNONYMS = {
  cooked_beef: ["steak", "cooked cow"],
  beef: ["raw steak", "cow"],
  cooked_porkchop: ["pork", "bacon", "pig"],
  porkchop: ["raw pork", "pig"],
  golden_carrot: ["best saturation", "gold carrot"],
  golden_apple: ["gapple", "notch apple"],
  enchanted_golden_apple: ["god apple", "notch apple", "napple"],
  rotten_flesh: ["zombie flesh", "junk food"],
  dried_kelp: ["kelp", "fast food"],
  bread: ["wheat"],
  baked_potato: ["potato"],
  pumpkin_pie: ["pie"],
  cake_slice: ["cake", "slice of cake"],
  honey_bottle: ["honey", "bottle of honey"],
  suspicious_stew: ["sus stew"],
  rabbit_stew: ["stew"],
  mushroom_stew: ["stew", "mushroom soup"],
  beetroot_soup: ["soup"],
  sweet_berries: ["berries", "berry bush"],
  glow_berries: ["berries", "cave vines"],
  chorus_fruit: ["end fruit", "teleport"],
  spider_eye: ["poison"],
  pufferfish: ["puffer"],
  tropical_fish: ["clownfish"],
  cooked_cod: ["fish"],
  cooked_salmon: ["fish"],
  poisonous_potato: ["poison potato"],
  ominous_bottle: ["bad omen", "trial chambers"],
};

const SMALL_WORDS = new Set(["of", "the", "a", "an"]);
function displayName(id) {
  if (SPECIAL_NAMES[id]) return SPECIAL_NAMES[id];
  const words = id.split("_");
  return words
    .map((w, i) => (SMALL_WORDS.has(w) && i > 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/** Float32 arithmetic leaves artifacts like 14.400001; 4 dp recovers 14.4. */
function round4(n) {
  return Math.round(n * 1e4) / 1e4;
}

// --------------------------------------------------------- side effects ----

/** Readable note for one applied effect, plus its Hunger exhaustion cost. */
function describeEffect(effect, probability) {
  const id = String(effect.id ?? "").replace(/^minecraft:/, "");
  const amp = Number(effect.amplifier ?? 0);
  const duration = Number(effect.duration ?? 0);
  const p = probability === undefined ? 1 : Number(probability);
  const roman = ["I", "II", "III", "IV", "V"][amp] ?? String(amp + 1);
  const name = id
    .split("_")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
  const seconds = round4(duration / 20);
  const chance = p >= 1 ? "" : `${Math.round(p * 100)}% chance of `;
  const text = `${chance}${name}${amp > 0 ? ` ${roman}` : ""} for ${seconds}s`;
  // HungerMobEffect#applyEffectTick: causeFoodExhaustion(0.005F * (amplifier + 1))
  // every tick the effect is active. Expected cost = probability x ticks x rate.
  const exhaustion = id === "hunger" ? round4(p * duration * 0.005 * (amp + 1)) : 0;
  return { text, exhaustion };
}

// ------------------------------------------------ component-era food ------

function loadComponents(version) {
  const path = join(EXTRACTED, version, "item_components.json");
  if (!existsSync(path)) {
    console.error(`missing ${path}`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    out[id] = Array.isArray(value)
      ? Object.fromEntries(value.map((e) => [e.type, e.value]))
      : value;
  }
  return out;
}

/** Item ids gated behind an unreleased feature flag in this version's Items.java. */
function featureGatedIds(version) {
  const items = src(version, "net/minecraft/world/item/Items.java");
  if (!items) return new Set();
  const gated = new Set();
  for (const chunk of items.split("public static final Item ")) {
    if (!/requiredFeatures\(/.test(chunk)) continue;
    const m = chunk.match(/registerItem\(\s*"([a-z_]+)"/);
    if (m) gated.add(m[1]);
  }
  return gated;
}

/** Ticks the eating animation takes, honouring per-item class overrides. */
function useDurationOverride(version, id) {
  if (id !== "honey_bottle") return null;
  const file = src(version, "net/minecraft/world/item/HoneyBottleItem.java");
  if (!file) return null;
  const m = file.match(/getUseDuration\([^)]*\)\s*\{\s*return\s+(\d+);/);
  return m ? Number(m[1]) : null;
}

function componentFoods(version) {
  const comps = loadComponents(version);
  const gated = featureGatedIds(version);
  const anyConsumable = Object.values(comps).some((c) => c["minecraft:consumable"]);
  const foods = [];
  for (const [id, c] of Object.entries(comps)) {
    const food = c["minecraft:food"];
    if (!food) continue;
    if (gated.has(id)) continue;
    const consumable = c["minecraft:consumable"];
    // From 1.21.2 the consumable component is what makes an item edible.
    if (anyConsumable && !consumable) continue;
    const rawEffects = anyConsumable
      ? (consumable.on_consume_effects ?? [])
          .filter((e) => e.type === "minecraft:apply_effects")
          .flatMap((e) => (e.effects ?? []).map((x) => ({ effect: x, probability: e.probability })))
      : (food.effects ?? []).map((e) => ({ effect: e.effect, probability: e.probability }));
    const described = rawEffects.map((e) => describeEffect(e.effect, e.probability));
    const seconds = anyConsumable ? consumable.consume_seconds : food.eat_seconds;
    const override = useDurationOverride(version, id);
    foods.push({
      id,
      nutrition: food.nutrition,
      saturation: round4(food.saturation),
      alwaysEdible: Boolean(food.can_always_eat),
      eatTicks: override ?? Math.trunc((seconds ?? 1.6) * 20),
      stack: c["minecraft:max_stack_size"] ?? 64,
      hungerExhaustion: round4(described.reduce((a, d) => a + d.exhaustion, 0)),
      effects: described.map((d) => d.text).join(", "),
    });
  }
  return foods;
}

// -------------------------------------------------- Foods.java era food ----

/** Parse Foods.java into FIELD -> {nutrition, saturationModifier, fast, alwaysEat, effects}. */
function parseFoodsJava(version) {
  const file = src(version, "net/minecraft/world/food/Foods.java");
  need(file, `${version}: Foods.java not found`);
  if (!file) return {};
  // stew(n) helper: nutrition n, saturationMod 0.6.
  const stew = file.match(
    /private static FoodProperties(?:\.Builder)? stew\([^)]*\)\s*\{[\s\S]*?nutrition\(([A-Za-z0-9$]+)\)\.saturationMod\(([0-9.]+)F\)/,
  );
  need(stew, `${version}: could not read the stew() helper in Foods.java`);
  const stewSaturationMod = stew ? Number(stew[2]) : 0.6;

  const out = {};
  const declRe = /public static final FoodProperties ([A-Z0-9_]+) =([\s\S]*?);\n/g;
  let m;
  while ((m = declRe.exec(file))) {
    const field = m[1];
    const body = m[2];
    let nutrition;
    let saturationModifier;
    const stewCall = body.match(/\bstew\((\d+)\)/);
    if (stewCall) {
      nutrition = Number(stewCall[1]);
      saturationModifier = stewSaturationMod;
    } else {
      const n = body.match(/\.nutrition\((\d+)\)/);
      const s = body.match(/\.saturationMod\(([0-9.]+)F\)/);
      if (!n || !s) continue;
      nutrition = Number(n[1]);
      saturationModifier = Number(s[1]);
    }
    const effects = [];
    const effRe =
      /new MobEffectInstance\(MobEffects\.([A-Z_]+),\s*(\d+),\s*(\d+)\)\s*,\s*([0-9.]+)F\s*\)/g;
    let e;
    while ((e = effRe.exec(body))) {
      // Field names that were renamed when effects became registry ids.
      const legacy = { CONFUSION: "nausea", DAMAGE_RESISTANCE: "resistance" };
      const id = legacy[e[1]] ?? e[1].toLowerCase();
      effects.push({
        effect: { id, duration: Number(e[2]), amplifier: Number(e[3]) },
        probability: Number(e[4]),
      });
    }
    out[field] = {
      nutrition,
      saturationModifier,
      fast: /\.fast\(\)/.test(body),
      alwaysEat: /\.alwaysEat\(\)/.test(body),
      effects,
    };
  }
  return out;
}

/** Parse Items.java into itemId -> {field, stack} for every item with a food(). */
function parseItemsJava(version) {
  const file = src(version, "net/minecraft/world/item/Items.java");
  need(file, `${version}: Items.java not found`);
  if (!file) return {};
  const out = {};
  for (const chunk of file.split("public static final Item ")) {
    const food = chunk.match(/\.food\(Foods\.([A-Z0-9_]+)\)/);
    if (!food) continue;
    const id = chunk.match(/registerItem\(\s*"([a-z_]+)"/);
    if (!id) continue;
    const stack = chunk.match(/\.stacksTo\((\d+)\)/);
    out[id[1]] = { field: food[1], stack: stack ? Number(stack[1]) : 64 };
  }
  return out;
}

function legacyFoods(version) {
  const table = parseFoodsJava(version);
  const items = parseItemsJava(version);
  // Item#getUseDuration: fast food eats in 16 ticks, everything else 32.
  const item = src(version, "net/minecraft/world/item/Item.java") ?? "";
  const dur = item.match(/isFastFood\(\)\s*\?\s*(\d+)\s*:\s*(\d+)/);
  need(dur, `${version}: could not read the food use duration in Item.java`);
  const fastTicks = dur ? Number(dur[1]) : 16;
  const slowTicks = dur ? Number(dur[2]) : 32;

  const foods = [];
  for (const [id, { field, stack }] of Object.entries(items)) {
    const props = table[field];
    if (!need(props, `${version}: Items.java references Foods.${field}, absent from Foods.java`)) {
      continue;
    }
    const described = props.effects.map((e) => describeEffect(e.effect, e.probability));
    const override = useDurationOverride(version, id);
    foods.push({
      id,
      nutrition: props.nutrition,
      // FoodConstants.saturationByModifier (inlined in 1.16.5): n x modifier x 2.
      saturation: round4(props.nutrition * props.saturationModifier * 2),
      alwaysEdible: props.alwaysEat,
      eatTicks: override ?? (props.fast ? fastTicks : slowTicks),
      stack,
      hungerExhaustion: round4(described.reduce((a, d) => a + d.exhaustion, 0)),
      effects: described.map((d) => d.text).join(", "),
    });
  }
  return foods;
}

// ------------------------------------------------------------- cake -------

/**
 * Cake is not an item food: CakeBlock#eat calls FoodData#eat(2, 0.1F) per
 * slice, so it never appears in Foods.java or in the item components. It is
 * added as a synthetic "cake_slice" row with the real numbers.
 */
function cakeSlice(version) {
  const file = src(version, "net/minecraft/world/level/block/CakeBlock.java");
  if (!need(file, `${version}: CakeBlock.java not found`)) return null;
  const eat = file.match(/getFoodData\(\)\.eat\((\d+),\s*([0-9.]+)F\)/);
  if (!need(eat, `${version}: could not read CakeBlock#eat`)) return null;
  const bites = file.match(/MAX_BITES = (\d+)/);
  const slices = bites ? Number(bites[1]) + 1 : 7;
  const nutrition = Number(eat[1]);
  return {
    id: "cake_slice",
    nutrition,
    saturation: round4(nutrition * Number(eat[2]) * 2),
    alwaysEdible: false,
    eatTicks: 0,
    stack: slices,
    hungerExhaustion: 0,
    effects: `one slice of a placed cake, ${slices} slices per cake`,
  };
}

// ------------------------------------------------------- mechanics --------

/** Read FoodConstants.java into a name -> number map (1.18.2 and later). */
function parseFoodConstants(version) {
  const file = src(version, "net/minecraft/world/food/FoodConstants.java");
  if (!file) return null;
  const out = {};
  const re = /public static final (?:int|float) ([A-Z_0-9]+) = ([0-9.]+)F?;/g;
  let m;
  while ((m = re.exec(file))) out[m[1]] = Number(m[2]);
  return out;
}

/** Every distinct literal passed to causeFoodExhaustion anywhere in the tree. */
function exhaustionCallSites(version) {
  const files = [
    "net/minecraft/world/entity/player/Player.java",
    "net/minecraft/server/level/ServerPlayer.java",
    "net/minecraft/world/level/block/Block.java",
    "net/minecraft/world/effect/HungerMobEffect.java",
    "net/minecraft/world/effect/MobEffect.java",
  ];
  const found = new Set();
  for (const rel of files) {
    const file = src(version, rel);
    if (!file) continue;
    const token = "causeFoodExhaustion(";
    for (let at = file.indexOf(token); at >= 0; at = file.indexOf(token, at + 1)) {
      // Scan forward with a paren counter: arguments contain nested calls.
      let depth = 1;
      let i = at + token.length;
      for (; i < file.length && depth > 0; i++) {
        if (file[i] === "(") depth++;
        else if (file[i] === ")") depth--;
      }
      found.add(
        file
          .slice(at + token.length, i - 1)
          .replace(/\s+/g, " ")
          .trim(),
      );
    }
  }
  return found;
}

/**
 * The exhaustion cost of one unit of each action. Every value is asserted
 * against a real call site below, so a future version that changes one of
 * them fails this script instead of silently shipping a stale number.
 */
const ACTIVITIES = [
  {
    id: "sprint",
    label: "Sprinting",
    unit: "block",
    unitPlural: "blocks",
    exhaustion: 0.1,
    expect: /^0\.1F \* \$*\w+ \* 0\.01F$/,
    source:
      "ServerPlayer#checkMovementStatistics (Player#checkMovementStatistics before 1.20): 0.1F per centimetre-hundredth, so 0.1 per block sprinted",
  },
  {
    id: "swim",
    label: "Swimming",
    unit: "block",
    unitPlural: "blocks",
    exhaustion: 0.01,
    expect: /^0\.01F \* \$*\w+ \* 0\.01F$/,
    source:
      "ServerPlayer#checkMovementStatistics: 0.01F per block swum, walked underwater, or walked on water",
  },
  {
    id: "walk",
    label: "Walking or crouching",
    unit: "block",
    unitPlural: "blocks",
    exhaustion: 0,
    expect: /^0\.0F \* \$*\w+ \* 0\.01F$/,
    source:
      "ServerPlayer#checkMovementStatistics: 0.0F per block walked or crouched, so plain walking is free",
  },
  {
    id: "jump",
    label: "Jumping",
    unit: "jump",
    unitPlural: "jumps",
    exhaustion: 0.05,
    expect: /^0\.05F$/,
    source:
      "ServerPlayer#jumpFromGround (Player#jumpFromGround before 1.21.2): 0.05F when not sprinting",
  },
  {
    id: "sprint_jump",
    label: "Sprint jumping",
    unit: "jump",
    unitPlural: "jumps",
    exhaustion: 0.2,
    expect: /^0\.2F$/,
    source:
      "ServerPlayer#jumpFromGround (Player#jumpFromGround before 1.21.2): 0.2F when sprinting",
  },
  {
    id: "mine",
    label: "Breaking blocks",
    unit: "block",
    unitPlural: "blocks",
    exhaustion: 0.005,
    expect: /^0\.005F$/,
    source: "Block#playerDestroy: 0.005F per block broken, whatever the block or tool",
  },
  {
    id: "attack",
    label: "Attacking",
    unit: "hit landed",
    unitPlural: "hits landed",
    exhaustion: 0.1,
    expect: /^0\.1F$/,
    source:
      "Player#attack: 0.1F per attack that deals damage; a miss or a fully blocked hit costs nothing",
  },
  {
    id: "damage",
    label: "Taking damage",
    unit: "hit taken",
    unitPlural: "hits taken",
    exhaustion: 0.1,
    expect: /^\$*\w+\.getFoodExhaustion\(\)$/,
    source:
      "Player#actuallyHurt via DamageSource#getFoodExhaustion: 0.1 for mob_attack, player_attack, arrow, explosion, cactus, thorns, fire and lava; 0.0 for fall, drowning, starving, magic, wither and freezing",
  },
  {
    id: "hunger_effect",
    label: "Hunger effect",
    unit: "second",
    unitPlural: "seconds",
    exhaustion: 0.1,
    expect: /^0\.005F \* \(\$*\w+ \+ 1\)$/,
    source:
      "HungerMobEffect#applyEffectTick (MobEffect#applyEffectTick before 1.20.5): 0.005F x (amplifier + 1) every tick, so 0.1 per second at Hunger I",
  },
];

// ------------------------------------------- enchantments that exhaust ----

/**
 * From 1.21 an enchantment can add exhaustion directly through the
 * apply_exhaustion entity effect (ApplyExhaustion.java, registered in
 * EnchantmentEntityEffect). Rather than hardcode which enchantments use it,
 * scan the extracted enchantment data per version: any enchantment that
 * carries the effect becomes a version-gated activity.
 */
function findApplyExhaustion(node) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findApplyExhaustion(child);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  if (node.type === "minecraft:apply_exhaustion") {
    const amount = node.amount;
    if (typeof amount === "number") return amount;
    if (amount && typeof amount === "object" && typeof amount.base === "number") return amount.base;
    return null;
  }
  for (const value of Object.values(node)) {
    const hit = findApplyExhaustion(value);
    if (hit !== null) return hit;
  }
  return null;
}

/** enchantment id -> { amount, versions[] } across every extracted version. */
const exhaustingEnchantments = new Map();
for (const v of VERSIONS) {
  const dir = join(EXTRACTED, v, "enchantment");
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const amount = findApplyExhaustion(raw);
    if (amount === null) continue;
    const id = file.replace(/\.json$/, "");
    const entry = exhaustingEnchantments.get(id) ?? {
      amount,
      versions: [],
      maxLevel: raw.max_level ?? 1,
    };
    need(
      entry.amount === amount,
      `${id}: apply_exhaustion amount changed between versions (${entry.amount} then ${amount})`,
    );
    entry.versions.push(v);
    exhaustingEnchantments.set(id, entry);
  }
}

for (const [id, info] of [...exhaustingEnchantments].sort(([a], [b]) => a.localeCompare(b))) {
  const name = displayName(id);
  ACTIVITIES.push({
    id: `ench_${id}`,
    label: `${name} attack`,
    unit: `${name} I attack`,
    unitPlural: `${name} I attacks`,
    exhaustion: info.amount,
    availableIn: info.versions,
    source: `Enchantments.${id.toUpperCase()} carries the apply_exhaustion entity effect with a base of ${info.amount} exhaustion, scaling linearly with the level up to ${info.maxLevel}. Enter ${info.maxLevel > 1 ? "level times your attack rate for higher levels" : "your attack rate"}.`,
  });
}

/**
 * Ready-made activity mixes. The exhaustion PER UNIT is source-derived (see
 * ACTIVITIES above); the rates here are not in the game code at all, because
 * the game charges exhaustion per block travelled rather than per second.
 * Any preset that assumes a travel speed is flagged approximate and says so
 * in the UI, and every rate stays editable.
 */
const ACTIVITY_PRESETS = [
  {
    id: "idle",
    label: "Standing still",
    approximate: false,
    note: "Standing still costs nothing at all: the walking and crouching branches both charge 0.0 exhaustion.",
    rates: {},
  },
  {
    id: "walking",
    label: "Walking and building",
    approximate: false,
    note: "Walking and crouching are charged 0.0 exhaustion per block, so only the blocks you place or break cost anything. The rate here is exact because the walking cost is exactly zero at any speed.",
    rates: { walk: 260, mine: 20 },
  },
  {
    id: "sprinting",
    label: "Sprinting nonstop",
    approximate: true,
    note: "Sprinting on flat ground covers about 5.6 blocks per second. The 0.1 exhaustion per block is from the game code; the speed is a measured figure, so adjust the rate if you know yours.",
    rates: { sprint: 337 },
  },
  {
    id: "sprint_jumping",
    label: "Sprint jumping",
    approximate: true,
    note: "Sprint jumping is the fastest way to travel on foot and roughly doubles the exhaustion cost, because each jump adds 0.2 on top of the distance. Distance and jump rate are measured figures, so adjust them to match your route.",
    rates: { sprint: 428, sprint_jump: 96 },
  },
  {
    id: "swimming",
    label: "Swimming an ocean",
    approximate: true,
    note: "Swimming costs 0.01 exhaustion per block, a tenth of sprinting, which is why crossing an ocean barely touches the hunger bar. The speed is a measured figure.",
    rates: { swim: 132 },
  },
  {
    id: "mining",
    label: "Branch mining",
    approximate: true,
    note: "Breaking a block costs 0.005 exhaustion whatever the block or tool, so mining is remarkably cheap. The blocks per minute depends on your pickaxe and the stone type.",
    rates: { mine: 90, walk: 60 },
  },
  {
    id: "combat",
    label: "Fighting at a mob farm",
    approximate: true,
    note: "Each hit that lands costs 0.1 exhaustion and each hit you take costs another 0.1, so combat is the most expensive thing you can do per second. The rates depend entirely on your farm.",
    rates: { attack: 150, damage: 20 },
  },
  {
    id: "hunger_effect",
    label: "Under the Hunger effect",
    approximate: false,
    note: "Hunger I adds 0.005 exhaustion every tick, which is 0.1 per second, or 6 exhaustion over a 60 second dose from rotten flesh. Exact from the effect code.",
    rates: { hunger_effect: 60 },
  },
];

const constants = {};
for (const v of VERSIONS) {
  const parsed = parseFoodConstants(v);
  const foodData = src(v, "net/minecraft/world/food/FoodData.java") ?? "";
  // 1.16.5 predates FoodConstants; read the same numbers from FoodData#tick.
  const read = parsed ?? {
    MAX_FOOD: /Math\.min\(\$*\w+ \+ this\.foodLevel, 20\)/.test(foodData) ? 20 : NaN,
    MAX_SATURATION: 20,
    START_SATURATION: /saturationLevel = 5\.0F/.test(foodData) ? 5 : NaN,
    EXHAUSTION_DROP: /exhaustionLevel > 4\.0F/.test(foodData) ? 4 : NaN,
    HEALTH_TICK_COUNT: /tickTimer >= 80/.test(foodData) ? 80 : NaN,
    HEALTH_TICK_COUNT_SATURATED: /tickTimer >= 10/.test(foodData) ? 10 : NaN,
    HEAL_LEVEL: /foodLevel >= 18/.test(foodData) ? 18 : NaN,
    EXHAUSTION_HEAL: /addExhaustion\(6\.0F\)/.test(foodData) ? 6 : NaN,
    // The sprint gate is enforced client side (LocalPlayer), which the
    // dedicated server jar does not contain, so 1.16.5 carries the value
    // FoodConstants pinned from 1.18.2 on. The emitter asserts every
    // version that DOES declare it agrees.
    SPRINT_LEVEL: 6,
    STARVE_LEVEL: 0,
  };
  constants[v] = read;
  need(
    /Math\.min\(this\.exhaustionLevel \+ \S+, 40\.0F\)/.test(foodData),
    `${v}: FoodData#addExhaustion no longer caps at 40`,
  );
  need(
    /Math\.min\(this\.saturationLevel, 6\.0F\)/.test(foodData),
    `${v}: FoodData#tick saturated heal no longer caps at 6 saturation`,
  );
  need(
    /getHealth\(\) > 10\.0F \|\| \S+ == Difficulty\.HARD \|\| \S+\.getHealth\(\) > 1\.0F && \S+ == Difficulty\.NORMAL/.test(
      foodData,
    ),
    `${v}: FoodData#tick starvation floor changed`,
  );
  const sites = exhaustionCallSites(v);
  for (const a of ACTIVITIES) {
    // Enchantment-driven costs are data driven, not call sites: they are
    // verified against the extracted enchantment JSON instead.
    if (!a.expect) continue;
    need(
      [...sites].some((s) => a.expect.test(s)),
      `${v}: no causeFoodExhaustion call site matching ${a.id} (${a.expect})`,
    );
  }
}

const CONSTANT_KEYS = [
  "MAX_FOOD",
  "MAX_SATURATION",
  "START_SATURATION",
  "EXHAUSTION_DROP",
  "HEALTH_TICK_COUNT",
  "HEALTH_TICK_COUNT_SATURATED",
  "HEAL_LEVEL",
  "EXHAUSTION_HEAL",
  "SPRINT_LEVEL",
  "STARVE_LEVEL",
];
const MECHANICS = {};
for (const key of CONSTANT_KEYS) {
  const values = new Set(VERSIONS.map((v) => constants[v][key]));
  need(values.size === 1, `${key} differs across versions: ${[...values].join(", ")}`);
  need(Number.isFinite([...values][0]), `${key} could not be read from every version`);
  MECHANICS[key] = [...values][0];
}
MECHANICS.MAX_EXHAUSTION = 40;
MECHANICS.SATURATED_HEAL_CAP = 6;

// ------------------------------------------------- Peaceful regeneration ---

/**
 * Peaceful is the one mechanic with a real version boundary: 1.21 added a
 * saturation refill next to the existing health and food refills.
 */
const peaceful = {};
for (const v of VERSIONS) {
  const player = src(v, "net/minecraft/world/entity/player/Player.java") ?? "";
  const server = src(v, "net/minecraft/server/level/ServerPlayer.java") ?? "";
  const body = player + server;
  peaceful[v] = {
    healEvery:
      /getHealth\(\) < this\.getMaxHealth\(\)[\s\S]{0,80}?heal\(1\.0F\)|tickCount % 20 == 0[\s\S]{0,120}?heal\(1\.0F\)/.test(
        body,
      )
        ? 20
        : NaN,
    foodEvery:
      /tickCount % 10 == 0[\s\S]{0,120}?setFoodLevel|needsFood\(\) && this\.tickCount % 10 == 0/.test(
        body,
      )
        ? 10
        : NaN,
    saturationEvery:
      /setSaturation\((?:this\.foodData\.getSaturationLevel\(\)|\$*\w+) \+ 1\.0F\)/.test(body)
        ? 20
        : 0,
  };
  need(
    Number.isFinite(peaceful[v].healEvery),
    `${v}: could not read the Peaceful health regeneration timer`,
  );
  need(
    Number.isFinite(peaceful[v].foodEvery),
    `${v}: could not read the Peaceful food refill timer`,
  );
}

// ------------------------------------------------------ build the table ----

const perVersion = {};
for (const v of VERSIONS) {
  const foods = COMPONENT_ERA.has(v) ? componentFoods(v) : legacyFoods(v);
  const cake = cakeSlice(v);
  if (cake) foods.push(cake);
  foods.sort((a, b) => a.id.localeCompare(b.id));
  perVersion[v] = foods.map((f) => ({
    ...f,
    name: displayName(f.id),
    cat: CATEGORIES[f.id] ?? "Other",
    synonyms: SYNONYMS[f.id] ?? [],
  }));
}

if (problems.length) {
  console.error("source verification failed:\n  " + problems.join("\n  "));
  process.exit(1);
}

// Dedupe identical tables into eras (the loot emitter's trick, smaller scale).
const eras = [];
const eraIndex = new Map();
const versionEra = {};
for (const v of VERSIONS) {
  const canon = JSON.stringify(perVersion[v]);
  if (!eraIndex.has(canon)) {
    eraIndex.set(canon, eras.length);
    eras.push(perVersion[v]);
  }
  versionEra[v] = eraIndex.get(canon);
}

// --------------------------------------------------------------- emit ----

function sq(s) {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

const categoryOrder = [
  "Meat",
  "Fish",
  "Crops and plants",
  "Baked and crafted",
  "Stews and bottles",
  "Golden and rare",
  "Other",
];
const usedCategories = new Set(eras.flat().map((f) => f.cat));
for (const c of usedCategories) {
  if (!categoryOrder.includes(c)) categoryOrder.push(c);
}

const payload = JSON.stringify({ eras, versionEra });

const out = `// GENERATED by mc-pipeline/08-emit-hunger-data.mjs. Do not edit by hand.
//
// Food tables come from the vanilla item component dump for 1.20.6 and later
// (mc-pipeline/extracted/<version>/item_components.json, where food became
// data driven in 1.20.5) and from net/minecraft/world/food/Foods.java plus
// net/minecraft/world/item/Items.java for 1.16.5 and 1.18.2. Mechanics
// constants come from net/minecraft/world/food/FoodConstants.java, read back
// out of FoodData#tick for 1.16.5 which predates that class. The emitter
// asserts every exhaustion call site still exists in every decompiled tree,
// so a changed constant fails the pipeline instead of shipping stale numbers.
//
// Saturation is stored ABSOLUTE (what the item actually restores), which is
// how the game stores it from 1.20.5 on. Older versions stored a modifier;
// the emitter applies FoodConstants.saturationByModifier (nutrition x
// modifier x 2) so both eras are directly comparable. Values are rounded to
// 4 decimal places to undo float32 artifacts such as 14.400001.

/** Versions with verified hunger data, oldest first. */
export const HUNGER_VERSIONS = [${VERSIONS.map((v) => JSON.stringify(v)).join(", ")}] as const;
export type VersionId = (typeof HUNGER_VERSIONS)[number];

/** Picker categories, in display order. */
export const FOOD_CATEGORIES = [
${categoryOrder.map((c) => `  ${JSON.stringify(c)},`).join("\n")}
] as const;
export type FoodCategory = (typeof FOOD_CATEGORIES)[number];

export interface FoodItem {
  /** Vanilla item id without the namespace, e.g. "golden_carrot". */
  id: string;
  /** Display name for pickers and results. */
  name: string;
  cat: FoodCategory;
  /** Hunger points restored (2 points fill one drumstick icon). */
  nutrition: number;
  /** Saturation points restored, absolute. */
  saturation: number;
  /** True when the item can be eaten on a full hunger bar. */
  alwaysEdible: boolean;
  /** Ticks the eating animation takes; 0 for cake, which is instant per slice. */
  eatTicks: number;
  /** Maximum stack size, so one inventory slot holds this many. */
  stack: number;
  /** Expected exhaustion from a Hunger effect this food can apply. */
  hungerExhaustion: number;
  /** Readable note about status effects or special handling; "" when none. */
  effects: string;
  /** Extra search words for the picker. */
  synonyms: string[];
}

interface HungerData {
  /** Deduplicated food tables; versions with identical tables share one. */
  eras: FoodItem[][];
  /** version id -> index into eras. */
  versionEra: Record<string, number>;
}

// Parsed from a minified string literal so the module AST stays trivial.
const DATA: HungerData = JSON.parse(
  ${sq(payload)},
) as HungerData;

export const FOOD_ERAS: FoodItem[][] = DATA.eras;

/** The food table for one version. */
export function foodsFor(version: VersionId): FoodItem[] {
  return DATA.eras[DATA.versionEra[version]] ?? [];
}

/** Look up one food in one version, or undefined when it does not exist there. */
export function foodById(version: VersionId, id: string): FoodItem | undefined {
  return foodsFor(version).find((f) => f.id === id);
}

/**
 * Core hunger constants. Identical in every verified version.
 * Source: net.minecraft.world.food.FoodConstants and FoodData#tick.
 */
export const MECHANICS = {
  /** Hunger bar maximum, in points. Ten drumstick icons of 2 points each. */
  maxFood: ${MECHANICS.MAX_FOOD},
  /** Saturation maximum; also clamped to the current food level on eating. */
  maxSaturation: ${MECHANICS.MAX_SATURATION},
  /** Saturation a freshly spawned player starts with. */
  startSaturation: ${MECHANICS.START_SATURATION},
  /** Exhaustion consumed to burn one saturation point, then one food point. */
  exhaustionDrop: ${MECHANICS.EXHAUSTION_DROP},
  /** Exhaustion is clamped here, so a huge burst is partly discarded. */
  maxExhaustion: ${MECHANICS.MAX_EXHAUSTION},
  /** Ticks between heals on the normal regeneration path. */
  healthTickCount: ${MECHANICS.HEALTH_TICK_COUNT},
  /** Ticks between heals on the saturated fast path. */
  healthTickCountSaturated: ${MECHANICS.HEALTH_TICK_COUNT_SATURATED},
  /** Food level at or above which normal regeneration runs. */
  healLevel: ${MECHANICS.HEAL_LEVEL},
  /** Exhaustion added per health point healed on the normal path. */
  exhaustionHeal: ${MECHANICS.EXHAUSTION_HEAL},
  /** Saturation spent per fast heal is capped here. */
  saturatedHealCap: ${MECHANICS.SATURATED_HEAL_CAP},
  /** Food level at or above which the player can sprint. */
  sprintLevel: ${MECHANICS.SPRINT_LEVEL},
  /** Food level at or below which starvation damage starts. */
  starveLevel: ${MECHANICS.STARVE_LEVEL},
} as const;

export interface Activity {
  id: string;
  label: string;
  unit: string;
  unitPlural: string;
  /** Exhaustion per unit. */
  exhaustion: number;
  /** Class and method the number was read from. */
  source: string;
  /**
   * Versions where this action exists at all. Absent means every version.
   * Only the enchantment-driven costs are gated, and the panel hides them
   * outside those versions so no impossible combination is ever offered.
   */
  availableIn?: string[];
}

/** Every exhaustion source a player controls, with its per-unit cost. */
export const ACTIVITIES: readonly Activity[] = JSON.parse(
  ${sq(
    JSON.stringify(
      ACTIVITIES.map(({ id, label, unit, unitPlural, exhaustion, source, availableIn }) => {
        const row = { id, label, unit, unitPlural, exhaustion, source };
        if (availableIn) row.availableIn = availableIn;
        return row;
      }),
    ),
  )},
) as Activity[];

export const ACTIVITY_BY_ID: ReadonlyMap<string, Activity> = new Map(
  ACTIVITIES.map((a) => [a.id, a]),
);

/** The actions that exist in one version. */
export function activitiesFor(version: VersionId): Activity[] {
  return ACTIVITIES.filter((a) => !a.availableIn || a.availableIn.includes(version));
}

export interface ActivityPreset {
  id: string;
  label: string;
  /** True when a rate assumes a measured travel speed rather than game code. */
  approximate: boolean;
  note: string;
  /** activity id -> units per minute. Missing activities are zero. */
  rates: Record<string, number>;
}

/**
 * Ready-made activity mixes. Every exhaustion cost per unit is source-derived;
 * the rates are not in the game code, because the game charges per block
 * travelled rather than per second. Presets that assume a travel speed are
 * flagged approximate and every rate stays editable.
 */
export const ACTIVITY_PRESETS: readonly ActivityPreset[] = JSON.parse(
  ${sq(JSON.stringify(ACTIVITY_PRESETS))},
) as ActivityPreset[];

export type DifficultyId = "peaceful" | "easy" | "normal" | "hard";

export interface Difficulty {
  id: DifficultyId;
  label: string;
  /**
   * Health below which starvation stops dealing damage, so the player is
   * left alive at this many points. null means starvation can kill.
   * Source: FoodData#tick starvation branch.
   */
  starveFloor: number | null;
  /** Peaceful never drains the hunger bar at all. */
  drains: boolean;
}

export const DIFFICULTIES: readonly Difficulty[] = [
  { id: "peaceful", label: "Peaceful", starveFloor: null, drains: false },
  { id: "easy", label: "Easy", starveFloor: 10, drains: true },
  { id: "normal", label: "Normal", starveFloor: 1, drains: true },
  { id: "hard", label: "Hard", starveFloor: null, drains: true },
];

/**
 * Peaceful regeneration timers, in ticks. Source: ServerPlayer#tickRegeneration
 * from 1.21.2, Player#aiStep before it. saturationEvery is 0 in versions with
 * no Peaceful saturation refill, which is the one real version boundary in
 * the whole mechanic.
 */
export interface PeacefulRegen {
  /** Ticks between the free health points. */
  healEvery: number;
  /** Ticks between the free hunger points. */
  foodEvery: number;
  /** Ticks between the free saturation points; 0 before 1.21. */
  saturationEvery: number;
}

export const PEACEFUL_REGEN: Record<string, PeacefulRegen> = JSON.parse(
  ${sq(JSON.stringify(peaceful))},
) as Record<string, PeacefulRegen>;

/** Ticks per second. The game runs a fixed 20 tick second. */
export const TICKS_PER_SECOND = 20;
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "data.ts"), out);

const bytes = Buffer.byteLength(out);
console.log(`versions: ${VERSIONS.join(", ")}`);
console.log(
  `food eras: ${eras.length} (${VERSIONS.map((v) => `${v}=era${versionEra[v]}`).join(", ")})`,
);
for (const [i, era] of eras.entries()) {
  const owners = VERSIONS.filter((v) => versionEra[v] === i);
  console.log(`  era ${i}: ${era.length} foods, used by ${owners.join(", ")}`);
}
console.log(
  `peaceful saturation refill: ${VERSIONS.filter((v) => peaceful[v].saturationEvery > 0).join(", ") || "none"}`,
);
console.log(`data.ts: ${bytes.toLocaleString()} bytes (${(bytes / 1024).toFixed(1)} KiB)`);
if (bytes >= SIZE_LIMIT) {
  console.error(`data.ts exceeds the 2 MB precache limit (${bytes} bytes)`);
  process.exit(1);
}

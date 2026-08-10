// Emit the committed data module for minecraft-elytra-calculator.
//
// Reads the per-version item component dumps extracted from mcmeta under
// mc-pipeline/extracted/<version>/item_components.json and writes:
//
//   src/tools/minecraft-elytra-calculator/data.ts
//
// Only the item-side facts come from extracted JSON: the elytra's
// max_damage, whether it carries the data driven `minecraft:glider`
// component, its rarity, its repair material, and the firework rocket's
// default flight_duration. Those are exactly the values that changed across
// releases, so reading them beats retyping them.
//
// The flight physics constants are NOT emitted from JSON: they live in the
// server code, not in any data file. They are hand written into the tail of
// data.ts below with class#method citations read from the decompiled trees
// under mc-pipeline/work/<version>/src/, and they are identical across all
// six versions (only the surrounding plumbing was refactored). See the
// PHYSICS_DOC block for the full citation list.
//
// The two pre-component versions (1.16.5, 1.18.2) have no
// item_components.json because item components did not exist yet; their rows
// are marked source-derived and carry the values read from
// net.minecraft.world.item.Items#ELYTRA and the Fireworks NBT tag path.
//
// Idempotent: output is deterministic (fixed version order, sorted keys), so
// re-running with unchanged inputs produces a byte identical file.
// Node builtins only. Usage: node mc-pipeline/08-emit-elytra-data.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const EXTRACTED = join(ROOT, "extracted");
const OUT_DIR = join(ROOT, "..", "src", "tools", "minecraft-elytra-calculator");
const SIZE_LIMIT = 2 * 1024 * 1024;

// Release order matters for the version picker (oldest first).
const KNOWN_VERSIONS = ["1.16.5", "1.18.2", "1.20.6", "1.21.1", "1.21.11", "26.2"];

/**
 * Values for versions that predate item components. Read by hand from
 * net.minecraft.world.item.Items#ELYTRA in the decompiled tree:
 *   new ElytraItem(new Item.Properties().durability(432).rarity(...))
 * and from FireworkRocketEntity's constructor, which reads the "Flight"
 * byte out of the item's "Fireworks" NBT compound instead of a component.
 */
const PRE_COMPONENT = {
  "1.16.5": {
    maxDamage: 432,
    rarity: "uncommon",
    glider: false,
    repairWith: "minecraft:phantom_membrane",
    flightDuration: 1,
  },
  "1.18.2": {
    maxDamage: 432,
    rarity: "uncommon",
    glider: false,
    repairWith: "minecraft:phantom_membrane",
    flightDuration: 1,
  },
};

/** 1.20.6 keys items bare ("elytra"), later dumps namespace them ("minecraft:elytra"). */
function itemEntry(all, id) {
  return all[`minecraft:${id}`] ?? all[id];
}

/** Normalize both extracted shapes: 1.20.6 is a list of {type,value}, later versions are a map. */
function componentMap(raw) {
  if (Array.isArray(raw)) {
    const out = {};
    for (const entry of raw) out[entry.type] = entry.value;
    return out;
  }
  return raw ?? {};
}

function readVersion(version) {
  const path = join(EXTRACTED, version, "item_components.json");
  if (!existsSync(path)) {
    const fallback = PRE_COMPONENT[version];
    if (!fallback) return null;
    return { version, source: "source-derived", ...fallback };
  }
  const all = JSON.parse(readFileSync(path, "utf8"));
  const elytra = componentMap(itemEntry(all, "elytra"));
  const rocket = componentMap(itemEntry(all, "firework_rocket"));
  const repairable = elytra["minecraft:repairable"];
  return {
    version,
    source: "extracted",
    maxDamage: elytra["minecraft:max_damage"],
    rarity: elytra["minecraft:rarity"],
    // The elytra became a data driven glider when this component appeared.
    glider: Object.prototype.hasOwnProperty.call(elytra, "minecraft:glider"),
    // Pre 1.21.2 the repair material lived in ElytraItem#isValidRepairItem.
    repairWith: repairable?.items ?? "minecraft:phantom_membrane",
    flightDuration: rocket["minecraft:fireworks"]?.flight_duration ?? 1,
  };
}

const rows = KNOWN_VERSIONS.map(readVersion).filter(Boolean);
if (!rows.length) {
  console.error("no extracted item component data found under mc-pipeline/extracted/");
  process.exit(1);
}
for (const row of rows) {
  if (typeof row.maxDamage !== "number") {
    console.error(`missing elytra max_damage for ${row.version}`);
    process.exit(1);
  }
}

const gliderFrom = rows.find((r) => r.glider);
const lastHardcoded = [...rows].reverse().find((r) => !r.glider);
const boundary = gliderFrom
  ? `between ${lastHardcoded?.version ?? "?"} and ${gliderFrom.version}`
  : "not reached in the extracted set";

/** Single-quoted JS string literal (prettier keeps double quotes for the rest). */
function lit(value) {
  return JSON.stringify(value);
}

const PHYSICS_DOC = `/**
 * Elytra flight constants, reimplemented from decompiled and unobfuscated
 * Minecraft server source. GENERATED FILE: the item facts below come from
 * mc-pipeline/08-emit-elytra-data.mjs reading the per-version item component
 * dumps; the physics constants are hand written here with citations and are
 * regenerated verbatim.
 *
 * Verified against six trees under mc-pipeline/work/<id>/src/
 * (1.16.5, 1.18.2, 1.20.6, 1.21.1, 1.21.11, 26.2).
 *
 * Glide physics: net.minecraft.world.entity.LivingEntity#travel, elytra
 * branch (extracted into #travelFallFlying and #updateFallFlyingMovement in
 * 1.21.11 and later). Every term is identical across all six trees:
 *   gravity term   deltaY += gravity * (-1 + cos(pitch)^2 * 0.75)
 *   dive to speed  when deltaY < 0: convert = deltaY * -0.1 * cos(pitch)^2,
 *                  added to Y and along the horizontal look direction
 *   climb trade    when pitch < 0: convert = horizontalSpeed * -sin(pitch)
 *                  * 0.04, subtracted from horizontal, times 3.2 into Y
 *   steering       horizontal velocity is dragged 10 percent toward the look
 *                  direction at the pre-step horizontal speed
 *   drag           velocity is multiplied by (0.99, 0.98, 0.99) each tick
 * Two cosmetic differences: 1.16.5 evaluates the lift cosine through the
 * float sine table (Mth#cos) while 1.18.2 and later use Math.cos, and 1.16.5
 * through 1.21.1 read a local gravity of 0.08 while 1.20.6 and later read
 * the minecraft:gravity attribute, whose default is 0.08
 * (net.minecraft.world.entity.ai.attributes.Attributes#GRAVITY). Slow
 * Falling clamps that gravity to 0.01.
 *
 * Rocket boost: net.minecraft.world.entity.projectile.FireworkRocketEntity
 * #tick, attached-to-entity branch. Per tick, for each axis:
 *   v += look * 0.1 + (look * 1.5 - v) * 0.5
 * so v converges on look * 1.7. Identical in all six trees.
 *
 * Rocket lifetime: FireworkRocketEntity constructor:
 *   lifetime = 10 * (1 + flightDuration) + nextInt(6) + nextInt(7)
 * and #tick explodes when life > lifetime, so a rocket boosts for
 * lifetime + 1 ticks. Identical in all six trees.
 *
 * Rocket self damage: FireworkRocketEntity#dealExplosionDamage:
 * 5 + 2 * explosionCount, dealt to the attached glider with no distance
 * falloff, and only when the rocket carries firework stars. The fireworks
 * damage type is in #minecraft:is_explosion and is not in
 * #minecraft:bypasses_armor, so armor and Blast Protection apply normally.
 *
 * Rocket crafting: net.minecraft.world.item.crafting.FireworkRocketRecipe
 * #assemble: 1 paper plus 1 to 3 gunpowder yields 3 rockets whose flight
 * duration equals the gunpowder count.
 *
 * Durability: LivingEntity#updateFallFlying damages the glider by 1 every
 * 20 ticks of flight. 1.16.5 writes that as (fallFlyTicks + 1) % 20 == 0;
 * 1.18.2 and later split it into a 10 tick game event with damage on every
 * second one, which is the same rate. Flight cuts off before the item
 * breaks: ElytraItem#isFlyEnabled requires damage < maxDamage - 1, and
 * ItemStack#nextDamageWillBreak is the same threshold in 1.21.11 and later.
 *
 * Unbreaking: the elytra is NOT armor for durability purposes. Through
 * 1.21.1 ElytraItem extends Item (not ArmorItem), so
 * DigDurabilityEnchantment#shouldIgnoreDurabilityDrop skips the damage with
 * probability level / (level + 1) rather than taking the 60 percent armor
 * penalty. From 1.21.1 on, unbreaking.json applies its armor branch only to
 * #minecraft:enchantable/armor, and the elytra is in
 * #minecraft:enchantable/durability but not in that armor tag, so the same
 * full rate applies.
 *
 * Anvil repair: net.minecraft.world.inventory.AnvilMenu#createResult
 * restores min(currentDamage, maxDamage / 4) per repair material, up to the
 * 4 materials that fit in the slot, at 1 level each plus the prior work
 * penalty. The elytra's repair material is the phantom membrane.
 *
 * Mending: net.minecraft.world.entity.ExperienceOrb repairs 2 durability per
 * point of experience absorbed.
 */`;

const dataTs = `${PHYSICS_DOC}

/** Version ids this tool knows about, oldest first. */
export const ELYTRA_VERSIONS = [${rows.map((r) => lit(r.version)).join(", ")}] as const;

export type ElytraVersionId = (typeof ELYTRA_VERSIONS)[number];

export interface ElytraVersionData {
  id: ElytraVersionId;
  /** Elytra max damage, i.e. total durability points. */
  maxDamage: number;
  /** Item rarity tier, purely cosmetic but it did change. */
  rarity: string;
  /** True once the item carries the data driven minecraft:glider component. */
  glider: boolean;
  /** Item id of the anvil repair material. */
  repairWith: string;
  /** flight_duration on a plain crafted firework rocket. */
  defaultFlightDuration: number;
  /** "extracted" from item component JSON, or "source-derived" for pre-component versions. */
  provenance: "extracted" | "source-derived";
}

export const ELYTRA_VERSION_DATA: Record<ElytraVersionId, ElytraVersionData> = {
${rows
  .map(
    (r) =>
      `  ${lit(r.version)}: {\n` +
      `    id: ${lit(r.version)},\n` +
      `    maxDamage: ${r.maxDamage},\n` +
      `    rarity: ${lit(r.rarity)},\n` +
      `    glider: ${r.glider},\n` +
      `    repairWith: ${lit(r.repairWith)},\n` +
      `    defaultFlightDuration: ${r.flightDuration},\n` +
      `    provenance: ${lit(r.source)},\n` +
      `  },`,
  )
  .join("\n")}
};

/**
 * Where the elytra stopped being a hardcoded item and became a data driven
 * glider component. Computed from the extracted component dumps, so it
 * states a bracket rather than guessing a version that is not on disk:
 * ${boundary}.
 */
export const GLIDER_COMPONENT_FROM: ElytraVersionId | null = ${gliderFrom ? lit(gliderFrom.version) : "null"};
export const LAST_HARDCODED_ELYTRA: ElytraVersionId | null = ${lastHardcoded ? lit(lastHardcoded.version) : "null"};

// ---------------------------------------------------------------------------
// Physics constants. Hand written, cited in the header block above, identical
// across all six verified versions.
// ---------------------------------------------------------------------------

/** Server ticks per second. */
export const TICKS_PER_SECOND = 20;

/** Default minecraft:gravity attribute value, and the local 0.08 before it existed. */
export const DEFAULT_GRAVITY = 0.08;

/** Slow Falling clamps effective gravity to this. */
export const SLOW_FALLING_GRAVITY = 0.01;

/** Per tick velocity multipliers from Vec3#multiply(0.99F, 0.98F, 0.99F). */
export const DRAG_HORIZONTAL = 0.99;
export const DRAG_VERTICAL = 0.98;

/** Fraction of gravity cancelled by lift at cos(pitch)^2 == 1. */
export const LIFT_FACTOR = 0.75;

/** Fraction of downward speed converted into forward speed each tick. */
export const DIVE_CONVERSION = 0.1;

/** Pitch-up trade: horizontal speed lost per tick, and the 3.2x into vertical. */
export const CLIMB_TRADE = 0.04;
export const CLIMB_VERTICAL_GAIN = 3.2;

/** Fraction of horizontal velocity steered toward the look direction each tick. */
export const STEER_RATE = 0.1;

/** Rocket boost: v += look * BOOST_ADD + (look * BOOST_TARGET - v) * BOOST_PULL. */
export const BOOST_ADD = 0.1;
export const BOOST_TARGET = 1.5;
export const BOOST_PULL = 0.5;

/** Rocket lifetime = LIFETIME_PER_LEVEL * (1 + flightDuration) + nextInt(6) + nextInt(7). */
export const LIFETIME_PER_LEVEL = 10;
export const LIFETIME_JITTER_MIN = 0;
export const LIFETIME_JITTER_MAX = 11;
export const LIFETIME_JITTER_MEAN = 5.5;

/** Ticks of flight per durability point consumed. */
export const TICKS_PER_DURABILITY = 20;

/** Durability restored per point of Mending experience. */
export const MENDING_DURABILITY_PER_XP = 2;

/** Fraction of max durability restored per anvil repair material. */
export const REPAIR_FRACTION = 4;

/** Repair materials that fit in one anvil slot. */
export const MAX_REPAIR_MATERIALS = 4;

/** Self damage from a rocket that carries stars: BASE + PER_STAR * starCount. */
export const SELF_DAMAGE_BASE = 5;
export const SELF_DAMAGE_PER_STAR = 2;

/** Firework rocket crafting: 1 paper + gunpowder(=flight duration) yields this many. */
export const ROCKETS_PER_CRAFT = 3;

/** Nether travel ratio: one block in the Nether is this many in the Overworld. */
export const NETHER_RATIO = 8;

/** Enchantments that can legally sit on an elytra (nothing else applies). */
export interface ElytraEnchant {
  id: string;
  label: string;
  maxLevel: number;
  synonyms: string[];
}

export const ELYTRA_ENCHANTS: ElytraEnchant[] = [
  {
    id: "unbreaking",
    label: "Unbreaking",
    maxLevel: 3,
    synonyms: ["durability", "unbreaking iii"],
  },
  { id: "mending", label: "Mending", maxLevel: 1, synonyms: ["repair", "xp repair"] },
  { id: "binding_curse", label: "Curse of Binding", maxLevel: 1, synonyms: ["binding", "cursed"] },
  {
    id: "vanishing_curse",
    label: "Curse of Vanishing",
    maxLevel: 1,
    synonyms: ["vanishing", "cursed"],
  },
];
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "data.ts"), dataTs);

const bytes = Buffer.byteLength(dataTs);
console.log(`versions: ${rows.map((r) => `${r.version}(${r.source})`).join(", ")}`);
console.log(`glider component boundary: ${boundary}`);
console.log(`data.ts: ${bytes.toLocaleString()} bytes`);
if (bytes >= SIZE_LIMIT) {
  console.error(`data.ts exceeds the 2 MB precache limit (${bytes} bytes)`);
  process.exit(1);
}

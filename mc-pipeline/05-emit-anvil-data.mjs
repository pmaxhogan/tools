// Emit the committed per-version anvil data module for the
// minecraft-anvil-calculator tool from authoritative game data.
//
// Sources, per version:
//   1.21.1 / 1.21.11 / 26.2 (data-driven enchantments):
//     - mc-pipeline/extracted/<v>/enchantment/*.json  (anvil_cost, max_level,
//       exclusive_set reference, supported_items reference)
//     - mc-pipeline/work/<v>/src/data/minecraft/tags/enchantment/exclusive_set/*.json
//       (exclusive set members; needed because membership is declared on the
//       tag, not always on the enchantment: e.g. riptide's set lists loyalty
//       and channeling, which declare nothing themselves)
//     - mc-pipeline/work/<v>/src/data/minecraft/tags/item/**  (enchantable/*
//       item tags, resolved recursively, to map enchantments onto the classic
//       item families)
//     - mc-pipeline/extracted/<v>/item_components.json  (minecraft:max_damage)
//   1.20.6 (code-defined enchantments with explicit anvil costs):
//     - anvilCost/maxLevel hand-derived from
//       work/1.20.6/src/net/minecraft/world/item/enchantment/Enchantments.java
//       (Enchantment.definition(supportedItems[, primaryItems], weight,
//       maxLevel, minCost, maxCost, anvilCost, slots)); supported-item tags
//       resolved mechanically from work/1.20.6/src/data/minecraft/tags/items/**.
//       density/breach/wind_burst are EXCLUDED: they are gated behind
//       FeatureFlags.UPDATE_1_21 in 1.20.6 and absent from vanilla play.
//     - incompatibilities hand-derived from the checkCompatibility overrides
//       (see the tables below for exact class provenance).
//   1.16.5 / 1.18.2 (rarity-based costs):
//     - per-level cost is the AnvilMenu.createResult rarity switch:
//       COMMON=1, UNCOMMON=2, RARE=4, VERY_RARE=8
//       (work/<v>/src/net/minecraft/world/inventory/AnvilMenu.java)
//     - rarity + max level + category per enchantment hand-derived from
//       work/<v>/src/net/minecraft/world/item/enchantment/Enchantments.java
//       and the *Enchantment.java subclasses (getMaxLevel, canEnchant,
//       checkCompatibility overrides).
//
// Output: src/tools/minecraft-anvil-calculator/data.ts (committed).
// Idempotent: same inputs produce a byte-identical file. Node builtins only.
// Usage: node mc-pipeline/05-emit-anvil-data.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, WORK } from "./lib/common.mjs";

const EXTRACTED = join(ROOT, "extracted");
const OUT_FILE = join(dirname(ROOT), "src", "tools", "minecraft-anvil-calculator", "data.ts");

/** All versions emitted, oldest first. */
const VERSIONS = ["1.16.5", "1.18.2", "1.20.6", "1.21.1", "1.21.11", "26.2"];

/* ------------------------------------------------------------------ */
/* Item families (the classic anvil-relevant families)                 */
/* ------------------------------------------------------------------ */

// Representative item per family: the diamond-tier member where tiers exist.
// A family is present in a version when its representative item exists there.
const FAMILIES = [
  { id: "sword", label: "Sword", rep: "diamond_sword" },
  { id: "axe", label: "Axe", rep: "diamond_axe" },
  { id: "pickaxe", label: "Pickaxe", rep: "diamond_pickaxe" },
  { id: "shovel", label: "Shovel", rep: "diamond_shovel" },
  { id: "hoe", label: "Hoe", rep: "diamond_hoe" },
  { id: "bow", label: "Bow", rep: "bow" },
  { id: "crossbow", label: "Crossbow", rep: "crossbow" },
  { id: "trident", label: "Trident", rep: "trident" },
  { id: "mace", label: "Mace", rep: "mace" },
  { id: "spear", label: "Spear", rep: "diamond_spear" },
  { id: "fishing_rod", label: "Fishing Rod", rep: "fishing_rod" },
  { id: "helmet", label: "Helmet", rep: "diamond_helmet" },
  { id: "chestplate", label: "Chestplate", rep: "diamond_chestplate" },
  { id: "leggings", label: "Leggings", rep: "diamond_leggings" },
  { id: "boots", label: "Boots", rep: "diamond_boots" },
  { id: "elytra", label: "Elytra", rep: "elytra" },
  { id: "shield", label: "Shield", rep: "shield" },
  { id: "shears", label: "Shears", rep: "shears" },
  { id: "flint_and_steel", label: "Flint and Steel", rep: "flint_and_steel" },
  { id: "brush", label: "Brush", rep: "brush" },
  { id: "book", label: "Enchanted Book", rep: "book" },
];

// Families that exist per version even if the extraction data mentions the
// item (feature-flag gates): mace/wind burst items are UPDATE_1_21 flagged in
// 1.20.6; brush is 1.20+; spears are 1.21.11+ (copper age drops).
const FAMILY_EXCLUSIONS = {
  "1.16.5": ["mace", "spear", "brush"],
  "1.18.2": ["mace", "spear", "brush"],
  "1.20.6": ["mace", "spear"],
  "1.21.1": ["spear"],
  "1.21.11": [],
  26.2: [],
};

/* ------------------------------------------------------------------ */
/* Display names                                                       */
/* ------------------------------------------------------------------ */

const NAME_OVERRIDES = {
  bane_of_arthropods: "Bane of Arthropods",
  luck_of_the_sea: "Luck of the Sea",
  binding_curse: "Curse of Binding",
  vanishing_curse: "Curse of Vanishing",
  sweeping_edge: "Sweeping Edge",
};

function displayName(id) {
  if (NAME_OVERRIDES[id]) return NAME_OVERRIDES[id];
  return id
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/* ------------------------------------------------------------------ */
/* Hand-derived tables for the code-defined eras                       */
/* ------------------------------------------------------------------ */

// 1.16.5 and 1.18.2 registrations are identical (Enchantments.java diff is
// naming only). Per-level cost = rarity via the AnvilMenu switch.
// Family lists come from EnchantmentCategory.canEnchant plus the subclass
// canEnchant overrides:
//   DamageEnchantment  +AxeItem      (sharpness/smite/bane on axes via anvil)
//   DiggingEnchantment +Items.SHEARS (efficiency on shears)
//   DigDurability      +isDamageableItem (unbreaking on any damageable)
//   ThornsEnchantment  +ArmorItem    (thorns on all armor, not just chests)
const OLD_ARMOR = ["helmet", "chestplate", "leggings", "boots"];
const OLD_DIGGER = ["axe", "pickaxe", "shovel", "hoe"];
const OLD_DAMAGEABLE = [
  "sword",
  "axe",
  "pickaxe",
  "shovel",
  "hoe",
  "bow",
  "crossbow",
  "trident",
  "fishing_rod",
  "helmet",
  "chestplate",
  "leggings",
  "boots",
  "elytra",
  "shield",
  "shears",
  "flint_and_steel",
];
const OLD_WEARABLE = [...OLD_ARMOR, "elytra"];

// [canonical id, native registry id (when it differs), rarity cost, maxLevel, families]
const OLD_ENCHANTS = [
  ["protection", null, 1, 4, OLD_ARMOR],
  ["fire_protection", null, 2, 4, OLD_ARMOR],
  ["feather_falling", null, 2, 4, ["boots"]],
  ["blast_protection", null, 4, 4, OLD_ARMOR],
  ["projectile_protection", null, 2, 4, OLD_ARMOR],
  ["respiration", null, 4, 3, ["helmet"]],
  ["aqua_affinity", null, 4, 1, ["helmet"]],
  ["thorns", null, 8, 3, OLD_ARMOR],
  ["depth_strider", null, 4, 3, ["boots"]],
  ["frost_walker", null, 4, 2, ["boots"]],
  ["binding_curse", null, 8, 1, OLD_WEARABLE],
  ["soul_speed", null, 8, 3, ["boots"]],
  ["sharpness", null, 1, 5, ["sword", "axe"]],
  ["smite", null, 2, 5, ["sword", "axe"]],
  ["bane_of_arthropods", null, 2, 5, ["sword", "axe"]],
  ["knockback", null, 2, 2, ["sword"]],
  ["fire_aspect", null, 4, 2, ["sword"]],
  ["looting", null, 4, 3, ["sword"]],
  ["sweeping_edge", "sweeping", 4, 3, ["sword"]],
  ["efficiency", null, 1, 5, [...OLD_DIGGER, "shears"]],
  ["silk_touch", null, 8, 1, OLD_DIGGER],
  ["unbreaking", null, 2, 3, OLD_DAMAGEABLE],
  ["fortune", null, 4, 3, OLD_DIGGER],
  ["power", null, 1, 5, ["bow"]],
  ["punch", null, 4, 2, ["bow"]],
  ["flame", null, 4, 1, ["bow"]],
  ["infinity", null, 8, 1, ["bow"]],
  ["luck_of_the_sea", null, 4, 3, ["fishing_rod"]],
  ["lure", null, 4, 3, ["fishing_rod"]],
  ["loyalty", null, 2, 3, ["trident"]],
  ["impaling", null, 4, 5, ["trident"]],
  ["riptide", null, 4, 3, ["trident"]],
  ["channeling", null, 8, 1, ["trident"]],
  ["multishot", null, 4, 1, ["crossbow"]],
  ["quick_charge", null, 2, 3, ["crossbow"]],
  ["piercing", null, 1, 4, ["crossbow"]],
  ["mending", null, 4, 1, OLD_DAMAGEABLE],
  ["vanishing_curse", null, 8, 1, OLD_DAMAGEABLE],
];

// Incompatibility pairs for 1.16.5/1.18.2, from checkCompatibility overrides
// (Enchantment.isCompatibleWith is symmetric: both directions are checked):
//   DamageEnchantment: sharpness/smite/bane mutually exclusive
//   ProtectionEnchantment: the four protections mutually exclusive
//     (feather falling exempt: Type.FALL passes)
//   UntouchingEnchantment (silk touch) vs BLOCK_FORTUNE, and
//   LootBonusEnchantment (fortune, looting, luck of the sea) vs SILK_TOUCH
//   ArrowInfiniteEnchantment vs MendingEnchantment
//   MultiShotEnchantment vs PIERCING
//   FrostWalkerEnchantment vs DEPTH_STRIDER (WaterWalker mirrors it)
//   TridentRiptideEnchantment vs LOYALTY and CHANNELING
const OLD_INCOMPAT_PAIRS = [
  ["sharpness", "smite"],
  ["sharpness", "bane_of_arthropods"],
  ["smite", "bane_of_arthropods"],
  ["protection", "fire_protection"],
  ["protection", "blast_protection"],
  ["protection", "projectile_protection"],
  ["fire_protection", "blast_protection"],
  ["fire_protection", "projectile_protection"],
  ["blast_protection", "projectile_protection"],
  ["silk_touch", "fortune"],
  ["silk_touch", "looting"],
  ["silk_touch", "luck_of_the_sea"],
  ["infinity", "mending"],
  ["multishot", "piercing"],
  ["frost_walker", "depth_strider"],
  ["riptide", "loyalty"],
  ["riptide", "channeling"],
];

// 1.20.6: Enchantment.definition(supported[, primary], weight, maxLevel,
// minCost, maxCost, ANVIL_COST, slots) from Enchantments.java. The anvil uses
// canEnchant -> supportedItems, so the supported tag (not primary) decides
// applicability. [id, anvilCost, maxLevel, supported item tag]
const V1206_ENCHANTS = [
  ["protection", 1, 4, "enchantable/armor"],
  ["fire_protection", 2, 4, "enchantable/armor"],
  ["feather_falling", 2, 4, "enchantable/foot_armor"],
  ["blast_protection", 4, 4, "enchantable/armor"],
  ["projectile_protection", 2, 4, "enchantable/armor"],
  ["respiration", 4, 3, "enchantable/head_armor"],
  ["aqua_affinity", 4, 1, "enchantable/head_armor"],
  ["thorns", 8, 3, "enchantable/armor"],
  ["depth_strider", 4, 3, "enchantable/foot_armor"],
  ["frost_walker", 4, 2, "enchantable/foot_armor"],
  ["binding_curse", 8, 1, "enchantable/equippable"],
  ["soul_speed", 8, 3, "enchantable/foot_armor"],
  ["swift_sneak", 8, 3, "enchantable/leg_armor"],
  ["sharpness", 1, 5, "enchantable/sharp_weapon"],
  ["smite", 2, 5, "enchantable/weapon"],
  ["bane_of_arthropods", 2, 5, "enchantable/weapon"],
  ["knockback", 2, 2, "enchantable/sword"],
  ["fire_aspect", 4, 2, "enchantable/fire_aspect"],
  ["looting", 4, 3, "enchantable/sword"],
  ["sweeping_edge", 4, 3, "enchantable/sword"],
  ["efficiency", 1, 5, "enchantable/mining"],
  ["silk_touch", 8, 1, "enchantable/mining_loot"],
  ["unbreaking", 2, 3, "enchantable/durability"],
  ["fortune", 4, 3, "enchantable/mining_loot"],
  ["power", 1, 5, "enchantable/bow"],
  ["punch", 4, 2, "enchantable/bow"],
  ["flame", 4, 1, "enchantable/bow"],
  ["infinity", 8, 1, "enchantable/bow"],
  ["luck_of_the_sea", 4, 3, "enchantable/fishing"],
  ["lure", 4, 3, "enchantable/fishing"],
  ["loyalty", 2, 3, "enchantable/trident"],
  ["impaling", 4, 5, "enchantable/trident"],
  ["riptide", 4, 3, "enchantable/trident"],
  ["channeling", 8, 1, "enchantable/trident"],
  ["multishot", 4, 1, "enchantable/crossbow"],
  ["quick_charge", 2, 3, "enchantable/crossbow"],
  ["piercing", 1, 4, "enchantable/crossbow"],
  ["mending", 4, 1, "enchantable/durability"],
  ["vanishing_curse", 8, 1, "enchantable/vanishing"],
];

// 1.20.6 incompatibilities: as 1.16.5 EXCEPT impaling is now a
// DamageEnchantment (DamageEnchantment.java: checkCompatibility rejects any
// DamageEnchantment, and impaling is registered as one in Enchantments.java),
// so it joins the sharpness/smite/bane group.
const V1206_INCOMPAT_PAIRS = [
  ...OLD_INCOMPAT_PAIRS,
  ["impaling", "sharpness"],
  ["impaling", "smite"],
  ["impaling", "bane_of_arthropods"],
];

// Old-era max damage values, verified against decompiled source:
//   diamond tier durability 1561: Tiers.java DIAMOND(3, 1561, ...)
//   armor: ArmorMaterials.java DIAMOND multiplier 33 x HEALTH_PER_SLOT
//     {13, 15, 16, 11} -> boots 429, leggings 495, chestplate 528, helmet 363
//   Items.java registrations: bow 384, trident 250, fishing_rod 64,
//     shears 238, shield 336, elytra 432, flint_and_steel 64,
//     crossbow 326 in 1.16.5 and 465 in 1.18.2 (durability change)
const OLD_MAX_DAMAGE = {
  sword: 1561,
  axe: 1561,
  pickaxe: 1561,
  shovel: 1561,
  hoe: 1561,
  bow: 384,
  trident: 250,
  fishing_rod: 64,
  helmet: 363,
  chestplate: 528,
  leggings: 495,
  boots: 429,
  elytra: 432,
  shield: 336,
  shears: 238,
  flint_and_steel: 64,
  book: 0,
};
const OLD_CROSSBOW_MAX_DAMAGE = { "1.16.5": 326, "1.18.2": 465 };

/* ------------------------------------------------------------------ */
/* Tag resolution (modern + 1.20.6 item tags, modern exclusive sets)   */
/* ------------------------------------------------------------------ */

function must(path, what) {
  if (!existsSync(path)) {
    console.error(`Missing ${what}: ${path}`);
    console.error(
      "Run the earlier pipeline steps (01-download, 02-decompile, 03-extract-data) first.",
    );
    process.exit(1);
  }
  return path;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Recursively resolve an item tag to a set of plain item ids. */
function resolveItemTag(version, tagDirName, tagName, seen = new Set()) {
  if (seen.has(tagName)) return new Set();
  seen.add(tagName);
  const path = must(
    join(WORK, version, "src", "data", "minecraft", "tags", tagDirName, `${tagName}.json`),
    `item tag for ${version}`,
  );
  const out = new Set();
  for (const value of readJson(path).values) {
    const raw = typeof value === "string" ? value : value.id;
    if (raw.startsWith("#")) {
      const child = raw.replace(/^#/, "").replace(/^minecraft:/, "");
      for (const id of resolveItemTag(version, tagDirName, child, seen)) out.add(id);
    } else {
      out.add(raw.replace(/^minecraft:/, ""));
    }
  }
  return out;
}

/** Members of a modern exclusive_set tag, as plain enchantment ids. */
function exclusiveSetMembers(version, ref) {
  if (!ref) return [];
  if (Array.isArray(ref)) return ref.map((id) => id.replace(/^minecraft:/, ""));
  if (!ref.startsWith("#")) return [ref.replace(/^minecraft:/, "")];
  const tagName = ref.replace(/^#/, "").replace(/^minecraft:/, "");
  const path = must(
    join(WORK, version, "src", "data", "minecraft", "tags", "enchantment", `${tagName}.json`),
    `enchantment tag for ${version}`,
  );
  return readJson(path).values.map((id) => id.replace(/^minecraft:/, ""));
}

/** Symmetrize incompatibility declarations into sorted per-enchant lists. */
function symmetrize(ids, declared) {
  const map = new Map(ids.map((id) => [id, new Set()]));
  for (const [id, others] of declared) {
    for (const other of others) {
      if (other === id || !map.has(other)) continue;
      map.get(id).add(other);
      map.get(other).add(id);
    }
  }
  return map;
}

function maxDamageLookup(version) {
  const path = must(
    join(EXTRACTED, version, "item_components.json"),
    `item components for ${version}`,
  );
  const data = readJson(path);
  return (itemId) => {
    const entry = data[itemId];
    if (!entry) return null;
    if (Array.isArray(entry)) {
      // 1.20.6 shape: [{ type, value }]
      const comp = entry.find((c) => c.type === "minecraft:max_damage");
      return comp ? comp.value : 0;
    }
    return entry["minecraft:max_damage"] ?? 0;
  };
}

function familiesFor(version, lookupMaxDamage) {
  const excluded = new Set(FAMILY_EXCLUSIONS[version]);
  const out = [];
  for (const fam of FAMILIES) {
    if (excluded.has(fam.id)) continue;
    if (fam.id === "book") {
      out.push({ id: fam.id, label: fam.label, maxDamage: 0 });
      continue;
    }
    const maxDamage = lookupMaxDamage(fam.id, fam.rep);
    if (maxDamage === null) continue;
    out.push({ id: fam.id, label: fam.label, maxDamage });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Per-version builders                                                */
/* ------------------------------------------------------------------ */

function buildOldVersion(version) {
  const lookup = (famId) =>
    famId === "crossbow" ? OLD_CROSSBOW_MAX_DAMAGE[version] : (OLD_MAX_DAMAGE[famId] ?? null);
  const families = familiesFor(version, lookup);
  const ids = OLD_ENCHANTS.map(([id]) => id);
  const incompat = symmetrize(
    ids,
    OLD_INCOMPAT_PAIRS.map(([a, b]) => [a, [b]]),
  );
  const enchants = OLD_ENCHANTS.map(([id, nativeId, anvilCost, maxLevel, fams]) => ({
    id,
    nativeId: nativeId ?? id,
    name: displayName(id),
    maxLevel,
    anvilCost,
    curse: id.endsWith("_curse"),
    exclusiveWith: [...incompat.get(id)].sort(),
    items: [...fams].sort(),
  })).sort((a, b) => a.id.localeCompare(b.id));
  return {
    version,
    costSource: "rarity",
    storage: "nbt",
    zeroWorkShowsZero: false,
    families,
    enchants,
  };
}

function build1206() {
  const version = "1.20.6";
  const lookupComponents = maxDamageLookup(version);
  const families = familiesFor(version, (famId, rep) => lookupComponents(rep));
  const familyIds = new Set(families.map((f) => f.id));
  const repToFamily = new Map(
    FAMILIES.filter((f) => familyIds.has(f.id)).map((f) => [f.rep, f.id]),
  );
  const ids = V1206_ENCHANTS.map(([id]) => id);
  const incompat = symmetrize(
    ids,
    V1206_INCOMPAT_PAIRS.map(([a, b]) => [a, [b]]),
  );
  const enchants = V1206_ENCHANTS.map(([id, anvilCost, maxLevel, tag]) => {
    const members = resolveItemTag(version, "items", tag);
    const fams = [...repToFamily.entries()]
      .filter(([rep]) => members.has(rep))
      .map(([, famId]) => famId)
      .sort();
    return {
      id,
      nativeId: id,
      name: displayName(id),
      maxLevel,
      anvilCost,
      curse: id.endsWith("_curse"),
      exclusiveWith: [...incompat.get(id)].sort(),
      items: fams,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return {
    version,
    costSource: "code definition",
    storage: "component",
    zeroWorkShowsZero: false,
    families,
    enchants,
  };
}

function buildModern(version) {
  const dir = must(
    join(EXTRACTED, version, "enchantment"),
    `extracted enchantments for ${version}`,
  );
  const lookupComponents = maxDamageLookup(version);
  const families = familiesFor(version, (famId, rep) => lookupComponents(rep));
  const familyIds = new Set(families.map((f) => f.id));
  const repToFamily = new Map(
    FAMILIES.filter((f) => familyIds.has(f.id)).map((f) => [f.rep, f.id]),
  );

  const raw = new Map();
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    const id = file.replace(/\.json$/, "");
    raw.set(id, readJson(join(dir, file)));
  }

  const declared = [...raw.entries()].map(([id, json]) => [
    id,
    exclusiveSetMembers(version, json.exclusive_set),
  ]);
  const incompat = symmetrize([...raw.keys()], declared);

  const enchants = [...raw.entries()]
    .map(([id, json]) => {
      const ref = json.supported_items;
      const tagName = String(ref)
        .replace(/^#/, "")
        .replace(/^minecraft:/, "");
      const members = resolveItemTag(version, "item", tagName);
      const fams = [...repToFamily.entries()]
        .filter(([rep]) => members.has(rep))
        .map(([, famId]) => famId)
        .sort();
      return {
        id,
        nativeId: id,
        name: displayName(id),
        maxLevel: json.max_level,
        anvilCost: json.anvil_cost,
        curse: id.endsWith("_curse"),
        exclusiveWith: [...incompat.get(id)].sort(),
        items: fams,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    version,
    costSource: "data pack",
    storage: "component",
    zeroWorkShowsZero: version === "1.21.11" || version === "26.2",
    families,
    enchants,
  };
}

/* ------------------------------------------------------------------ */
/* Emit                                                                */
/* ------------------------------------------------------------------ */

const built = VERSIONS.map((v) => {
  if (v === "1.16.5" || v === "1.18.2") return buildOldVersion(v);
  if (v === "1.20.6") return build1206();
  return buildModern(v);
});

// Report which versions carry identical anvil data (informs the version
// picker grouping; printed, not persisted).
const canon = built.map((b) => JSON.stringify({ ...b, version: "" }));
for (let i = 0; i < built.length; i += 1) {
  for (let j = i + 1; j < built.length; j += 1) {
    if (canon[i] === canon[j]) {
      console.log(`identical anvil data: ${built[i].version} == ${built[j].version}`);
    }
  }
}

function tsString(value) {
  return JSON.stringify(value);
}

function emitEnchant(e, indent) {
  const pad = " ".repeat(indent);
  const native = e.nativeId !== e.id ? ` nativeId: ${tsString(e.nativeId)},` : "";
  return (
    `${pad}{ id: ${tsString(e.id)},${native} name: ${tsString(e.name)}, maxLevel: ${e.maxLevel}, ` +
    `anvilCost: ${e.anvilCost}, curse: ${e.curse}, ` +
    `exclusiveWith: ${tsString(e.exclusiveWith)}, items: ${tsString(e.items)} }`
  );
}

function emitVersion(b) {
  const lines = [];
  lines.push(`  ${tsString(b.version)}: {`);
  lines.push(`    version: ${tsString(b.version)},`);
  lines.push(`    costSource: ${tsString(b.costSource)},`);
  lines.push(`    storage: ${tsString(b.storage)},`);
  lines.push(`    zeroWorkShowsZero: ${b.zeroWorkShowsZero},`);
  lines.push(`    families: [`);
  for (const f of b.families) {
    lines.push(
      `      { id: ${tsString(f.id)}, label: ${tsString(f.label)}, maxDamage: ${f.maxDamage} },`,
    );
  }
  lines.push(`    ],`);
  lines.push(`    enchants: [`);
  for (const e of b.enchants) lines.push(`${emitEnchant(e, 6)},`);
  lines.push(`    ],`);
  lines.push(`  },`);
  return lines.join("\n");
}

const header = `// AUTO-GENERATED by mc-pipeline/05-emit-anvil-data.mjs. Do not edit by hand.
//
// Per-version anvil data for the Minecraft anvil calculator, derived from
// decompiled or unobfuscated game code and from the game's own data files:
//   1.16.5 / 1.18.2: per-level costs are the AnvilMenu.createResult rarity
//     switch (COMMON=1, UNCOMMON=2, RARE=4, VERY_RARE=8); registrations from
//     Enchantments.java; applicability from EnchantmentCategory plus the
//     canEnchant overrides; incompatibilities from checkCompatibility.
//     nativeId records old registry names (sweeping_edge was "sweeping").
//   1.20.6: explicit anvil costs from Enchantment.definition(...) in
//     Enchantments.java; supported-item tags resolved from the version's data
//     tags; density/breach/wind_burst excluded (UPDATE_1_21 feature flag).
//   1.21.1 / 1.21.11 / 26.2: data-driven enchantment JSON (anvil_cost,
//     max_level, exclusive_set, supported_items) with exclusive-set and
//     enchantable item tags resolved from the version's data pack.
// exclusiveWith lists are pre-symmetrized: Enchantment.areCompatible checks
// both directions, and vanilla declarations are asymmetric (riptide's set
// lists loyalty/channeling, which declare nothing back).
// maxDamage is the representative item per family (diamond tier where tiers
// exist), from item_components.json or Items.java/Tiers.java registrations.

export interface AnvilEnchant {
  id: string;
  /** Registry id inside this version when it differs from the canonical id. */
  nativeId?: string;
  name: string;
  maxLevel: number;
  /** Per-level anvil fee, halved (minimum 1) when the sacrifice is a book. */
  anvilCost: number;
  curse: boolean;
  /** Symmetric incompatibility list (canonical ids). */
  exclusiveWith: string[];
  /** Item families this enchantment can land on via anvil (books bypass). */
  items: string[];
}

export interface AnvilFamily {
  id: string;
  label: string;
  /** Max damage of the representative item; 0 = not damageable. */
  maxDamage: number;
}

export interface AnvilVersionData {
  version: string;
  /** Where per-enchant costs come from in this version. */
  costSource: "rarity" | "code definition" | "data pack";
  /** RepairCost NBT (pre 1.20.5) or the minecraft:repair_cost component. */
  storage: "nbt" | "component";
  /** 1.21.2+ shows 0 instead of the prior-work sum when nothing changes. */
  zeroWorkShowsZero: boolean;
  families: AnvilFamily[];
  enchants: AnvilEnchant[];
}

`;

const body = [
  `export const ANVIL_VERSION_ORDER = ${tsString(VERSIONS)};`,
  ``,
  `export const ANVIL_VERSIONS: Record<string, AnvilVersionData> = {`,
  ...built.map((b) => emitVersion(b)),
  `};`,
  ``,
].join("\n");

writeFileSync(OUT_FILE, header + body);

// Normalize through the repo's own prettier (invoked as an external tool, the
// way the pipeline shells out to Java) so the committed file is format-clean
// and reruns stay byte-identical.
const prettierBin = join(dirname(ROOT), "node_modules", "prettier", "bin", "prettier.cjs");
if (existsSync(prettierBin)) {
  execFileSync(process.execPath, [prettierBin, "--write", OUT_FILE], { stdio: "ignore" });
} else {
  console.warn("prettier not found under node_modules; emitted file is unformatted");
}
console.log(`wrote ${OUT_FILE}`);
for (const b of built) {
  console.log(`  ${b.version}: ${b.enchants.length} enchants, ${b.families.length} families`);
}

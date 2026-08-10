// Extract authoritative per-version game data from misode/mcmeta (the
// committed output of Mojang's own data generator) into
// mc-pipeline/extracted/<version>/. This raw JSON is the input for the
// committed per-tool data.ts modules. Shipping mcmeta-derived data is
// standard practice across the modding ecosystem.
// Usage: node mc-pipeline/03-extract-data.mjs [versionId ...]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, ensureDir, pinnedVersions } from "./lib/common.mjs";

const OUT = join(ROOT, "extracted");
const RAW = "https://raw.githubusercontent.com/misode/mcmeta";

const BLOCK_TABLES = [
  "coal_ore", "iron_ore", "copper_ore", "gold_ore", "redstone_ore",
  "lapis_ore", "diamond_ore", "emerald_ore", "nether_quartz_ore",
  "nether_gold_ore", "ancient_debris", "deepslate_coal_ore",
  "deepslate_iron_ore", "deepslate_copper_ore", "deepslate_gold_ore",
  "deepslate_redstone_ore", "deepslate_lapis_ore", "deepslate_diamond_ore",
  "deepslate_emerald_ore", "gravel", "grass", "short_grass", "tall_grass",
  "fern", "wheat", "carrots", "potatoes", "beetroots", "nether_wart",
  "oak_leaves", "birch_leaves", "spruce_leaves", "jungle_leaves",
  "acacia_leaves", "dark_oak_leaves", "mangrove_leaves", "cherry_leaves",
  "azalea_leaves", "melon", "clay", "snow", "glowstone", "sea_lantern",
  "sweet_berry_bush", "cocoa", "amethyst_cluster",
];

const ENTITY_TABLES = [
  "zombie", "husk", "drowned", "skeleton", "stray", "bogged", "creeper",
  "spider", "cave_spider", "enderman", "blaze", "wither_skeleton", "ghast",
  "slime", "magma_cube", "witch", "pillager", "vindicator", "evoker",
  "ravager", "zombified_piglin", "piglin", "hoglin", "zoglin", "guardian",
  "elder_guardian", "shulker", "phantom", "silverfish", "endermite",
  "cow", "pig", "chicken", "rabbit", "squid", "glow_squid", "salmon",
  "cod", "pufferfish", "tropical_fish", "mooshroom", "horse", "donkey",
  "llama", "goat", "turtle", "polar_bear", "panda", "dolphin", "bat",
  "parrot", "wolf", "fox", "frog", "iron_golem", "snow_golem",
  "ender_dragon", "wither", "warden", "breeze", "camel", "sniffer",
  "armadillo", "wandering_trader",
  "sheep", "sheep/white", "sheep/black", "sheep/gray", "sheep/light_gray",
  "sheep/brown", "sheep/red", "sheep/orange", "sheep/yellow", "sheep/lime",
  "sheep/green", "sheep/cyan", "sheep/light_blue", "sheep/blue",
  "sheep/purple", "sheep/magenta", "sheep/pink",
];

const GAMEPLAY_TABLES = [
  "fishing", "fishing/fish", "fishing/junk", "fishing/treasure",
  "cat_morning_gift", "hero_of_the_village/armorer_gift",
];

const CHEST_TABLES = [
  "simple_dungeon", "abandoned_mineshaft", "desert_pyramid", "jungle_temple",
  "stronghold_library", "end_city_treasure", "buried_treasure",
  "shipwreck_treasure", "nether_bridge", "bastion_treasure", "ancient_city",
  "trial_chambers/reward",
];

const DAMAGE_TAGS = [
  "bypasses_armor", "bypasses_effects", "bypasses_enchantments",
  "bypasses_resistance", "bypasses_invulnerability", "is_fall",
  "is_projectile", "is_explosion", "is_fire",
];

async function tryFetch(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

/** Fetch a batch of {url, dest} in parallel, skipping 404s. */
async function fetchBatch(items, label) {
  let hit = 0;
  const CHUNK = 12;
  for (let i = 0; i < items.length; i += CHUNK) {
    await Promise.all(
      items.slice(i, i + CHUNK).map(async ({ url, dest }) => {
        const text = await tryFetch(url);
        if (text === null) return;
        ensureDir(join(dest, ".."));
        writeFileSync(dest, text);
        hit++;
      }),
    );
  }
  console.log(`  ${label}: ${hit}/${items.length}`);
}

const only = process.argv.slice(2);
const { ids } = await pinnedVersions();
const targets = only.length ? only : ids;

for (const id of targets) {
  console.log(`[${id}] extracting...`);
  const out = ensureDir(join(OUT, id));
  // Path era: 1.21+ singular loot_table, before that loot_tables.
  const dataBase = `${RAW}/${id}-data/data/minecraft`;
  const probe = await tryFetch(`${dataBase}/loot_table/blocks/diamond_ore.json`);
  const lootRoot = probe !== null ? "loot_table" : "loot_tables";

  const items = [];
  for (const t of BLOCK_TABLES)
    items.push({
      url: `${dataBase}/${lootRoot}/blocks/${t}.json`,
      dest: join(out, "loot", "blocks", `${t.replace(/\//g, "_")}.json`),
    });
  for (const t of ENTITY_TABLES)
    items.push({
      url: `${dataBase}/${lootRoot}/entities/${t}.json`,
      dest: join(out, "loot", "entities", `${t.replace(/\//g, "_")}.json`),
    });
  for (const t of GAMEPLAY_TABLES)
    items.push({
      url: `${dataBase}/${lootRoot}/gameplay/${t}.json`,
      dest: join(out, "loot", "gameplay", `${t.replace(/\//g, "_")}.json`),
    });
  for (const t of CHEST_TABLES)
    items.push({
      url: `${dataBase}/${lootRoot}/chests/${t}.json`,
      dest: join(out, "loot", "chests", `${t.replace(/\//g, "_")}.json`),
    });
  await fetchBatch(items, "loot tables");

  await fetchBatch(
    DAMAGE_TAGS.map((t) => ({
      url: `${dataBase}/tags/damage_type/${t}.json`,
      dest: join(out, "damage_type_tags", `${t}.json`),
    })),
    "damage type tags",
  );

  // Data-driven enchantments (1.21+): enumerate via the summary registries.
  const registries = await tryFetch(
    `${RAW}/${id}-summary/registries/data.json`,
  );
  if (registries) {
    writeFileSync(join(out, "registries.json"), registries);
    const reg = JSON.parse(registries);
    const enchants = reg.enchantment ?? [];
    if (enchants.length) {
      await fetchBatch(
        enchants.map((e) => ({
          url: `${dataBase}/enchantment/${e}.json`,
          dest: join(out, "enchantment", `${e}.json`),
        })),
        "enchantments",
      );
    }
  }

  // Item components summary (1.20.5+): armor attributes, food, tools.
  const components = await tryFetch(`${RAW}/${id}-summary/item_components/data.json`);
  if (components) writeFileSync(join(out, "item_components.json"), components);

  // Version metadata for provenance.
  const vmeta = await tryFetch(`${RAW}/${id}-summary/version.json`);
  if (vmeta) writeFileSync(join(out, "mcmeta-version.json"), vmeta);
}
console.log("done");

#!/usr/bin/env node
/**
 * Emit src/tools/minecraft-villager-trade-calculator/data.ts.
 *
 * Villager trades are NOT data driven before 26.x: they are hardcoded in
 * net/minecraft/world/entity/npc/VillagerTrades.java (moved to
 * net/minecraft/world/entity/npc/villager/ in 1.21.11) as a map of
 * profession to level to ItemListing[]. This script slices that TRADES map
 * out of the decompiled source and resolves each ItemListing constructor
 * against an explicit per-class signature table, so a shape the game
 * introduced but this script does not know is a hard error rather than a
 * silent misparse.
 *
 * 26.x reworked trades into registry data: the server jar ships
 * data/minecraft/villager_trade/<profession>/<level>/<name>.json plus
 * data/minecraft/trade_set/<profession>/level_<n>.json. Those JSON files are
 * read directly, which is authoritative and needs no parsing heuristics.
 *
 * Also emitted:
 * - the tradeable enchantment universe per version (drives enchanted book
 *   price ranges). 1.21+ ships enchantments and the #minecraft:tradeable /
 *   #minecraft:double_trade_price tags as data; older versions keep them in
 *   Enchantments.java plus per-class isTreasureOnly/isTradeable/getMaxLevel
 *   overrides, which are read from the decompiled classes.
 * - the gossip rules per version, read from
 *   net/minecraft/world/entity/ai/gossip/GossipType.java. This is where the
 *   1.20.2 cure nerf lives.
 *
 * Nothing here is committed to the site bundle except numbers: no Java code
 * is transcribed into TypeScript.
 *
 * Usage: node mc-pipeline/11-emit-villager-data.mjs
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const WORK = join(ROOT, "work");
const OUT = join(ROOT, "..", "src", "tools", "minecraft-villager-trade-calculator", "data.ts");

const VERSIONS = ["1.16.5", "1.18.2", "1.20.6", "1.21.1", "1.21.11", "26.2"];

// ------------------------------------------------------------- java utils --

/** Body of the balanced bracket group whose opener is at src[open]. */
function balanced(src, open) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  if (!pairs[src[open]]) throw new Error(`not an opener at ${open}: ${src.slice(open, open + 20)}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) return { body: src.slice(open + 1, i), end: i + 1 };
    }
  }
  throw new Error("unbalanced group");
}

/** Split on commas that sit outside brackets and outside generic <> lists. */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let generic = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "<" && depth === 0 && /[A-Za-z.]/.test(s[i - 1] ?? "")) generic++;
    else if (c === ">" && generic > 0) generic--;
    else if (c === "," && depth === 0 && generic === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = s.slice(start).trim();
  if (last) out.push(last);
  return out;
}

const int = (s) => {
  const n = Number(String(s).trim());
  if (!Number.isFinite(n)) throw new Error(`not a number: ${s}`);
  return n;
};
const flt = (s) => {
  const n = Number(String(s).trim().replace(/[Ff]$/, ""));
  if (!Number.isFinite(n)) throw new Error(`not a float: ${s}`);
  return n;
};
/**
 * Java constant names that do not lowercase into the registry id. Mojang's
 * official 1.16.5 and 1.18.2 mappings name the globe banner pattern item
 * GLOBE_BANNER_PATTER, a typo in the field only: the registry id has always
 * been globe_banner_pattern. Every emitted id is checked against the version's
 * item registry, so a future mismatch fails the run instead of shipping.
 */
const ITEM_ALIASES = { globe_banner_patter: "globe_banner_pattern" };

/** "Items.GOLDEN_CARROT" / "Blocks.PUMPKIN" / "new ItemStack(Items.X)" -> "golden_carrot". */
function itemId(expr) {
  const s = String(expr).trim();
  const stack = s.match(/^new ItemStack\(\s*(?:Items|Blocks)\.(\w+)/);
  const cost = s.match(/^new ItemCost\(\s*(?:Items|Blocks)\.(\w+)/);
  const plain = s.match(/^(?:Items|Blocks)\.(\w+)$/);
  const hit = stack ?? cost ?? plain;
  if (!hit) throw new Error(`cannot read item from: ${s}`);
  const id = hit[1].toLowerCase();
  return ITEM_ALIASES[id] ?? id;
}
const villagerType = (expr) =>
  String(expr)
    .trim()
    .replace(/^VillagerType\./, "")
    .toLowerCase();

// ----------------------------------------------------------- stack sizes --

/**
 * Max stack size per item, which the price formula needs: both
 * MerchantOffer.getModifiedCostCount (every version) and TradeCost.toItemCost
 * (26.x only) clamp a trade's cost to the COST ITEM's stack size, not to 64.
 * That is why the librarian's "2 book and quill" trade only ever charges one.
 *
 * 1.21+ ships max_stack_size as an item component in the extracted dump.
 * Earlier versions keep it in Items.java as Item.Properties().stacksTo(n),
 * with tools implying 1 through durability(n).
 */
function parseStackSizes(version) {
  const dump = join(ROOT, "extracted", version, "item_components.json");
  if (existsSync(dump)) {
    const json = JSON.parse(readFileSync(dump, "utf8"));
    const probe = json["minecraft:writable_book"] ?? json.writable_book;
    if (probe && typeof probe === "object" && "minecraft:max_stack_size" in probe) {
      const out = {};
      for (const [id, components] of Object.entries(json)) {
        out[stripNs(id)] = components["minecraft:max_stack_size"] ?? 64;
      }
      return out;
    }
  }
  return stackSizesFromJava(version);
}

/** Items.java: register*("id" | Blocks.X, ... new Item.Properties()...). */
function stackSizesFromJava(version) {
  const file = join(WORK, version, "src/net/minecraft/world/item/Items.java");
  const src = readFileSync(file, "utf8");
  const out = {};
  const re = /\bregister(?:Item|Block)\(/g;
  while (re.exec(src)) {
    const { body } = balanced(src, re.lastIndex - 1);
    const named = body.match(/^\s*"(\w+)"/);
    const fromBlock = body.match(/^\s*Blocks\.(\w+)/);
    const id = named ? named[1] : fromBlock ? fromBlock[1].toLowerCase() : null;
    if (!id) continue;
    const stacksTo = body.match(/stacksTo\((\d+)\)/);
    if (stacksTo) out[id] = int(stacksTo[1]);
    else if (/\b(?:durability|defaultDurability)\(/.test(body)) out[id] = 1;
    else out[id] = 64;
  }
  if (!Object.keys(out).length) throw new Error(`${version}: parsed no item stack sizes`);
  return out;
}

/** Stack size for a cost item. An unknown id is a hard error, never a guess. */
function stackSize(stacks, id, where) {
  const size = stacks[id];
  if (size === undefined) throw new Error(`${where}: no known stack size for "${id}"`);
  return size;
}

// --------------------------------------------------------- trade records --

/**
 * One offer template. Counts are the base cost BEFORE demand, reputation and
 * Hero of the Village are applied; wMin/wMax bracket the randomised part.
 */
function trade(o) {
  const biomes = o.biomes ?? [];
  return {
    wants: o.wants,
    wMin: o.wMin,
    wMax: o.wMax ?? o.wMin,
    // Explorer maps are stored as a blank map and turned into a filled map by
    // the offer, which is the item the trade really hands over. 26.x keeps the
    // blank template in its data, so normalise it to what the player sees.
    gives: (o.variable ?? "") === "map" ? "filled_map" : o.gives,
    gCount: o.gCount ?? 1,
    maxUses: o.maxUses,
    xp: o.xp,
    mult: o.mult,
    w2: o.w2 ?? "",
    w2Count: o.w2Count ?? 0,
    // A villager type gate always marks the trade as type specific, however
    // the version happens to express it.
    variable: o.variable || (biomes.length ? "type" : ""),
    biomes,
  };
}

/** Enchanted book emerald cost: 2 + rand(5 + 10L) + 3L, doubled for treasure. */
const BOOK_MIN = (level) => 2 + 3 * level;
const BOOK_MAX = (level) => Math.min(2 + (5 + 10 * level - 1) + 3 * level, 64);

// ------------------------------------------------ ItemListing signatures --

/**
 * Constructor shapes actually used inside the TRADES map, resolved by arity.
 * Every one was read off the decompiled class; an unknown class or arity
 * throws so that a future shape cannot be silently mis-assigned.
 */
const LISTINGS = {
  // (item, cost, maxUses, xp) -> cost items for 1 emerald, multiplier 0.05
  EmeraldForItems: (a) => {
    if (a.length !== 4) throw new Error(`EmeraldForItems arity ${a.length}`);
    return trade({
      wants: itemId(a[0]),
      wMin: int(a[1]),
      gives: "emerald",
      gCount: 1,
      maxUses: int(a[2]),
      xp: int(a[3]),
      mult: 0.05,
    });
  },
  // (item, emeraldCost, count, [maxUses], xp, [multiplier])
  ItemsForEmeralds: (a) => {
    let maxUses = 12;
    let mult = 0.05;
    let xp;
    if (a.length === 4) xp = int(a[3]);
    else if (a.length === 5) {
      maxUses = int(a[3]);
      xp = int(a[4]);
    } else if (a.length === 6) {
      maxUses = int(a[3]);
      xp = int(a[4]);
      mult = flt(a[5]);
    } else throw new Error(`ItemsForEmeralds arity ${a.length}`);
    return trade({
      wants: "emerald",
      wMin: int(a[1]),
      gives: itemId(a[0]),
      gCount: int(a[2]),
      maxUses,
      xp,
      mult,
    });
  },
  // pre 1.20.6: (from, fromCount, to, toCount, maxUses, xp) with 1 emerald
  // 1.20.6+:    (from, fromCount, emeraldCost, to, toCount, maxUses, xp, mult)
  ItemsAndEmeraldsToItems: (a) => {
    if (a.length === 6) {
      return trade({
        wants: "emerald",
        wMin: 1,
        w2: itemId(a[0]),
        w2Count: int(a[1]),
        gives: itemId(a[2]),
        gCount: int(a[3]),
        maxUses: int(a[4]),
        xp: int(a[5]),
        mult: 0.05,
      });
    }
    if (a.length === 8) {
      return trade({
        wants: "emerald",
        wMin: int(a[2]),
        w2: itemId(a[0]),
        w2Count: int(a[1]),
        gives: itemId(a[3]),
        gCount: int(a[4]),
        maxUses: int(a[5]),
        xp: int(a[6]),
        mult: flt(a[7]),
      });
    }
    throw new Error(`ItemsAndEmeraldsToItems arity ${a.length}`);
  },
  // (cost, maxUses, xp, map of villager type to item) -> 1 emerald
  EmeraldsForVillagerTypeItem: (a) => {
    if (a.length !== 4) throw new Error(`EmeraldsForVillagerTypeItem arity ${a.length}`);
    const pairs = [...String(a[3]).matchAll(/VillagerType\.(\w+)\s*,\s*Items\.(\w+)/g)];
    if (!pairs.length) throw new Error("EmeraldsForVillagerTypeItem: no biome map entries");
    return pairs.map(([, type, item]) =>
      trade({
        wants: item.toLowerCase(),
        wMin: int(a[0]),
        gives: "emerald",
        gCount: 1,
        maxUses: int(a[1]),
        xp: int(a[2]),
        mult: 0.05,
        biomes: [type.toLowerCase()],
        variable: "type",
      }),
    );
  },
  // (xp) or (xp, enchantmentTag): emeralds + book -> random enchanted book
  EnchantBookForEmeralds: (a) => {
    if (a.length !== 1 && a.length !== 2)
      throw new Error(`EnchantBookForEmeralds arity ${a.length}`);
    return trade({
      wants: "emerald",
      wMin: BOOK_MIN(1),
      wMax: BOOK_MAX(5),
      w2: "book",
      w2Count: 1,
      gives: "enchanted_book",
      gCount: 1,
      maxUses: 12,
      xp: int(a[0]),
      mult: 0.2,
      variable: "book",
    });
  },
  // (item, baseCost, maxUses, xp, [multiplier]); real cost is base + 5..19
  EnchantedItemForEmeralds: (a) => {
    if (a.length !== 4 && a.length !== 5)
      throw new Error(`EnchantedItemForEmeralds arity ${a.length}`);
    const base = int(a[1]);
    return trade({
      wants: "emerald",
      wMin: Math.min(base + 5, 64),
      wMax: Math.min(base + 19, 64),
      gives: itemId(a[0]),
      gCount: 1,
      maxUses: int(a[2]),
      xp: int(a[3]),
      mult: a.length === 5 ? flt(a[4]) : 0.05,
      variable: "enchanted",
    });
  },
  // (item, emeraldCost, [maxUses, xp]) -> randomly dyed leather armour
  DyedArmorForEmeralds: (a) => {
    if (a.length !== 2 && a.length !== 4) throw new Error(`DyedArmorForEmeralds arity ${a.length}`);
    return trade({
      wants: "emerald",
      wMin: int(a[1]),
      gives: itemId(a[0]),
      gCount: 1,
      maxUses: a.length === 4 ? int(a[2]) : 12,
      xp: a.length === 4 ? int(a[3]) : 1,
      mult: 0.2,
      variable: "dyed",
    });
  },
  // emeralds + compass -> explorer map. 1.16.5 has no display-name argument.
  TreasureMapForEmeralds: (a) => {
    if (a.length !== 5 && a.length !== 6)
      throw new Error(`TreasureMapForEmeralds arity ${a.length}`);
    const tail = a.length === 5 ? [a[3], a[4]] : [a[4], a[5]];
    return trade({
      wants: "emerald",
      wMin: int(a[0]),
      w2: "compass",
      w2Count: 1,
      gives: "filled_map",
      gCount: 1,
      maxUses: int(tail[0]),
      xp: int(tail[1]),
      mult: 0.2,
      variable: "map",
    });
  },
  // (from, fromCount, to, toCount, emeraldCost, maxUses, xp)
  TippedArrowForItemsAndEmeralds: (a) => {
    if (a.length !== 7) throw new Error(`TippedArrowForItemsAndEmeralds arity ${a.length}`);
    return trade({
      wants: "emerald",
      wMin: int(a[4]),
      w2: itemId(a[0]),
      w2Count: int(a[1]),
      gives: itemId(a[2]),
      gCount: int(a[3]),
      maxUses: int(a[5]),
      xp: int(a[6]),
      mult: 0.05,
      variable: "arrow",
    });
  },
  // (effect, duration, xp) -> 1 emerald for one suspicious stew
  SuspiciousStewForEmerald: (a) => {
    if (a.length !== 3) throw new Error(`SuspiciousStewForEmerald arity ${a.length}`);
    return trade({
      wants: "emerald",
      wMin: 1,
      gives: "suspicious_stew",
      gCount: 1,
      maxUses: 12,
      xp: int(a[2]),
      mult: 0.05,
      variable: "stew",
    });
  },
};
LISTINGS.SuspisciousStewForEmerald = LISTINGS.SuspiciousStewForEmerald; // 1.16.5 spelling

/** Parse one `new VillagerTrades.X(...)` or `TypeSpecificTrade.oneTradeInBiomes(...)`. */
function parseListing(expr) {
  const src = expr.trim();
  const biomeWrap = src.match(/^VillagerTrades\.TypeSpecificTrade\.oneTradeInBiomes\(/);
  if (biomeWrap) {
    const { body } = balanced(src, biomeWrap[0].length - 1);
    const args = splitTop(body);
    const inner = parseListing(args[0]);
    const biomes = args.slice(1).map(villagerType);
    return inner.map((t) => ({ ...t, biomes, variable: t.variable || "type" }));
  }
  const m = src.match(/^new VillagerTrades\.(\w+)\(/);
  if (!m) throw new Error(`unrecognised listing expression: ${src.slice(0, 80)}`);
  const handler = LISTINGS[m[1]];
  if (!handler) throw new Error(`unknown ItemListing class: ${m[1]}`);
  const { body } = balanced(src, m[0].length - 1);
  const out = handler(splitTop(body));
  return Array.isArray(out) ? out : [out];
}

// ---------------------------------------------------- java TRADES parsing --

function javaTradesFile(version) {
  const candidates = [
    join(WORK, version, "src/net/minecraft/world/entity/npc/VillagerTrades.java"),
    join(WORK, version, "src/net/minecraft/world/entity/npc/villager/VillagerTrades.java"),
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error(`no VillagerTrades.java for ${version}`);
  return hit;
}

function parseJavaTrades(version) {
  const src = readFileSync(javaTradesFile(version), "utf8");
  const anchor = src.indexOf("TRADES = Util.make(");
  if (anchor < 0) throw new Error(`${version}: no TRADES map`);
  const { body } = balanced(src, src.indexOf("(", anchor));

  const professions = {};
  const re = /\.put\(\s*VillagerProfession\.(\w+),\s*toIntMap\(/g;
  let m;
  while ((m = re.exec(body))) {
    const profession = m[1].toLowerCase();
    const { body: mapExpr } = balanced(body, re.lastIndex - 1);
    professions[profession] = parseLevelMap(mapExpr, `${version}/${profession}`);
  }
  if (!Object.keys(professions).length) throw new Error(`${version}: parsed no professions`);
  return professions;
}

/** ImmutableMap.of(1, [...], 2, [...]) or ImmutableMap.builder().put(...).build(). */
function parseLevelMap(expr, where) {
  const levels = {};
  const ofAt = expr.indexOf("ImmutableMap.of(");
  if (ofAt >= 0) {
    const { body } = balanced(expr, ofAt + "ImmutableMap.of".length);
    const args = splitTop(body);
    if (args.length % 2) throw new Error(`${where}: odd ImmutableMap.of arity`);
    for (let i = 0; i < args.length; i += 2)
      levels[int(args[i])] = parseListingArray(args[i + 1], where);
    return levels;
  }
  if (expr.includes("builder()")) {
    const re = /\.put\(/g;
    while (re.exec(expr)) {
      const { body } = balanced(expr, re.lastIndex - 1);
      const args = splitTop(body);
      if (args.length !== 2) throw new Error(`${where}: builder put arity ${args.length}`);
      levels[int(args[0])] = parseListingArray(args[1], where);
    }
    return levels;
  }
  throw new Error(`${where}: unrecognised level map shape`);
}

function parseListingArray(expr, where) {
  const at = expr.indexOf("{");
  if (at < 0) throw new Error(`${where}: no ItemListing array literal`);
  const { body } = balanced(expr, at);
  const out = [];
  for (const part of splitTop(body)) out.push(...parseListing(part));
  if (!out.length) throw new Error(`${where}: empty listing array`);
  return out;
}

// ------------------------------------------------ 26.x data-driven trades --

/** Flatten a villager_trade tag, following nested "#tag" references. */
function resolveTradeTag(dataRoot, tag, seen = new Set()) {
  const id = stripNs(tag.replace(/^#/, ""));
  if (seen.has(id)) return [];
  seen.add(id);
  const file = join(dataRoot, "tags/villager_trade", `${id}.json`);
  if (!existsSync(file)) throw new Error(`missing villager_trade tag ${id}`);
  const out = [];
  for (const raw of JSON.parse(readFileSync(file, "utf8")).values) {
    const value = typeof raw === "string" ? raw : raw.id;
    if (String(value).startsWith("#")) out.push(...resolveTradeTag(dataRoot, value, seen));
    else out.push(stripNs(value));
  }
  return out;
}

/**
 * 26.x: each profession level is a trade_set pointing at a villager_trade
 * tag, so shared pools (the smith trades used by all three smiths) resolve
 * correctly. The wandering trader has trade sets too and is excluded: this
 * tool models villagers only.
 */
function parseDataTrades(version, stacks) {
  const dataRoot = join(WORK, version, "src/data/minecraft");
  const setRoot = join(dataRoot, "trade_set");
  if (!existsSync(setRoot)) throw new Error(`${version}: no trade_set data directory`);
  const professions = {};
  for (const profession of readdirSync(setRoot)) {
    if (profession === "wandering_trader") continue;
    if (!statSync(join(setRoot, profession)).isDirectory()) continue;
    const levels = {};
    for (let level = 1; level <= 5; level++) {
      const setFile = join(setRoot, profession, `level_${level}.json`);
      if (!existsSync(setFile)) continue;
      const set = JSON.parse(readFileSync(setFile, "utf8"));
      const rows = [];
      for (const id of resolveTradeTag(dataRoot, set.trades)) {
        const file = join(dataRoot, "villager_trade", `${id}.json`);
        if (!existsSync(file)) throw new Error(`${version}: missing villager_trade ${id}`);
        rows.push(
          convertDataTrade(JSON.parse(readFileSync(file, "utf8")), `${version}/${id}`, stacks),
        );
      }
      if (!rows.length) throw new Error(`${version}/${profession}/${level}: empty trade set`);
      levels[level] = rows;
    }
    professions[profession] = levels;
  }
  if (!Object.keys(professions).length) throw new Error(`${version}: parsed no professions`);
  return professions;
}

const stripNs = (id) => String(id).replace(/^minecraft:/, "");

function convertDataTrade(json, where, stacks) {
  if (!json.wants || !json.gives) throw new Error(`${where}: missing wants/gives`);
  const wants = stripNs(json.wants.id);
  const base = json.wants.count ?? 1;
  // TradeCost.toItemCost clamps the cost to the COST ITEM's max stack size
  // when the offer is built, so a `count: 2` book and quill trade really
  // stores a base cost of 1. See the note in main() for why this only shows
  // up in 26.x data.
  const cap = stackSize(stacks, wants, where);
  let wMin = Math.min(base, cap);
  let wMax = wMin;
  let variable = "";

  for (const fn of json.given_item_modifiers ?? []) {
    const name = stripNs(fn.function);
    if (name === "enchant_randomly" && fn.include_additional_cost_component) {
      variable = "book";
      wMin = Math.min(base + BOOK_MIN(1), cap);
      wMax = Math.min(base + BOOK_MAX(5), cap);
    } else if (name === "enchant_with_levels" && fn.include_additional_cost_component) {
      variable = "enchanted";
      const lv = fn.levels ?? {};
      wMin = Math.min(base + (lv.min ?? 5), cap);
      wMax = Math.min(base + (lv.max ?? 19), cap);
    } else if (name === "set_random_dyes") variable = variable || "dyed";
    else if (name === "exploration_map") variable = variable || "map";
    else if (name === "set_stew_effect") variable = variable || "stew";
    else if (name === "set_potion") variable = variable || "arrow";
  }

  const biomes = [];
  const predicate =
    json.merchant_predicate?.predicate?.["minecraft:predicates"]?.["minecraft:villager/variant"];
  if (predicate) {
    // The villager type gate is a single id or a list of them.
    for (const value of Array.isArray(predicate) ? predicate : [predicate]) {
      biomes.push(stripNs(value));
    }
    variable = variable || "type";
  }

  return trade({
    wants,
    wMin,
    wMax,
    gives: stripNs(json.gives.id),
    gCount: json.gives.count ?? 1,
    maxUses: json.max_uses ?? 4,
    xp: json.xp ?? 1,
    mult: json.reputation_discount ?? 0,
    w2: json.additional_wants ? stripNs(json.additional_wants.id) : "",
    w2Count: json.additional_wants ? (json.additional_wants.count ?? 1) : 0,
    variable,
    biomes,
  });
}

/** Trades offered per level: hardcoded 2 before 26.x, a trade_set field after. */
function tradesPerLevel(version, professions) {
  const dir = join(WORK, version, "src/data/minecraft/trade_set");
  if (!existsSync(dir))
    return Object.fromEntries(Object.keys(professions).map((p) => [p, [2, 2, 2, 2, 2]]));
  const out = {};
  for (const profession of Object.keys(professions)) {
    const amounts = [];
    for (let level = 1; level <= 5; level++) {
      const file = join(dir, profession, `level_${level}.json`);
      amounts.push(existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).amount ?? 2) : 0);
    }
    out[profession] = amounts;
  }
  return out;
}

// ----------------------------------------------------------- enchantments --

/** Flatten an enchantment tag, following nested "#tag" references. */
function resolveEnchantTag(dataRoot, tag, seen = new Set()) {
  const id = stripNs(tag.replace(/^#/, ""));
  if (seen.has(id)) return [];
  seen.add(id);
  const file = join(dataRoot, "tags/enchantment", `${id}.json`);
  if (!existsSync(file)) throw new Error(`missing enchantment tag ${id}`);
  const out = [];
  for (const raw of JSON.parse(readFileSync(file, "utf8")).values) {
    const value = typeof raw === "string" ? raw : raw.id;
    if (String(value).startsWith("#")) out.push(...resolveEnchantTag(dataRoot, value, seen));
    else out.push(stripNs(value));
  }
  return out;
}

/** 1.21+: enchantment definitions and the trade tags ship as jar data. */
function enchantsFromData(version) {
  const dataRoot = join(WORK, version, "src/data/minecraft");
  const tradeable = [...new Set(resolveEnchantTag(dataRoot, "tradeable"))];
  const doubled = new Set(resolveEnchantTag(dataRoot, "double_trade_price"));
  return tradeable.map((id) => {
    const def = JSON.parse(readFileSync(join(dataRoot, "enchantment", `${id}.json`), "utf8"));
    return { id, maxLevel: def.max_level ?? 1, doublePrice: doubled.has(id) };
  });
}

/**
 * Pre-1.21: Enchantments.java registers `register("id", new XEnchantment(...))`.
 * The max level, the treasure flag and the tradeable flag are virtual methods
 * on the class, defaulting to 1 / false / true on Enchantment itself.
 */
function enchantsFromJava(version) {
  const dir = join(WORK, version, "src/net/minecraft/world/item/enchantment");
  const registry = readFileSync(join(dir, "Enchantments.java"), "utf8");
  const classCache = new Map();

  const readClass = (name) => {
    if (classCache.has(name)) return classCache.get(name);
    const file = join(dir, `${name}.java`);
    const src = existsSync(file) ? readFileSync(file, "utf8") : "";
    const boolOverride = (method) => {
      const m = src.match(
        new RegExp(`public boolean ${method}\\(\\)\\s*\\{\\s*return (true|false);`),
      );
      return m ? m[1] === "true" : null;
    };
    const maxLevel = src.match(/public int getMaxLevel\(\)\s*\{\s*return (\d+);/);
    const info = {
      maxLevel: maxLevel ? int(maxLevel[1]) : null,
      treasure: boolOverride("isTreasureOnly"),
      tradeable: boolOverride("isTradeable"),
    };
    classCache.set(name, info);
    return info;
  };

  const out = [];
  const re = /register\(\s*"(\w+)",\s*new (\w+)\(/g;
  let m;
  while ((m = re.exec(registry))) {
    const [, id, className] = m;
    const { body } = balanced(registry, re.lastIndex - 1);
    const info = readClass(className);
    // 1.20.x moved the numbers into Enchantment.definition(tag, weight, maxLevel, ...).
    let maxLevel = info.maxLevel;
    // 1.20.x: Enchantment.definition(supportedItems, [primaryItems,] weight,
    // maxLevel, ...). Both overloads are in use, so anchor on the first two
    // bare integer arguments: they are always weight then maxLevel.
    const at = body.indexOf("Enchantment.definition");
    if (at >= 0) {
      const args = splitTop(balanced(body, body.indexOf("(", at)).body);
      const weightAt = args.findIndex((a) => /^\d+$/.test(a));
      if (weightAt < 0 || !/^\d+$/.test(args[weightAt + 1] ?? "")) {
        throw new Error(`${version}/${id}: cannot locate max level in Enchantment.definition`);
      }
      maxLevel = int(args[weightAt + 1]);
    }
    if (maxLevel == null) maxLevel = 1;
    const treasure = info.treasure ?? false;
    const tradeable = info.tradeable ?? true;
    if (!tradeable) continue;
    out.push({ id, maxLevel, doublePrice: treasure });
  }
  if (!out.length) throw new Error(`${version}: parsed no enchantments`);
  return out;
}

function parseEnchants(version) {
  const dataTag = join(WORK, version, "src/data/minecraft/tags/enchantment/tradeable.json");
  return existsSync(dataTag) ? enchantsFromData(version) : enchantsFromJava(version);
}

// ----------------------------------------------------------------- gossip --

/** GossipType.java: id, weight, max, decayPerDay, decayPerTransfer. */
function parseGossip(version) {
  const file = join(WORK, version, "src/net/minecraft/world/entity/ai/gossip/GossipType.java");
  const src = readFileSync(file, "utf8");
  const out = {};
  const re = /(\w+)\("(\w+)",\s*(-?\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)/g;
  let m;
  while ((m = re.exec(src))) {
    out[m[2]] = {
      weight: int(m[3]),
      max: int(m[4]),
      decayPerDay: int(m[5]),
      decayPerTransfer: int(m[6]),
    };
  }
  const expected = [
    "major_negative",
    "minor_negative",
    "minor_positive",
    "major_positive",
    "trading",
  ];
  for (const key of expected)
    if (!out[key]) throw new Error(`${version}: missing gossip type ${key}`);
  return out;
}

// ------------------------------------------------------------------ emit --

const ROW_KEYS = [
  "wants",
  "wMin",
  "wMax",
  "gives",
  "gCount",
  "maxUses",
  "xp",
  "mult",
  "w2",
  "w2Count",
  "variable",
  "biomes",
];

function toRow(t) {
  return [
    t.wants,
    t.wMin,
    t.wMax,
    t.gives,
    t.gCount,
    t.maxUses,
    t.xp,
    t.mult,
    t.w2,
    t.w2Count,
    t.variable,
    t.biomes.join(","),
  ];
}

/**
 * Every emitted item id must exist in that version's item registry. This is
 * the guard that catches a Java constant whose name does not lowercase into
 * its registry id, which is exactly how GLOBE_BANNER_PATTER slipped through
 * the first time.
 */
function assertItemsExist(version, professions) {
  const file = join(ROOT, "extracted", version, "registries.json");
  if (!existsSync(file)) {
    process.stdout.write(`${version}: no extracted registries.json, skipping item id check\n`);
    return;
  }
  const items = new Set(JSON.parse(readFileSync(file, "utf8")).item ?? []);
  if (!items.size) throw new Error(`${version}: empty item registry`);
  for (const [profession, levels] of Object.entries(professions)) {
    for (const [level, trades] of Object.entries(levels)) {
      for (const t of trades) {
        for (const id of [t.wants, t.gives, t.w2].filter(Boolean)) {
          if (!items.has(id)) {
            throw new Error(
              `${version}/${profession}/${level}: "${id}" is not an item in this version`,
            );
          }
        }
      }
    }
  }
}

function main() {
  const data = {};
  for (const version of VERSIONS) {
    const stacks = parseStackSizes(version);
    const professions = existsSync(join(WORK, version, "src/data/minecraft/villager_trade"))
      ? parseDataTrades(version, stacks)
      : parseJavaTrades(version);
    assertItemsExist(version, professions);
    const perLevel = tradesPerLevel(version, professions);
    const rows = {};
    // Only cost items matter to the price formula, and only the ones that do
    // not stack to 64 are worth shipping.
    const costStacks = {};
    let count = 0;
    for (const [profession, levels] of Object.entries(professions)) {
      rows[profession] = { offered: perLevel[profession], levels: {} };
      for (const [level, trades] of Object.entries(levels)) {
        rows[profession].levels[level] = trades.map(toRow);
        count += trades.length;
        for (const t of trades) {
          for (const id of [t.wants, t.w2].filter(Boolean)) {
            const size = stackSize(stacks, id, `${version}/${profession}/${level}`);
            if (size !== 64) costStacks[id] = size;
          }
        }
      }
    }
    data[version] = {
      professions: rows,
      stacks: costStacks,
      enchants: parseEnchants(version).map((e) => [e.id, e.maxLevel, e.doublePrice ? 1 : 0]),
      gossip: parseGossip(version),
    };
    process.stdout.write(
      `${version}: ${Object.keys(rows).length} professions, ${count} trades, ${data[version].enchants.length} tradeable enchantments\n`,
    );
  }

  const payload = JSON.stringify(data);
  // The literal is emitted single quoted to match prettier, which is only
  // safe because no extracted id or version string contains an apostrophe.
  if (payload.includes("'") || payload.includes("\\")) {
    throw new Error("payload needs escaping: it contains a quote or a backslash");
  }
  const ts = `// GENERATED by mc-pipeline/11-emit-villager-data.mjs. Do not edit by hand.
//
// Sources, per version:
// - 1.16.5 to 1.21.11: the hardcoded TRADES map in
//   net/minecraft/world/entity/npc/VillagerTrades.java (moved under
//   .../npc/villager/ in 1.21.11). Trade rebalance EXPERIMENTAL_TRADES and
//   the wandering trader are deliberately excluded: this tool models the
//   default datapack only.
// - 26.2: data/minecraft/villager_trade/ and data/minecraft/trade_set/ from
//   the server jar, where 26.x moved trades into registry data.
// - enchantments: data/minecraft/enchantment plus the #minecraft:tradeable
//   and #minecraft:double_trade_price tags in 1.21+, and Enchantments.java
//   with the per-class isTreasureOnly/isTradeable/getMaxLevel overrides
//   before that.
// - gossip: net/minecraft/world/entity/ai/gossip/GossipType.java, which is
//   where the 1.20.2 zombie cure nerf lives (MAJOR_POSITIVE max 100 -> 20).
// - stacks: max stack size per cost item, from the item components dump in
//   1.21+ and from Items.java before that. Costs are clamped to the cost
//   item's stack size, in MerchantOffer.getModifiedCostCount everywhere and
//   additionally in TradeCost.toItemCost when 26.x builds the offer.
//
// Row layout: [${ROW_KEYS.join(", ")}].

/** One offer template. Counts are base costs, before any discount. */
export type TradeRow = [
  wants: string,
  wMin: number,
  wMax: number,
  gives: string,
  gCount: number,
  maxUses: number,
  xp: number,
  mult: number,
  w2: string,
  w2Count: number,
  variable: string,
  biomes: string,
];

export interface ProfessionTrades {
  /** Offers rolled per level, index 0 is level 1. */
  offered: number[];
  /** Level number (1 to 5) to the pool it rolls from. */
  levels: Record<string, TradeRow[]>;
}

export interface GossipRule {
  weight: number;
  max: number;
  decayPerDay: number;
  decayPerTransfer: number;
}

export interface VersionData {
  professions: Record<string, ProfessionTrades>;
  /**
   * Max stack size for every cost item that does not stack to 64. Both
   * MerchantOffer.getModifiedCostCount and, in 26.x, TradeCost.toItemCost
   * clamp a trade's cost to the cost item's stack size, so the librarian's
   * "2 book and quill" trade only ever charges one.
   */
  stacks: Record<string, number>;
  /** [enchantment id, max level, 1 when the trade price doubles]. */
  enchants: Array<[string, number, number]>;
  gossip: Record<string, GossipRule>;
}

/** Version ids with extracted villager data, oldest first. */
export const VILLAGER_VERSIONS: string[] = [
${VERSIONS.map((v) => `  ${JSON.stringify(v)},`).join("\n")}
];

/** Villager XP needed to reach the next level (VillagerData.NEXT_LEVEL_XP_THRESHOLDS). */
export const LEVEL_XP_THRESHOLDS: number[] = [0, 10, 70, 150, 250];

// Parsed from a string literal so the module stays prettier-stable.
export const VILLAGER_DATA: Record<string, VersionData> = JSON.parse(
  '${payload}',
) as Record<string, VersionData>;
`;
  writeFileSync(OUT, ts);
  process.stdout.write(`wrote ${OUT} (${(ts.length / 1024).toFixed(0)} KB)\n`);
}

main();

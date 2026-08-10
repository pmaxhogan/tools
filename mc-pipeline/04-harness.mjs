// Golden-vector harness: boots a real dedicated server per version and
// measures game behavior over RCON. Families:
//   damage - /damage grid over armor, toughness, protection, resistance
//            (versions with the /damage command only)
//   fall   - drop mobs from measured heights, with feather falling and
//            slow falling variants
//   loot   - real loot rolls: per-roll histograms for flagship tables,
//            bulk totals for the rest
// Output: mc-pipeline/vectors/<family>/<version>.json (committed).
// Usage: node mc-pipeline/04-harness.mjs <versionId> [damage|fall|loot ...]
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, VECTORS, WORK, ensureDir, sha1 } from "./lib/common.mjs";
import {
  enchantedItem,
  parseChestItems,
  parseNum,
  probeAttrPrefix,
  probeEnchantSyntax,
} from "./lib/era.mjs";
import { startServer } from "./lib/server.mjs";

const CHEST = "0 100 0";
const ORE = "0 98 0";
const MOB = { x: 4, y: 100, z: 4 };
const SEL = "@e[tag=vec,limit=1]";

const id = process.argv[2];
let slot = 0;
const families = process.argv.slice(3).filter((a) => {
  const m = a.match(/^--slot=(\d+)$/);
  if (m) {
    slot = Number(m[1]);
    return false;
  }
  return true;
});
if (!id) throw new Error("usage: node mc-pipeline/04-harness.mjs <id> [--slot=N] [family...]");
const wanted = (f) => !families.length || families.includes(f);

const { rcon, stop } = await startServer(id, { slot });
console.log(`[${id}] server up`);

// Arena: forceloaded chunk, stone platform, barrier roof so nothing burns
// in daylight, a chest for loot capture, an ore slot below it.
await rcon.cmd("forceload add 0 0");
await rcon.cmd("kill @e[type=!minecraft:player]");
await rcon.cmd("fill -2 99 -2 8 99 8 minecraft:stone");
// Stone roof: barriers are transparent to light, so they do not stop
// daylight zombie burning. Belt and braces: mobs also get fire resistance.
await rcon.cmd("fill -2 120 -2 8 120 8 minecraft:stone");
// Fall shaft: 1x1 interior column capped with stone. Fall mobs keep their
// AI (NoAI mobs take no fall damage, measured empirically) but cannot
// wander inside a 1x1 shaft.
await rcon.cmd("fill 9 100 9 11 220 11 minecraft:stone hollow");
await rcon.cmd(`setblock ${CHEST} minecraft:chest`);
await rcon.cmd("weather clear 1000000");

const syntax = await probeEnchantSyntaxSafe();
console.log(`[${id}] enchant syntax: ${syntax}`);

async function probeEnchantSyntaxSafe() {
  await rcon.cmd(`setblock ${ORE} minecraft:diamond_ore`);
  return probeEnchantSyntax(rcon, CHEST, ORE);
}

const meta = {
  version: id,
  generated: new Date().toISOString(),
  serverJarSha1: sha1(readFileSync(join(WORK, id, "server.jar"))),
  method: "rcon-e2e",
};

function save(family, data) {
  const dir = ensureDir(join(VECTORS, family));
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ ...meta, ...data }, null, 1));
  console.log(`[${id}] wrote vectors/${family}/${id}.json`);
}

async function freshMob({ health = 1000, tags = "vec", pos = MOB, noAI = true } = {}) {
  await rcon.cmd(`kill ${SEL}`);
  await rcon.cmd(
    `summon minecraft:zombie ${pos.x} ${pos.y} ${pos.z} {${noAI ? "NoAI:1b," : ""}PersistenceRequired:1b,Silent:1b,Tags:["${tags}"]}`,
  );
  const prefix = await attrPrefix();
  await rcon.cmd(`attribute ${SEL} ${prefix}max_health base set ${health}`);
  await rcon.cmd(`attribute ${SEL} ${prefix}armor base set 0`);
  // Fire resistance blocks is_fire damage only; keeps daylight burning from
  // polluting measurements without touching armor or fall math.
  await rcon.cmd(`effect give ${SEL} minecraft:fire_resistance 1000000 0 true`);
  await rcon.cmd(`data merge entity ${SEL} {Health:${health}f}`);
}

let _attrPrefix;
async function attrPrefix() {
  if (!_attrPrefix) _attrPrefix = await probeAttrPrefix(rcon, SEL);
  return _attrPrefix;
}

/** Equip an item, falling back to the pre-1.17 replaceitem command. */
async function equipItem(slotName, itemStr) {
  const res = await rcon.cmd(`item replace entity ${SEL} armor.${slotName} with ${itemStr}`);
  if (/Unknown or incomplete command|Incorrect argument/i.test(res))
    return rcon.cmd(`replaceitem entity ${SEL} armor.${slotName} ${itemStr}`);
  return res;
}

async function readHealth() {
  return parseNum(await rcon.cmd(`data get entity ${SEL} Health`));
}

/** Fail fast if attribute writes are not actually landing on this version. */
async function assertAttributesWork() {
  await freshMob();
  const h = await readHealth();
  if (Math.abs(h - 1000) > 0.01)
    throw new Error(
      `attribute sanity check failed: fresh mob health ${h}, expected 1000; ` +
        "attribute prefix probe is wrong for this version",
    );
}
await assertAttributesWork();

// ---------------------------------------------------------------- damage --
async function runDamage() {
  const probe = await rcon.cmd("damage @e[tag=nothing,limit=1] 1");
  if (/Unknown or incomplete command/i.test(probe)) {
    console.log(`[${id}] /damage not available, skipping damage family`);
    return;
  }
  const prefix = await (async () => {
    await freshMob();
    return attrPrefix();
  })();
  const samples = [];

  // Armor and toughness grid, no enchantments.
  for (const armor of [0, 2, 5, 10, 15, 20, 25, 30]) {
    for (const toughness of [0, 4, 8, 12, 20]) {
      for (const amount of [1, 3, 7.5, 10, 15, 20, 36, 100]) {
        await freshMob();
        await rcon.cmd(`attribute ${SEL} ${prefix}armor base set ${armor}`);
        await rcon.cmd(`attribute ${SEL} ${prefix}armor_toughness base set ${toughness}`);
        await rcon.cmd(`damage ${SEL} ${amount} minecraft:mob_attack`);
        const after = await readHealth();
        samples.push({ armor, toughness, amount, type: "mob_attack", taken: round(1000 - after) });
      }
    }
  }

  // Protection EPF via real equipped armor (armor points come along).
  for (const pieces of [1, 2, 3, 4]) {
    for (const level of [1, 2, 3, 4]) {
      await freshMob();
      const slots = ["head", "chest", "legs", "feet"].slice(0, pieces);
      const items = { head: "diamond_helmet", chest: "diamond_chestplate", legs: "diamond_leggings", feet: "diamond_boots" };
      for (const slot of slots)
        await equipItem(slot, enchantedItem(items[slot], "protection", level, syntax));
      // Equipment attribute modifiers apply on the entity's next tick on
      // some versions; wait one tick so the recorded attributes are final.
      await new Promise((r) => setTimeout(r, 120));
      const armorAttr = parseNum(await rcon.cmd(`attribute ${SEL} ${prefix}armor get`));
      const toughAttr = parseNum(await rcon.cmd(`attribute ${SEL} ${prefix}armor_toughness get`));
      await rcon.cmd(`damage ${SEL} 10 minecraft:mob_attack`);
      const after = await readHealth();
      samples.push({
        equipped: { material: "diamond", pieces, protection: level },
        armor: armorAttr, toughness: toughAttr, amount: 10,
        type: "mob_attack", taken: round(1000 - after),
      });
    }
  }

  // Resistance effect (amp 4 = full immunity).
  for (const amp of [0, 1, 2, 3, 4]) {
    await freshMob();
    await rcon.cmd(`effect give ${SEL} minecraft:resistance 1000 ${amp}`);
    await rcon.cmd(`damage ${SEL} 10 minecraft:mob_attack`);
    samples.push({ resistance: amp + 1, amount: 10, type: "mob_attack", taken: round(1000 - await readHealth()) });
  }

  // Bypassing damage types for contrast.
  for (const type of ["magic", "out_of_world", "generic"]) {
    await freshMob();
    await rcon.cmd(`attribute ${SEL} ${prefix}armor base set 20`);
    const res = await rcon.cmd(`damage ${SEL} 10 minecraft:${type}`);
    if (/Applied/i.test(res))
      samples.push({ armor: 20, toughness: 0, amount: 10, type, taken: round(1000 - await readHealth()) });
  }

  await rcon.cmd(`kill ${SEL}`);
  save("damage", { samples });
}

// ------------------------------------------------------------------ fall --
async function runFall() {
  await freshMob();
  const samples = [];
  const cases = [];
  for (const h of [2, 3, 3.5, 4, 5, 10, 23.5, 50, 100]) cases.push({ h });
  for (const ff of [1, 2, 3, 4]) cases.push({ h: 23.5, ff });
  cases.push({ h: 23.5, slowFalling: true });

  // Shaft interior: floor stone at y=100, mob stands at y=101.
  const shaft = { x: 10, y: 101, z: 10 };
  for (const c of cases) {
    await freshMob({ pos: shaft, noAI: false });
    if (c.ff)
      await equipItem("feet", enchantedItem("diamond_boots", "feather_falling", c.ff, syntax));
    if (c.slowFalling) await rcon.cmd(`effect give ${SEL} minecraft:slow_falling 60 0`);
    await rcon.cmd(`tp ${SEL} ${shaft.x} ${101 + c.h} ${shaft.z}`);
    // Wait for landing: poll OnGround, then let the damage tick land.
    let onGround = false;
    for (let i = 0; i < 100 && !onGround; i++) {
      await new Promise((r) => setTimeout(r, 150));
      onGround = /1b/.test(await rcon.cmd(`data get entity ${SEL} OnGround`));
    }
    await new Promise((r) => setTimeout(r, 300));
    const after = await readHealth();
    samples.push({
      height: c.h,
      featherFalling: c.ff ?? 0,
      slowFalling: !!c.slowFalling,
      taken: round(1000 - after),
    });
  }
  await rcon.cmd(`kill ${SEL}`);
  save("fall", { samples });
}

// ------------------------------------------------------------------ loot --
const FLAGSHIP = [
  { table: "blocks/diamond_ore", block: "diamond_ore", tools: [null, ["fortune", 1], ["fortune", 2], ["fortune", 3], ["silk_touch", 1]] },
  { table: "blocks/redstone_ore", block: "redstone_ore", tools: [null, ["fortune", 3]] },
  { table: "blocks/lapis_ore", block: "lapis_ore", tools: [null, ["fortune", 3]] },
  { table: "blocks/gravel", block: "gravel", tools: [null, ["fortune", 3]] },
  { table: "blocks/wheat", block: "wheat[age=7]", tools: [null, ["fortune", 3]] },
];
const PER_ROLL = 400;
const BULK_BATCH = 50;
const BULK_BATCHES = 20;

async function mineRoll(block, toolStr) {
  await rcon.cmd(`setblock ${ORE} minecraft:${block}`);
  await rcon.cmd(`loot insert ${CHEST} mine ${ORE} ${toolStr}`);
}

async function chestTotalsAndReset() {
  const totals = parseChestItems(await rcon.cmd(`data get block ${CHEST} Items`));
  await rcon.cmd(`data merge block ${CHEST} {Items:[]}`);
  return totals;
}

async function runLoot() {
  const out = { perRoll: {}, bulk: {} };

  for (const f of FLAGSHIP) {
    for (const tool of f.tools) {
      const toolStr = tool
        ? enchantedItem("diamond_pickaxe", tool[0], tool[1], syntax)
        : "minecraft:diamond_pickaxe";
      const key = `${f.table}|${tool ? tool.join("") : "bare"}`;
      const hist = {};
      for (let i = 0; i < PER_ROLL; i++) {
        await mineRoll(f.block, toolStr);
        const totals = await chestTotalsAndReset();
        const sig = Object.entries(totals).sort().map(([k, v]) => `${k}:${v}`).join(",") || "nothing";
        hist[sig] = (hist[sig] ?? 0) + 1;
      }
      out.perRoll[key] = { rolls: PER_ROLL, histogram: hist };
      console.log(`  perRoll ${key} done`);
    }
  }

  // Bulk totals for every extracted block table that exists in this version.
  const lootDir = join(ROOT, "extracted", id, "loot", "blocks");
  if (existsSync(lootDir)) {
    for (const file of readdirSync(lootDir)) {
      const name = file.replace(/\.json$/, "");
      if (FLAGSHIP.some((f) => f.block.replace(/\[.*/, "") === name)) continue;
      const blockArg = name === "wheat" ? "wheat[age=7]" : name;
      const probeRes = await rcon.cmd(`setblock ${ORE} minecraft:${blockArg}`);
      if (/Could not set|Unknown|Expected/i.test(probeRes) && !/Changed/i.test(probeRes)) {
        await rcon.cmd(`setblock ${ORE} minecraft:air`);
        const retry = await rcon.cmd(`setblock ${ORE} minecraft:${blockArg}`);
        if (!/Changed/i.test(retry)) continue;
      }
      const totals = {};
      for (let b = 0; b < BULK_BATCHES; b++) {
        for (let i = 0; i < BULK_BATCH; i++) await mineRoll(blockArg, "minecraft:diamond_pickaxe");
        const t = await chestTotalsAndReset();
        for (const [k, v] of Object.entries(t)) totals[k] = (totals[k] ?? 0) + v;
      }
      out.bulk[`${name}|bare`] = { rolls: BULK_BATCH * BULK_BATCHES, totals };
    }
  }

  // Entity kill-context rolls (no looting attribution possible via command).
  for (const ent of ["zombie", "skeleton", "creeper", "enderman", "blaze"]) {
    const probe = await rcon.cmd(
      `summon minecraft:${ent} ${MOB.x} ${MOB.y} ${MOB.z} {NoAI:1b,PersistenceRequired:1b,Silent:1b,Tags:["victim"]}`,
    );
    if (!/Summoned/i.test(probe)) continue;
    const totals = {};
    let rolls = 0;
    for (let i = 0; i < 600; i++) {
      const res = await rcon.cmd(`loot insert ${CHEST} kill @e[tag=victim,limit=1]`);
      if (!/Dropped|Filled|no loot|nothing/i.test(res) && i === 0) break;
      rolls++;
      if ((i + 1) % BULK_BATCH === 0) {
        const t = await chestTotalsAndReset();
        for (const [k, v] of Object.entries(t)) totals[k] = (totals[k] ?? 0) + v;
      }
    }
    const t = await chestTotalsAndReset();
    for (const [k, v] of Object.entries(t)) totals[k] = (totals[k] ?? 0) + v;
    await rcon.cmd(`kill @e[tag=victim]`);
    if (rolls) out.bulk[`entities/${ent}|bare`] = { rolls, totals };
    console.log(`  kill ${ent}: ${rolls} rolls`);
  }

  save("loot", out);
}

function round(n) {
  return Math.round(n * 100) / 100;
}

try {
  if (wanted("damage")) await runDamage();
  if (wanted("fall")) await runFall();
  if (wanted("loot")) await runLoot();
} finally {
  await stop();
  console.log(`[${id}] server stopped`);
}

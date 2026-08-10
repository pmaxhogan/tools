// Smoke test: bring up a server, run a few commands over RCON, shut down.
// Usage: node mc-pipeline/smoke.mjs <versionId>
import { startServer } from "./lib/server.mjs";

const id = process.argv[2];
if (!id) throw new Error("usage: node mc-pipeline/smoke.mjs <versionId>");
console.log(`[smoke] starting ${id}...`);
const { rcon, stop } = await startServer(id);
console.log("[smoke] rcon up");
console.log("seed:", await rcon.cmd("seed"));
console.log("mobspawn off:", await rcon.cmd("gamerule doMobSpawning false"));
console.log("forceload:", await rcon.cmd("forceload add 0 0"));
console.log("chest:", await rcon.cmd("setblock 0 100 0 minecraft:chest"));
console.log("ore:", await rcon.cmd("setblock 0 90 0 minecraft:diamond_ore"));
console.log(
  "loot:",
  await rcon.cmd(
    "loot insert 0 100 0 mine 0 90 0 minecraft:diamond_pickaxe[minecraft:enchantments={\"minecraft:fortune\":3}]",
  ),
);
console.log("data:", await rcon.cmd("data get block 0 100 0 Items"));
console.log("summon:", await rcon.cmd('summon minecraft:zombie 0 101 0 {NoAI:1b,PersistenceRequired:1b,Tags:["dmgtest"]}'));
console.log("damage:", await rcon.cmd("damage @e[tag=dmgtest,limit=1] 10 minecraft:mob_attack"));
console.log("health:", await rcon.cmd("data get entity @e[tag=dmgtest,limit=1] Health"));
await stop();
console.log("[smoke] clean shutdown");

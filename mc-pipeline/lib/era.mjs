// Per-era command syntax helpers. The item enchantment syntax changed twice:
// NBT (through 1.20.4), components with a levels wrapper (1.20.5 - 1.21.4),
// components without the wrapper (1.21.5+). Attribute ids dropped their
// "generic." prefix in 1.21.2. Rather than trusting version-number parsing
// alone, callers probe with probeEnchantSyntax() once per server and cache.

/** Item string with one enchantment, in the given syntax era. */
export function enchantedItem(item, ench, lvl, syntax) {
  if (!ench || !lvl) return `minecraft:${item}`;
  switch (syntax) {
    case "nbt":
      return `minecraft:${item}{Enchantments:[{id:"minecraft:${ench}",lvl:${lvl}s}]}`;
    case "components-levels":
      return `minecraft:${item}[minecraft:enchantments={levels:{"minecraft:${ench}":${lvl}}}]`;
    default: // components
      return `minecraft:${item}[minecraft:enchantments={"minecraft:${ench}":${lvl}}]`;
  }
}

/**
 * Detect the enchantment syntax by test-mining against a real block with a
 * fortune tool: the successful syntax yields a "Dropped" response.
 */
export async function probeEnchantSyntax(rcon, chest, ore) {
  for (const syntax of ["components", "components-levels", "nbt"]) {
    const item = enchantedItem("diamond_pickaxe", "fortune", 3, syntax);
    const res = await rcon.cmd(
      `loot insert ${chest} mine ${ore} ${item}`,
    );
    if (/Dropped|Filled/i.test(res)) {
      await rcon.cmd(`data merge block ${chest} {Items:[]}`);
      return syntax;
    }
  }
  throw new Error("no enchantment syntax accepted");
}

/** Attribute id per era: probe once with a harmless "get" on an entity. */
export async function probeAttrPrefix(rcon, selector) {
  for (const prefix of ["minecraft:armor", "minecraft:generic.armor"]) {
    const res = await rcon.cmd(`attribute ${selector} ${prefix} get`);
    if (!/Unknown|Incorrect|Expected|No such/i.test(res)) {
      return prefix === "minecraft:armor" ? "minecraft:" : "minecraft:generic.";
    }
  }
  throw new Error("no attribute prefix accepted");
}

/** Parse "... has the following entity data: 9.16f" style numeric replies. */
export function parseNum(response) {
  const m = response.match(/(-?\d+(?:\.\d+)?)[fdbsL]?\s*$/);
  return m ? Number(m[1]) : NaN;
}

/**
 * Parse chest Items SNBT into {itemId: count} totals. Tolerates both
 * modern {count: 3, id: "..."} and legacy {Count: 3b, id: "..."} shapes.
 */
export function parseChestItems(response) {
  const totals = {};
  const re = /\{[^{}]*?\}/g;
  const body = response.slice(response.indexOf(":") + 1);
  for (const m of body.matchAll(re)) {
    const entry = m[0];
    const id = entry.match(/id:\s*"([^"]+)"/)?.[1];
    const count = entry.match(/[cC]ount:\s*(\d+)/)?.[1];
    if (id) totals[id] = (totals[id] ?? 0) + Number(count ?? 1);
  }
  return totals;
}

import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "minecraft-damage-calculator",
  matrixSlug: "minecraft-damage",
  icon: "Swords",
  name: "Minecraft Damage Calculator",
  description:
    "Armor, fall, and mace smash damage per Minecraft version, verified against real dedicated servers and decompiled game code.",
  category: "Minecraft",
  keywords: [
    "minecraft damage calculator",
    "minecraft armor calculator",
    "minecraft fall damage calculator",
    "minecraft mace damage calculator",
    "minecraft armor toughness formula",
    "minecraft protection enchantment calculator",
    "how much damage does a mace do",
  ],
  searchTerms: [
    "armor points damage reduction",
    "netherite armor protection percent",
    "feather falling fall damage",
    "how far can i fall without dying",
    "mace smash attack damage",
    "density enchantment damage",
    "breach enchantment armor",
    "resistance effect damage reduction",
    "hits to kill full diamond",
    "sword damage vs armor",
    "epf enchantment protection factor",
  ],
  input: "none",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Mode",
      default: "melee",
      options: [
        {
          value: "melee",
          label: "Melee vs armor",
          synonyms: ["attack", "sword", "armor reduction", "pvp damage", "hit damage"],
        },
        {
          value: "fall",
          label: "Fall damage",
          synonyms: ["falling", "drop height", "feather falling", "safe fall"],
        },
        {
          value: "mace",
          label: "Mace smash",
          synonyms: ["smash attack", "density", "breach", "wind charge", "1.21 weapon"],
        },
      ],
    },
    {
      kind: "select",
      id: "version",
      label: "Version",
      default: "1.21.11",
      options: [
        { value: "1.16.5", label: "1.16.5", synonyms: ["nether update"] },
        { value: "1.18.2", label: "1.18.2", synonyms: ["caves and cliffs"] },
        { value: "1.20.6", label: "1.20.6", synonyms: ["trails and tales"] },
        { value: "1.21.1", label: "1.21.1", synonyms: ["tricky trials", "mace update"] },
        { value: "1.21.11", label: "1.21.11", synonyms: ["copper age"] },
        { value: "26.2", label: "26.2 (latest)", synonyms: ["latest", "newest", "current"] },
      ],
    },
    { kind: "number", id: "amount", label: "Attack damage", default: 7, min: 0, max: 10000, step: 0.5 },
    { kind: "number", id: "armor", label: "Armor points", default: 20, min: 0, max: 30, step: 1 },
    { kind: "number", id: "toughness", label: "Armor toughness", default: 8, min: 0, max: 20, step: 1 },
    { kind: "number", id: "protection", label: "Protection levels (all pieces)", default: 0, min: 0, max: 16, step: 1 },
    { kind: "number", id: "resistance", label: "Resistance level", default: 0, min: 0, max: 5, step: 1 },
    { kind: "number", id: "breach", label: "Breach level", default: 0, min: 0, max: 4, step: 1 },
    { kind: "number", id: "height", label: "Fall height (blocks)", default: 10, min: 0, max: 10000, step: 0.5 },
    { kind: "number", id: "featherFalling", label: "Feather Falling", default: 0, min: 0, max: 4, step: 1 },
    { kind: "boolean", id: "slowFalling", label: "Slow Falling", default: false },
    { kind: "number", id: "maceFall", label: "Mace fall distance", default: 5, min: 0, max: 10000, step: 0.5 },
    { kind: "number", id: "density", label: "Density level", default: 0, min: 0, max: 5, step: 1 },
  ],
  copy: {
    what: "Calculates Minecraft damage the way the game actually computes it: melee hits against armor, toughness, Protection and Resistance, fall damage from any height, and mace smash damage with Density and Breach. Every formula was reimplemented from decompiled or unobfuscated server code for six versions (1.16.5 through the current release) and then verified against golden vectors measured on real dedicated servers, so the numbers match the game to the hundredth of a heart. Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.",
    how: "Pick a version and a mode. In melee mode, choose a weapon preset or type raw attack damage, then describe the target's armor with the piece picker or raw armor and toughness values, plus Protection, Resistance and Breach levels; you get the final damage, the percent reduced, and hits to kill common health pools. In fall mode, enter the drop height and Feather Falling level. In mace mode, enter the fall distance and Density level. Results update live and the URL fragment keeps your setup shareable.",
    why: "Most Minecraft damage calculators online are ad farms that hardcode one era's formula and never say which version they model. Fall damage genuinely differs per version (a 100 block drop deals 95 damage on 1.16.5 and 97 on 1.21.11, because older versions accumulate fall distance per tick while 1.21.2+ measures actual positions), and this tool reproduces those measured differences exactly. It runs entirely in your browser, has no ads, and your files and inputs never leave your device.",
    faq: [
      {
        q: "How were these formulas verified?",
        a: "Two ways. A local pipeline boots real dedicated servers for each version and measures damage over RCON: the /damage command applies exact amounts to mobs with controlled armor, toughness, Protection and Resistance, and real zombies are dropped from measured heights for fall damage. Those measurements are committed as golden vectors and the calculator's test suite must reproduce every sample exactly. For 1.16.5 and 1.18.2, where /damage does not exist, armor cases were hand-derived from the decompiled server source and cross-checked against the measured versions, since the armor formula is unchanged since 1.9.",
      },
      {
        q: "What actually changed between versions?",
        a: "The armor, Protection, and Resistance math is identical across all six covered versions; the armor formula has not changed since 1.9. Fall damage is the real story: through 1.21.1 the game accumulates fall distance per tick and misses the landing tick's movement, so long falls register short (95 damage from 100 blocks), while 1.21.2+ computes fall distance from actual positions (97 from 100 blocks), and the rounding flipped from ceiling to floor, which shifts half-block drops like 23.5. The mace, Density and Breach arrived in 1.21, and copper armor in 1.21.9.",
      },
      {
        q: "How does armor reduce damage?",
        a: "Each armor point blocks 4 percent, but strong hits pierce: the effective points are armor minus damage divided by (2 + toughness / 4), clamped between 20 percent of your armor and 20 points, so the cap is 80 percent. Protection adds a separate multiplier after armor (4 percent per Protection level summed across pieces, capped at 80 percent), Resistance removes 20 percent per level, and fall damage skips armor entirely, which is why Feather Falling (12 percent per level) matters so much.",
      },
    ],
  },
};

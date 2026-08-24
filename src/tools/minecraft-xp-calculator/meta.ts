import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "minecraft-xp-calculator",
  icon: "Sparkles",
  name: "Minecraft XP Calculator",
  description:
    "Exact level-to-XP math, Mending repair costs, and kill counts, verified against decompiled game code.",
  category: "Minecraft",
  keywords: [
    "minecraft xp calculator",
    "minecraft level calculator",
    "minecraft xp to level 30",
    "minecraft mending xp cost",
    "minecraft xp per mob",
    "minecraft experience calculator",
    "xp bottle calculator",
  ],
  searchTerms: [
    "how much xp for level 30",
    "minecraft experience points",
    "xp farm math",
    "mending repair cost",
    "levels to xp",
    "minecraft level curve",
    "xp bottles needed",
    "diamond ore xp",
    "mob grinder levels",
    "enchanting level cost",
    "xp level chart",
    "mob grinder xp rate",
    "how much xp to repair item",
    "afk xp farm",
    "durability repair calculator",
    "xp to next level",
    "unbreaking calculator",
  ],
  input: "none",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Mode",
      default: "levels",
      options: [
        {
          value: "levels",
          label: "Levels to XP",
          synonyms: ["level to xp", "between levels", "level cost", "kill planning", "xp needed"],
        },
        {
          value: "xp",
          label: "XP to level",
          synonyms: ["points to level", "total xp", "what level am i", "convert xp"],
        },
        {
          value: "mending",
          label: "Mending repair",
          synonyms: ["mending", "repair", "durability", "fix item", "unbreaking partner"],
        },
      ],
    },
    {
      kind: "number",
      id: "fromLevel",
      label: "Current level",
      default: 0,
      min: 0,
      max: 100000,
      step: 1,
    },
    {
      kind: "number",
      id: "toLevel",
      label: "Target level",
      default: 30,
      min: 0,
      max: 100000,
      step: 1,
    },
    {
      kind: "number",
      id: "totalXp",
      label: "Total XP points (XP to level mode)",
      default: 1395,
      min: 0,
      max: 2147483647,
      step: 1,
    },
    {
      kind: "number",
      id: "durability",
      label: "Durability to repair (Mending mode)",
      default: 1561,
      min: 0,
      max: 1000000,
      step: 1,
    },
    {
      kind: "select",
      id: "source",
      label: "XP source",
      default: "zombie",
      groups: [
        {
          label: "Hostile mobs",
          synonyms: ["mobs", "monsters", "hostile", "farm"],
          options: [
            {
              value: "zombie",
              label: "Zombie (5 XP)",
              synonyms: ["zombie", "husk", "zombie villager", "drowned"],
            },
            {
              value: "baby_zombie",
              label: "Baby zombie (12 XP)",
              synonyms: ["baby", "zombie baby"],
            },
            {
              value: "skeleton",
              label: "Skeleton (5 XP)",
              synonyms: ["skelly", "stray", "bogged"],
            },
            { value: "creeper", label: "Creeper (5 XP)", synonyms: ["creeper farm"] },
            { value: "spider", label: "Spider (5 XP)", synonyms: ["cave spider", "spider farm"] },
            {
              value: "enderman",
              label: "Enderman (5 XP)",
              synonyms: ["ender man", "enderman farm", "end farm"],
            },
            { value: "witch", label: "Witch (5 XP)", synonyms: ["witch farm"] },
            {
              value: "wither_skeleton",
              label: "Wither skeleton (5 XP)",
              synonyms: ["wither skelly", "nether fortress"],
            },
            { value: "ghast", label: "Ghast (5 XP)", synonyms: ["ghast tear"] },
            {
              value: "zombified_piglin",
              label: "Zombified piglin (5 XP)",
              synonyms: ["zombie pigman", "pigman", "gold farm"],
            },
            { value: "piglin", label: "Piglin (5 XP)", synonyms: ["bartering", "nether mob"] },
            { value: "blaze", label: "Blaze (10 XP)", synonyms: ["blaze farm", "blaze rod"] },
            {
              value: "guardian",
              label: "Guardian (10 XP)",
              synonyms: ["guardian farm", "elder guardian", "ocean monument"],
            },
            { value: "evoker", label: "Evoker (10 XP)", synonyms: ["raid", "totem of undying"] },
            { value: "breeze", label: "Breeze (10 XP)", synonyms: ["trial chamber", "breeze rod"] },
            { value: "warden", label: "Warden (5 XP)", synonyms: ["deep dark", "sculk shrieker"] },
            { value: "ravager", label: "Ravager (20 XP)", synonyms: ["raid", "beast"] },
            {
              value: "piglin_brute",
              label: "Piglin brute (20 XP)",
              synonyms: ["brute", "bastion"],
            },
            { value: "vex", label: "Vex (3 XP)", synonyms: ["evoker minion"] },
            {
              value: "slime_big",
              label: "Slime or magma cube, big (4 XP)",
              synonyms: ["slime", "magma cube", "large slime"],
            },
            {
              value: "slime_small",
              label: "Slime or magma cube, small (2 XP)",
              synonyms: ["medium slime"],
            },
            {
              value: "slime_tiny",
              label: "Slime or magma cube, tiny (1 XP)",
              synonyms: ["tiny slime", "baby slime"],
            },
          ],
        },
        {
          label: "Bosses",
          synonyms: ["boss", "dragon", "wither boss"],
          options: [
            { value: "wither", label: "Wither (50 XP)", synonyms: ["wither boss", "nether star"] },
            {
              value: "ender_dragon_first",
              label: "Ender dragon, first kill (12,000 XP)",
              synonyms: ["dragon", "end boss", "first dragon"],
            },
            {
              value: "ender_dragon_respawn",
              label: "Ender dragon, respawned (500 XP)",
              synonyms: ["respawned dragon", "dragon refight"],
            },
          ],
        },
        {
          label: "Animals",
          synonyms: ["passive", "farm animals", "breeding"],
          options: [
            {
              value: "adult_animal",
              label: "Adult animal (1 to 3 XP)",
              synonyms: ["cow", "pig", "sheep", "chicken", "animal farm"],
            },
            {
              value: "breeding",
              label: "Breeding two animals (1 to 7 XP)",
              synonyms: ["breed", "breeder", "love mode"],
            },
          ],
        },
        {
          label: "Bottles and blocks",
          synonyms: ["bottle", "spawner", "sculk", "blocks"],
          options: [
            {
              value: "xp_bottle",
              label: "Bottle o' Enchanting (3 to 11 XP)",
              synonyms: ["xp bottle", "experience bottle", "bottle of enchanting"],
            },
            {
              value: "spawner_block",
              label: "Breaking a monster spawner (15 to 43 XP)",
              synonyms: ["spawner", "mob spawner", "cage"],
            },
            {
              value: "sculk",
              label: "Sculk block (1 XP)",
              synonyms: ["sculk mining", "deep dark", "hoe"],
            },
          ],
        },
        {
          label: "Ore mining",
          synonyms: ["ore", "mining", "fortune", "silk touch"],
          options: [
            { value: "coal_ore", label: "Coal ore (0 to 2 XP)", synonyms: ["coal", "coal mining"] },
            {
              value: "nether_gold_ore",
              label: "Nether gold ore (0 to 1 XP)",
              synonyms: ["gold nugget ore", "nether gold"],
            },
            {
              value: "lapis_ore",
              label: "Lapis lazuli ore (2 to 5 XP)",
              synonyms: ["lapis", "lapis mining"],
            },
            {
              value: "nether_quartz_ore",
              label: "Nether quartz ore (2 to 5 XP)",
              synonyms: ["quartz", "quartz mining"],
            },
            {
              value: "redstone_ore",
              label: "Redstone ore (1 to 5 XP)",
              synonyms: ["redstone", "redstone mining"],
            },
            {
              value: "diamond_ore",
              label: "Diamond ore (3 to 7 XP)",
              synonyms: ["diamond", "diamond mining"],
            },
            {
              value: "emerald_ore",
              label: "Emerald ore (3 to 7 XP)",
              synonyms: ["emerald", "emerald mining"],
            },
          ],
        },
      ],
    },
  ],
  copy: {
    what: "Exact Minecraft XP math: convert levels to experience points and back, chart the full XP curve, and plan how many mob kills, XP bottles, or mined ore blocks a level climb costs, with a planner table covering every source. Mix several sources with relative weights, or apply presets built from the game's own biome spawner weights and ore generation data. A Mending mode models a self-repairing tool: pick a sword, axe, or pickaxe with its enchantments and see whether grinding your sources sustains it forever or how long until it breaks. Every constant is reimplemented from decompiled, unobfuscated game code and checked across six releases from 1.16.5 through 26.2. Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.",
    how: "Enter a level range (or flip the converter to turn raw XP back into a level) and read the totals, the gap, and the every-level chart. Pick XP sources below: select several within a category to weight them, or load a preset like Overworld mobs or Mining at y=0. Turn on the Mending toggle to describe your tool: family, material, durability, Unbreaking, Sharpness or Smite or Bane, and Fire Aspect where legal; the result shows average and worst-case actions before the tool breaks, or calls it self-sustaining. Everything lives in the page address, so a link reproduces your exact setup.",
    why: "Most Minecraft XP calculators copy each other's tables and never say which version they describe. The numbers here were verified against the game's own decompiled code, version by version: the level curve, mob rewards, bottle and ore drops, weapon damage, Unbreaking odds, and the Mending ratio of 2 durability per point are identical in every release checked, from 1.16.5 through 26.2, so the version picker only gates newer content such as copper tools and the preset data. The math runs in your browser with no ads, and your files and inputs never leave your device.",
    faq: [
      {
        q: "How much XP does it take to reach level 30?",
        a: "1,395 experience points starting from level 0. The curve has three tiers: each level up to 15 costs 7 + 2 times the level, levels 15 to 30 cost 37 + 5 per level above 15, and levels past 30 cost 112 + 9 per level above 30. That is why level 30 to 39 costs more than level 0 to 30.",
      },
      {
        q: "Can a Mending tool repair itself forever?",
        a: "Often, yes. Each XP point an orb carries repairs 2 durability on the damaged Mending item before filling your XP bar, and Unbreaking makes each point of wear land only 1 time in level + 1. A Mending sword on zombies loses about 3 durability per kill and repairs 10, so it is self-sustaining; the calculator also reports the honest worst case, meaning your single worst selected source at 100 percent, minimum XP rolls, and Unbreaking never proccing. Fortune never changes ore XP and Silk Touch drops zero, so a silk-touched pickaxe cannot sustain off ore.",
      },
      {
        q: "Do these numbers change between Minecraft versions?",
        a: "No. The level curve, mob XP rewards, Bottle o' Enchanting range, ore drop ranges, weapon damage, enchantment formulas, and the Mending ratio were compared across decompiled code for 1.16.5, 1.18.2, 1.20.6, 1.21.1, 1.21.11, and 26.2, and every value is identical. Only availability and world data change: copper tools and mobs like the Warden or Breeze do not exist in older versions, and the mining presets use 1.18+ world generation. Mob equipment adds 1 to 3 bonus XP per equipped item, and Looting does not change XP drops.",
      },
    ],
  },
};

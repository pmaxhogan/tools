import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "minecraft-anvil-calculator",
  icon: "Anvil",
  name: "Minecraft Anvil Calculator",
  description:
    "Exact anvil level costs, optimal enchanted book merge order, and the Too Expensive horizon per Minecraft version.",
  category: "Minecraft",
  keywords: [
    "minecraft anvil calculator",
    "anvil cost calculator",
    "too expensive minecraft",
    "best enchantment order",
    "anvil repair cost",
    "prior work penalty",
    "combine enchanted books",
  ],
  searchTerms: [
    "anvil uses left",
    "enchantment order calculator",
    "xp levels anvil",
    "anvil 40 level limit",
    "repair cost nbt",
    "god sword enchant order",
    "cheapest way to combine books",
    "anvil mechanics",
    "rename cost minecraft",
    "sacrifice item repair",
  ],
  input: "application/json",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "version",
      label: "Game version",
      default: "1.21.11",
      options: [
        {
          value: "1.21.11",
          label: "1.21.11 and 26.2 (latest)",
          synonyms: ["latest", "26.2", "1.22", "2026", "current", "newest", "copper age"],
        },
        {
          value: "1.21.1",
          label: "1.21.1",
          synonyms: ["1.21", "tricky trials", "mace update"],
        },
        {
          value: "1.20.6",
          label: "1.20.6",
          synonyms: ["1.20", "1.20.5", "trails and tales", "armored paws", "components"],
        },
        {
          value: "1.18.2",
          label: "1.18.2",
          synonyms: ["1.18", "caves and cliffs"],
        },
        {
          value: "1.16.5",
          label: "1.16.5",
          synonyms: ["1.16", "1.17", "nether update"],
        },
      ],
    },
  ],
  copy: {
    what: "Calculates exact Minecraft anvil level costs per game version. Combine two items, an item and an enchanted book, repair with raw materials, or rename, and get the full price broken into repair units, the sacrifice durability bonus, per enchantment fees, incompatibility penalties, rename charges, and prior work, plus the resulting item and Too Expensive detection. Every number is reimplemented from the game's own anvil code, decompiled or unobfuscated per version, and verified against a committed suite of worked cases. Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.",
    how: "Pick a game version, then fill the two anvil slots: choose the target item with its enchantments, prior work, and damage, and a sacrifice item, enchanted book, or repair material. The cost breakdown updates as you edit. The planner tab takes an item plus up to seven books and searches every merge tree for the cheapest order, and the horizon tab shows how many combines remain before a prior work penalty makes everything Too Expensive.",
    why: "Most anvil sites only sort enchantments and silently assume one version's numbers. This one models the whole algorithm: unit repairs, the 12 percent sacrifice bonus, per pair incompatibility penalties, the rename-only clamp at 39 levels, and prior work that doubles after every combine, with separate verified data for 1.16.5 through the current release. It has no ads or level caps, and your files and inputs never leave your device.",
    faq: [
      {
        q: "Which versions behave differently at the anvil?",
        a: "The cost formula itself has been stable since 1.16.5; the data around it changed. 1.16.5 and 1.18.2 price enchantments by rarity (1, 2, 4, or 8 per level) and crossbow durability grew from 326 to 465 in 1.18.2. In 1.20.5 the repair cost moved from NBT to an item component and Impaling joined the Sharpness exclusivity group. 1.21 made enchantments data driven: Silk Touch stopped clashing with Looting and Luck of the Sea, and the mace arrived with Density and Breach. 1.21.11 and 26.2 add spears with Lunge and show a cost of 0 when a combine changes nothing, where older versions showed the prior work sum.",
      },
      {
        q: "Why does my combine say Too Expensive?",
        a: "Any combine totaling 40 levels or more is refused in survival. The prior work penalty doubles plus one after every combine (0, 1, 3, 7, 15, 31, 63), so a fresh item supports at most six combines before only creative mode can touch it. Renaming alone is exempt: its price clamps to 39 and it never raises the prior work penalty.",
      },
      {
        q: "Does the merge order really matter?",
        a: "Yes. Applying five books to a sword one by one can cost 46 levels while the best merge tree costs 31, because prior work compounds on the item and each enchantment's fee is charged every time it transfers. The planner searches every merge tree exactly, so the plan it prints is the true minimum for the books you entered, not a heuristic.",
      },
    ],
  },
};

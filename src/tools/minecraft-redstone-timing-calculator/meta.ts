import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "minecraft-redstone-timing-calculator",
  matrixSlug: "minecraft-redstone-timing",
  icon: "Zap",
  name: "Minecraft Redstone Timing Calculator",
  description:
    "Convert ticks to seconds, build exact repeater delays and clocks, plan hopper throughput, and invert the comparator container signal, per Minecraft version.",
  category: "Minecraft",
  keywords: [
    "minecraft redstone timing calculator",
    "redstone tick to seconds",
    "repeater delay calculator",
    "comparator signal strength items",
    "hopper items per second",
    "minecraft clock period calculator",
    "how many items for signal strength",
  ],
  searchTerms: [
    "game tick vs redstone tick",
    "how long is a redstone tick",
    "how many items in a chest for signal 7",
    "double chest comparator signal",
    "hopper speed minecraft",
    "hopper minecart unload rate",
    "dropper clock rate",
    "observer pulse length",
    "piston extension ticks",
    "tnt fuse ticks",
    "sculk sensor cooldown",
    "items per hour hopper",
    "20 tps server lag",
    "redstone delay to seconds",
    "flip flop timer",
    "pulse extender circuit",
    "minecraft comparator loop",
    "redstone clock calculator",
    "furnace signal strength",
    "item clock calculator",
    "mc tick calculator",
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
          value: "26.2",
          label: "26.2 (latest)",
          synonyms: ["latest", "current", "newest", "2026", "unobfuscated"],
        },
        {
          value: "1.21.11",
          label: "1.21.11",
          synonyms: ["1.21.11", "copper age", "redstone experiments"],
        },
        {
          value: "1.21.1",
          label: "1.21.1",
          synonyms: ["1.21", "tricky trials"],
        },
        {
          value: "1.20.6",
          label: "1.20.6",
          synonyms: ["1.20", "1.20.5", "trails and tales", "crafter", "copper bulb"],
        },
        {
          value: "1.18.2",
          label: "1.18.2",
          synonyms: ["1.18", "1.17", "caves and cliffs", "sculk sensor", "lightning rod"],
        },
        {
          value: "1.16.5",
          label: "1.16.5",
          synonyms: ["1.16", "nether update", "target block"],
        },
      ],
    },
    {
      kind: "number",
      id: "tps",
      label: "Server tick rate (ticks per second)",
      default: 20,
      min: 1,
      max: 20,
      step: 0.1,
    },
  ],
  copy: {
    what: "Converts between game ticks, redstone ticks, seconds and real wall-clock time, and answers the timing questions that come up while building. It plans the cheapest repeater arrangement for a target delay, sizes repeater loop and item clocks to a target period, works out items per second and per hour for hoppers, hopper chains, hopper minecarts, dropper chains and water streams, and prints the comparator container-fullness table in both directions, so you can ask how many items a chest needs for signal strength 7 instead of hunting for a static table. Every number is reimplemented from the game's own code, decompiled or unobfuscated per version, for 1.16.5, 1.18.2, 1.20.6, 1.21.1, 1.21.11 and 26.2. Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.",
    how: "Pick your game version, then use whichever tab fits the question. The converter takes a number in any unit and shows the rest, including real time on a server that is running below 20 ticks per second. The delay and clock builder takes a target in game ticks and returns the exact repeater setup, or the two achievable delays that bracket it when the target is impossible. The throughput tab compares transports and shows how long a double chest takes to fill or empty, and the signal tab gives the full fullness table for any container and stack size.",
    why: "Most redstone timing pages are a single hardcoded table for a double chest of stackable items, with no version awareness and no way to ask the question backwards. This one derives the whole table from the game's own formula, scanning every possible item count so the forward and inverse answers can never disagree, handles containers from a 3 slot furnace to a 54 slot double chest, and models stack sizes of 64, 16 and 1. It also states plainly which components changed between versions rather than pretending redstone has always behaved the same. No ads, no signup, and your files and inputs never leave your device.",
    faq: [
      {
        q: "What is the difference between a game tick and a redstone tick?",
        a: "A game tick is the real unit: the server runs 20 of them a second, one every 50 milliseconds. A redstone tick is only a nickname for two game ticks, because the smallest delay a repeater or comparator can add is two game ticks. That is why an odd number of game ticks cannot be built out of repeaters at all, and why this tool works in game ticks and shows redstone ticks alongside. On a server running below 20 ticks per second every one of these delays takes longer in real time, though the tick counts themselves never change.",
      },
      {
        q: "How many items do I need in a chest for a given comparator signal?",
        a: "The game divides the total item count by the per-slot stack size, divides that by the number of slots, multiplies by 14, floors it, and adds 1 for any container that is not empty. For a double chest of items that stack to 64 that means 1 item gives signal 1, 1482 gives signal 7, 3210 gives signal 14 and only a completely full chest gives 15. How you spread the items across slots makes no difference, only the total does. Smaller containers skip levels: a 3 slot furnace can only ever produce a handful of the 16 signal strengths.",
      },
      {
        q: "Which redstone timings actually changed between versions?",
        a: "Very few. The repeater, comparator, observer, piston, hopper, dropper, dispenser, TNT fuse, button, pressure plate and detector rail timings are identical in 1.16.5, 1.18.2, 1.20.6, 1.21.1, 1.21.11 and 26.2. The sculk sensor is the real change: it arrived in 1.18.2 active for 40 game ticks with a 1 tick cooldown, and was retimed in 1.20.6 to 30 active ticks with a 10 tick cooldown. The hopper minecart is the other one: it paid a 4 tick pull cooldown in 1.16.5 and 1.18.2, and from 1.20.6 it pulls one item every game tick, which quadruples unloader speed. The crafter, copper bulb and calibrated sculk sensor only exist from 1.20.6, and the lightning rod only from 1.18.2.",
      },
    ],
  },
};

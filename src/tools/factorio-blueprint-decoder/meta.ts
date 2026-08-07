import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "factorio-blueprint-decoder",
  icon: "Factory",
  matrixSlug: "factorio",
  name: "Blueprint Surgeon",
  description: "Decode, inspect, repair and re-encode Factorio blueprint strings.",
  category: "Dev",
  keywords: [
    "factorio blueprint decoder",
    "factorio blueprint string to json",
    "edit factorio blueprint",
    "fix corrupted blueprint string",
    "blueprint book viewer",
    "factorio blueprint json editor",
    "decode factorio blueprint online",
  ],
  searchTerms: [
    "factorio blueprint",
    "blueprint string parser",
    "bp string decoder",
    "factorio json",
    "blueprint book",
    "factorio zlib base64",
    "undo mangled blueprint",
    "factorio save editor",
    "production line planner",
    "factorio calculator",
  ],
  input: "text/plain",
  output: "text/plain",
  options: [
    {
      kind: "select",
      id: "operation",
      label: "Operation",
      default: "inspect",
      choices: [
        { value: "inspect", label: "Inspect (summary)" },
        { value: "json", label: "Show raw JSON" },
        { value: "reencode", label: "Re-encode JSON to a string" },
        { value: "repair", label: "Repair a mangled string" },
        { value: "strip", label: "Strip junk and re-encode" },
      ],
    },
    {
      kind: "boolean",
      id: "stripTrees",
      label: "Strip: remove trees, rocks and other environment entities",
      default: true,
    },
    {
      kind: "boolean",
      id: "stripRequests",
      label: "Strip: clear all module and item requests",
      default: false,
    },
    { kind: "boolean", id: "stripTiles", label: "Strip: remove the tile layer", default: false },
  ],
  http: { method: "POST", contentType: "text/plain" },
  copy: {
    what: "Turns a Factorio blueprint string back into the JSON the game actually stores, and turns edited JSON back into a string the game accepts. The inspect view reads a blueprint or a whole blueprint book, recursing through nested books, and reports the label, the game version packed into the version number, every entity counted by name, tiles, icons, item requests, wire and circuit connection counts, and the bounding box the build covers. The repair pass rescues strings that arrived mangled, and the strip pass deletes the trees, rocks, item requests or tiles you did not mean to copy.",
    how: "Paste a blueprint string starting with 0 and leave the operation on Inspect for a readable summary. Switch to Show raw JSON to see the full structure, edit it, then paste it back with Re-encode to get a fresh string. If a string will not decode because it came through a chat client, choose Repair: it removes line breaks and URL encoding, cuts trailing junk, restores a missing version byte, and prints exactly what it changed. Choose Strip with the three toggles to clean a build before sharing it.",
    why: "Most Factorio blueprint decoders are abandoned forum projects that choke on blueprint books, show you a wall of unformatted JSON, and offer no way back to a valid string. This one decodes in your browser, recurses through nested books, explains what the packed version number means, re-encodes strings the game accepts, and repairs the mangling that chat clients inflict on long strings, all with the browser's own compression engine: your files and inputs never leave your device.",
    faq: [
      {
        q: "What is actually inside a blueprint string?",
        a: "A leading version byte, which has been the character 0 for every export since Factorio 0.15, followed by base64 of a zlib deflate stream whose contents are a JSON object with a blueprint or blueprint_book key. This tool undoes exactly those three steps, and redoes them when you re-encode.",
      },
      {
        q: "Why did my blueprint string break when someone pasted it to me?",
        a: "Chat clients and forums mangle very long strings. They wrap them across lines, turn plus signs into %2B when the string travels through a link, append a stray character or a stray word, and sometimes drop the leading 0. The Repair operation undoes those four and tells you exactly which ones it found. If characters were lost from the middle, or a plus sign was replaced by a plain space, the missing data is gone and you need the string again from the source.",
      },
      {
        q: "Is my blueprint uploaded anywhere?",
        a: "No. The decode, repair and re-encode all run in your browser using its built-in compression engine, and your files and inputs never leave your device.",
      },
    ],
  },
};

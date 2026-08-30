import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "electron-configuration",
  icon: "Atom",
  name: "Electron Configuration Viewer",
  description: "Aufbau order electron configuration and orbital diagram for any element.",
  category: "Chemistry",
  keywords: [
    "electron configuration calculator",
    "noble gas configuration",
    "orbital diagram generator",
    "valence electrons calculator",
    "electron configuration of ions",
    "paramagnetic or diamagnetic",
  ],
  searchTerms: [
    "aufbau principle",
    "hund's rule",
    "madelung order",
    "orbital filling",
    "unpaired electrons",
    "shorthand configuration",
    "condensed configuration",
    "electron shells",
    "spdf notation",
    "chromium exception",
    "copper exception",
    "iron three plus configuration",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "order",
      label: "Write the subshells",
      default: "shell",
      options: [
        {
          value: "shell",
          label: "By shell (3d before 4s)",
          synonyms: ["shell order", "principal", "standard", "textbook"],
        },
        {
          value: "energy",
          label: "By filling energy (4s before 3d)",
          synonyms: ["aufbau order", "madelung", "filling order", "energy"],
        },
      ],
    },
    { kind: "boolean", id: "showDiagram", label: "Show the orbital diagram", default: true },
  ],
  examples: [
    { label: "Iron", input: "Fe" },
    { label: "The iron(III) ion", input: "Fe3+" },
    { label: "Chromium, an Aufbau exception", input: "Cr" },
    { label: "The oxide ion", input: "O2-" },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Gives the full and noble gas shorthand electron configuration for any element or monatomic ion, along with an orbital box diagram drawn with up and down arrows, the valence electron count, the block, period and group, the number of unpaired electrons, and whether the species is paramagnetic or diamagnetic. The twenty elements whose measured ground state breaks the Aufbau order, chromium and copper through to curium, are carried in an explicit table and flagged in the result rather than predicted wrongly.",
    how: "Type a symbol, a full name, or an atomic number: Fe, iron and 26 all work. Add a charge for an ion, written either way round as Fe3+ or Fe^3+, and O2- or Cl- for anions. Switch the subshell order if your course writes 4s before 3d, and turn off the orbital diagram when you only want the configuration line.",
    why: "Configuration pages elsewhere apply plain Aufbau to every element, which gets chromium, copper, palladium and the lanthanides wrong, and most of them cannot do ions at all. This one carries the measured exceptions, removes electrons from the highest shell first so Fe3+ comes out as [Ar] 3d5 rather than [Ar] 3d3 4s2, and draws the Hund's rule box diagram alongside. It runs entirely in your browser, so your inputs never leave your device.",
    faq: [
      {
        q: "Why is Fe3+ written [Ar] 3d5 and not [Ar] 3d3 4s2?",
        a: "Because electrons come off the highest principal quantum number first. The 4s subshell fills before 3d, but once it is filled it sits higher in energy, so iron loses both 4s electrons before any 3d electron. That leaves a half filled 3d5 shell, which is part of why iron(III) is so stable and why it has five unpaired electrons.",
      },
      {
        q: "Which elements break the Aufbau order?",
        a: "The table here carries chromium, copper, niobium, molybdenum, ruthenium, rhodium, palladium, silver, lanthanum, cerium, gadolinium, platinum, gold, actinium, thorium, protactinium, uranium, neptunium and curium. In each case a half filled or filled d or f subshell sits lower in energy than the extra outer s electron. Palladium is the most extreme: its 5s subshell is empty and the configuration is simply [Kr] 4d10.",
      },
      {
        q: "How are valence electrons counted here?",
        a: "Everything outside the noble gas core, less any inner d or f subshell that is completely full and sits below the outermost shell. That gives 7 for bromine, 8 for iron, 1 for copper and 5 for the iron(III) ion. Other conventions count a full inner d shell toward the group number instead, which is why some tables give copper 11 rather than 1.",
      },
    ],
  },
};

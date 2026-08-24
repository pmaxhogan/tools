import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "chemical-lookup",
  icon: "TestTube",
  name: "Chemical Lookup",
  description:
    "Look up a chemical by name, CAS number, or formula and see its properties, NFPA diamond, and GHS classification.",
  category: "Chemistry",
  keywords: [
    "chemical lookup",
    "cas number lookup",
    "chemical properties",
    "msds data lookup",
    "chemical formula search",
    "ghs classification lookup",
  ],
  searchTerms: [
    "cas registry number",
    "chemical database",
    "compound lookup",
    "substance search",
    "sds data",
    "safety data sheet",
    "hazard statements",
    "h codes",
    "p codes",
    "boiling point",
    "melting point",
    "flash point",
    "molar mass",
    "sulphuric acid",
    "aluminium",
    "oxidiser",
  ],
  input: "text/plain",
  output: "application/json",
  examples: [
    { label: "Acetone", input: "acetone" },
    { label: "By CAS number", input: "67-64-1" },
    { label: "By formula", input: "H2SO4" },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Searches 3,050 chemicals by name, synonym, CAS registry number, or molecular formula, and shows what is known about the match: formula, molar mass, density, melting point, boiling point, flash point, the NFPA 704 fire diamond with its source, the GHS signal word, pictograms, hazard statements, and precautionary statements, plus links to the Wikipedia article and the PubChem compound page.",
    how: "Type a name like acetone, a CAS number like 67-64-1, or a formula like H2SO4. The best match opens straight away; when a query matches several chemicals equally well, such as the formula C3H6O, you get the candidates by name so you can pick one. Every field has its own copy button.",
    why: "Looking a chemical up usually means bouncing between PubChem, Wikipedia, and a supplier catalog, each with a different search box. This pulls the same public domain and Creative Commons data into one page that loads fast, works offline after the first visit, and never sends what you typed anywhere.",
    faq: [
      {
        q: "Where does the data come from?",
        a: "PubChem for NFPA annotations, GHS classifications, CAS numbers, and formulas, all public domain work of the US National Library of Medicine, plus English Wikipedia chembox parameters under CC BY-SA 4.0. Any value taken from Wikipedia comes with a link to the article that supplied it.",
      },
      {
        q: "Why does one chemical show two NFPA diamonds?",
        a: "Because PubChem and Wikipedia disagree about it. Rather than pick a winner, both ratings are listed with their source so you can see the disagreement and check the safety data sheet yourself.",
      },
      {
        q: "Is this a substitute for a safety data sheet?",
        a: "No. It is a reference, and nothing here is a basis for a workplace safety decision. Hazard statements are recorded as the notifying body worded them, coverage is uneven, and some compounds have no classification at all. Always work from the actual safety data sheet.",
      },
    ],
  },
};

import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "chemical-lookup",
  icon: "TestTube",
  name: "Chemical Lookup",
  description:
    "Search more than 25,000 compounds by name, CAS number, formula, or molar mass and read the properties, NFPA diamond, and GHS classification.",
  category: "Chemistry",
  keywords: [
    "chemical lookup",
    "cas number lookup",
    "chemical properties database",
    "molecular formula search",
    "ghs classification lookup",
    "nfpa 704 rating lookup",
    "molar mass search",
  ],
  searchTerms: [
    "cas registry number",
    "chemical database",
    "compound lookup",
    "substance search",
    "drug lookup",
    "sds data",
    "safety data sheet",
    "hazard statements",
    "h codes",
    "p codes",
    "pubchem",
    "boiling point",
    "melting point",
    "flash point",
    "molar mass",
    "molecular weight",
    "sulphuric acid",
    "aluminium",
    "oxidiser",
  ],
  input: "text/plain",
  output: "application/json",
  examples: [
    { label: "Acetone", input: "acetone" },
    { label: "By molar mass", input: "mass:98-99" },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Searches more than 25,000 chemical compounds by name, synonym, CAS registry number, molecular formula, or molar mass, and shows what is known about the one you pick: formula, molar mass, exact mass, density, melting point, boiling point, flash point, the NFPA 704 fire diamond, the GHS signal word, pictograms, hazard statements and precautionary statements with their full wording, a description of the compound, and links to the Wikipedia article and the PubChem compound page. Formula search is order independent, so H2SO4 also answers to h2so4 and to O4SH2, and a misspelled name still finds the compound. Filters narrow the list to compounds that carry an NFPA rating, that carry a GHS classification, or that are drugs.",
    how: "Type a name like acetone, a CAS number like 67-64-1, a formula like H2SO4, or a molar mass like mass:98-99. Results appear as you type; the arrow keys move through them and Enter opens one. The full compound index downloads once in the background, so the first few keystrokes search the smaller bundled set and the rest of the catalog joins in when it arrives. Copy report puts the whole data sheet on the clipboard, and the address bar carries your search and the compound you opened so a link shares exactly what you are looking at.",
    why: "Looking a chemical up usually means bouncing between PubChem, Wikipedia, and a supplier catalog, each with a different search box and none of them tolerant of a typo or a formula written in the wrong order. This pulls the same public domain and Creative Commons data into one page with one box, no ads, no signup, and no daily limit. What you type never leaves your device: the compound data is downloaded from this site as static files and searched in the browser, so no query is ever sent anywhere.",
    faq: [
      {
        q: "Where does the data come from?",
        a: "PubChem supplies the CAS numbers, formulas, molar masses, NFPA annotations, and GHS classifications, all public domain work of the US National Library of Medicine. English Wikipedia supplies the chembox and drugbox parameters and the one sentence description, under CC BY-SA 4.0, and every value taken from an article is shown with a credit and a link to it.",
      },
      {
        q: "Why does a compound have no GHS classification or no fire diamond?",
        a: "Because nobody has published one for it. About 9,000 of the compounds here carry a GHS classification, from PubChem's records of what ECHA and other notifying bodies registered, and about 1,800 carry an NFPA 704 rating. The rest are in the dataset for their identifiers and properties. Use the filters to search only the compounds that carry the rating you need.",
      },
      {
        q: "Is this a substitute for a safety data sheet?",
        a: "No. It is a reference, and nothing here is a basis for a workplace safety decision. Hazard statements are recorded as the notifying body worded them, coverage is uneven, and some compounds have no classification at all. Always work from the actual safety data sheet, NFPA 704 itself, and the authority having jurisdiction.",
      },
    ],
  },
};

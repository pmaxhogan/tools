import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "periodic-table",
  icon: "Atom",
  name: "Periodic Table",
  description:
    "Browse all 118 elements, color the table by a property trend, and read the detail for any element.",
  category: "Chemistry",
  keywords: [
    "periodic table",
    "interactive periodic table",
    "element properties",
    "atomic mass table",
    "electronegativity chart",
    "periodic trends",
  ],
  searchTerms: [
    "elements",
    "chemical elements",
    "atomic number",
    "atomic weight",
    "electron configuration",
    "electronegativity",
    "ionisation energy",
    "ionization energy",
    "atomic radius",
    "melting point",
    "boiling point",
    "noble gases",
    "halogens",
    "lanthanides",
    "actinides",
    "aluminium",
    "caesium",
    "sulphur",
    "mendeleev",
  ],
  input: "none",
  output: "application/json",
  options: [
    {
      kind: "text",
      id: "symbol",
      label: "Element",
      default: "C",
      placeholder: "Fe, Iron or 26",
    },
    {
      kind: "select",
      id: "layout",
      label: "Layout",
      default: "standard",
      ui: "segmented",
      options: [
        {
          value: "standard",
          label: "Standard",
          synonyms: ["18 column", "classic", "printed", "f block below", "short form"],
        },
        {
          value: "wide",
          label: "Wide",
          synonyms: [
            "32 column",
            "long form",
            "extended",
            "inline f block",
            "lanthanides inline",
            "actinides inline",
          ],
        },
      ],
    },
    {
      kind: "select",
      id: "trend",
      label: "Color by trend",
      default: "none",
      options: [
        {
          value: "none",
          label: "Category",
          synonyms: ["no trend", "group block", "metal nonmetal", "family", "default colors"],
        },
        {
          value: "electronegativity",
          label: "Electronegativity",
          synonyms: ["pauling", "electron pull", "en"],
        },
        {
          value: "atomicRadius",
          label: "Atomic radius",
          synonyms: ["size", "van der waals radius", "atom size", "picometres", "picometers"],
        },
        {
          value: "ionizationEnergy",
          label: "Ionization energy",
          synonyms: ["ionisation energy", "first ionization", "electronvolts", "ev"],
        },
        {
          value: "electronAffinity",
          label: "Electron affinity",
          synonyms: ["electron gain", "affinity", "electronvolts"],
        },
        {
          value: "meltingPoint",
          label: "Melting point",
          synonyms: ["melts", "fusion point", "kelvin", "mp"],
        },
        {
          value: "density",
          label: "Density",
          synonyms: ["heaviness", "grams per cubic centimeter", "specific gravity", "log scale"],
        },
      ],
    },
    {
      kind: "select",
      id: "palette",
      label: "Palette",
      default: "viridis",
      options: [
        {
          value: "viridis",
          label: "Viridis",
          synonyms: ["purple green yellow", "perceptual", "matplotlib", "colorblind safe"],
        },
        {
          value: "plasma",
          label: "Plasma",
          synonyms: ["blue magenta yellow", "perceptual", "matplotlib"],
        },
        {
          value: "blue-red",
          label: "Blue to red",
          synonyms: ["diverging", "cool warm", "heat map", "red blue"],
        },
        {
          value: "grayscale",
          label: "Grayscale",
          synonyms: ["greyscale", "mono", "black and white", "print"],
        },
      ],
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "An interactive periodic table of all 118 elements. Switch between the standard 18 column layout with the f block below and the wide 32 column layout with the lanthanides and actinides spliced back inline. Color the whole table by electronegativity, atomic radius, ionization energy, electron affinity, melting point, or density, and click any element for its atomic mass, electron configuration, oxidation states, standard state, discovery year, and links to Wikipedia and PubChem.",
    how: "Pick a layout, then pick a trend to paint the cells by. Click an element to open its detail. The layout, trend, palette, and selected element all travel in the URL, so a link reproduces exactly the table you were looking at. Density uses a log scale because it spans five orders of magnitude from hydrogen to osmium; every other trend is linear.",
    why: "Most periodic table sites are ad-heavy, slow, or hide the property data behind a subscription. This one loads a single small dataset, works offline after first visit, and your interactions never leave your device. The data is the public domain PubChem periodic table, credited on every element page.",
    faq: [
      {
        q: "What is the difference between the standard and wide layouts?",
        a: "The standard layout is the printed table: 18 columns, with the lanthanides and actinides lifted out into two rows underneath and a 57-71 and 89-103 marker left in group 3. The wide layout puts those elements back where their atomic numbers belong, which needs 32 columns. In the wide layout, lutetium and lawrencium sit in the group 3 column so that the count works out and atomic number still increases left to right.",
      },
      {
        q: "Why are some cells left unpainted when I pick a trend?",
        a: "Because PubChem publishes no value for that element and that property. Only 57 elements have a measured electron affinity, for example. An unpainted cell means no data, which is more honest than painting it as a zero.",
      },
      {
        q: "Where does the data come from?",
        a: "The PubChem periodic table, which is public domain work of the US National Library of Medicine. Atomic masses are the standard atomic weights exactly as PubChem publishes them, so the printed precision matches the source.",
      },
    ],
  },
};

import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "ghs-pictogram-lookup",
  icon: "Shield",
  name: "GHS Pictogram Lookup",
  description:
    "Pick GHS pictograms or hazard codes and see which chemicals carry them, with the official symbols.",
  category: "Chemistry",
  keywords: [
    "ghs pictograms",
    "ghs hazard symbols",
    "h code lookup",
    "hazard statement codes",
    "ghs labels",
    "clp pictograms",
  ],
  searchTerms: [
    "hazard symbols",
    "warning symbols",
    "ghs01",
    "ghs02",
    "ghs09",
    "exploding bomb",
    "flame over circle",
    "skull and crossbones",
    "corrosion",
    "gas cylinder",
    "health hazard",
    "exclamation mark",
    "h statements",
    "p statements",
    "precautionary statements",
    "clp regulation",
    "hazard labelling",
    "hazard labeling",
    "oxidiser symbol",
    "signal word",
  ],
  input: "none",
  output: "application/json",
  options: [
    {
      kind: "text",
      id: "pictograms",
      label: "Pictograms",
      default: "",
      placeholder: "GHS02, GHS07",
    },
    {
      kind: "select",
      id: "mode",
      label: "Match",
      default: "all",
      ui: "segmented",
      options: [
        {
          value: "all",
          label: "All of them",
          synonyms: ["every", "and", "intersection", "must have all"],
        },
        {
          value: "any",
          label: "Any of them",
          synonyms: ["at least one", "or", "union", "some"],
        },
      ],
    },
    {
      kind: "text",
      id: "hcodes",
      label: "Hazard codes",
      default: "",
      placeholder: "H225, H319",
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Shows the nine GHS pictograms as the drawn UN symbols and lets you search the dataset by them. Pick one to see every chemical that carries it, or pick several and choose whether a match needs all of them or just one. You can filter by hazard statement codes such as H225 the same way, and combine the two. Each result set also reports which hazard statements come up most often, which is a quick way to see what a symbol actually means in practice.",
    how: "Click the pictograms you want, set the match to all or any, and read the list of chemicals. Add hazard codes to narrow it further; both filters apply together. The pictogram artwork is self hosted, so you can right click and save any symbol you need for a label mockup. Your selection travels in the URL so a link reproduces the same search.",
    why: "The official pictogram pages are PDFs, and the sites that reproduce them rarely let you search by symbol at all. This is a real filter over a few thousand classified compounds, with the artwork served from this site rather than a third party, and everything you type stays on your device.",
    faq: [
      {
        q: "What do the nine pictograms mean?",
        a: "GHS01 exploding bomb for explosives, GHS02 flame for flammables, GHS03 flame over circle for oxidizers, GHS04 gas cylinder for compressed gases, GHS05 corrosion for corrosives, GHS06 skull and crossbones for acute toxicity, GHS07 exclamation mark for irritants, GHS08 health hazard for serious longer term effects, and GHS09 environment for aquatic toxicity.",
      },
      {
        q: "Why does a chemical I know is flammable not show GHS02?",
        a: "A compound often has several classifications, one per notifying body, and the dataset keeps one coherent classification per chemical rather than merging them. Coverage is also uneven: about 2,100 of the 3,050 chemicals here carry a GHS classification at all.",
      },
      {
        q: "Can I use these symbols on a real label?",
        a: "The artwork is the public domain UN set, so reproducing it is fine. Whether a particular label is correct is a separate question, and this tool is a reference, not a compliance tool. Nothing here is a basis for a workplace safety decision.",
      },
    ],
  },
};

import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "bookmarklets",
  matrixSlug: "bookmarklets",
  icon: "Bookmark",
  name: "Bookmarklet Shelf",
  description: "Run the ruler, picker and audits on somebody else's page.",
  category: "Platform",
  keywords: [
    "bookmarklet",
    "javascript bookmark",
    "bookmarklet generator",
    "bookmarklet decoder",
    "javascript url",
  ],
  searchTerms: [
    "js to bookmarklet",
    "minify javascript for bookmark",
    "javascript colon url",
    "decode bookmarklet",
    "pixel ruler tool",
    "outline elements bookmarklet",
    "accessibility audit bookmarklet",
    "reveal password field",
    "designmode editable page",
    "list page links",
  ],
  input: "text/plain",
  output: "text/plain",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Mode",
      default: "encode",
      options: [
        {
          value: "encode",
          label: "Encode: JS to bookmarklet",
          synonyms: ["minify", "wrap", "convert to bookmarklet", "javascript to url", "build"],
        },
        {
          value: "decode",
          label: "Decode: bookmarklet to JS",
          synonyms: ["unwrap", "read bookmarklet", "url to javascript", "unminify"],
        },
        {
          value: "shelf",
          label: "Shelf: ready made bookmarklets",
          synonyms: ["presets", "examples", "ready to use", "toolkit", "library"],
        },
      ],
    },
  ],
  copy: {
    what: "Turns JavaScript source into a javascript: bookmarklet URL, or unwraps one back into readable source. A third mode, Shelf, ships nine ready made bookmarklets for outlining elements, killing sticky headers, revealing password fields, making a page editable, a pixel ruler, a color picker, link and image dumps, and a basic accessibility audit.",
    how: "Pick Encode, paste JavaScript, and drag the resulting link to your bookmarks bar since browsers block a click on a javascript: link from this page. Pick Decode and paste an existing bookmarklet URL to read its source. Pick Shelf to get the nine built in bookmarklets as ready to drag links.",
    why: "Most bookmarklet builders online either strip your comments incorrectly, breaking any string that contains // or /*, or do nothing more than encodeURIComponent and call it done. This one respects strings and regex literals while stripping comments, and ships a working starter set instead of an empty text box.",
    faq: [
      {
        q: "Why can I not just click these links here?",
        a: "Browsers block navigation to a javascript: URL from a page click as a security measure. Drag the link to your bookmarks bar instead, then click it from there while on the page you want to affect.",
      },
      {
        q: "Do bookmarklets send my data anywhere?",
        a: "No. Every bookmarklet on this page runs entirely inside the tab you invoke it on, reads and modifies only that page, and makes no network requests of its own.",
      },
      {
        q: "Why does a bookmarklet sometimes get blocked on a site?",
        a: "A site's Content Security Policy can restrict inline script execution, which blocks some javascript: bookmarklets on that specific site regardless of what the bookmarklet does. This is a restriction the site sets, not something this tool can work around.",
      },
    ],
  },
};

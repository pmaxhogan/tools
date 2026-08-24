import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "barcode-generator",
  matrixSlug: "barcode",
  icon: "Barcode",
  name: "Barcode Generator",
  description:
    "Generate Code 128, EAN, UPC, Code 39, ITF-14 and Codabar barcodes as SVG, on their own or laid out on a print ready label sheet.",
  category: "QR",
  keywords: [
    "barcode generator",
    "free barcode generator",
    "code 128 generator",
    "ean 13 generator",
    "upc barcode generator",
    "print barcode labels",
    "itf 14 generator",
    "svg barcode",
  ],
  searchTerms: [
    "make a barcode",
    "barcode maker",
    "product barcode",
    "gtin barcode",
    "avery 5160 barcode labels",
    "code 39 generator",
    "codabar generator",
    "upc e generator",
    "interleaved 2 of 5",
    "barcode label sheet",
    "check digit calculator",
    "barcode no watermark",
    "gs1 barcode",
  ],
  input: "text/plain",
  output: "image/svg+xml",
  http: { method: "GET", contentType: "image/svg+xml" },
  options: [
    {
      kind: "select",
      id: "type",
      label: "Symbology",
      default: "code128",
      groups: [
        {
          label: "Retail and GS1",
          synonyms: ["product", "gtin", "grocery", "point of sale", "shop", "retail"],
          options: [
            {
              value: "ean13",
              label: "EAN-13",
              synonyms: ["ean 13", "gtin 13", "european article number", "isbn barcode"],
            },
            {
              value: "upca",
              label: "UPC-A",
              synonyms: ["upc a", "upc", "gtin 12", "north america retail"],
            },
            {
              value: "ean8",
              label: "EAN-8",
              synonyms: ["ean 8", "gtin 8", "small pack", "short barcode"],
            },
            {
              value: "upce",
              label: "UPC-E",
              synonyms: ["upc e", "compressed upc", "zero suppressed", "small package"],
            },
          ],
        },
        {
          label: "Shipping and warehouse",
          synonyms: ["logistics", "carton", "pallet", "case code", "outer box"],
          options: [
            {
              value: "itf14",
              label: "ITF-14",
              synonyms: [
                "itf 14",
                "interleaved 2 of 5",
                "case code",
                "carton code",
                "gtin 14",
                "bearer bars",
              ],
            },
          ],
        },
        {
          label: "General purpose",
          synonyms: ["any text", "asset tag", "part number", "internal", "inventory"],
          options: [
            {
              value: "code128",
              label: "Code 128",
              synonyms: ["code128", "c128", "gs1 128", "ascii barcode", "dense barcode"],
            },
            {
              value: "code39",
              label: "Code 39",
              synonyms: ["code39", "3 of 9", "code 3 of 9", "alpha39", "asset tag"],
            },
            {
              value: "codabar",
              label: "Codabar",
              synonyms: ["nw-7", "nw7", "code 2 of 7", "blood bank", "library card", "fedex"],
            },
          ],
        },
      ],
    },
    {
      kind: "select",
      id: "sheet",
      label: "Layout",
      default: "single",
      // Full sentence labels: keep the dropdown rather than a row of buttons.
      ui: "select",
      options: [
        {
          value: "single",
          label: "Single barcode",
          synonyms: ["one", "just the code", "no sheet", "standalone"],
        },
        {
          value: "avery-5160",
          label: "Avery 5160: 30 labels on US Letter",
          synonyms: ["avery 5160", "5160", "30 up", "letter labels", "2.625 x 1 inch", "8160"],
        },
        {
          value: "a4-3x8",
          label: "A4 3 x 8: 24 labels, 70 x 37 mm",
          synonyms: ["a4 24 up", "70x37", "3 by 8", "24 labels", "l7159"],
        },
        {
          value: "a4-2x7",
          label: "A4 2 x 7: 14 labels, 99.1 x 38.1 mm",
          synonyms: ["a4 14 up", "99x38", "2 by 7", "14 labels", "l7163"],
        },
      ],
    },
    { kind: "number", id: "copies", label: "Copies of each value", default: 1, min: 1, max: 1000 },
    { kind: "boolean", id: "showText", label: "Print the value under the bars", default: true },
    {
      kind: "number",
      id: "moduleWidth",
      label: "Module width (px)",
      default: 2,
      min: 0.5,
      max: 20,
      step: 0.5,
    },
    { kind: "number", id: "height", label: "Bar height (px)", default: 80, min: 10, max: 600 },
    {
      kind: "number",
      id: "quietZone",
      label: "Quiet zone (modules)",
      default: 10,
      min: 0,
      max: 40,
    },
    {
      kind: "boolean",
      id: "code39Check",
      label: "Code 39: add the modulo 43 check character",
      default: false,
    },
  ],
  copy: {
    what: "Encodes a value as a real linear barcode and hands you the SVG. Eight symbologies are built in: Code 128 with automatic A, B and C code set switching, EAN-13, EAN-8, UPC-A and UPC-E with the correct parity and guard bars, Code 39 with an optional modulo 43 check character, ITF-14 with bearer bars, and Codabar. Check digits are calculated for you, or validated when you paste a full number, and the pattern tables come straight from the published symbology specifications. Pick a label sheet and the same values are laid out on a page sized SVG in real millimeters, ready to print.",
    how: "Choose a symbology, type or paste the value, and the barcode redraws as you go. Enter 12 digits for an EAN-13 or 11 for a UPC-A and the check digit is appended, or paste the full number and it is checked instead. For a label run, pick a sheet layout, put one value per line, set how many copies of each you want, then print the page or download the SVG or PNG. Module width, bar height, quiet zone and the human readable text underneath are all adjustable.",
    why: "Most barcode sites cap you at a handful of codes a day, watermark the output, hide SVG behind a signup, or upload your product numbers to their servers to render a PNG. This one encodes in your browser, so your files and inputs never leave your device, and there is no limit, no watermark and no account. You get vector output that stays sharp at any print size, honest check digit handling instead of a silently wrong number, and label sheets measured in millimeters so what comes out of the printer is actually to scale.",
    faq: [
      {
        q: "Which barcode type do I need for a product I want to sell in shops?",
        a: "EAN-13 outside North America and UPC-A inside it, and both need a number you own rather than one you invent. Retail numbers start with a GS1 company prefix that you license from GS1, and the barcode is only the printed form of it. This tool will happily encode any 12 or 11 digits, which is fine for internal stock and warehouse use, but a retailer's scanner will reject a number that is not registered to you.",
      },
      {
        q: "Will a real scanner read what this produces?",
        a: "Yes, if you print it big enough. The bar patterns and check digits follow the published specifications, so the data is right; what usually fails is scale. Keep the narrow module at 0.33 mm or wider for retail EAN and UPC, keep the quiet zone clear on both sides (the tool enforces the minimum for you), print black on white rather than color on color, and never stretch the image non uniformly. Print one and scan it with a phone before you order a thousand.",
      },
      {
        q: "How do the label sheets work, and will they line up in my printer?",
        a: "Pick Avery 5160, A4 3 x 8 or A4 2 x 7, put one value on each line, and set the copies number if you want the same value repeated. The page comes out as an SVG sized in millimeters with the label grid at the manufacturer's measurements, so printing at 100% scale (not fit to page) puts each barcode in the middle of its label. If you ask for more barcodes than the sheet holds, the tool tells you exactly how many fit instead of quietly dropping the rest.",
      },
    ],
  },
};

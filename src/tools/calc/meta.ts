import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "calc",
  icon: "Calculator",
  name: "Unit Calculator",
  description:
    "A calculator that understands units and currencies, so 3 ft + 4 in to cm just works.",
  category: "Dev",
  keywords: [
    "unit calculator",
    "convert units",
    "currency converter",
    "numbat alternative",
    "calculator with units",
    "math with units",
  ],
  searchTerms: [
    "calculator",
    "unit conversion calculator",
    "convert miles to km",
    "usd to eur",
    "physics calculator",
    "dimensional analysis",
    "frink alternative",
    "wolfram alpha alternative",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "number",
      id: "precision",
      label: "Significant digits",
      default: 6,
      min: 1,
      max: 15,
      step: 1,
    },
  ],
  copy: {
    what: "A calculator that carries units through the math instead of making you strip them out first. Type an expression like 3 ft + 4 in to cm, 120 km/h to mph, sin(45 deg), or 2^16 bytes to MB and it converts, adds, multiplies, and cancels the units for you. It also knows about 30 world currencies, so 100 USD to EUR and 5 GBP + 3 EUR in USD both evaluate. Currency numbers come from a dated exchange rate snapshot that ships with the page, not a live feed, and the result always shows you the snapshot date.",
    how: "Type an expression in the input and the answer updates as you type. Use to or in for a conversion (20 miles to km), plain operators for arithmetic, and deg or rad inside trig functions. Raise the significant digits option when you need more decimals than the default six. Results have a copy button, and the URL updates so you can share the exact expression.",
    why: "A search engine calculator turns your expression into a search query, and the big symbolic math sites gate step-by-step answers behind a subscription and stack ads around the answer. This one is a plain text box with no ads, no sign-in, and no query limits, it works offline after first load, and your inputs never leave your device. The tradeoff is honest: exchange rates are a snapshot taken on a specific date rather than a live quote.",
    faq: [
      {
        q: "How fresh are the currency rates?",
        a: "They are a fixed snapshot of European Central Bank reference rates bundled with the page, not a live feed. Every currency result labels the snapshot date so you always know how old the number is. For anything where the exact rate matters, such as a payment or an invoice, check your bank or broker for the live rate.",
      },
      {
        q: "Which units does it understand?",
        a: "Length, mass, time, temperature, area, volume, angle, energy, power, pressure, force, data size, and the SI prefixes on all of them, plus roughly 30 currency codes. Units combine and cancel, so 3 kg * 9.81 m/s^2 to N gives 29.43 N.",
      },
      {
        q: "Is my expression sent anywhere?",
        a: "No. The whole calculator runs in your browser, so your inputs never leave your device, and the page keeps working with no network connection after the first load.",
      },
    ],
  },
};

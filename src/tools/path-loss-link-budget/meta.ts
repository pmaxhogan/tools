import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "path-loss-link-budget",
  icon: "Waypoints",
  name: "Path Loss and Link Budget Calculator",
  description:
    "Free space path loss from frequency and distance, plus a full link budget from transmit power to received power and fade margin.",
  category: "RF",
  keywords: [
    "path loss calculator",
    "free space path loss calculator",
    "link budget calculator",
    "fspl calculator",
    "rf link budget",
    "fade margin calculator",
    "wireless link budget",
  ],
  searchTerms: [
    "fspl formula",
    "20log10 distance frequency",
    "eirp calculator",
    "receiver sensitivity margin",
    "microwave link budget",
    "wifi link budget",
    "point to point link calculator",
    "two ray ground reflection",
    "itu-r p.525",
    "received signal strength calculator",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "distanceUnit",
      label: "Distance display unit",
      default: "km",
      options: [
        { value: "km", label: "Kilometers", synonyms: ["km", "kilometers", "kilometres"] },
        { value: "mi", label: "Miles", synonyms: ["mi", "miles", "statute miles"] },
        { value: "m", label: "Meters", synonyms: ["m", "meters", "metres"] },
        { value: "ft", label: "Feet", synonyms: ["ft", "feet"] },
      ],
    },
  ],
  examples: [
    { label: "FSPL only", input: "915 MHz 5 km" },
    {
      label: "Full link budget",
      input:
        "freq=915MHz distance=5km txpower=20dBm txgain=6 rxgain=6 cableloss=1 sensitivity=-100dBm",
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: 'Calculates free space path loss (FSPL) from a frequency and distance, and, when transmit power and receiver sensitivity are given, a complete link budget: EIRP, received power, and fade margin with a pass or fail verdict. Input is plain text like "915 MHz 5 km" for FSPL alone, or key=value tokens like "freq=915MHz distance=5km txpower=20dBm txgain=6 rxgain=6 cableloss=1 sensitivity=-100dBm" for the full budget.',
    how: 'Type a frequency and distance, either as bare tokens ("2.4GHz 1km") or as freq= and distance= keys. Add txpower, txgain, rxgain, cableloss, and sensitivity keys to get the full link budget; any omitted gain or loss defaults to zero. Pick the distance display unit from the dropdown; the FSPL figure and every other value stay accurate regardless of the display unit chosen.',
    why: "Free online path loss calculators usually stop at a single FSPL number and make you do the link budget arithmetic by hand in a spreadsheet. This one does both in one pass, from parsed text rather than a dozen separate form fields, and shows the reference FSPL at 1 km and 10 km so you can sanity check the scaling. Your inputs never leave your device.",
    faq: [
      {
        q: "Why is my real world signal weaker than the free space path loss predicts?",
        a: "FSPL assumes a clear, unobstructed line of sight with no ground reflection, terrain, foliage, or building loss. Real links, especially near ground level over flat terrain, often lose more to the two ray ground reflection effect described in ITU-R P.525, where a reflected path partially cancels the direct path at certain distances. Treat FSPL as a best case floor, not a prediction.",
      },
      {
        q: "What counts as a healthy fade margin?",
        a: "A fade margin of 10 to 20 dB is a common rule of thumb for a reliable outdoor link, giving headroom for rain fade, multipath fading, and small antenna misalignment. A margin near zero technically passes but leaves no room for real world variation, so most link designers aim well above the bare minimum.",
      },
      {
        q: "Does this account for antenna radiation patterns or Fresnel zone clearance?",
        a: "No. This tool assumes ideal isotropic-referenced antenna gain (dBi) and a clear path; it does not model the antenna's actual radiation pattern or check that the first Fresnel zone is unobstructed. For Fresnel zone clearance over a specific path, use the Fresnel Zone tool.",
      },
    ],
  },
};

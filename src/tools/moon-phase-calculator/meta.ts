import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "moon-phase-calculator",
  icon: "Moon",
  name: "Moon Phase Calculator",
  description:
    "The moon's phase, illumination, age and distance for any date, with the next four phases and moonrise for your location.",
  category: "Astronomy",
  keywords: [
    "moon phase calculator",
    "moon phase today",
    "moon illumination percentage",
    "next full moon date",
    "next new moon date",
    "moonrise and moonset times",
    "moon age in days",
    "moon distance from earth",
  ],
  searchTerms: [
    "what phase is the moon in",
    "when is the next full moon",
    "when is the next new moon",
    "waxing crescent",
    "waning gibbous",
    "first quarter moon",
    "last quarter moon",
    "lunar phase on my birthday",
    "supermoon perigee distance",
    "moon calendar for the month",
    "lunation number",
    "synodic month length",
    "moon phase southern hemisphere",
    "terminator line on the moon",
    "how full is the moon tonight",
  ],
  input: "text/plain",
  output: "application/json",
  http: { method: "GET", contentType: "text/plain" },
  options: [
    {
      kind: "select",
      id: "hemisphere",
      label: "Draw the moon as seen from",
      default: "north",
      options: [
        {
          value: "north",
          label: "Northern hemisphere",
          synonyms: ["north", "up north", "europe", "usa", "canada", "japan", "lit on the right"],
        },
        {
          value: "south",
          label: "Southern hemisphere",
          synonyms: [
            "south",
            "australia",
            "new zealand",
            "south africa",
            "chile",
            "argentina",
            "upside down",
            "lit on the left",
          ],
        },
      ],
    },
    {
      kind: "select",
      id: "detail",
      label: "Detail",
      default: "summary",
      options: [
        {
          value: "summary",
          label: "Summary",
          synonyms: ["short", "brief", "basic", "simple", "just the phase"],
        },
        {
          value: "full",
          label: "Full",
          synonyms: [
            "everything",
            "detailed",
            "advanced",
            "verbose",
            "right ascension",
            "declination",
            "elongation",
            "parallax",
            "lunation number",
          ],
        },
      ],
    },
  ],
  examples: [
    {
      label: "The wolf moon of January 2024",
      input: "2024-01-25",
      opts: { hemisphere: "north", detail: "summary" },
    },
    {
      label: "Tonight's moon over Sydney",
      input: "Sydney",
      opts: { hemisphere: "south", detail: "summary" },
    },
  ],
  copy: {
    what: "Works out the moon for any date between 1900 and 2100: which of the eight phases it is in, what percentage of the disc is lit, how many days old it is, how far away it is in kilometers, and how wide it looks. It then gives the exact times of the next new moon, first quarter, full moon and last quarter, to the minute. Add a place and it also reports moonrise, moonset, the time and height of the moon's highest point, and where the moon is in your sky right now as an altitude and a compass bearing. The picture at the top draws the real terminator for that moment, so a 12 percent crescent is drawn as a 12 percent crescent rather than a stock icon.",
    how: 'Pick a date, or leave it on today. Type a city like "Sydney" or a coordinate pair like "40.7128, -74.0060" in the location box for rise and set times, and switch the hemisphere toggle if you want the disc drawn the way it looks from below the equator, where a waxing moon is lit on the left. Drag the month scrubber to walk day by day through the month and watch the phase open and close, or press play to run it. Switch Detail to Full for the right ascension, declination, elongation from the sun, position angle of the bright limb, horizontal parallax and lunation number.',
    why: "Most moon phase pages show a stock picture of one of eight phases, wrapped in ads, and quietly assume you are in the northern hemisphere. This one runs the real series: the truncated ELP2000-82 lunar theory from Meeus chapter 47 for the position and distance, and the chapter 49 phase series for the event times, which land within seconds of the published values. The drawing is generated from the illuminated fraction rather than picked from a sprite sheet, the hemisphere toggle genuinely flips the geometry, and your files and inputs never leave your device.",
    faq: [
      {
        q: "How accurate are the phase times and the moonrise?",
        a: "The four phase times come from the Meeus chapter 49 series, which is the standard published one, and they land within a few seconds of the almanac value: the full moon of 2024 January 25 comes out at 17:53:56 against a published 17:54. Moonrise and moonset are worked out by sampling the moon's altitude across the day and finding where it crosses the standard rise altitude, which allows for refraction and for the moon's own parallax, and they are good to about a minute at mid latitudes. Two things will move them more than the arithmetic does: a real horizon with hills or buildings on it, and being close to the poles, where the moon crosses the horizon at a very shallow angle.",
      },
      {
        q: "Why is the moon not 100 percent lit at the exact moment of full moon?",
        a: "Because full moon means the sun and the moon are opposite each other in longitude, not that the three bodies are in a straight line. The moon's orbit is tilted about five degrees to the ecliptic, so at most full moons it passes above or below the earth's shadow and a sliver of its disc is still turned away from the sun. That leaves the illumination at around 99.8 percent rather than exactly 100. The times it really is 100 percent are the times the moon is inside the shadow, which is a lunar eclipse.",
      },
      {
        q: "What does the hemisphere toggle actually change?",
        a: "The orientation of the whole disc, by half a turn. From the northern hemisphere a waxing moon is lit on the right and the crescent opens to the left; from the southern hemisphere the same moon is lit on the left. Nothing about the phase, the illumination or the times changes, because those are properties of the moon and the sun rather than of where you stand. Near the equator the moon rides overhead and the lit limb tends to sit along the bottom or the top instead, so neither drawing is exactly what you see, which is worth knowing before you go looking for the crescent.",
      },
    ],
  },
};

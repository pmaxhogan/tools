import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "planet-positions",
  matrixSlug: "planet-positions-rise-set",
  icon: "Orbit",
  name: "Planet Positions and Rise Times",
  description:
    "Where the sun, the moon and the naked eye planets are for any place and date, with rise and set times, brightness and whether you can see them.",
  category: "Astronomy",
  keywords: [
    "planet positions calculator",
    "planet rise and set times",
    "where is mars tonight",
    "planet visibility tonight",
    "right ascension and declination of planets",
    "planet altitude and azimuth",
    "planet magnitude calculator",
    "elongation from the sun",
  ],
  searchTerms: [
    "what planets are visible tonight",
    "where is jupiter in the sky",
    "where is saturn right now",
    "venus evening star morning star",
    "mercury greatest elongation",
    "planet ephemeris",
    "ra dec of planets",
    "alt az of planets",
    "planetary conjunction",
    "opposition date",
    "which constellation is mars in",
    "how bright is venus",
    "naked eye planets",
    "uranus neptune finder",
    "sky tonight calculator",
  ],
  input: "text/plain",
  output: "application/json",
  http: { method: "GET", contentType: "text/plain" },
  options: [
    {
      kind: "select",
      id: "order",
      label: "List the bodies",
      default: "traditional",
      options: [
        {
          value: "traditional",
          label: "Sun and moon first, then outward",
          synonyms: ["traditional", "default", "distance", "order from the sun", "classic"],
        },
        {
          value: "brightest",
          label: "Brightest first",
          synonyms: ["brightness", "magnitude", "easiest to see", "bright"],
        },
        {
          value: "highest",
          label: "Highest in the sky first",
          synonyms: ["altitude", "up", "overhead", "best placed"],
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
          synonyms: ["short", "brief", "basic", "one line each"],
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
            "ecliptic longitude",
            "distance in au",
            "light time",
          ],
        },
      ],
    },
  ],
  examples: [
    {
      label: "The sky over St Louis tonight",
      input: "St Louis",
      opts: { order: "brightest", detail: "summary" },
    },
    {
      label: "Mars at its 2022 opposition, seen from London",
      input: "London\n2022-12-08 05:42",
      opts: { order: "traditional", detail: "full" },
    },
  ],
  copy: {
    what: "Gives you the whole naked eye solar system at once for a place and a moment: the sun, the moon, Mercury, Venus, Mars, Jupiter, Saturn, Uranus and Neptune. For each one it reports the apparent right ascension and declination for the equinox of date, the altitude and compass azimuth from where you are standing, the times it rises, reaches its highest point and sets, its estimated visual magnitude, how far it sits from the sun in the sky and on which side, the constellation it is passing through, and a plain sentence saying whether you can actually see it right now. Full detail adds the distances in astronomical units, the phase angle and illuminated fraction, the ecliptic coordinates and the light travel time.",
    how: 'Type a city like "Tokyo" or a coordinate pair like "40.7128, -74.0060". Add a date on its own line, written like "2026-08-30", and the report is for 9 pm local on that evening; add a time as well, like "2026-08-30 21:30", to pick the moment yourself. Add "tz Europe/Berlin" on a third line to read the times in another zone. Leave everything blank and you get the current sky, with no altitude or rise times until you name a place. Sort the list by brightness or by height in the sky when you are deciding what to look at first.',
    why: "The planetarium sites that answer this either want you to sign in, or hand you a picture with no numbers under it. This one gives you the numbers and says where they came from: the JPL approximate Keplerian elements published by Standish for the planets, the truncated ELP2000-82 lunar theory for the moon, and the Astronomical Almanac magnitude expressions including the tilt of Saturn's rings. Every figure carries an honest accuracy claim rather than a false decimal place, and your files and inputs never leave your device.",
    faq: [
      {
        q: "How accurate is this compared with a real ephemeris?",
        a: "Positions come from the JPL approximate Keplerian elements, which are six elements and six rates per planet fitted to the years 1800 through 2050. Checked against JPL Horizons, the full numerical ephemeris, every body here lands within about five arcminutes and most within one: Mars comes out 1.5 arcseconds off on 2024 January 1, and Saturn, the worst case, is about five arcminutes off because these elements do not model the long slow tug between Jupiter and Saturn. That is far better than you need to find a planet in binoculars and nowhere near good enough to time an occultation. Rise and set times inherit that accuracy and land within a minute or so. Dates outside 1800 to 2050 are refused rather than answered badly.",
      },
      {
        q: "How are the constellations worked out?",
        a: "By a band lookup along the ecliptic, not the full IAU boundary table. The tool takes the body's ecliptic longitude, converts it back onto the J2000 grid the boundaries are published on, and reports which of the thirteen constellations the ecliptic runs through at that longitude, Ophiuchus included. That is right for anything close to the ecliptic, which is where the planets live. When a body is more than four degrees off the ecliptic, which the moon often is and Venus and Mercury sometimes are, the answer says so, because the true boundary may put it in the neighboring constellation.",
      },
      {
        q: "What does the visibility line take into account?",
        a: "Three things: whether the body is above your horizon, how bright it is, and how far the sun has sunk below the horizon. A planet above the horizon in a fully dark sky and brighter than magnitude 6 is called visible; anything fainter is called out as a binocular or telescope object, which is where Neptune always lands and Uranus usually does. In twilight the bar rises with the sky brightness, so Jupiter is called visible long before Saturn is. Venus gets its own case, because at magnitude -4 it can be found in broad daylight if you know exactly where to look, and so does the moon. Altitudes are geometric with no correction for refraction, so a body reported just below the horizon may already be peeking over it.",
      },
    ],
  },
};
